// Live sessions: single-consumer bounded event iterators, serial turns and an
// owned transport per session. `LiveSession` is the public abstract handle;
// the process implementation below owns one child per session with strict
// JSONL framing on stdout and correlated requests on stdin, shared by two
// backends:
//
// - `pi` on `rpc`: `pi --mode rpc` (protocol of @earendil-works/pi-coding-agent
//   0.85.1: a turn is complete on `agent_settled`, never on `agent_end`, which
//   may be followed by a retry).
// - `omp` on `sdk`: an owned Bun child running the bridge worker
//   `_omp_sdk.mjs`, which loads the caller-installed
//   @oh-my-pi/pi-coding-agent 18.1.14 SDK. The worker speaks the same
//   `get_state` / `prompt` / `abort` request framing, wraps native SDK events
//   as `{type:'sdk_event', event}` and reports turn completion through the
//   internal `{type:'sdk_settled', error?}` frame; the native `agent_settled`
//   event never completes an SDK turn.
//
// Ownership mirrors the one-shot engine in lifecycle.ts through the shared
// `OwnedChild` (owned-process.ts): the child leads a fresh POSIX process
// group, teardown is TERM → GRACE_MS → KILL → bounded DRAIN_MS reap/drain,
// and the workdir lease (with any projected AGENTS.md) is held until the tree
// is gone. Any transport or protocol violation invalidates the handle and
// triggers that same bounded teardown.
//
// Two more backends share the spec validation, `EventQueue`, `TurnCore` and
// result shapes declared here and are loaded lazily:
//
// - `opencode` on `rpc`: direct HTTP + SSE against a caller-owned server
//   (opencode.ts), never a child process.
// - `factory-droid` on `sdk`: the caller-installed @factory/droid-sdk 0.9.1
//   public `DroidClient` driving one owned `droid exec` child over a
//   Harness-owned stdio transport (factory-droid-sdk.ts). The SDK is imported
//   only when such a session is opened; importing this module or querying
//   capabilities never loads it.
import type { ChildProcess } from 'node:child_process'
import { closeSync, existsSync, openSync, readSync, realpathSync } from 'node:fs'
import { basename, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Backend, ErrorCode, PermissionPolicy } from './base.js'
import { HarnessError } from './base.js'
import { cleanupCommand, prepareCommand } from './instructions.js'
import type { PreparedCommand } from './instructions.js'
import { assertSupportedPlatform, describeError } from './lifecycle.js'
import { MAX_FRAME_BYTES, OwnedChild, inheritedEnv, spawnGroupLeader } from './owned-process.js'
import type { OwnedChildFailure } from './owned-process.js'
import { getAdapter } from './registry.js'

export { MAX_FRAME_BYTES }

/** `rpc` drives `pi` (and `opencode` over HTTP); `sdk` drives `omp` through the owned Bun bridge and `factory-droid` through the caller-installed Droid SDK. Any other pairing (and `cli`) is `unsupported-backend`. */
export type SessionBackend = 'rpc' | 'sdk'

/** The harnesses with a live session backend. */
type SessionHarness = 'pi' | 'omp' | 'opencode' | 'factory-droid'

/**
 * Selection of the caller-installed OMP SDK. Nothing here is guessed: the
 * package, the agent profile and the credential source are all explicit.
 */
export interface OmpSdkOptions {
  /** Absolute path to the caller-installed `@oh-my-pi/pi-coding-agent` package directory (loaded by the bridge worker, never by this process). */
  packageRoot: string
  /** Absolute path to the caller-selected agent profile directory; exported to the worker as `PI_CODING_AGENT_DIR` and `PI_CONFIG_DIR`. */
  agentDir: string
  /** `local` opens the profile credential DB; `environment` uses an in-memory DB. Both retain native environment/dotenv/models.yml auth resolution. */
  auth: 'local' | 'environment'
}

/** Native Droid autonomy levels (`AutonomyLevel` on the wire). */
export type FactoryDroidAutonomy = 'off' | 'low' | 'medium' | 'high'

/**
 * A native Droid callback: receives the exact `params` JSON object of the
 * CLI's `droid.request_permission` / `droid.ask_user` request and returns the
 * native response JSON object, synchronously or as a promise.
 *
 * - Permission reply: `{ selectedOption, comment?, editedSpecContent? }` where
 *   `selectedOption` must be one of the `options[].value` strings offered in
 *   the request; nothing is escalated or mapped on the caller's behalf.
 * - Question reply: `{ cancelled: boolean, answers?: [...] }` with native
 *   `{ index, question, answer }` entries whose `index` names an offered
 *   question (`answers` defaults to `[]`).
 *
 * A callback that throws, times out (`requestTimeoutSeconds`) or returns an
 * invalid / unoffered reply fails closed: the session ends as `agent-error`
 * with the cause retained and the owned process group is torn down.
 */
export type FactoryDroidCallback = (params: JsonObject) => JsonObject | Promise<JsonObject>

/**
 * Optional native policy for `factory-droid` on `sdk`. Every field is
 * optional; omitted (or `null`) fields leave the upstream default untouched.
 * Only the policy the pinned SDK exposes publicly is accepted: restrictive
 * allowlists / additional tool IDs, MCP servers, hooks and permission bypass
 * are unsupported and rejected, never tunnelled through CLI flags.
 */
export interface FactoryDroidOptions {
  autonomy?: FactoryDroidAutonomy | null
  /** Native tool IDs disabled for the session (copied). */
  disabledTools?: readonly string[] | null
  /** Native `autoRejectPermissionRequests`: the CLI rejects permission requests itself instead of asking. */
  autoRejectPermissionRequests?: boolean | null
  disableBuiltinSkills?: boolean | null
  /** Answers `droid.request_permission`; without it the SDK's default (`cancel`) applies. */
  onPermission?: FactoryDroidCallback | null
  /** Answers `droid.ask_user`; without it the SDK's default (`cancelled`) applies. */
  onQuestion?: FactoryDroidCallback | null
}

export type OpenCodeAuth = 'none' | 'basic'

/**
 * Selection of a caller-owned OpenCode server (pinned v1.18.29). Nothing is
 * discovered: endpoint and credentials are explicit and the server is never
 * started, configured or disposed by the session.
 */
export interface OpenCodeOptions {
  /** Absolute `http(s)://host[:port]` origin, optional trailing slash; credentials, path, query and fragment are rejected. */
  endpoint: string
  /** `none` sends no credentials; `basic` sends `Authorization: Basic` from `username`/`password`, which must both be non-empty. */
  auth: OpenCodeAuth
  username?: string
  password?: string
}

/** Native OpenCode permission replies this session forwards. `always` is refused: upstream stores it as an instance-wide rule shared by every client. */
export type OpenCodeApprovalResponse = 'once' | 'reject'

/** A parsed JSON object frame; array and scalar frames are protocol errors. */
export type JsonObject = Record<string, unknown>

/** Identity of a native session: the full native ID plus the file it persists to (or the server it lives on). */
export interface SessionReference {
  /** Full native session ID; never a prefix. */
  sessionId: string
  /** Absolute session file, or null while the native session has not been persisted yet (always null on `opencode`). On `factory-droid` it is the path Droid persists to under the effective `FACTORY_HOME_OVERRIDE` / `HOME` (`.factory/sessions/<encoded workdir>/<id>.jsonl`), computed from the native ID; native persistence may be lazy. */
  sessionFile: string | null
  /** Absolute working directory the session was opened in; the literal server-side directory on `opencode`. */
  workdir: string
  /** Normalized server origin on `opencode`; absent for process sessions, which reject a reference that carries one. */
  endpoint?: string
}

export interface SessionSpec {
  harness: string
  /** Local absolute directory for `pi`/`omp`/`factory-droid`; for `opencode` the literal absolute POSIX directory on the server (never resolved or created locally). */
  workdir: string
  /** Required; `rpc` for `pi` and `opencode`, `sdk` for `omp` and `factory-droid`. */
  backend: SessionBackend
  /** Passed through as `--model <trimmed>` (pi), to the SDK worker (omp), as the native `modelId` (factory-droid, new sessions only) or as `provider/model` (opencode); absent leaves the model to the harness's own defaults. */
  model?: string
  /** Layered over the inherited process env; never mutated. On `omp`, entries conflicting with the owned `PI_CODING_AGENT_DIR` / `PI_CONFIG_DIR` are rejected. On `factory-droid` the effective env must carry a non-empty `FACTORY_API_KEY`. Must be empty on `opencode`. */
  env?: Record<string, string>
  /** Replaces the `pi` binary, the `bun` binary running the OMP bridge worker, or the `droid` binary (factory-droid): a bare name resolved on PATH or an absolute path. Rejected on `opencode`. */
  executable?: string
  /** Only `upstream` is supported; `bypass` is rejected. */
  permissionPolicy?: PermissionPolicy
  /** Projected into `AGENTS.md` for the session's lifetime. Rejected on `opencode` (no local workdir). */
  instructions?: string
  /** Resume an existing native session; needs `sessionFile` and the full `sessionId` (on `opencode`: a null `sessionFile`, the matching `endpoint` and the full `ses_` ID). On `factory-droid` a resumed session keeps its saved model and autonomy: `model` and `factoryDroid.autonomy` are rejected alongside `resume`. */
  resume?: SessionReference
  /** Wall-clock limit per turn; defaults to 1800. `null` disables it. */
  timeoutSeconds?: number | null
  /** Bound on every native request/response round trip (on `factory-droid` also on every native callback reply); defaults to 30. */
  requestTimeoutSeconds?: number
  /** Bytes of unconsumed events buffered per turn (and for idle session events); defaults to 1 MiB. Overflow is a protocol error, never a silent drop. */
  maxBufferBytes?: number
  /** Required for harness `omp`, rejected otherwise. */
  ompSdk?: OmpSdkOptions
  /** Required for harness `opencode`, rejected otherwise. */
  opencode?: OpenCodeOptions
  /** Optional for harness `factory-droid` on `sdk` (omitted = upstream defaults), rejected otherwise. */
  factoryDroid?: FactoryDroidOptions
}

/** `SessionSpec` after defaults and validation; the read-only snapshot a `LiveSession` exposes. */
export interface ResolvedSessionSpec {
  readonly harness: SessionHarness
  readonly workdir: string
  readonly backend: SessionBackend
  readonly model: string | null
  readonly env: Readonly<Record<string, string>>
  /** Leader binary for process sessions; null on `opencode`. */
  readonly executable: string | null
  readonly permissionPolicy: PermissionPolicy
  readonly instructions: string | null
  readonly resume: SessionReference | null
  readonly timeoutSeconds: number | null
  readonly requestTimeoutSeconds: number
  readonly maxBufferBytes: number
  /** Frozen copy of the caller's selection for `omp`; null otherwise. */
  readonly ompSdk: Readonly<OmpSdkOptions> | null
  /** Frozen, endpoint-normalized copy of the caller's selection for `opencode`; null otherwise. */
  readonly opencode: Readonly<OpenCodeOptions> | null
  /** Frozen, fully defaulted (`null` = upstream default) native policy for `factory-droid`; null for every other harness. */
  readonly factoryDroid: Readonly<Required<FactoryDroidOptions>> | null
}

/** What a harness supports as a live session on a backend. Static; never probes installs or credentials. */
export interface SessionCapabilities {
  backend: SessionBackend
  events: boolean
  interrupt: boolean
  followUp: boolean
  resume: boolean
  concurrentTurns: boolean
  approval: boolean
}

export type SessionTurnStatus =
  | 'completed'
  | 'agent-error'
  | 'interrupted'
  | 'protocol-error'
  | 'disconnected'
  | 'timed-out'
  | 'closed'
  | 'exited'
  | 'signaled'

/** One native frame, response frames included. Unknown native event types pass through untouched in `raw`; on `omp`, `raw` is the exact native SDK event, never the bridge wrapper; on `opencode`, `raw` is the decoded SSE `{id, type, properties}` object; on `factory-droid`, `raw` is the inner native notification for notification frames and the whole JSON-RPC envelope for `request` / `response` frames. */
export interface SessionEvent {
  backend: SessionBackend
  harness: SessionHarness
  sessionId: string
  /** Null for frames that arrived while no turn was active, and on `opencode` for message frames of the selected session that do not belong to the active turn's lineage. */
  turnId: string | null
  /** The native `id` correlation field when the frame carries one (stringified on `factory-droid`); on `opencode` the native message or permission request ID. */
  requestId: string | null
  /** Native `type` string: the inner notification type, or `request` / `response` for `factory-droid` envelopes. */
  type: string
  raw: JsonObject
}

export interface SessionTurnResult {
  sessionId: string
  turnId: string
  status: SessionTurnStatus
  /** Last `agent_end` payload, the failed `prompt` response, the failing `sdk_settled` bridge frame, the native `agent_turn_completed` notification or failed `droid.add_user_message` response envelope (factory-droid), or on `opencode` the native prompt response (`{info, parts}`) / failing HTTP JSON body. */
  raw: JsonObject | null
  error: string | null
  /** Leader exit code once reaped, else null. Signaled exits report `-signum`. Always null on `opencode` (no process is observed). */
  exitCode: number | null
  signal: string | null
  /** Bounded prefix of the session's stderr so far; empty with `stderrBytes` 0 on `opencode`. */
  stderr: string
  stderrBytes: number
  stderrTruncated: boolean
  /** True when this turn's unconsumed events exceeded `maxBufferBytes` (the session was torn down). */
  eventsTruncated: boolean
}

export interface SessionTurn {
  readonly id: string
  /** Single-consumer; ends once `result` settled and the buffered events are drained. */
  readonly events: AsyncIterable<SessionEvent>
  /** Settles exactly once, never rejects. */
  readonly result: Promise<SessionTurnResult>
}

const PI_ARGS: readonly string[] = ['--mode', 'rpc']
/** Bun flags ahead of the bridge worker script: never load a `.env` from the workdir. */
const BUN_ARGS: readonly string[] = ['--no-env-file']
const DEFAULT_TIMEOUT_SECONDS = 1800
const DEFAULT_REQUEST_TIMEOUT_SECONDS = 30
const DEFAULT_MAX_BUFFER_BYTES = 1_048_576
/** Characters of stderr quoted in handshake failure messages. */
export const STDERR_EXCERPT = 512
const LF = 0x0a
const UTF8 = new TextDecoder('utf-8', { fatal: true })
const FACTORY_AUTONOMY: readonly FactoryDroidAutonomy[] = ['off', 'low', 'medium', 'high']
/** Native OpenCode session IDs: the server validates the prefix only, so the rest is merely required to be safe alphanumerics. */
const OPENCODE_SESSION_ID = /^ses_[0-9A-Za-z]+$/
/** Any ASCII control character (including DEL); rejected in every OpenCode option that ends up on the wire. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/

export function invalid(message: string): HarnessError {
  return new HarnessError(message, 'invalid-options')
}

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Bounded `setTimeout` for second-valued deadlines (clamped to the platform maximum). */
export function deadline(seconds: number, fn: () => void): NodeJS.Timeout {
  return setTimeout(fn, Math.min(seconds * 1000, 2_147_483_647))
}

/** The shared prompt contract of `startTurn`. */
export function requirePrompt(prompt: unknown): string {
  if (typeof prompt !== 'string' || prompt.trim() === '' || prompt.includes('\0')) {
    throw invalid('prompt must be a non-empty string without NUL bytes')
  }
  return prompt
}

/** Strict UTF-8 text of one stdout frame, shared by the process backends. Throws `protocol-error`. */
export function decodeFrameText(bytes: Buffer): string {
  try {
    return UTF8.decode(bytes)
  } catch (err) {
    throw new HarnessError(`stdout frame is not strict UTF-8: ${describeError(err)}`, 'protocol-error')
  }
}

/** One JSON object from decoded frame text; arrays, scalars and malformed JSON are `protocol-error`. */
export function parseFrame(text: string): JsonObject {
  let frame: unknown
  try {
    frame = JSON.parse(text)
  } catch (err) {
    throw new HarnessError(`stdout frame is not strict UTF-8 JSON: ${describeError(err)}`, 'protocol-error')
  }
  if (!isJsonObject(frame)) throw new HarnessError('stdout frame is not a JSON object', 'protocol-error')
  return frame
}

export function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/** Raw equality or equality after symlink resolution on both sides (Pi records `/private/tmp` for `/tmp`). */
export function samePath(a: string, b: string): boolean {
  return a === b || realpathOrSelf(a) === realpathOrSelf(b)
}

/** Owned child environment for the bridge worker: config-root writes stay inside the selected profile. */
function ompSdkEnv(options: Readonly<OmpSdkOptions>): Readonly<Record<string, string>> {
  return { PI_CODING_AGENT_DIR: options.agentDir, PI_CONFIG_DIR: options.agentDir }
}

/** Which backend each session harness is qualified on; anything else is `unsupported-backend`. */
const SESSION_BACKENDS: Readonly<Record<SessionHarness, SessionBackend>> = { pi: 'rpc', omp: 'sdk', opencode: 'rpc', 'factory-droid': 'sdk' }

function isSessionHarness(name: string): name is SessionHarness {
  return name === 'pi' || name === 'omp' || name === 'opencode' || name === 'factory-droid'
}

/** Resolve the harness first, then validate the backend before rejecting an unsupported pairing. */
function requireSessionHarness(name: unknown, backend: unknown): { harness: SessionHarness; backend: SessionBackend } {
  if (typeof name !== 'string') throw invalid('harness must be a string')
  const adapter = getAdapter(name)
  if (backend !== 'cli' && backend !== 'rpc' && backend !== 'sdk') {
    throw invalid(`Unknown backend: ${JSON.stringify(backend)}. Expected one of: cli, rpc, sdk`)
  }
  if (!isSessionHarness(adapter.name)) {
    throw new HarnessError(`Harness "${name}" has no live session backend; only "pi" (rpc), "opencode" (rpc), "omp" (sdk) and "factory-droid" (sdk) are supported`, 'unsupported-backend')
  }
  const qualified = SESSION_BACKENDS[adapter.name]
  if (backend !== qualified) {
    throw new HarnessError(`Live sessions for "${adapter.name}" are only implemented on backend "${qualified}", not "${backend}"`, 'unsupported-backend')
  }
  return { harness: adapter.name, backend: qualified }
}

/**
 * Static support report for a harness as a live session. Separate from
 * `getCapabilities`: this documents session operations, not one-shot execution.
 *
 * `approval` refers to the generic `respondApproval` method only. Factory
 * Droid reports `false` there because its permission and question requests
 * are answered through the backend-specific `factoryDroid.onPermission` /
 * `onQuestion` callbacks with native replies, never through a mapped generic
 * reply.
 */
export function getSessionCapabilities(name: string, backend: Backend = 'rpc'): SessionCapabilities {
  const resolved = requireSessionHarness(name, backend)
  return {
    backend: resolved.backend,
    events: true,
    interrupt: true,
    followUp: true,
    resume: true,
    concurrentTurns: false,
    approval: resolved.harness === 'opencode',
  }
}

/**
 * Validate the caller's Factory Droid policy: every accepted field is typed,
 * copied and defaulted to `null` (upstream default); anything else is rejected
 * by name so no native choice is silently discarded. Pure.
 */
function resolveFactoryDroid(raw: unknown): Readonly<Required<FactoryDroidOptions>> {
  const options: Required<FactoryDroidOptions> = {
    autonomy: null, disabledTools: null, autoRejectPermissionRequests: null, disableBuiltinSkills: null, onPermission: null, onQuestion: null,
  }
  if (raw === undefined) return Object.freeze(options)
  if (!isJsonObject(raw)) throw invalid('factoryDroid must be a FactoryDroidOptions object')
  for (const key of Object.keys(raw)) {
    if (!(key in options)) throw invalid(`factoryDroid.${key} is not a supported option; only autonomy, disabledTools, autoRejectPermissionRequests, disableBuiltinSkills, onPermission and onQuestion are accepted`)
  }
  const { autonomy, disabledTools, autoRejectPermissionRequests, disableBuiltinSkills, onPermission, onQuestion } = raw
  if (autonomy !== undefined && autonomy !== null) {
    const level = FACTORY_AUTONOMY.find((value) => value === autonomy)
    if (level === undefined) throw invalid(`factoryDroid.autonomy must be one of off, low, medium, high, got ${JSON.stringify(autonomy)}`)
    options.autonomy = level
  }
  if (disabledTools !== undefined && disabledTools !== null) {
    if (!Array.isArray(disabledTools)) throw invalid('factoryDroid.disabledTools must be an array of native tool IDs')
    const copy: string[] = []
    for (const id of disabledTools) {
      if (typeof id !== 'string' || id === '' || id.includes('\0')) throw invalid('factoryDroid.disabledTools entries must be non-empty strings without NUL bytes')
      copy.push(id)
    }
    options.disabledTools = Object.freeze(copy)
  }
  for (const [name, value] of [['autoRejectPermissionRequests', autoRejectPermissionRequests], ['disableBuiltinSkills', disableBuiltinSkills]] as const) {
    if (value !== undefined && value !== null && typeof value !== 'boolean') throw invalid(`factoryDroid.${name} must be a boolean`)
  }
  if (typeof autoRejectPermissionRequests === 'boolean') options.autoRejectPermissionRequests = autoRejectPermissionRequests
  if (typeof disableBuiltinSkills === 'boolean') options.disableBuiltinSkills = disableBuiltinSkills
  for (const [name, value] of [['onPermission', onPermission], ['onQuestion', onQuestion]] as const) {
    if (value !== undefined && value !== null && !isCallback(value)) throw invalid(`factoryDroid.${name} must be a function returning the native reply object`)
  }
  if (isCallback(onPermission)) options.onPermission = onPermission
  if (isCallback(onQuestion)) options.onQuestion = onQuestion
  return Object.freeze(options)
}

/** Only the callable shape is checkable here; the reply object is validated when the native request arrives. */
function isCallback(value: unknown): value is FactoryDroidCallback {
  return typeof value === 'function'
}

/** Validate the caller's SDK selection; every field is explicit and absolute, nothing is probed on disk. */
function resolveOmpSdk(raw: unknown): Readonly<OmpSdkOptions> {
  if (!isJsonObject(raw)) throw invalid('ompSdk must be an OmpSdkOptions object')
  if (Object.keys(raw).some((key) => !['packageRoot', 'agentDir', 'auth'].includes(key))) {
    throw invalid('ompSdk contains an unsupported option')
  }
  const { packageRoot, agentDir, auth } = raw
  if (typeof packageRoot !== 'string' || !isAbsolute(packageRoot) || packageRoot.includes('\0')) {
    throw invalid('ompSdk.packageRoot must be the absolute path of the installed @oh-my-pi/pi-coding-agent package')
  }
  if (typeof agentDir !== 'string' || !isAbsolute(agentDir) || agentDir.includes('\0')) {
    throw invalid('ompSdk.agentDir must be the absolute path of the agent profile directory')
  }
  if (auth !== 'local' && auth !== 'environment') {
    throw invalid(`ompSdk.auth must be "local" or "environment", got ${JSON.stringify(auth)}`)
  }
  return Object.freeze({ packageRoot, agentDir, auth })
}

/**
 * Normalize an OpenCode endpoint to its origin (`scheme://host[:port]`, lower
 * case, default port dropped). Only an absolute http(s) origin with at most a
 * trailing slash is accepted: no credentials, path, query, fragment,
 * whitespace or control characters.
 */
function normalizeEndpoint(raw: unknown, field: string): string {
  if (typeof raw !== 'string' || raw === '') throw invalid(`${field} must be a non-empty http(s) origin`)
  if (CONTROL_CHARS.test(raw) || /\s/.test(raw)) throw invalid(`${field} must not contain whitespace or control characters`)
  if (raw.includes('?') || raw.includes('#')) throw invalid(`${field} must be a bare origin without query or fragment`)
  if (!/^https?:\/\//i.test(raw) || raw.includes('\\')) throw invalid(`${field} must be an absolute http(s) origin without backslashes`)
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw invalid(`${field} is not an absolute URL`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw invalid(`${field} must use http or https, got ${JSON.stringify(url.protocol)}`)
  if (url.username !== '' || url.password !== '') throw invalid(`${field} must not embed credentials; use auth "basic" with username/password`)
  const authority = raw.slice(raw.indexOf('://') + 3)
  if (authority.endsWith(':') || authority.endsWith(':/')) throw invalid(`${field} must not have an empty port`)
  const slash = authority.indexOf('/')
  if (url.pathname !== '/' || (slash !== -1 && slash !== authority.length - 1)) {
    throw invalid(`${field} must be a bare origin without a path (an optional trailing slash is allowed)`)
  }
  return url.origin
}

/** Validate the caller's OpenCode server selection; the endpoint is normalized, credentials are kept verbatim and never echoed. */
function resolveOpenCode(raw: unknown): Readonly<OpenCodeOptions> {
  if (!isJsonObject(raw)) throw invalid('opencode must be an OpenCodeOptions object')
  if (Object.keys(raw).some((key) => !['endpoint', 'auth', 'username', 'password'].includes(key))) {
    throw invalid('opencode contains an unsupported option')
  }
  const { auth, username, password } = raw
  const endpoint = normalizeEndpoint(raw.endpoint, 'opencode.endpoint')
  if (auth !== 'none' && auth !== 'basic') throw invalid(`opencode.auth must be "none" or "basic", got ${JSON.stringify(auth)}`)
  if (auth === 'none') {
    if (username !== undefined || password !== undefined) throw invalid('opencode.username/password are only accepted with auth "basic"')
    return Object.freeze({ endpoint, auth })
  }
  if (typeof username !== 'string' || username === '' || username.includes(':') || CONTROL_CHARS.test(username)) {
    throw invalid('opencode.username must be a non-empty string without ":" or control characters')
  }
  if (typeof password !== 'string' || password === '' || CONTROL_CHARS.test(password)) {
    throw invalid('opencode.password must be a non-empty string without control characters')
  }
  return Object.freeze({ endpoint, auth, username, password })
}

/**
 * The literal server-side directory an OpenCode session runs in: absolute
 * POSIX, canonical (no empty, `.` or `..` segments, no trailing slash except
 * for the root itself). Nothing is resolved or checked locally.
 */
function requireServerWorkdir(raw: string): string {
  if (!raw.startsWith('/')) throw invalid(`workdir ${JSON.stringify(raw)} must be an absolute POSIX path on the OpenCode server`)
  if (CONTROL_CHARS.test(raw)) throw invalid('workdir must not contain control characters')
  if (raw === '/') return raw
  if (raw.endsWith('/')) throw invalid(`workdir ${JSON.stringify(raw)} must not end with a slash`)
  for (const segment of raw.slice(1).split('/')) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw invalid(`workdir ${JSON.stringify(raw)} must be canonical: no empty, "." or ".." segments`)
    }
  }
  return raw
}

/** Resume target for process sessions: a persisted file plus the full ID, matching the local workdir. A server reference (`endpoint`) is rejected, never discarded. */
function resolveReference(raw: unknown, workdir: string): SessionReference {
  if (!isJsonObject(raw)) throw invalid('resume must be a SessionReference object')
  const { sessionId, sessionFile, workdir: refWorkdir, endpoint } = raw
  if (typeof sessionId !== 'string' || sessionId === '') throw invalid('resume.sessionId must be the full non-empty native session ID')
  if (endpoint !== undefined) throw invalid('resume.endpoint is only meaningful for harness "opencode"; this reference belongs to a server session')
  if (sessionFile === null || sessionFile === undefined) {
    throw invalid('resume needs sessionFile: a session that was never persisted cannot be resumed')
  }
  if (typeof sessionFile !== 'string' || !isAbsolute(sessionFile) || sessionFile.includes('\0')) {
    throw invalid('resume.sessionFile must be an absolute path')
  }
  if (typeof refWorkdir !== 'string' || !isAbsolute(refWorkdir) || refWorkdir.includes('\0')) {
    throw invalid('resume.workdir must be an absolute path')
  }
  if (!samePath(refWorkdir, workdir)) {
    throw invalid(`resume.workdir ${JSON.stringify(refWorkdir)} does not match the session workdir ${JSON.stringify(workdir)}`)
  }
  return { sessionId, sessionFile, workdir: refWorkdir }
}

/** Resume target for OpenCode: the full `ses_` ID on the same normalized endpoint and literal workdir, with no session file. Verified against the server in `open`. */
function resolveServerReference(raw: unknown, workdir: string, endpoint: string): SessionReference {
  if (!isJsonObject(raw)) throw invalid('resume must be a SessionReference object')
  const { sessionId, sessionFile, workdir: refWorkdir, endpoint: refEndpoint } = raw
  if (typeof sessionId !== 'string' || !OPENCODE_SESSION_ID.test(sessionId)) {
    throw invalid('resume.sessionId must be the full native OpenCode session ID (ses_ followed by alphanumerics)')
  }
  if (sessionFile !== null) throw invalid('resume.sessionFile must be null for OpenCode sessions; they live on the server, not in a local file')
  if (refWorkdir !== workdir) {
    throw invalid(`resume.workdir ${JSON.stringify(refWorkdir)} does not match the session workdir ${JSON.stringify(workdir)}`)
  }
  if (refEndpoint === undefined) throw invalid('resume.endpoint is required for OpenCode sessions')
  const normalized = normalizeEndpoint(refEndpoint, 'resume.endpoint')
  if (normalized !== endpoint) {
    throw invalid(`resume.endpoint ${JSON.stringify(normalized)} does not match opencode.endpoint ${JSON.stringify(endpoint)}`)
  }
  return { sessionId, sessionFile: null, workdir, endpoint }
}

/** Apply defaults and validate. Pure: nothing is touched on disk or on the network. */
function resolveSessionSpec(spec: SessionSpec): ResolvedSessionSpec {
  if (!isJsonObject(spec)) throw invalid('spec must be a SessionSpec object')
  const { harness, backend } = requireSessionHarness(spec.harness, spec.backend)
  const rawOmpSdk: unknown = spec.ompSdk
  let ompSdk: Readonly<OmpSdkOptions> | null = null
  if (harness === 'omp') {
    if (rawOmpSdk === undefined) throw invalid('ompSdk is required for harness "omp": packageRoot, agentDir and auth are never guessed')
    ompSdk = resolveOmpSdk(rawOmpSdk)
  } else if (rawOmpSdk !== undefined) {
    throw invalid('ompSdk is only accepted for harness "omp" on backend "sdk"')
  }
  const rawOpenCode: unknown = spec.opencode
  let opencode: Readonly<OpenCodeOptions> | null = null
  if (harness === 'opencode') {
    if (rawOpenCode === undefined) throw invalid('opencode is required for harness "opencode": endpoint and auth are never guessed')
    opencode = resolveOpenCode(rawOpenCode)
  } else if (rawOpenCode !== undefined) {
    throw invalid('opencode is only accepted for harness "opencode"')
  }
  const rawFactoryDroid: unknown = spec.factoryDroid
  let factoryDroid: Readonly<Required<FactoryDroidOptions>> | null = null
  if (harness === 'factory-droid') factoryDroid = resolveFactoryDroid(rawFactoryDroid)
  else if (rawFactoryDroid !== undefined) throw invalid('factoryDroid is only accepted for harness "factory-droid" on backend "sdk"')
  const rawWorkdir: unknown = spec.workdir
  if (typeof rawWorkdir !== 'string' || rawWorkdir === '' || rawWorkdir.includes('\0')) {
    throw invalid('workdir must be a non-empty string without NUL bytes')
  }
  const workdir = opencode === null ? resolve(rawWorkdir) : requireServerWorkdir(rawWorkdir)

  let model: string | null = null
  const rawModel: unknown = spec.model
  if (rawModel !== undefined) {
    if (typeof rawModel !== 'string' || rawModel.includes('\0')) throw invalid('model must be a string without NUL bytes')
    model = rawModel.trim()
    if (model === '') throw invalid('model must not be empty')
    if (opencode !== null) {
      const slash = model.indexOf('/')
      if (slash <= 0 || slash === model.length - 1) throw invalid(`model ${JSON.stringify(model)} must be "provider/model" for opencode`)
    }
  }

  const env: Record<string, string> = {}
  const rawEnv: unknown = spec.env
  if (rawEnv !== undefined) {
    if (!isJsonObject(rawEnv)) throw invalid('env must be an object of string values')
    for (const [key, value] of Object.entries(rawEnv)) {
      if (key === '' || key.includes('=') || key.includes('\0') || typeof value !== 'string' || value.includes('\0')) {
        throw invalid('env keys and values must be valid NUL-free environment strings')
      }
      env[key] = value
    }
  }
  if (opencode !== null && Object.keys(env).length > 0) {
    throw invalid('env is not supported for opencode: the server process is caller-owned and its environment cannot be changed per session')
  }
  if (ompSdk !== null) {
    for (const [key, owned] of Object.entries(ompSdkEnv(ompSdk))) {
      const explicit = env[key]
      if (explicit !== undefined && explicit !== owned) {
        throw invalid(`env.${key} ${JSON.stringify(explicit)} conflicts with the session-owned value ${JSON.stringify(owned)} derived from ompSdk.agentDir`)
      }
    }
    for (const key of ['OMP_PROFILE', 'PI_PROFILE']) {
      if (env[key] !== undefined && env[key] !== 'default') {
        throw invalid(`env.${key} conflicts with the explicit SDK profile path; omit it`)
      }
    }
  }

  let executable: string | null = harness === 'omp' ? 'bun' : harness === 'factory-droid' ? 'droid' : 'pi'
  const rawExecutable: unknown = spec.executable
  if (opencode !== null) {
    if (rawExecutable !== undefined) throw invalid('executable is not supported for opencode: no local process is launched')
    executable = null
  } else if (rawExecutable !== undefined) {
    if (typeof rawExecutable !== 'string' || rawExecutable === '' || rawExecutable.includes('\0')) {
      throw invalid('executable must be a non-empty string without NUL bytes')
    }
    if ((rawExecutable.includes('/') || rawExecutable.includes(sep)) && !isAbsolute(rawExecutable)) {
      throw invalid(`executable ${JSON.stringify(rawExecutable)} must be a bare binary name or an absolute path`)
    }
    executable = rawExecutable
  }

  const rawPolicy: unknown = spec.permissionPolicy
  if (rawPolicy !== undefined && rawPolicy !== 'upstream' && rawPolicy !== 'bypass') {
    throw invalid(`Unknown permissionPolicy: ${JSON.stringify(rawPolicy)}. Expected one of: upstream, bypass`)
  }
  if (rawPolicy === 'bypass') {
    throw new HarnessError(`${harness} has no documented permission bypass for live sessions; only "upstream" is supported`, 'unsupported-capability')
  }

  const rawInstructions: unknown = spec.instructions
  if (rawInstructions !== undefined && typeof rawInstructions !== 'string') throw invalid('instructions must be a string')
  if (rawInstructions !== undefined && opencode !== null) {
    throw invalid('instructions are not supported for opencode: the session has no local workdir to project AGENTS.md into')
  }

  let resume: SessionReference | null = null
  if (spec.resume !== undefined) {
    resume = opencode === null ? resolveReference(spec.resume, workdir) : resolveServerReference(spec.resume, workdir, opencode.endpoint)
  }
  if (resume !== null && factoryDroid !== null) {
    // The native load request cannot replace the saved model or autonomy; an explicit request to do so must not be silently dropped.
    if (model !== null) throw invalid('model cannot be combined with resume for factory-droid: a resumed Droid session keeps its saved modelId')
    if (factoryDroid.autonomy !== null) throw invalid('factoryDroid.autonomy cannot be combined with resume for factory-droid: a resumed Droid session keeps its saved autonomy level')
  }

  let timeoutSeconds: number | null = DEFAULT_TIMEOUT_SECONDS
  const rawTimeout: unknown = spec.timeoutSeconds
  if (rawTimeout === null) timeoutSeconds = null
  else if (rawTimeout !== undefined) {
    if (typeof rawTimeout !== 'number' || !Number.isFinite(rawTimeout) || rawTimeout < 0) {
      throw invalid(`timeoutSeconds must be null or a finite non-negative number, got ${String(rawTimeout)}`)
    }
    timeoutSeconds = rawTimeout
  }

  let requestTimeoutSeconds = DEFAULT_REQUEST_TIMEOUT_SECONDS
  const rawRequestTimeout: unknown = spec.requestTimeoutSeconds
  if (rawRequestTimeout !== undefined) {
    if (typeof rawRequestTimeout !== 'number' || !Number.isFinite(rawRequestTimeout) || rawRequestTimeout <= 0) {
      throw invalid(`requestTimeoutSeconds must be a finite positive number, got ${String(rawRequestTimeout)}`)
    }
    requestTimeoutSeconds = rawRequestTimeout
  }

  const maxBufferBytes = spec.maxBufferBytes === undefined ? DEFAULT_MAX_BUFFER_BYTES : spec.maxBufferBytes
  if (!Number.isSafeInteger(maxBufferBytes) || maxBufferBytes < 0) {
    throw invalid(`maxBufferBytes must be a non-negative safe integer, got ${String(spec.maxBufferBytes)}`)
  }

  return Object.freeze({
    harness,
    workdir,
    backend,
    model,
    env: Object.freeze(env),
    executable,
    permissionPolicy: 'upstream',
    instructions: rawInstructions === undefined ? null : rawInstructions,
    resume,
    timeoutSeconds,
    requestTimeoutSeconds,
    maxBufferBytes,
    ompSdk,
    opencode,
    factoryDroid,
  })
}

/**
 * The OMP SDK bridge worker: `src/harness/_omp_sdk.mjs` next to the Python
 * package when running from source (`sessions.ts`), the build-time copy
 * `omp-sdk.mjs` beside the bundle otherwise. Resolved by path only; the SDK
 * itself is loaded by the worker, never imported here.
 */
function ompSdkWorkerPath(): string {
  const source = basename(fileURLToPath(import.meta.url)) === 'sessions.ts'
  return fileURLToPath(new URL(source ? '../../src/harness/_omp_sdk.mjs' : './omp-sdk.mjs', import.meta.url))
}

/** What the leader process is called in diagnostics. */
function leaderName(spec: ResolvedSessionSpec): string {
  return spec.harness === 'omp' ? 'the OMP SDK bridge' : 'pi'
}

/** Bounded native header reader shared by the process backends; OMP alone permits one leading title record. */
export function readSessionHeader(file: string, allowTitle: boolean): JsonObject {
  let fd: number
  try {
    fd = openSync(file, 'r')
  } catch (err) {
    throw invalid(`session file ${JSON.stringify(file)} is not readable: ${describeError(err)}`)
  }
  const chunks: Buffer[] = []
  let length = 0
  const chunk = Buffer.allocUnsafe(65_536)
  try {
    for (;;) {
      const size = readSync(fd, chunk, 0, chunk.length, null)
      let from = 0
      do {
        const at = chunk.subarray(0, size).indexOf(LF, from)
        const end = at === -1 ? size : at
        const part = chunk.subarray(from, end)
        length += part.length
        if (length > MAX_FRAME_BYTES) throw invalid(`session file ${JSON.stringify(file)} header exceeds ${MAX_FRAME_BYTES} bytes`)
        // The read buffer is reused; only incomplete header fragments need copying.
        if (at === -1 && size !== 0) {
          chunks.push(Buffer.from(part))
          break
        }
        const bytes = chunks.length === 0 ? part : Buffer.concat([...chunks, part], length)
        const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
        if (!isJsonObject(parsed)) throw invalid(`session file ${JSON.stringify(file)} header is not a JSON object`)
        if (!allowTitle || parsed.type !== 'title') return parsed
        allowTitle = false
        chunks.length = 0
        length = 0
        from = end + 1
      } while (from < size)
    }
  } catch (err) {
    if (err instanceof HarnessError) throw err
    throw invalid(`session file ${JSON.stringify(file)} has no readable JSON header: ${describeError(err)}`)
  } finally {
    closeSync(fd)
  }
}

/** Pre-spawn identity check so `--session` can never silently fall back to a different or fresh session. */
function verifySessionHeader(reference: SessionReference, sessionFile: string, backend: SessionBackend): void {
  const header = readSessionHeader(sessionFile, backend === 'sdk')
  if (header.type !== 'session') throw invalid(`resume.sessionFile ${JSON.stringify(sessionFile)} header type is not "session"`)
  if (header.id !== reference.sessionId) {
    throw invalid(`resume.sessionFile ${JSON.stringify(sessionFile)} belongs to session ${JSON.stringify(header.id)}, not ${JSON.stringify(reference.sessionId)}`)
  }
  if (typeof header.cwd !== 'string' || !samePath(header.cwd, reference.workdir)) {
    throw invalid(`resume.sessionFile ${JSON.stringify(sessionFile)} was recorded in ${JSON.stringify(header.cwd)}, not ${JSON.stringify(reference.workdir)}`)
  }
}

/**
 * Single-consumer async queue bounded by the raw byte size of what sits
 * unconsumed. A waiting consumer receives events directly; otherwise they
 * queue, and crossing the bound reports overflow (the session then fails)
 * while everything already queued stays readable.
 */
export class EventQueue implements AsyncIterable<SessionEvent> {
  readonly #limit: number
  readonly #onOverflow: () => void
  #items: { event: SessionEvent; bytes: number }[] = []
  #bytes = 0
  #ended = false
  #claimed = false
  #waiter: ((result: IteratorResult<SessionEvent, undefined>) => void) | null = null

  constructor(limit: number, onOverflow: () => void) {
    this.#limit = limit
    this.#onOverflow = onOverflow
  }

  push(event: SessionEvent, bytes: number): void {
    if (this.#ended) return
    const waiter = this.#waiter
    if (waiter !== null) {
      this.#waiter = null
      waiter({ value: event, done: false })
      return
    }
    this.#items.push({ event, bytes })
    this.#bytes += bytes
    if (this.#bytes > this.#limit) this.#onOverflow()
  }

  /** No further events; buffered ones remain consumable. */
  end(): void {
    this.#ended = true
    const waiter = this.#waiter
    if (waiter !== null && this.#items.length === 0) {
      this.#waiter = null
      waiter({ value: undefined, done: true })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SessionEvent, undefined> {
    if (this.#claimed) {
      throw new HarnessError('Session event iterators are single-consumer; iterate once', 'unsupported-capability')
    }
    this.#claimed = true
    return {
      next: (): Promise<IteratorResult<SessionEvent, undefined>> => {
        const item = this.#items.shift()
        if (item !== undefined) {
          this.#bytes -= item.bytes
          return Promise.resolve({ value: item.event, done: false })
        }
        if (this.#ended) return Promise.resolve({ value: undefined, done: true })
        if (this.#waiter !== null) {
          return Promise.reject(new HarnessError('Session event iterators are single-consumer; await next() sequentially', 'unsupported-capability'))
        }
        return new Promise((resolve) => {
          this.#waiter = resolve
        })
      },
    }
  }
}

interface PendingRequest {
  command: string
  timer: NodeJS.Timeout
  resolve: (frame: JsonObject) => void
  reject: (err: HarnessError) => void
}

interface AbortState {
  acked: boolean
  confirmed: boolean
}

/** The backend-independent turn: ID, bounded event queue, deadline timer and the single settlement. */
export class TurnCore {
  readonly id: string
  readonly queue: EventQueue
  readonly promise: Promise<SessionTurnResult>
  readonly settle: (result: SessionTurnResult) => void
  timer: NodeJS.Timeout | undefined
  eventsTruncated = false
  done = false

  constructor(id: string, queue: EventQueue) {
    this.id = id
    this.queue = queue
    let settle: ((result: SessionTurnResult) => void) | undefined
    this.promise = new Promise((resolve) => {
      settle = resolve
    })
    this.settle = settle!
  }

  get handle(): SessionTurn {
    return { id: this.id, events: this.queue, result: this.promise }
  }
}

class ProcessTurn extends TurnCore {
  promptAcked = false
  /** Failed `prompt` response or failing `sdk_settled` frame; the turn ends as `agent-error` once every outstanding ack is in. */
  failure: JsonObject | null = null
  settled = false
  lastAgentEnd: JsonObject | null = null
  /** Last assistant message from the last `agent_end`; earlier retries do not determine the result. */
  lastAssistant: JsonObject | null = null
  abort: AbortState | null = null
}

function lastAssistantMessage(messages: unknown): JsonObject | null {
  if (!Array.isArray(messages)) return null
  for (let i = messages.length - 1; i >= 0; i--) {
    const message: unknown = messages[i]
    if (isJsonObject(message) && message.role === 'assistant') return message
  }
  return null
}

/**
 * An open live session. Obtain one through `openSession`; the native
 * resources (process group, workdir lease and projected instructions for
 * `pi`/`omp`/`factory-droid`; HTTP connections and the event stream for
 * `opencode`) are owned until `close()` (or an internal failure) tears them
 * down. Turns are sequential: the next `startTurn` after a settled result is a
 * follow-up in the same native session. There is no event callback API;
 * consume `turn.events` / `events`. The only callbacks are Factory Droid's
 * native `factoryDroid.onPermission` / `onQuestion` replies.
 */
export abstract class LiveSession {
  readonly spec: ResolvedSessionSpec

  protected constructor(spec: ResolvedSessionSpec) {
    this.spec = spec
  }

  /** Open through the same validated contract as `openSession`. */
  static async open(input: SessionSpec): Promise<LiveSession> {
    const spec = resolveSessionSpec(input)
    if (spec.opencode !== null) {
      // Lazy by contract: the HTTP/SSE transport is only loaded when an OpenCode session is selected.
      const { OpenCodeSession } = await import('./opencode.js')
      return OpenCodeSession.connect(spec)
    }
    if (spec.factoryDroid !== null) {
      // Lazy by contract: the optional @factory/droid-sdk is only imported (inside this module) when a Factory Droid session is selected.
      const { FactoryDroidSession } = await import('./factory-droid-sdk.js')
      return FactoryDroidSession.launch(spec)
    }
    return ProcessSession.launch(spec)
  }

  /** Native identity; available once `openSession` resolved. */
  abstract get reference(): SessionReference

  /** Frames that arrive while no turn is active (single-consumer; ends when the session closes). */
  abstract get events(): AsyncIterable<SessionEvent>

  abstract get active(): SessionTurn | null

  /** True once teardown has begun, whether by `close()` or by a failure. */
  abstract get closed(): boolean

  /**
   * Reserve the single turn slot and send the prompt. Synchronous: the turn is
   * accepted locally before anything is sent; a native rejection settles it as
   * `agent-error`, and a prompt that is acknowledged but never settled is
   * reported by the turn deadline as `timed-out` rather than fabricated.
   */
  abstract startTurn(prompt: string): SessionTurn

  /** Abort the active turn; resolves once the turn settled. */
  abstract interrupt(): Promise<void>

  /**
   * Answer an outstanding native permission request of this session. Only
   * `opencode` supports it (`getSessionCapabilities(...).approval`); the
   * request must have been observed as a `permission.asked` event of the
   * selected session and still be unanswered. Factory Droid answers its
   * native requests through `factoryDroid.onPermission` / `onQuestion`.
   */
  abstract respondApproval(requestId: string, response: OpenCodeApprovalResponse): Promise<void>

  /** Idempotent, concurrent-safe teardown of everything this handle owns. Cleanup failures are rethrown. */
  abstract close(): Promise<void>
}

/** Pi RPC and the OMP SDK bridge: one owned child process per session. Constructed only through `LiveSession.open`. */
class ProcessSession extends LiveSession {
  readonly #prepared: PreparedCommand
  readonly #child: OwnedChild
  readonly #sessionQueue: EventQueue
  readonly #pending = new Map<string, PendingRequest>()
  #prelude: { frame: JsonObject; requestId: string | null; bytes: number }[] = []
  #preludeBytes = 0
  #reference: SessionReference | null = null
  #requestSeq = 0
  #turnSeq = 0
  #active: ProcessTurn | null = null
  #dead = false
  #teardown: Promise<void> | null = null
  #cleanupError: unknown = null

  private constructor(spec: ResolvedSessionSpec, prepared: PreparedCommand, child: ChildProcess) {
    super(spec)
    this.#prepared = prepared
    this.#sessionQueue = new EventQueue(spec.maxBufferBytes, () => {
      void this.#invalidate('protocol-error', `unconsumed session events exceeded maxBufferBytes (${spec.maxBufferBytes})`)
    })
    this.#child = new OwnedChild(child, leaderName(spec), spec.maxBufferBytes, {
      line: (bytes) => this.#onLine(bytes),
      fail: (status: OwnedChildFailure, error) => void this.#invalidate(status, error),
    })
  }

  /** Verify any resume target, take the workdir lease, spawn the leader and complete the `get_state` handshake. */
  static async launch(spec: ResolvedSessionSpec): Promise<LiveSession> {
    const executable = spec.executable
    if (executable === null) throw invalid(`harness "${spec.harness}" resolved without a leader executable`)
    assertSupportedPlatform()
    const resume = spec.resume
    if (resume !== null && resume.sessionFile !== null) verifySessionHeader(resume, resume.sessionFile, spec.backend)
    const args: string[] = []
    // Explicit layering, never a parent mutation: inherited env, then the caller's entries, then the session-owned ones.
    const layered: Record<string, string> = { ...spec.env }
    if (spec.ompSdk === null) {
      args.push(...PI_ARGS)
      if (spec.model !== null) args.push('--model', spec.model)
      if (resume !== null && resume.sessionFile !== null) args.push('--session', resume.sessionFile)
    } else {
      const worker = ompSdkWorkerPath()
      if (!existsSync(worker)) throw new HarnessError(`OMP SDK bridge worker is missing at ${worker}`, 'launch-failed')
      const { packageRoot, agentDir, auth } = spec.ompSdk
      args.push(...BUN_ARGS, worker, JSON.stringify({ packageRoot, agentDir, auth, cwd: spec.workdir, model: spec.model, resume }))
      Object.assign(layered, ompSdkEnv(spec.ompSdk))
    }
    const adapter = getAdapter(spec.harness)
    const prepared = prepareCommand({
      cmd: executable,
      args,
      cwd: spec.workdir,
      env: layered,
      instructionsFile: join(spec.workdir, adapter.instructionsFilename),
      ...(spec.instructions === null ? {} : { instructionContent: spec.instructions }),
    })
    let child: ChildProcess
    try {
      child = spawnGroupLeader(executable, args, spec.workdir, inheritedEnv(layered))
    } catch (err) {
      cleanupCommand(prepared)
      throw new HarnessError(`${leaderName(spec)} could not be launched: ${describeError(err)}`, 'launch-failed')
    }
    const session = new ProcessSession(spec, prepared, child)
    try {
      await session.#request('get_state', {})
    } catch (err) {
      await session.#teardown
      if (session.#cleanupError !== null) throw session.#cleanupError
      throw err
    }
    return session
  }

  /**
   * Validate the `get_state` response and adopt the native identity. Runs
   * synchronously inside the frame handler so that frames sharing the same
   * chunk are already stamped with the session ID. Returns the problem, if any.
   */
  #adoptState(frame: JsonObject): string | null {
    const data = frame.data
    if (frame.success !== true || !isJsonObject(data)) {
      return `get_state failed: ${typeof frame.error === 'string' ? frame.error : 'malformed response'}`
    }
    const { sessionId, sessionFile, isStreaming } = data
    if (typeof sessionId !== 'string' || sessionId === '') return 'get_state returned no sessionId'
    if (sessionFile !== null && sessionFile !== undefined &&
        (typeof sessionFile !== 'string' || !isAbsolute(sessionFile) || sessionFile.includes('\0'))) {
      return 'get_state returned a malformed sessionFile'
    }
    if (isStreaming !== false) return 'get_state reports the agent is already streaming'
    const resume = this.spec.resume
    if (resume !== null && sessionId !== resume.sessionId) {
      return `${leaderName(this.spec)} resumed session ${JSON.stringify(sessionId)}, not ${JSON.stringify(resume.sessionId)}`
    }
    this.#reference = Object.freeze({ sessionId, sessionFile: sessionFile ?? null, workdir: this.spec.workdir })
    const prelude = this.#prelude
    this.#prelude = []
    this.#preludeBytes = 0
    for (const entry of prelude) this.#route(entry.frame, entry.requestId, entry.bytes)
    return null
  }

  /** Native identity; available once `openSession` resolved. */
  get reference(): SessionReference {
    if (this.#reference === null) throw new HarnessError('session handshake has not completed', 'protocol-error')
    return this.#reference
  }

  /** Frames that arrive while no turn is active (single-consumer; ends when the session closes). */
  get events(): AsyncIterable<SessionEvent> {
    return this.#sessionQueue
  }

  get active(): SessionTurn | null {
    return this.#active?.handle ?? null
  }

  /** True once teardown has begun, whether by `close()` or by a failure. */
  get closed(): boolean {
    return this.#dead
  }

  /**
   * Prompts handled entirely by a local Pi extension or input hook may
   * acknowledge without ever settling; the turn deadline reports those as
   * `timed-out` rather than fabricating a completion.
   */
  startTurn(prompt: string): SessionTurn {
    requirePrompt(prompt)
    if (this.#dead) throw new HarnessError('session is closed', 'session-closed')
    if (this.#active !== null) {
      throw new HarnessError('a turn is still active; concurrent turns are unsupported', 'unsupported-capability')
    }
    const id = `turn-${++this.#turnSeq}`
    const turn = new ProcessTurn(id, new EventQueue(this.spec.maxBufferBytes, () => {
      turn.eventsTruncated = true
      void this.#invalidate('protocol-error', `unconsumed events of ${id} exceeded maxBufferBytes (${this.spec.maxBufferBytes})`)
    }))
    this.#active = turn
    if (this.spec.timeoutSeconds !== null) {
      const seconds = this.spec.timeoutSeconds
      turn.timer = deadline(seconds, () => {
        void this.#invalidate('timed-out', `${id} exceeded timeoutSeconds (${seconds})`)
      })
    }
    this.#request('prompt', { message: prompt }).then(
      (frame) => {
        turn.promptAcked = true
        if (frame.success !== true) turn.failure = frame
        this.#maybeComplete(turn)
      },
      () => {},
    )
    return turn.handle
  }

  /**
   * Abort the active turn. Resolves once the turn settled, which requires both
   * the native abort acknowledgement and the turn's settlement (`agent_settled`
   * on rpc, the worker's `sdk_settled` on sdk); the result reports
   * `interrupted` only when the harness confirmed the abort.
   */
  async interrupt(): Promise<void> {
    if (this.#dead) throw new HarnessError('session is closed', 'session-closed')
    const turn = this.#active
    if (turn === null) throw new HarnessError('no active turn to interrupt', 'unsupported-capability')
    if (turn.abort === null) {
      const abort: AbortState = { acked: false, confirmed: false }
      turn.abort = abort
      this.#request('abort', {}).then(
        (frame) => {
          abort.acked = true
          abort.confirmed = frame.success === true
          this.#maybeComplete(turn)
        },
        () => {},
      )
    }
    await turn.promise
  }

  /** Neither Pi RPC nor the OMP SDK bridge exposes native permission replies; approvals stay inside the harness. */
  respondApproval(): Promise<void> {
    return Promise.reject(new HarnessError(`${this.spec.harness} live sessions cannot answer permission requests; only "opencode" supports respondApproval`, 'unsupported-capability'))
  }

  /** Idempotent, concurrent-safe teardown: stdin EOF, TERM → KILL the group, bounded drain, then release the lease. Cleanup failures are rethrown. */
  async close(): Promise<void> {
    await this.#invalidate('closed', null)
    if (this.#cleanupError !== null) throw this.#cleanupError
  }

  // ---- requests ----

  #request(command: string, payload: JsonObject): Promise<JsonObject> {
    if (this.#dead) {
      return Promise.reject(new HarnessError('session is closed', 'session-closed'))
    }
    const id = `req-${++this.#requestSeq}`
    const seconds = this.spec.requestTimeoutSeconds
    return new Promise<JsonObject>((resolve, reject) => {
      const timer = deadline(seconds, () => {
        void this.#invalidate('protocol-error', `request ${id} (${command}) was not answered within requestTimeoutSeconds (${seconds})`)
      })
      this.#pending.set(id, { command, timer, resolve, reject })
      this.#child.write(`${JSON.stringify({ id, type: command, ...payload })}\n`)
    })
  }

  // ---- stdout frames ----

  #onLine(bytes: Buffer): void {
    let frame: JsonObject
    try {
      frame = parseFrame(decodeFrameText(bytes))
    } catch (err) {
      void this.#invalidate('protocol-error', err instanceof Error ? err.message : String(err))
      return
    }
    if (typeof frame.type !== 'string' || frame.type === '') {
      void this.#invalidate('protocol-error', 'stdout frame has no string "type"')
      return
    }
    if (frame.type === 'response') this.#onResponse(frame, bytes.length)
    else if (this.spec.backend === 'sdk') this.#onBridgeFrame(frame, bytes.length)
    else this.#onEvent(frame, bytes.length)
  }

  #onResponse(frame: JsonObject, bytes: number): void {
    const id = frame.id
    if (typeof id !== 'string') {
      void this.#invalidate('protocol-error', 'response frame has no string "id"')
      return
    }
    const pending = this.#pending.get(id)
    if (pending === undefined) {
      void this.#invalidate('protocol-error', `unexpected or duplicate response for request ${JSON.stringify(id)}`)
      return
    }
    if (frame.command !== pending.command) {
      void this.#invalidate('protocol-error', `response for ${id} names command ${JSON.stringify(frame.command)}, expected ${JSON.stringify(pending.command)}`)
      return
    }
    if (typeof frame.success !== 'boolean') {
      void this.#invalidate('protocol-error', `response for ${id} has no boolean success`)
      return
    }
    if (this.#reference === null) {
      // The handshake response is consumed here (it becomes `reference`), not surfaced as an idle event.
      const problem = this.#adoptState(frame)
      if (problem !== null) {
        void this.#invalidate('protocol-error', problem)
        return
      }
    } else {
      this.#route(frame, id, bytes)
    }
    this.#pending.delete(id)
    clearTimeout(pending.timer)
    pending.resolve(frame)
  }

  /** A native event (Pi directly, or unwrapped from an `sdk_event`). Only the Pi backend completes turns on `agent_settled`. */
  #onEvent(frame: JsonObject, bytes: number): void {
    const turn = this.#active
    const settles = frame.type === 'agent_settled' && this.spec.backend === 'rpc'
    if (turn !== null && !turn.done) {
      if (frame.type === 'agent_end') {
        turn.lastAgentEnd = frame
        turn.lastAssistant = lastAssistantMessage(frame.messages)
      } else if (settles) {
        turn.settled = true
      }
    }
    this.#route(frame, typeof frame.id === 'string' ? frame.id : null, bytes)
    if (turn !== null && settles) this.#maybeComplete(turn)
  }

  /**
   * Frames from the OMP SDK bridge worker other than responses: `sdk_event`
   * unwraps to the exact native event and goes through event routing;
   * `sdk_settled` is the worker's authoritative turn completion and is never
   * exposed as an event. Anything else is a protocol violation.
   */
  #onBridgeFrame(frame: JsonObject, bytes: number): void {
    if (frame.type === 'sdk_event') {
      const event = frame.event
      if (!isJsonObject(event) || typeof event.type !== 'string' || event.type === '') {
        void this.#invalidate('protocol-error', 'sdk_event frame carries no native event object with a string "type"')
        return
      }
      this.#onEvent(event, bytes)
      return
    }
    if (frame.type !== 'sdk_settled') {
      void this.#invalidate('protocol-error', `unknown bridge frame type ${JSON.stringify(frame.type)}`)
      return
    }
    const error = frame.error
    if (error !== undefined && error !== null && (typeof error !== 'string' || error === '')) {
      void this.#invalidate('protocol-error', 'sdk_settled frame has a non-string or empty "error"')
      return
    }
    const turn = this.#active
    if (turn === null || turn.done) return // idle settle: nothing to complete, mirrors an idle agent_settled
    turn.settled = true
    if (typeof error === 'string') turn.failure = frame
    this.#maybeComplete(turn)
  }

  #route(frame: JsonObject, requestId: string | null, bytes: number): void {
    if (this.#dead) return
    if (this.#reference === null) {
      if (this.#preludeBytes + bytes > this.spec.maxBufferBytes) {
        void this.#invalidate('protocol-error', 'events before session identity exceeded maxBufferBytes')
        return
      }
      this.#preludeBytes += bytes
      this.#prelude.push({ frame, requestId, bytes })
      return
    }
    const turn = this.#active
    const event: SessionEvent = {
      backend: this.spec.backend,
      harness: this.spec.harness,
      sessionId: this.#reference?.sessionId ?? '',
      turnId: turn !== null && !turn.done ? turn.id : null,
      requestId,
      type: typeof frame.type === 'string' ? frame.type : '',
      raw: frame,
    }
    ;(turn !== null && !turn.done ? turn.queue : this.#sessionQueue).push(event, bytes)
  }

  // ---- turn completion ----

  #maybeComplete(turn: ProcessTurn): void {
    if (this.#dead || turn.done || !turn.promptAcked) return
    if (turn.abort !== null && !turn.abort.acked) return
    if (turn.failure !== null) {
      const error = turn.failure.error
      this.#finishTurn(turn, 'agent-error', turn.failure, typeof error === 'string' ? error : 'prompt rejected')
      return
    }
    if (!turn.settled) return
    const assistant = turn.lastAssistant
    const stopReason = assistant?.stopReason
    if (stopReason === 'aborted') {
      this.#finishTurn(turn, 'interrupted', turn.lastAgentEnd, null)
    } else if (stopReason === 'error') {
      const message = assistant?.errorMessage
      this.#finishTurn(turn, 'agent-error', turn.lastAgentEnd, typeof message === 'string' ? message : 'assistant message ended with stopReason "error"')
    } else if (assistant === null && turn.abort?.confirmed === true) {
      this.#finishTurn(turn, 'interrupted', turn.lastAgentEnd, null)
    } else {
      this.#finishTurn(turn, 'completed', turn.lastAgentEnd, null)
    }
  }

  #finishTurn(turn: ProcessTurn, status: SessionTurnStatus, raw: JsonObject | null, error: string | null): void {
    if (turn.done) return
    turn.done = true
    clearTimeout(turn.timer)
    if (this.#active === turn) this.#active = null
    const child = this.#child
    turn.settle({
      sessionId: this.#reference?.sessionId ?? '',
      turnId: turn.id,
      status,
      raw,
      error,
      exitCode: child.exitCode,
      signal: child.signal,
      stderr: child.stderr.text,
      stderrBytes: child.stderr.bytes,
      stderrTruncated: child.stderr.truncated,
      eventsTruncated: turn.eventsTruncated,
    })
    turn.queue.end()
  }

  // ---- teardown ----

  /**
   * Fail or close the session once: reject every pending request, stop the
   * process group, then settle the active turn with `status` and end the
   * idle event stream. Returns the shared teardown promise.
   *
   * On `sdk` the worker disposes the SDK session when asked to stop; a
   * worker that was still running here and then exited non-zero or had to be
   * killed did not dispose cleanly, which `close()` reports as
   * `adapter-error` after the owned teardown and lease cleanup. A worker
   * that had already ended is reported through the session status instead.
   */
  #invalidate(status: SessionTurnStatus, error: string | null): Promise<void> {
    if (this.#teardown !== null) return this.#teardown
    this.#dead = true
    const child = this.#child
    child.stop()
    // Only `openSession` observes these rejections (interrupt awaits the turn result instead).
    const rejectCode: ErrorCode =
      status === 'closed' ? 'session-closed' : status === 'protocol-error' || status === 'timed-out' ? 'protocol-error' : 'launch-failed'
    const excerpt = child.stderr.text.trim().slice(0, STDERR_EXCERPT)
    const message = `${error ?? 'session closed'}${status !== 'closed' && excerpt !== '' ? `; stderr: ${excerpt}` : ''}`
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer)
      this.#pending.delete(id)
      pending.reject(new HarnessError(message, rejectCode))
    }
    const turn = this.#active
    if (turn !== null) clearTimeout(turn.timer)
    const disposing = this.spec.backend === 'sdk' && child.pid !== null && child.leader === null
    this.#teardown = child.stopGroup().catch((err: unknown) => {
      this.#cleanupError = err
    }).then(() => {
      if (turn !== null) this.#finishTurn(turn, status, turn.lastAgentEnd, error)
      this.#sessionQueue.end()
      // A failed reap/termination must not release ownership of live resources.
      if (this.#cleanupError !== null) return
      try {
        cleanupCommand(this.#prepared)
      } catch (err) {
        this.#cleanupError = err
        return
      }
      const leader = child.leader
      if (!disposing || leader === null) return
      if (leader.signal !== null) {
        this.#cleanupError = new HarnessError(`the OMP SDK bridge did not dispose within the teardown budget and was terminated by ${leader.signal}`, 'adapter-error')
      } else if (leader.code !== 0) {
        const tail = child.stderr.text.trim().slice(0, STDERR_EXCERPT)
        this.#cleanupError = new HarnessError(`the OMP SDK bridge failed to dispose (exit code ${leader.code ?? -1})${tail === '' ? '' : `; stderr: ${tail}`}`, 'adapter-error')
      }
    })
    return this.#teardown
  }
}

/**
 * Validate the spec and open the native session. For `pi`/`omp`: verify any
 * resume target, take the workdir lease (projecting `instructions` into
 * AGENTS.md), spawn the leader (`pi --mode rpc`, or `bun` running the OMP SDK
 * bridge worker) and complete the `get_state` handshake; rejects with the
 * lease released and the process group stopped when any step fails. For
 * `factory-droid`: verify the SDK pin and `FACTORY_API_KEY`, verify any
 * resume target against the saved native session file, take the lease, spawn
 * `droid exec --input-format stream-jsonrpc --output-format stream-jsonrpc`
 * and complete the native `initialize_session` / `load_session` handshake
 * through the caller-installed SDK. For `opencode`: qualify the caller-owned
 * server (health/version, directory, session identity) and subscribe to its
 * event stream; rejects with every owned connection closed, never touching
 * the server itself.
 */
export async function openSession(spec: SessionSpec): Promise<LiveSession> {
  return LiveSession.open(spec)
}
