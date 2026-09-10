// Live sessions: single-consumer bounded event iterators, serial turns and an
// owned transport per session. `LiveSession` is the public abstract handle;
// the process implementation below owns one child per session with strict
// JSONL framing on stdout and correlated requests on stdin, shared by three
// harnesses:
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
// - `claude-code` on `sdk`: an owned Node (or Bun) child running
//   `claude-sdk-worker.mjs`, which loads the caller-installed
//   @anthropic-ai/claude-agent-sdk 0.3.263 and drives the caller-selected
//   Claude Code 2.1.263 executable through `query` with streaming input. Same
//   request framing plus `approval`; native SDK messages arrive as
//   `sdk_event`, a turn completes on `{type:'sdk_settled', result}` carrying
//   the exact native `result` message, the persisted transcript is learned
//   from `{type:'sdk_reference'}` once a native hook observed it, and fatal
//   native failures arrive as `{type:'sdk_failure', status, error, raw?}`.
//
// Ownership mirrors the one-shot engine in lifecycle.ts: the child leads a
// fresh POSIX process group, teardown is TERM → GRACE_MS → KILL → bounded
// DRAIN_MS reap/drain, and the workdir lease (with any projected AGENTS.md)
// is held until the tree is gone. Any transport or protocol violation
// invalidates the handle and triggers that same bounded teardown.
//
// `opencode` on `rpc` is the fourth harness: direct HTTP + SSE against a
// caller-owned server, implemented in opencode.ts and loaded lazily. It
// shares the spec validation, `EventQueue`, `TurnCore` and result shapes
// declared here, never a child process.
//
// `amp` on `sdk` is the fifth: one finite Node worker (`_amp_sdk.mjs`,
// loading the caller-installed @ampcode/sdk) per operation, driven through
// the shared subprocess runner. Implemented in amp.ts and loaded lazily.
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { closeSync, existsSync, openSync, readSync, realpathSync } from 'node:fs'
import { constants as osConstants } from 'node:os'
import { basename, isAbsolute, join, resolve, sep } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { fileURLToPath } from 'node:url'
import type { Backend, ErrorCode, PermissionPolicy } from './base.js'
import { HarnessError } from './base.js'
import { cleanupCommand, prepareCommand } from './instructions.js'
import type { PreparedCommand } from './instructions.js'
import { DRAIN_MS, GRACE_MS, assertSupportedPlatform, describeError } from './lifecycle.js'
import { getAdapter } from './registry.js'

/** `rpc` drives `pi` (and `opencode` over HTTP); `sdk` drives `omp` through the owned Bun bridge, `claude-code` through the owned SDK worker and `amp` through the Node SDK worker. Any other pairing (and `cli`) is `unsupported-backend`. */
export type SessionBackend = 'rpc' | 'sdk'

/** The harnesses with a live session backend. */
type SessionHarness = 'pi' | 'omp' | 'opencode' | 'claude-code' | 'amp'

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

/** Native Claude Code settings sources, passed verbatim as `--setting-sources`. */
export type ClaudeSettingSource = 'user' | 'project' | 'local'

/**
 * Selection of the caller-installed Claude Agent SDK and Claude Code
 * executable. Nothing is discovered, downloaded or configured: the package,
 * the executable, the config directory and the settings sources are all
 * explicit, and the exact versions (SDK 0.3.263, CLI 2.1.263) are qualified by
 * the worker before the session opens.
 */
export interface ClaudeSdkOptions {
  /** Absolute path to the caller-installed `@anthropic-ai/claude-agent-sdk` package directory (loaded by the worker, never by this process). */
  packageRoot: string
  /** Absolute path of the Claude Code executable the SDK spawns; its `--version` must report exactly 2.1.263. */
  cliPath: string
  /** Absolute caller-selected `CLAUDE_CONFIG_DIR`, layered over the inherited environment for the worker and the native process. Not a sandbox: nothing else is isolated or copied. */
  configDir: string
  /** Exact native `--setting-sources` selection; empty disables filesystem settings. `instructions` require `project` (CLAUDE.md is only read from that source). */
  settingSources: ClaudeSettingSource[]
  /** Optional absolute settings JSON file passed as native `--settings`. */
  settingsFile?: string
}

/** Native Amp reasoning effort; omitted leaves the CLI default. */
export type AmpEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** Native Amp thread visibility; only applied when a thread is created. */
export type AmpVisibility = 'private' | 'unlisted' | 'workspace' | 'group'

/**
 * Selection of the caller-installed Amp TypeScript SDK (pinned
 * @ampcode/sdk 0.1.0-20260823161614-g3631dc6 driving the pinned native CLI
 * 0.0.1788883237-g0b98e3). Nothing is discovered: the SDK package, the CLI
 * binary and the mode are all explicit. No model option exists; Amp routes
 * models through `mode`.
 */
export interface AmpSdkOptions {
  /** Absolute path to the caller-installed `@ampcode/sdk` package directory (loaded by the worker, never by this process). */
  packageRoot: string
  /** Absolute path of the native `amp` CLI the SDK executes; the worker verifies its version through `--version`. */
  cliPath: string
  /** Only `local` is supported: the SDK runs the CLI on this machine. */
  executor: 'local'
  /** Native Amp mode, required so the SDK never silently selects its own default. Passed through verbatim (trimmed); the CLI validates it. */
  mode: string
  effort?: AmpEffort
  /** Thread visibility at creation. Rejected together with `resume`: an existing thread's visibility is never changed. */
  visibility?: AmpVisibility
  /** Absolute path of a caller-owned Amp settings file (`--settings-file`). */
  settingsFile?: string
}

/** `AmpSdkOptions` after validation plus the derived native endpoint. */
export interface ResolvedAmpSdkOptions extends AmpSdkOptions {
  readonly effort: AmpEffort | undefined
  readonly visibility: AmpVisibility | undefined
  readonly settingsFile: string | undefined
  /** Normalized origin of `AMP_URL` (the session's `env`, else the inherited process env, else `https://ampcode.com`); the worker enforces it. */
  readonly endpoint: string
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

/** Native permission replies this session forwards (`opencode` and `claude-code`). `always` is refused: upstream stores it as a rule beyond the session. */
export type OpenCodeApprovalResponse = 'once' | 'reject'

/** A parsed JSON object frame; array and scalar frames are protocol errors. */
export type JsonObject = Record<string, unknown>

/** Identity of a native session: the full native ID plus the file it persists to (or the server it lives on). */
export interface SessionReference {
  /** Full native session ID; never a prefix. */
  sessionId: string
  /** Absolute session file, or null while the native session has not been persisted yet (always null on `opencode`; on `claude-code` null until a native hook reported the transcript, typically after the first turn). */
  sessionFile: string | null
  /** Absolute working directory the session was opened in; the literal server-side directory on `opencode`. */
  workdir: string
  /** Normalized server origin on `opencode`; absent for process sessions, which reject a reference that carries one. */
  endpoint?: string
}

export interface SessionSpec {
  harness: string
  /** Local absolute directory for `pi`/`omp`/`amp`; for `opencode` the literal absolute POSIX directory on the server (never resolved or created locally). */
  workdir: string
  /** Required; `rpc` for `pi` and `opencode`, `sdk` for `omp`, `claude-code` and `amp`. */
  backend: SessionBackend
  /** Passed through as `--model <trimmed>` (rpc), to the OMP SDK worker (sdk) or as `provider/model` (opencode); absent leaves the model to the harness's own defaults. Rejected for `amp`, which routes models through `ampSdk.mode`. */
  model?: string
  /** Layered over the inherited process env; never mutated. For `omp`, entries conflicting with the session-owned `PI_CODING_AGENT_DIR` / `PI_CONFIG_DIR` are rejected; for `claude-code`, an entry conflicting with the session-owned `CLAUDE_CONFIG_DIR` is rejected; for `amp`, `AMP_SKIP_UPDATE_CHECK` may only be `"1"` and `AMP_URL` selects the endpoint. Must be empty on `opencode`. */
  env?: Record<string, string>
  /** Replaces the `pi` binary (rpc), the `bun` binary running the OMP bridge worker, the `node` binary running the Amp SDK worker, or the JavaScript runtime running the Claude SDK worker (defaults to this process's `execPath`; a `bun` runtime gets `--no-env-file`): a bare name resolved on PATH or an absolute path. Rejected on `opencode`. */
  executable?: string
  /** Only `upstream` is supported; `bypass` is rejected. */
  permissionPolicy?: PermissionPolicy
  /** Projected into `AGENTS.md` for the session's lifetime. Rejected on `opencode` (no local workdir). */
  instructions?: string
  /** Resume an existing native session; needs `sessionFile` and the full `sessionId` (on `opencode`/`amp`: a null `sessionFile`, the matching `endpoint` and the full native ID). */
  resume?: SessionReference
  /** Wall-clock limit per turn; defaults to 1800. `null` disables it. */
  timeoutSeconds?: number | null
  /** Bound on every native request/response round trip; defaults to 30. On `amp` it also bounds `open` and each turn's native initialization (until the worker reports the thread identity). */
  requestTimeoutSeconds?: number
  /** Bytes of unconsumed events buffered per turn (and for idle session events); defaults to 1 MiB. Overflow is a protocol error, never a silent drop. */
  maxBufferBytes?: number
  /** Required for harness `omp` (backend `sdk`), rejected otherwise. */
  ompSdk?: OmpSdkOptions
  /** Required for harness `amp`, rejected otherwise. */
  ampSdk?: AmpSdkOptions
  /** Required for harness `opencode`, rejected otherwise. */
  opencode?: OpenCodeOptions
  /** Required for harness `claude-code` (backend `sdk`), rejected otherwise. */
  claudeSdk?: ClaudeSdkOptions
}

/** `SessionSpec` after defaults and validation; the read-only snapshot a `LiveSession` exposes. */
export interface ResolvedSessionSpec {
  readonly harness: SessionHarness
  readonly workdir: string
  readonly backend: SessionBackend
  readonly model: string | null
  readonly env: Readonly<Record<string, string>>
  /** Leader binary for process sessions (the worker runtime on `sdk`); null on `opencode`. */
  readonly executable: string | null
  readonly permissionPolicy: PermissionPolicy
  readonly instructions: string | null
  readonly resume: SessionReference | null
  readonly timeoutSeconds: number | null
  readonly requestTimeoutSeconds: number
  readonly maxBufferBytes: number
  /** Frozen copy of the caller's selection for `omp`; null otherwise. */
  readonly ompSdk: Readonly<OmpSdkOptions> | null
  /** Frozen copy of the caller's selection for `amp` plus the derived endpoint; null otherwise. */
  readonly ampSdk: ResolvedAmpSdkOptions | null
  /** Frozen, endpoint-normalized copy of the caller's selection for `opencode`; null otherwise. */
  readonly opencode: Readonly<OpenCodeOptions> | null
  /** Frozen copy of the caller's selection for `claude-code`; null otherwise. */
  readonly claudeSdk: Readonly<ClaudeSdkOptions> | null
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

/** One native frame, response frames included. Unknown native event types pass through untouched in `raw`; on `sdk`, `raw` is the exact native SDK event, never the bridge/worker wrapper; on `opencode`, `raw` is the decoded SSE `{id, type, properties}` object. */
export interface SessionEvent {
  backend: SessionBackend
  harness: SessionHarness
  sessionId: string
  /** Null for frames that arrived while no turn was active, and on `opencode` for message frames of the selected session that do not belong to the active turn's lineage. */
  turnId: string | null
  /** The native `id` correlation field when the frame carries one; on `opencode` the native message or permission request ID; always null on `amp`. */
  requestId: string | null
  /** Native `type` string. */
  type: string
  raw: JsonObject
}

export interface SessionTurnResult {
  sessionId: string
  turnId: string
  status: SessionTurnStatus
  /** Last `agent_end` payload, the failed `prompt` response, the failing `sdk_settled` bridge frame, on `amp` the last native SDK result the worker reported, or on `opencode` the native prompt response (`{info, parts}`) / failing HTTP JSON body. */
  raw: JsonObject | null
  error: string | null
  /** Leader exit code once reaped, else null. Signaled exits report `-signum`. On `amp` the native CLI's exit as observed by the worker (the worker's own exit only when it failed before reporting). Always null on `opencode` (no process is observed). */
  exitCode: number | null
  signal: string | null
  /** Bounded prefix of the session's stderr so far; on `amp` the stderr of this turn's own worker; empty with `stderrBytes` 0 on `opencode`. */
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
/** Bun flags ahead of a worker script: never load a `.env` from the workdir. Only Bun accepts the flag; Node runs the Claude worker without it. */
const BUN_ARGS: readonly string[] = ['--no-env-file']
/** Native Claude session IDs are UUIDs; the worker selects one explicitly at open and a resume must name one exactly. */
const CLAUDE_SESSION_ID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
const DEFAULT_TIMEOUT_SECONDS = 1800
const DEFAULT_REQUEST_TIMEOUT_SECONDS = 30
const DEFAULT_MAX_BUFFER_BYTES = 1_048_576
/** Largest stdout frame (and, on `opencode`, SSE event / HTTP JSON body) accepted in bytes. */
export const MAX_FRAME_BYTES = 1_048_576
const PROBE_MS = 20
/** Characters of stderr quoted in handshake failure messages. */
export const STDERR_EXCERPT = 512
const LF = 0x0a
const CR = 0x0d
/** Native OpenCode session IDs: the server validates the prefix only, so the rest is merely required to be safe alphanumerics. */
const OPENCODE_SESSION_ID = /^ses_[0-9A-Za-z]+$/
/** Any ASCII control character (including DEL); rejected in every OpenCode option that ends up on the wire. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/
/** Full native Amp thread IDs (`T-` plus a lowercase UUID); never a prefix. */
export const AMP_THREAD_ID = /^T-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const AMP_DEFAULT_ENDPOINT = 'https://ampcode.com'
const AMP_EFFORTS: readonly string[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const AMP_VISIBILITIES: readonly string[] = ['private', 'unlisted', 'workspace', 'group']

export function invalid(message: string): HarnessError {
  return new HarnessError(message, 'invalid-options')
}

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isClaudeSettingSource(value: unknown): value is ClaudeSettingSource {
  return value === 'user' || value === 'project' || value === 'local'
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

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms))
}

function realpathOrSelf(path: string): string {
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

/** Signal (or probe with 0) a whole process group; `true` while it still has members (EPERM counts as alive, see lifecycle.ts). */
function signalGroup(pgid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pgid, signal)
    return true
  } catch (err) {
    const code = err instanceof Error && 'code' in err ? err.code : null
    if (code === 'ESRCH') return false
    if (code === 'EPERM' && signal !== 'SIGKILL') return true
    throw err
  }
}

/** Owned child environment for the bridge worker: config-root writes stay inside the selected profile. */
function ompSdkEnv(options: Readonly<OmpSdkOptions>): Readonly<Record<string, string>> {
  return { PI_CODING_AGENT_DIR: options.agentDir, PI_CONFIG_DIR: options.agentDir }
}

/** Which backend each session harness is qualified on; anything else is `unsupported-backend`. */
const SESSION_BACKENDS: Readonly<Record<SessionHarness, SessionBackend>> = { pi: 'rpc', omp: 'sdk', opencode: 'rpc', 'claude-code': 'sdk', amp: 'sdk' }

function isSessionHarness(name: string): name is SessionHarness {
  return name === 'pi' || name === 'omp' || name === 'opencode' || name === 'claude-code' || name === 'amp'
}

/** Resolve the harness first, then validate the backend before rejecting an unsupported pairing. */
function requireSessionHarness(name: unknown, backend: unknown): { harness: SessionHarness; backend: SessionBackend } {
  if (typeof name !== 'string') throw invalid('harness must be a string')
  const adapter = getAdapter(name)
  if (backend !== 'cli' && backend !== 'rpc' && backend !== 'sdk') {
    throw invalid(`Unknown backend: ${JSON.stringify(backend)}. Expected one of: cli, rpc, sdk`)
  }
  if (!isSessionHarness(adapter.name)) {
    throw new HarnessError(`Harness "${name}" has no live session backend; only "pi" (rpc), "opencode" (rpc), "omp" (sdk), "claude-code" (sdk) and "amp" (sdk) are supported`, 'unsupported-backend')
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
    approval: resolved.harness === 'opencode' || resolved.harness === 'claude-code',
  }
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

/** Validate the caller's Claude SDK selection; every path is explicit and absolute, nothing is probed on disk here (the worker qualifies versions). */
function resolveClaudeSdk(raw: unknown): Readonly<ClaudeSdkOptions> {
  if (!isJsonObject(raw)) throw invalid('claudeSdk must be a ClaudeSdkOptions object')
  if (Object.keys(raw).some((key) => !['packageRoot', 'cliPath', 'configDir', 'settingSources', 'settingsFile'].includes(key))) {
    throw invalid('claudeSdk contains an unsupported option')
  }
  const { packageRoot, cliPath, configDir, settingSources, settingsFile } = raw
  if (typeof packageRoot !== 'string' || !isAbsolute(packageRoot) || packageRoot.includes('\0')) {
    throw invalid('claudeSdk.packageRoot must be the absolute path of the installed @anthropic-ai/claude-agent-sdk package')
  }
  if (typeof cliPath !== 'string' || !isAbsolute(cliPath) || cliPath.includes('\0')) {
    throw invalid('claudeSdk.cliPath must be the absolute path of the Claude Code executable')
  }
  if (typeof configDir !== 'string' || !isAbsolute(configDir) || configDir.includes('\0')) {
    throw invalid('claudeSdk.configDir must be the absolute path of the caller-selected CLAUDE_CONFIG_DIR')
  }
  if (!Array.isArray(settingSources)) throw invalid('claudeSdk.settingSources must be an array chosen from user, project, local (empty allowed)')
  const sources: ClaudeSettingSource[] = []
  for (const source of settingSources as unknown[]) {
    if (!isClaudeSettingSource(source)) throw invalid(`claudeSdk.settingSources contains ${JSON.stringify(source)}; expected user, project or local`)
    if (sources.includes(source)) throw invalid(`claudeSdk.settingSources lists ${JSON.stringify(source)} twice`)
    sources.push(source)
  }
  if (settingsFile !== undefined && (typeof settingsFile !== 'string' || !isAbsolute(settingsFile) || settingsFile.includes('\0'))) {
    throw invalid('claudeSdk.settingsFile must be an absolute path when given')
  }
  return Object.freeze({
    packageRoot,
    cliPath,
    configDir,
    settingSources: sources,
    ...(settingsFile === undefined ? {} : { settingsFile }),
  })
}

function isAmpEffort(value: unknown): value is AmpEffort {
  return typeof value === 'string' && AMP_EFFORTS.includes(value)
}

function isAmpVisibility(value: unknown): value is AmpVisibility {
  return typeof value === 'string' && AMP_VISIBILITIES.includes(value)
}

/** Validate the caller's Amp SDK selection; every field is explicit, nothing is probed on disk. `endpoint` is derived from `AMP_URL` (session env, then inherited env). */
function resolveAmpSdk(raw: unknown, env: Readonly<Record<string, string>>): ResolvedAmpSdkOptions {
  if (!isJsonObject(raw)) throw invalid('ampSdk must be an AmpSdkOptions object')
  const unsupported = Object.keys(raw).find((key) => !['packageRoot', 'cliPath', 'executor', 'mode', 'effort', 'visibility', 'settingsFile'].includes(key))
  if (unsupported !== undefined) throw invalid(`ampSdk contains an unsupported option ${JSON.stringify(unsupported)}`)
  const { packageRoot, cliPath, executor, mode, effort, visibility, settingsFile } = raw
  if (typeof packageRoot !== 'string' || !isAbsolute(packageRoot) || packageRoot.includes('\0')) {
    throw invalid('ampSdk.packageRoot must be the absolute path of the installed @ampcode/sdk package')
  }
  if (typeof cliPath !== 'string' || !isAbsolute(cliPath) || cliPath.includes('\0')) {
    throw invalid('ampSdk.cliPath must be the absolute path of the native amp CLI')
  }
  if (executor !== 'local') throw invalid(`ampSdk.executor must be "local", got ${JSON.stringify(executor)}`)
  if (typeof mode !== 'string' || mode.trim() === '' || mode.includes('\0')) {
    throw invalid('ampSdk.mode must be a non-blank string without NUL bytes; the SDK default is never selected implicitly')
  }
  if (effort !== undefined && !isAmpEffort(effort)) {
    throw invalid(`ampSdk.effort must be one of ${AMP_EFFORTS.join(', ')}, got ${JSON.stringify(effort)}`)
  }
  if (visibility !== undefined && !isAmpVisibility(visibility)) {
    throw invalid(`ampSdk.visibility must be one of ${AMP_VISIBILITIES.join(', ')}, got ${JSON.stringify(visibility)}`)
  }
  if (settingsFile !== undefined && (typeof settingsFile !== 'string' || !isAbsolute(settingsFile) || settingsFile.includes('\0'))) {
    throw invalid('ampSdk.settingsFile must be an absolute path')
  }
  const url = env.AMP_URL ?? process.env.AMP_URL ?? AMP_DEFAULT_ENDPOINT
  const endpoint = normalizeEndpoint(url, 'env.AMP_URL')
  return Object.freeze({ packageRoot, cliPath, executor, mode: mode.trim(), effort, visibility, settingsFile, endpoint })
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

/** Resume target for Amp: the full `T-` thread ID on the same derived endpoint and local workdir, with no session file. Verified through the SDK in `open`. */
function resolveAmpReference(raw: unknown, workdir: string, endpoint: string): SessionReference {
  if (!isJsonObject(raw)) throw invalid('resume must be a SessionReference object')
  const { sessionId, sessionFile, workdir: refWorkdir, endpoint: refEndpoint } = raw
  if (typeof sessionId !== 'string' || !AMP_THREAD_ID.test(sessionId)) {
    throw invalid('resume.sessionId must be the full native Amp thread ID (T- followed by a lowercase UUID)')
  }
  if (sessionFile !== null) throw invalid('resume.sessionFile must be null for Amp sessions; threads live on the server, not in a local file')
  if (typeof refWorkdir !== 'string' || !isAbsolute(refWorkdir) || refWorkdir.includes('\0')) {
    throw invalid('resume.workdir must be an absolute path')
  }
  if (!samePath(refWorkdir, workdir)) {
    throw invalid(`resume.workdir ${JSON.stringify(refWorkdir)} does not match the session workdir ${JSON.stringify(workdir)}`)
  }
  if (refEndpoint === undefined) throw invalid('resume.endpoint is required for Amp sessions')
  const normalized = normalizeEndpoint(refEndpoint, 'resume.endpoint')
  if (normalized !== endpoint) {
    throw invalid(`resume.endpoint ${JSON.stringify(normalized)} does not match the AMP_URL endpoint ${JSON.stringify(endpoint)}`)
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
  const rawClaudeSdk: unknown = spec.claudeSdk
  let claudeSdk: Readonly<ClaudeSdkOptions> | null = null
  if (harness === 'claude-code') {
    if (rawClaudeSdk === undefined) {
      throw invalid('claudeSdk is required for harness "claude-code" on backend "sdk": packageRoot, cliPath, configDir and settingSources are never guessed')
    }
    claudeSdk = resolveClaudeSdk(rawClaudeSdk)
  } else if (rawClaudeSdk !== undefined) {
    throw invalid('claudeSdk is only accepted for harness "claude-code" on backend "sdk"')
  }
  const rawAmpSdk: unknown = spec.ampSdk
  if (harness === 'amp') {
    if (rawAmpSdk === undefined) throw invalid('ampSdk is required for harness "amp": packageRoot, cliPath, executor and mode are never guessed')
  } else if (rawAmpSdk !== undefined) {
    throw invalid('ampSdk is only accepted for harness "amp" on backend "sdk"')
  }
  const rawOpenCode: unknown = spec.opencode
  let opencode: Readonly<OpenCodeOptions> | null = null
  if (harness === 'opencode') {
    if (rawOpenCode === undefined) throw invalid('opencode is required for harness "opencode": endpoint and auth are never guessed')
    opencode = resolveOpenCode(rawOpenCode)
  } else if (rawOpenCode !== undefined) {
    throw invalid('opencode is only accepted for harness "opencode"')
  }
  const rawWorkdir: unknown = spec.workdir
  if (typeof rawWorkdir !== 'string' || rawWorkdir === '' || rawWorkdir.includes('\0')) {
    throw invalid('workdir must be a non-empty string without NUL bytes')
  }
  const workdir = opencode === null ? resolve(rawWorkdir) : requireServerWorkdir(rawWorkdir)

  let model: string | null = null
  const rawModel: unknown = spec.model
  if (rawModel !== undefined) {
    if (harness === 'amp') throw invalid('model is not supported for amp: ampSdk.mode selects the native routing')
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
  if (claudeSdk !== null) {
    const explicit = env.CLAUDE_CONFIG_DIR
    if (explicit !== undefined && explicit !== claudeSdk.configDir) {
      throw invalid(`env.CLAUDE_CONFIG_DIR ${JSON.stringify(explicit)} conflicts with claudeSdk.configDir ${JSON.stringify(claudeSdk.configDir)}`)
    }
  }
  // The Amp endpoint derives from the layered env, so the selection resolves after it.
  let ampSdk: ResolvedAmpSdkOptions | null = null
  if (harness === 'amp') {
    const skip = env.AMP_SKIP_UPDATE_CHECK
    if (skip !== undefined && skip !== '1') {
      throw invalid(`env.AMP_SKIP_UPDATE_CHECK ${JSON.stringify(skip)} conflicts with the session-owned value "1": the worker never lets the CLI self-update`)
    }
    ampSdk = resolveAmpSdk(rawAmpSdk, env)
  }

  let executable: string | null = claudeSdk !== null ? process.execPath : harness === 'omp' ? 'bun' : harness === 'amp' ? 'node' : 'pi'
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
  if (rawInstructions !== undefined && claudeSdk !== null && !claudeSdk.settingSources.includes('project')) {
    throw invalid('instructions require claudeSdk.settingSources to include "project": Claude Code only reads the projected CLAUDE.md from that source')
  }

  let resume: SessionReference | null = null
  if (spec.resume !== undefined) {
    if (opencode !== null) resume = resolveServerReference(spec.resume, workdir, opencode.endpoint)
    else if (ampSdk !== null) resume = resolveAmpReference(spec.resume, workdir, ampSdk.endpoint)
    else resume = resolveReference(spec.resume, workdir)
    if (claudeSdk !== null && !CLAUDE_SESSION_ID.test(resume.sessionId)) {
      throw invalid(`resume.sessionId ${JSON.stringify(resume.sessionId)} is not a native Claude session UUID`)
    }
  }
  if (ampSdk !== null && resume !== null && ampSdk.visibility !== undefined) {
    throw invalid('ampSdk.visibility only applies when a thread is created; it cannot be combined with resume')
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
    ampSdk,
    opencode,
    claudeSdk,
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

/**
 * The Claude SDK worker `claude-sdk-worker.mjs` sits beside this module both
 * in source (`ts/src`) and in the build (copied next to the bundle). Resolved
 * by path only; the optional SDK is loaded by the worker, never imported here.
 */
function claudeSdkWorkerPath(): string {
  return fileURLToPath(new URL('./claude-sdk-worker.mjs', import.meta.url))
}

/** What the leader process is called in diagnostics. */
function leaderName(spec: ResolvedSessionSpec): string {
  return spec.claudeSdk !== null ? 'the Claude SDK worker' : spec.backend === 'sdk' ? 'the OMP SDK bridge' : 'pi'
}

/** Bounded native header reader; OMP alone permits one leading title record. */
function readSessionHeader(file: string, allowTitle: boolean): JsonObject {
  let fd: number
  try {
    fd = openSync(file, 'r')
  } catch (err) {
    throw invalid(`resume.sessionFile ${JSON.stringify(file)} is not readable: ${describeError(err)}`)
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
        if (length > MAX_FRAME_BYTES) throw invalid(`resume.sessionFile header exceeds ${MAX_FRAME_BYTES} bytes`)
        // The read buffer is reused; only incomplete header fragments need copying.
        if (at === -1 && size !== 0) {
          chunks.push(Buffer.from(part))
          break
        }
        const bytes = chunks.length === 0 ? part : Buffer.concat([...chunks, part], length)
        const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
        if (!isJsonObject(parsed)) throw invalid('resume.sessionFile header is not a JSON object')
        if (!allowTitle || parsed.type !== 'title') return parsed
        allowTitle = false
        chunks.length = 0
        length = 0
        from = end + 1
      } while (from < size)
    }
  } catch (err) {
    if (err instanceof HarnessError) throw err
    throw invalid(`resume.sessionFile ${JSON.stringify(file)} has no readable JSON header: ${describeError(err)}`)
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
 * Pre-spawn identity check for a Claude transcript (`<sessionId>.jsonl`): the
 * native records name the session (`sessionId` / `session_id`) and `cwd`; the
 * first of each, found within a bounded prefix, must match the reference. A
 * file naming no session, or another one, is rejected, so `resume` can never
 * silently open a different or fresh transcript.
 */
function verifyClaudeTranscript(reference: SessionReference, sessionFile: string): void {
  let fd: number
  try {
    fd = openSync(sessionFile, 'r')
  } catch (err) {
    throw invalid(`resume.sessionFile ${JSON.stringify(sessionFile)} is not readable: ${describeError(err)}`)
  }
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const chunk = Buffer.allocUnsafe(65_536)
  const partial: Buffer[] = []
  let scanned = 0
  let identified = false
  const record = (line: Buffer): void => {
    if (line.length === 0) return
    let parsed: unknown
    try {
      const text = decoder.decode(line)
      if (text.trim() === '') return
      parsed = JSON.parse(text)
    } catch (err) {
      throw invalid(`resume.sessionFile ${JSON.stringify(sessionFile)} is not Claude JSONL: ${describeError(err)}`)
    }
    if (!isJsonObject(parsed)) throw invalid(`resume.sessionFile ${JSON.stringify(sessionFile)} contains a non-object record`)
    const id = 'sessionId' in parsed ? parsed.sessionId : parsed.session_id
    if (id !== undefined && id !== null && id !== reference.sessionId) {
      throw invalid(`resume.sessionFile ${JSON.stringify(sessionFile)} belongs to session ${JSON.stringify(id)}, not ${JSON.stringify(reference.sessionId)}`)
    }
    if (parsed.cwd !== undefined && parsed.cwd !== null
      && (typeof parsed.cwd !== 'string' || !samePath(parsed.cwd, reference.workdir))) {
      throw invalid(`resume.sessionFile ${JSON.stringify(sessionFile)} was recorded in ${JSON.stringify(parsed.cwd)}, not ${JSON.stringify(reference.workdir)}`)
    }
    identified = id === reference.sessionId && typeof parsed.cwd === 'string'
  }
  try {
    // Bounded by bytes consumed, partial lines included: identity sits in the first records of every Claude transcript.
    while (scanned < MAX_FRAME_BYTES) {
      const size = readSync(fd, chunk, 0, Math.min(chunk.length, MAX_FRAME_BYTES - scanned), null)
      if (size === 0) break
      let from = 0
      while (from < size) {
        const at = chunk.subarray(0, size).indexOf(LF, from)
        if (at === -1) {
          partial.push(Buffer.from(chunk.subarray(from, size)))
          scanned += size - from
          break
        }
        let line = chunk.subarray(from, at)
        if (partial.length > 0) {
          partial.push(line)
          line = Buffer.concat(partial)
          partial.length = 0
        }
        if (line.length > 0 && line[line.length - 1] === CR) line = line.subarray(0, line.length - 1)
        scanned += at + 1 - from
        record(line)
        if (identified) return
        from = at + 1
      }
    }
  } catch (err) {
    if (err instanceof HarnessError) throw err
    throw invalid(`resume.sessionFile ${JSON.stringify(sessionFile)} could not be read: ${describeError(err)}`)
  } finally {
    closeSync(fd)
  }
  throw invalid(`resume.sessionFile ${JSON.stringify(sessionFile)} names no Claude session identity (sessionId and cwd) within its first ${MAX_FRAME_BYTES} bytes`)
}

/** Bounded stderr prefix: keeps the first `cap` raw bytes decoded incrementally, counts everything. */
class BoundedCapture {
  readonly #decoder = new StringDecoder('utf8')
  readonly #cap: number
  #text = ''
  #kept = 0
  bytes = 0

  constructor(cap: number) {
    this.#cap = cap
  }

  push(chunk: Buffer): void {
    this.bytes += chunk.length
    const room = this.#cap - this.#kept
    if (room <= 0) return
    const slice = chunk.length > room ? chunk.subarray(0, room) : chunk
    this.#kept += slice.length
    this.#text += this.#decoder.write(slice)
  }

  get text(): string {
    return this.#text
  }

  get truncated(): boolean {
    return this.bytes > this.#cap
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

interface LeaderExit {
  code: number | null
  signal: NodeJS.Signals | null
}

interface AbortState {
  acked: boolean
  confirmed: boolean
  /** Explicit native refusal of the interrupt (claude-code): `interrupt()` rejects with it instead of pretending the abort took. */
  refused: string | null
  acknowledgement: Promise<void> | null
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
  /** The exact native Claude `result` message delivered by `sdk_settled` (claude-code only). */
  result: JsonObject | null = null
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
 * `pi`/`omp`; HTTP connections and the event stream for `opencode`) are owned
 * until `close()` (or an internal failure) tears them down. Turns are
 * sequential: the next `startTurn` after a settled result is a follow-up in
 * the same native session. There is no callback API; consume `turn.events` /
 * `events`.
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
    if (spec.ampSdk !== null) {
      // Lazy by contract: the Node SDK worker transport is only loaded when an Amp session is selected.
      const { AmpSession } = await import('./amp.js')
      return AmpSession.launch(spec)
    }
    return ProcessSession.launch(spec)
  }

  /** Native identity; available once `openSession` resolved. On `claude-code` the ID is selected explicitly at open (`--session-id`), and `sessionFile` fills in once a native hook observed the transcript. */
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
   * Answer an outstanding native permission request of this session.
   * `opencode` and `claude-code` support it (`getSessionCapabilities(...).approval`);
   * the request must have been observed as a `permission.asked` (opencode)
   * or `claude_permission` (claude-code) event of the selected session and
   * still be unanswered.
   */
  abstract respondApproval(requestId: string, response: OpenCodeApprovalResponse): Promise<void>

  /** Idempotent, concurrent-safe teardown of everything this handle owns. Cleanup failures are rethrown. */
  abstract close(): Promise<void>
}

/** Pi RPC, the OMP SDK bridge and the Claude SDK worker: one owned child process per session. Constructed only through `LiveSession.open`. */
class ProcessSession extends LiveSession {
  readonly #prepared: PreparedCommand
  readonly #child: ChildProcess
  readonly #pid: number | null
  readonly #stderr: BoundedCapture
  readonly #sessionQueue: EventQueue
  readonly #pending = new Map<string, PendingRequest>()
  readonly #partial: Buffer[] = []
  #partialBytes = 0
  #prelude: { frame: JsonObject; requestId: string | null; bytes: number }[] = []
  #preludeBytes = 0
  #reference: SessionReference | null = null
  /** Bridge-local `claude_permission` IDs observed and not yet answered or cancelled (claude-code only). */
  readonly #pendingApprovals = new Set<string>()
  #requestSeq = 0
  #turnSeq = 0
  #active: ProcessTurn | null = null
  #writes: Promise<void> = Promise.resolve()
  #leader: LeaderExit | null = null
  #stdoutClosed = false
  #stderrClosed = false
  #ending = false
  #dead = false
  #teardown: Promise<void> | null = null
  #cleanupError: unknown = null
  #onLeaderKnown: (() => void)[] = []
  #onStdioClosed: (() => void)[] = []

  private constructor(spec: ResolvedSessionSpec, prepared: PreparedCommand, child: ChildProcess) {
    super(spec)
    this.#prepared = prepared
    this.#child = child
    this.#pid = child.pid ?? null
    this.#stderr = new BoundedCapture(spec.maxBufferBytes)
    this.#sessionQueue = new EventQueue(spec.maxBufferBytes, () => {
      void this.#invalidate('protocol-error', `unconsumed session events exceeded maxBufferBytes (${spec.maxBufferBytes})`)
    })
    child.stdin?.on('error', () => {}) // EPIPE surfaces through stdout EOF / leader exit, not as a write failure
    child.stdout?.on('data', (chunk: Buffer) => this.#onStdout(chunk))
    child.stderr?.on('data', (chunk: Buffer) => this.#stderr.push(chunk))
    const stdoutDone = (): void => this.#onStdoutEnd()
    child.stdout?.once('end', stdoutDone)
    child.stdout?.once('close', stdoutDone)
    const stderrDone = (): void => {
      this.#stderrClosed = true
      this.#notifyStdio()
    }
    child.stderr?.once('end', stderrDone)
    child.stderr?.once('close', stderrDone)
    child.once('exit', (code, signal) => this.#onExit({ code, signal }))
    child.once('error', (err) => {
      if (this.#dead) return
      const name = leaderName(this.spec)
      void this.#invalidate('disconnected', this.#pid === null ? `${name} could not be launched: ${describeError(err)}` : `${name} process error: ${describeError(err)}`)
    })
  }

  /** Verify any resume target, take the workdir lease, spawn the leader and complete the `get_state` handshake. */
  static async launch(spec: ResolvedSessionSpec): Promise<LiveSession> {
    const executable = spec.executable
    if (executable === null) throw invalid(`harness "${spec.harness}" resolved without a leader executable`)
    assertSupportedPlatform()
    const resume = spec.resume
    if (resume !== null && resume.sessionFile !== null) {
      if (spec.claudeSdk === null) verifySessionHeader(resume, resume.sessionFile, spec.backend)
      else verifyClaudeTranscript(resume, resume.sessionFile)
    }
    const args: string[] = []
    // Explicit layering, never a parent mutation: inherited env, then the caller's entries, then the session-owned ones.
    const layered: Record<string, string> = { ...spec.env }
    if (spec.ompSdk !== null) {
      const worker = ompSdkWorkerPath()
      if (!existsSync(worker)) throw new HarnessError(`OMP SDK bridge worker is missing at ${worker}`, 'launch-failed')
      const { packageRoot, agentDir, auth } = spec.ompSdk
      args.push(...BUN_ARGS, worker, JSON.stringify({ packageRoot, agentDir, auth, cwd: spec.workdir, model: spec.model, resume }))
      Object.assign(layered, ompSdkEnv(spec.ompSdk))
    } else if (spec.claudeSdk !== null) {
      const worker = claudeSdkWorkerPath()
      if (!existsSync(worker)) throw new HarnessError(`Claude SDK worker is missing at ${worker}`, 'launch-failed')
      const { packageRoot, cliPath, configDir, settingSources, settingsFile } = spec.claudeSdk
      // Only Bun understands `--no-env-file`; Node (the default runtime) never loads a `.env` on its own.
      if (basename(executable).replace(/\.exe$/, '') === 'bun') args.push(...BUN_ARGS)
      args.push(worker, JSON.stringify({
        packageRoot, cliPath, configDir, settingSources, settingsFile: settingsFile ?? null, cwd: spec.workdir, model: spec.model, resume,
      }))
      layered.CLAUDE_CONFIG_DIR = configDir
    } else {
      args.push(...PI_ARGS)
      if (spec.model !== null) args.push('--model', spec.model)
      if (resume !== null && resume.sessionFile !== null) args.push('--session', resume.sessionFile)
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
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) env[key] = value
    }
    Object.assign(env, layered)
    let child: ChildProcess
    try {
      child = spawn(executable, args, {
        cwd: spec.workdir,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
      })
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
   * on rpc, the worker's `sdk_settled` on sdk). On `pi`/`omp` the result
   * reports `interrupted` only when the harness confirmed the abort; on
   * `claude-code` the native `result` decides (`terminal_reason`), and an
   * interrupt the SDK refused (no native receipt, still-queued work) rejects
   * with `adapter-error` while the turn runs on.
   */
  async interrupt(): Promise<void> {
    if (this.#dead) throw new HarnessError('session is closed', 'session-closed')
    const turn = this.#active
    if (turn === null) throw new HarnessError('no active turn to interrupt', 'unsupported-capability')
    let abort = turn.abort
    if (abort === null) {
      const state: AbortState = { acked: false, confirmed: false, refused: null, acknowledgement: null }
      abort = state
      turn.abort = state
      state.acknowledgement = this.#request('abort', {}).then(
        (frame) => {
          state.acked = true
          state.confirmed = frame.success === true
          if (!state.confirmed && this.spec.claudeSdk !== null) {
            state.refused = typeof frame.error === 'string' && frame.error !== '' ? frame.error : 'the Claude SDK refused the interrupt'
          }
          this.#maybeComplete(turn)
        },
        () => {},
      )
    }
    if (this.spec.claudeSdk !== null && abort.acknowledgement !== null) await abort.acknowledgement
    if (abort.refused !== null) throw new HarnessError(`interrupt of ${turn.id} was refused: ${abort.refused}`, 'adapter-error')
    await turn.promise
  }

  /**
   * Answer an outstanding `claude_permission` request (claude-code only) with
   * `once` (native allow with the original input) or `reject` (native deny
   * with a fixed message). The request must have been observed as an event of
   * this session and be neither answered nor cancelled; the worker validates
   * it again before resolving the native `canUseTool` callback. Pi RPC and the
   * OMP SDK bridge expose no native permission replies.
   */
  async respondApproval(requestId: string, response: OpenCodeApprovalResponse): Promise<void> {
    if (this.spec.claudeSdk === null) {
      throw new HarnessError(`${this.spec.harness} live sessions cannot answer permission requests; only "opencode" and "claude-code" support respondApproval`, 'unsupported-capability')
    }
    const reply: unknown = response
    if (reply === 'always') {
      throw new HarnessError('permission reply "always" is unsupported: it would store a permission rule beyond this session', 'unsupported-capability')
    }
    if (reply !== 'once' && reply !== 'reject') throw invalid(`response must be "once" or "reject", got ${JSON.stringify(reply)}`)
    if (typeof requestId !== 'string' || requestId === '') throw invalid('requestId must be the bridge approval ID of an observed claude_permission event')
    if (this.#dead) throw new HarnessError('session is closed', 'session-closed')
    if (!this.#pendingApprovals.has(requestId)) {
      throw invalid(`no outstanding permission request ${JSON.stringify(requestId)} was observed for session ${this.reference.sessionId}`)
    }
    this.#pendingApprovals.delete(requestId)
    const frame = await this.#request('approval', { approvalId: requestId, response: reply })
    if (frame.success !== true) {
      throw invalid(`permission request ${JSON.stringify(requestId)} could not be answered: ${typeof frame.error === 'string' ? frame.error : 'worker refused'}`)
    }
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
      this.#write(`${JSON.stringify({ id, type: command, ...payload })}\n`)
    })
  }

  /** Serialized, backpressured stdin writes; a write failure is a disconnect. */
  #write(line: string): void {
    this.#writes = this.#writes.then(async () => {
      if (this.#dead) return
      const stdin = this.#child.stdin
      if (stdin === null || stdin.destroyed || stdin.writableEnded) {
        throw new Error('stdin is closed')
      }
      if (!stdin.write(line, 'utf8')) {
        await new Promise<void>((done) => {
          const finish = (): void => {
            stdin.off('drain', finish)
            stdin.off('close', finish)
            stdin.off('error', finish)
            done()
          }
          stdin.on('drain', finish)
          stdin.on('close', finish)
          stdin.on('error', finish)
        })
      }
    }).catch((err: unknown) => {
      void this.#invalidate('disconnected', `stdin write failed: ${describeError(err)}`)
    })
  }

  // ---- stdout framing ----

  #onStdout(chunk: Buffer): void {
    if (this.#dead) return
    let from = 0
    while (from < chunk.length) {
      const at = chunk.indexOf(LF, from)
      if (at === -1) {
        const rest = chunk.subarray(from)
        this.#partial.push(rest)
        this.#partialBytes += rest.length
        if (this.#partialBytes > MAX_FRAME_BYTES) {
          void this.#invalidate('protocol-error', `stdout frame exceeds ${MAX_FRAME_BYTES} bytes`)
        }
        return
      }
      let line = chunk.subarray(from, at)
      if (this.#partial.length > 0) {
        this.#partial.push(line)
        line = Buffer.concat(this.#partial)
        this.#partial.length = 0
        this.#partialBytes = 0
      }
      from = at + 1
      this.#onLine(line)
      if (this.#dead) return
    }
  }

  #onLine(bytes: Buffer): void {
    if (bytes.length > 0 && bytes[bytes.length - 1] === CR) bytes = bytes.subarray(0, bytes.length - 1)
    if (bytes.length === 0) return
    if (bytes.length > MAX_FRAME_BYTES) {
      void this.#invalidate('protocol-error', `stdout frame exceeds ${MAX_FRAME_BYTES} bytes`)
      return
    }
    let frame: unknown
    try {
      frame = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    } catch (err) {
      void this.#invalidate('protocol-error', `stdout frame is not strict UTF-8 JSON: ${describeError(err)}`)
      return
    }
    if (!isJsonObject(frame)) {
      void this.#invalidate('protocol-error', 'stdout frame is not a JSON object')
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
    if (this.spec.claudeSdk !== null && typeof frame.id === 'string') {
      if (frame.type === 'claude_permission') this.#pendingApprovals.add(frame.id)
      else if (frame.type === 'claude_permission_cancelled') this.#pendingApprovals.delete(frame.id)
    }
    this.#route(frame, typeof frame.id === 'string' ? frame.id : null, bytes)
    if (turn !== null && settles) this.#maybeComplete(turn)
  }

  /**
   * Frames from an SDK worker other than responses: `sdk_event` unwraps to
   * the exact native event and goes through event routing; `sdk_settled` is
   * the worker's authoritative turn completion (carrying the exact native
   * `result` on claude-code) and is never exposed as an event. The Claude
   * worker additionally reports the persisted transcript (`sdk_reference`)
   * and fatal native failures (`sdk_failure`). Anything else is a protocol
   * violation.
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
    const claude = this.spec.claudeSdk !== null
    if (claude && frame.type === 'sdk_reference') {
      this.#onReference(frame)
      return
    }
    if (claude && frame.type === 'sdk_failure') {
      const { status, error, raw } = frame
      if (typeof error !== 'string' || error === '') {
        void this.#invalidate('protocol-error', 'sdk_failure frame has no non-empty "error"')
      } else if (raw !== undefined && !isJsonObject(raw)) {
        void this.#invalidate('protocol-error', 'sdk_failure frame "raw" is not an object')
      } else if (status === 'protocol-error' || status === 'disconnected' || status === 'exited' || status === 'signaled') {
        void this.#invalidate(status, error, frame)
      } else {
        void this.#invalidate('protocol-error', `sdk_failure frame has unknown status ${JSON.stringify(status)}`)
      }
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
    const result = frame.result
    if (claude && result !== undefined) {
      if (!isJsonObject(result) || result.type !== 'result') {
        void this.#invalidate('protocol-error', 'sdk_settled "result" is not a native Claude result message')
        return
      }
      if (result.session_id !== this.#reference?.sessionId) {
        void this.#invalidate('protocol-error', `sdk_settled result belongs to session ${JSON.stringify(result.session_id)}, not ${JSON.stringify(this.#reference?.sessionId)}`)
        return
      }
    }
    const turn = this.#active
    if (turn === null || turn.done) {
      // OMP: an idle settle mirrors an idle agent_settled. Claude: exactly one result per prompt, so a stray settle is a violation.
      if (claude) void this.#invalidate('protocol-error', 'sdk_settled arrived without an active turn')
      return
    }
    if (claude && typeof error !== 'string' && result === undefined) {
      void this.#invalidate('protocol-error', 'sdk_settled carries neither a native result nor an error')
      return
    }
    turn.settled = true
    if (typeof error === 'string') turn.failure = frame
    else if (isJsonObject(result)) turn.result = result
    this.#maybeComplete(turn)
  }

  /** The Claude worker observed the persisted transcript through a native hook: same selected ID and workdir, the file is adopted. */
  #onReference(frame: JsonObject): void {
    const reference = this.#reference
    const { sessionId, sessionFile, workdir } = frame
    if (reference === null) {
      void this.#invalidate('protocol-error', 'sdk_reference arrived before the session identity')
    } else if (sessionId !== reference.sessionId) {
      void this.#invalidate('protocol-error', `sdk_reference names session ${JSON.stringify(sessionId)}, not ${JSON.stringify(reference.sessionId)}`)
    } else if (typeof workdir !== 'string' || !samePath(workdir, this.spec.workdir)) {
      void this.#invalidate('protocol-error', `sdk_reference names workdir ${JSON.stringify(workdir)}, not ${JSON.stringify(this.spec.workdir)}`)
    } else if (typeof sessionFile !== 'string' || !isAbsolute(sessionFile) || sessionFile.includes('\0')) {
      void this.#invalidate('protocol-error', 'sdk_reference has no absolute sessionFile')
    } else if (reference.sessionFile !== null && !samePath(reference.sessionFile, sessionFile)) {
      void this.#invalidate('protocol-error', `sdk_reference moved the transcript from ${JSON.stringify(reference.sessionFile)} to ${JSON.stringify(sessionFile)}`)
    } else {
      this.#reference = Object.freeze({ sessionId: reference.sessionId, sessionFile, workdir: reference.workdir })
    }
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
    if (this.spec.claudeSdk !== null && typeof frame.session_id === 'string' && frame.session_id !== this.#reference.sessionId) {
      void this.#invalidate('protocol-error', `native event ${JSON.stringify(frame.type)} belongs to session ${JSON.stringify(frame.session_id)}, not ${JSON.stringify(this.#reference.sessionId)}`)
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
    if (this.spec.claudeSdk !== null) {
      const result = turn.result
      if (result === null) return
      const reason = result.terminal_reason
      if (reason === 'aborted_streaming' || reason === 'aborted_tools') {
        this.#finishTurn(turn, 'interrupted', result, null)
      } else if (result.is_error === true || result.subtype !== 'success') {
        const text = result.result
        const errors = Array.isArray(result.errors) ? result.errors.filter((entry): entry is string => typeof entry === 'string' && entry !== '') : []
        const message = typeof text === 'string' && text !== '' ? text : errors.length > 0 ? errors.join('; ') : `native result subtype ${JSON.stringify(result.subtype)}`
        this.#finishTurn(turn, 'agent-error', result, message)
      } else {
        this.#finishTurn(turn, 'completed', result, null)
      }
      return
    }
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
    const leader = this.#leader
    turn.settle({
      sessionId: this.#reference?.sessionId ?? '',
      turnId: turn.id,
      status,
      raw,
      error,
      exitCode: leader === null ? null : leader.signal !== null ? -osConstants.signals[leader.signal] : leader.code,
      signal: leader?.signal ?? null,
      stderr: this.#stderr.text,
      stderrBytes: this.#stderr.bytes,
      stderrTruncated: this.#stderr.truncated,
      eventsTruncated: turn.eventsTruncated,
    })
    turn.queue.end()
  }

  // ---- process end classification ----

  #onExit(exit: LeaderExit): void {
    this.#leader = exit
    for (const fn of this.#onLeaderKnown.splice(0)) fn()
    if (!this.#dead) void this.#naturalEnd()
  }

  #onStdoutEnd(): void {
    if (this.#stdoutClosed) return
    this.#stdoutClosed = true
    this.#notifyStdio()
    if (!this.#dead) void this.#naturalEnd()
  }

  #notifyStdio(): void {
    if (this.#stdoutClosed && this.#stderrClosed) for (const fn of this.#onStdioClosed.splice(0)) fn()
  }

  /**
   * The leader exited or stdout hit EOF without us asking. Give the other
   * signal a bounded window (frames still parse meanwhile, so a protocol
   * violation in the tail wins), then classify: an unterminated frame is a
   * protocol error, a reaped leader is `exited`/`signaled`, otherwise the
   * pipe was lost while the leader lives on: `disconnected`.
   */
  async #naturalEnd(): Promise<void> {
    if (this.#ending) return
    this.#ending = true
    await Promise.race([
      new Promise<void>((done) => {
        if (this.#leader !== null && this.#stdoutClosed) done()
        else {
          this.#onLeaderKnown.push(() => this.#stdoutClosed && done())
          this.#onStdioClosed.push(() => this.#leader !== null && done())
        }
      }),
      sleep(GRACE_MS),
    ])
    if (this.#dead) return
    if (this.#stdoutClosed && this.#partialBytes > 0) {
      void this.#invalidate('protocol-error', 'stdout ended inside an unterminated frame')
      return
    }
    const leader = this.#leader
    const name = leaderName(this.spec)
    if (leader === null) {
      void this.#invalidate('disconnected', `${name} closed stdout while still running`)
    } else if (leader.signal !== null) {
      void this.#invalidate('signaled', `${name} was terminated by ${leader.signal}`)
    } else {
      void this.#invalidate('exited', `${name} exited with code ${leader.code ?? -1}`)
    }
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
   * The exit metadata of `SessionTurnResult` always describes the owned
   * leader (worker); a native Claude exit is described by the `sdk_failure`
   * frame passed as `raw`.
   */
  #invalidate(status: SessionTurnStatus, error: string | null, raw: JsonObject | null = null): Promise<void> {
    if (this.#teardown !== null) return this.#teardown
    this.#dead = true
    // Only `openSession` observes these rejections (interrupt awaits the turn result instead).
    const rejectCode: ErrorCode =
      status === 'closed' ? 'session-closed' : status === 'protocol-error' || status === 'timed-out' ? 'protocol-error' : 'launch-failed'
    const excerpt = this.#stderr.text.trim().slice(0, STDERR_EXCERPT)
    const message = `${error ?? 'session closed'}${status !== 'closed' && excerpt !== '' ? `; stderr: ${excerpt}` : ''}`
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer)
      this.#pending.delete(id)
      pending.reject(new HarnessError(message, rejectCode))
    }
    const turn = this.#active
    if (turn !== null) clearTimeout(turn.timer)
    const disposing = this.spec.backend === 'sdk' && this.#pid !== null && this.#leader === null
    this.#teardown = this.#stopGroup().catch((err: unknown) => {
      this.#cleanupError = err
    }).then(() => {
      if (turn !== null) this.#finishTurn(turn, status, raw ?? turn.lastAgentEnd, error)
      this.#sessionQueue.end()
      // A failed reap/termination must not release ownership of live resources.
      if (this.#cleanupError !== null) return
      try {
        cleanupCommand(this.#prepared)
      } catch (err) {
        this.#cleanupError = err
        return
      }
      const leader = this.#leader
      if (!disposing || leader === null) return
      const name = leaderName(this.spec)
      if (leader.signal !== null) {
        this.#cleanupError = new HarnessError(`${name} did not dispose within the teardown budget and was terminated by ${leader.signal}`, 'adapter-error')
      } else if (leader.code !== 0) {
        const tail = this.#stderr.text.trim().slice(0, STDERR_EXCERPT)
        this.#cleanupError = new HarnessError(`${name} failed to dispose (exit code ${leader.code ?? -1})${tail === '' ? '' : `; stderr: ${tail}`}`, 'adapter-error')
      }
    })
    return this.#teardown
  }

  /** stdin EOF, TERM the group, GRACE_MS, KILL, then bounded group/leader/stdio drain before force-closing. */
  async #stopGroup(): Promise<void> {
    const child = this.#child
    try {
      child.stdin?.end()
    } catch {
      // already gone
    }
    if (this.#pid !== null) {
      const pgid = this.#pid
      let alive = signalGroup(pgid, 'SIGTERM')
      if (alive) {
        const graceEnd = performance.now() + GRACE_MS
        while (performance.now() < graceEnd) {
          await sleep(PROBE_MS)
          alive = signalGroup(pgid, 0)
          if (!alive) break
        }
        if (alive) signalGroup(pgid, 'SIGKILL')
      }
    }
    const drainEnd = performance.now() + DRAIN_MS
    while (performance.now() < drainEnd) {
      const groupGone = this.#pid === null || !signalGroup(this.#pid, 0)
      const leaderReaped = this.#leader !== null || this.#pid === null
      if (groupGone && leaderReaped && this.#stdoutClosed && this.#stderrClosed) break
      await sleep(PROBE_MS)
    }
    child.stdout?.destroy()
    child.stderr?.destroy()
    child.stdin?.destroy()
    child.unref()
    if (this.#pid !== null && this.#leader === null) {
      throw new HarnessError(`${leaderName(this.spec)} process ${this.#pid} was not reaped within the teardown budget`, 'adapter-error')
    }
  }
}

/**
 * Validate the spec and open the native session. For `pi`/`omp`/`claude-code`:
 * verify any resume target, take the workdir lease (projecting `instructions`
 * into AGENTS.md / CLAUDE.md), spawn the leader (`pi --mode rpc`, `bun`
 * running the OMP SDK bridge worker, or the JavaScript runtime running the
 * Claude SDK worker, which qualifies the SDK/CLI versions and selects the
 * native session ID) and complete the `get_state` handshake; rejects with
 * the lease released and the process group stopped when any step fails. For
 * `amp`: take the lease, run one finite `open` worker that creates the thread
 * (or verifies the resume target through the SDK) and adopt its identity;
 * rejects with the worker's process group stopped and the lease released.
 * For `opencode`: qualify the caller-owned server (health/version, directory,
 * session identity) and subscribe to its event stream; rejects with every
 * owned connection closed, never touching the server itself.
 */
export async function openSession(spec: SessionSpec): Promise<LiveSession> {
  return LiveSession.open(spec)
}
