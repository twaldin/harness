// Live sessions: single-consumer bounded event iterators, serial turns and an
// owned transport per session. `LiveSession` is the public abstract handle;
// the process implementation below owns one child per session with strict
// JSONL framing on stdout and correlated requests on stdin, shared by four
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
// - `cline` on `sdk`: an owned Node child running the shared worker
//   `_cline_sdk.mjs`, which loads the caller-installed @cline/sdk 0.0.82
//   against an explicit builtin-only profile. Same request framing plus
//   `approval`; native `CoreSessionEvent`s arrive as `sdk_event`, a turn
//   completes on `{type:'sdk_settled', result}` carrying the exact native
//   `AgentResult`, and every native command is delegated back to this
//   process (`shell_request` / `shell_cancel`), which owns the command
//   process groups through the shared subprocess runner and answers with
//   `shell_output` / `shell_result`.
//
// Ownership mirrors the one-shot engine in lifecycle.ts through the shared
// `OwnedChild` (owned-process.ts): the child leads a fresh POSIX process
// group, teardown is TERM → GRACE_MS → KILL → bounded DRAIN_MS reap/drain,
// and the workdir lease (with any projected AGENTS.md) is held until the tree
// is gone. Any transport or protocol violation invalidates the handle and
// triggers that same bounded teardown.
//
// Four more backends share the spec validation, `EventQueue`, `TurnCore` and
// result shapes declared here and are loaded lazily:
//
// - `opencode` on `rpc`: direct HTTP + SSE against a caller-owned server
//   (opencode.ts), never a child process.
// - `amp` on `sdk`: one finite Node worker (`_amp_sdk.mjs`, loading the
//   caller-installed @ampcode/sdk) per operation through the subprocess runner.
// - `factory-droid` on `sdk`: the caller-installed @factory/droid-sdk public
//   `DroidClient` driving one owned `droid exec` child (factory-droid-sdk.ts).
// - `openhands` on `rpc`: direct HTTP + WebSocket against a caller-owned
//   Agent Server (openhands.ts, with the optional `ws` peer). Session-only:
//   `getAdapter('openhands')` stays unknown-harness.
import type { ChildProcess } from 'node:child_process'
import { closeSync, existsSync, mkdtempSync, openSync, readSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Backend, ErrorCode, OutputStream, PermissionPolicy, SubprocOutcome } from './base.js'
import { HarnessError } from './base.js'
import { cleanupCommand, prepareCommand } from './instructions.js'
import type { PreparedCommand } from './instructions.js'
import { DRAIN_MS, GRACE_MS, assertSupportedPlatform, describeError, prepareLaunch, runLifecycle } from './lifecycle.js'
import { MAX_FRAME_BYTES, OwnedChild, inheritedEnv, spawnGroupLeader } from './owned-process.js'
import type { OwnedChildFailure } from './owned-process.js'
import { getAdapter } from './registry.js'

export { MAX_FRAME_BYTES }

/** `rpc`: Pi and caller-owned OpenCode/OpenHands servers. `sdk`: OMP, Claude, Amp, Cline and Factory Droid through their qualified local runtimes. Other pairings (including `cli`) reject. */
export type SessionBackend = 'rpc' | 'sdk'

/** The harnesses with a live session backend. `openhands` has no CLI adapter. */
type SessionHarness = 'pi' | 'omp' | 'opencode' | 'claude-code' | 'amp' | 'cline' | 'factory-droid' | 'openhands'

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

/** Native Cline feature selection; only the explicit builtin-only profile is qualified. */
export type ClineFeatures = 'builtin-only'

/** How native tool approvals are answered. */
export type ClineApproval = 'upstream' | 'callback'

/**
 * Selection of the caller-installed Cline local SDK (@cline/sdk 0.0.82 with
 * its @cline/core / @cline/shared transitives, resolved by the worker).
 * Nothing is discovered or defaulted: the package, the Cline root and the
 * native provider are explicit, and `features` names the one profile this
 * integration qualified. `builtin-only` is not a silently accepted default:
 * it selects the native builtin tools and explicitly excludes hooks,
 * plugins, rules, skills, workflows, MCP servers, subagents, teams,
 * checkpoints, custom runtime hooks and command detachment, none of which
 * this session owns.
 */
export interface ClineSdkOptions {
  /** Absolute path to the caller-installed `@cline/sdk` package directory (loaded by the worker, never by this process). */
  packageRoot: string
  /** Absolute caller-selected Cline root: the worker pins `CLINE_DIR` to it and every native data root under its `data` subdirectory. */
  configDir: string
  /** Native provider ID, passed through verbatim (trimmed); the worker takes the model from that provider's stored profile when `model` is omitted. */
  provider: string
  /** Must be `builtin-only`; any other selection is `unsupported-capability`. */
  features: ClineFeatures
  /** `upstream` (default) leaves the SDK's native auto-approval defaults intact; `callback` sets the native `*` policy to `autoApprove: false` and routes every request through `respondApproval`. */
  approval?: ClineApproval
}

/** `ClineSdkOptions` after validation; `approval` carries its resolved default. */
export interface ResolvedClineSdkOptions extends ClineSdkOptions {
  readonly approval: ClineApproval
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

/** Native permission replies this session forwards (`opencode` and `claude-code`). `always` is refused: upstream stores it as a rule beyond the session. */
export type OpenCodeApprovalResponse = 'once' | 'reject'

/**
 * Selection of a caller-owned OpenHands Agent Server (pinned 1.45.0).
 * Nothing is discovered or provisioned: endpoint, credential and the
 * server-side agent profile are explicit, and the server is never started,
 * configured, initialized or disposed by the session.
 */
export interface OpenHandsOptions {
  /** Absolute `http(s)://host[:port]` origin, optional trailing slash; credentials, path, query and fragment are rejected. */
  endpoint: string
  /** Session API key sent as `X-Session-API-Key` (REST) and as the first `auth` frame (WebSocket); never in URLs or diagnostics. Required and non-empty. */
  apiKey: string
  /** Exact name of the caller-selected server-side agent profile (`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`); resolved through GET /api/agent-profiles/{name}, never listed or seeded. */
  agentProfile: string
  /**
   * Must be exactly `true`: the caller attests that the supplied server has no
   * unwanted webhooks or callbacks configured. The pinned server attaches its
   * server-level webhooks to every conversation, and this session neither
   * verifies nor disables them; the attestation is a caller precondition, not
   * a network check.
   */
  confirmNoUnwantedCallbacks: boolean
}

/** A parsed JSON object frame; array and scalar frames are protocol errors. */
export type JsonObject = Record<string, unknown>

/** Identity of a native session: the full native ID plus the file it persists to (or the server it lives on). */
export interface SessionReference {
  /** Full native session ID; never a prefix. The canonical lowercase conversation UUID on `openhands`. */
  sessionId: string
  /** Absolute session file; null on server sessions and until Claude's native hook reports its transcript. Factory uses its verified persisted `.factory/sessions/<encoded workdir>/<id>.jsonl` under effective `FACTORY_HOME_OVERRIDE` / `HOME`. */
  sessionFile: string | null
  /** Absolute working directory the session was opened in; the literal server-side directory on `opencode` and `openhands`. */
  workdir: string
  /** Normalized server origin on `opencode` and `openhands`; absent for process sessions, which reject a reference that carries one. */
  endpoint?: string
}

export interface SessionSpec {
  harness: string
  /** Local absolute directory for process sessions; literal absolute POSIX directory on OpenCode/OpenHands servers (never resolved or created locally). */
  workdir: string
  /** Required; `rpc` for Pi/OpenCode/OpenHands, `sdk` for OMP/Claude/Amp/Cline/Factory Droid. */
  backend: SessionBackend
  /** Native trimmed selector; passed to the OMP or Cline SDK worker on `sdk`; Cline falls back to the selected provider profile's stored model (which the worker requires to exist). Factory sends `modelId` for new sessions only; OpenCode requires provider/model. Amp rejects this (ampSdk.mode routes models). OpenHands requires the exact model declared by the selected profile. Omission otherwise preserves native selection. */
  model?: string
  /** Overlay on inherited process env, never mutated. OMP/Claude profile variables and Amp's AMP_SKIP_UPDATE_CHECK are protected; AMP_URL selects Amp's endpoint. Cline protects its session-owned roots and mode variables, refuses every other `CLINE_*_DIR` / `CLINE_*_PATH` override (the worker drops them before importing the SDK) and owns `TMPDIR` (one temporary directory per session). Factory requires a nonempty FACTORY_API_KEY and protects SDK attribution. Must be empty on server sessions. */
  env?: Record<string, string>
  /** Bare name or absolute path: Pi/Droid CLI, Bun OMP worker, Node Amp or Cline worker, or Claude worker's JavaScript runtime (default process.execPath; Bun gets --no-env-file). Rejected on server sessions. */
  executable?: string
  /** Only `upstream` is supported; `bypass` is rejected. */
  permissionPolicy?: PermissionPolicy
  /** Projected into `AGENTS.md` for the session's lifetime. Rejected on server sessions (no local workdir). */
  instructions?: string
  /** Exact native ID plus sessionFile; OpenCode/OpenHands/Amp instead require null sessionFile and matching endpoint. Factory preserves saved model/autonomy, rejecting model and factoryDroid.autonomy overrides on resume. */
  resume?: SessionReference
  /** Wall-clock limit per turn; defaults to 1800. `null` disables it. */
  timeoutSeconds?: number | null
  /** Native round-trip bound, default 30s; includes Factory callbacks and Amp initialization. OpenHands submission through matching socket echo shares one deadline; interruption is also bounded. */
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
  /** Required for harness `cline` (backend `sdk`), rejected otherwise. */
  clineSdk?: ClineSdkOptions
  /** Optional for harness `factory-droid` on `sdk` (omitted = upstream defaults), rejected otherwise. */
  factoryDroid?: FactoryDroidOptions
  /** Required for harness `openhands`, rejected otherwise. */
  openhands?: OpenHandsOptions
}

/** `SessionSpec` after defaults and validation; the read-only snapshot a `LiveSession` exposes. */
export interface ResolvedSessionSpec {
  readonly harness: SessionHarness
  readonly workdir: string
  readonly backend: SessionBackend
  readonly model: string | null
  readonly env: Readonly<Record<string, string>>
  /** Leader binary for process sessions (the worker runtime on `sdk`); null on server sessions. */
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
  /** Frozen copy of the caller's selection for `cline` plus the resolved approval mode; null otherwise. */
  readonly clineSdk: ResolvedClineSdkOptions | null
  /** Frozen native policy for `factory-droid`; null for every other harness. */
  readonly factoryDroid: Readonly<Required<FactoryDroidOptions>> | null
  /** Frozen, endpoint-normalized selection for `openhands`; null otherwise. */
  readonly openhands: Readonly<OpenHandsOptions> | null
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
  /** `openhands` only: native stuck detection stopped the run. */
  | 'stuck'

/** Native events remain untouched in raw: unwrapped SDK events, OpenCode SSE objects, whole OpenHands socket envelopes (seq retained), or Factory inner notifications / whole request-response envelopes. Unknown event types remain visible. */
export interface SessionEvent {
  backend: SessionBackend
  harness: SessionHarness
  sessionId: string
  /** Null for frames that arrived while no turn was active, and on `opencode` for message frames of the selected session that do not belong to the active turn's lineage. */
  turnId: string | null
  /** Native correlation ID (stringified on Factory), OpenCode message/permission ID, or OpenHands inner event ID; always null on Amp. */
  requestId: string | null
  /** Native type; Factory uses inner notification type or request/response; OpenHands uses inner event kind for durable/transient frames and envelope type otherwise. */
  type: string
  raw: JsonObject
}

export interface SessionTurnResult {
  sessionId: string
  turnId: string
  status: SessionTurnStatus
  /** Native terminal/failure payload: agent_end, rejected prompt, sdk_settled, Amp result, Factory agent_turn_completed/request rejection, OpenCode prompt response/failing HTTP body, or OpenHands {state, terminal_event}/{http_status, body}. */
  raw: JsonObject | null
  error: string | null
  /** Leader exit code once reaped, else null. Signaled exits report `-signum`. On `amp` the native CLI's exit as observed by the worker (the worker's own exit only when it failed before reporting). Always null on server sessions (no process is observed). */
  exitCode: number | null
  signal: string | null
  /** Bounded prefix of the session's stderr so far; on `amp` the stderr of this turn's own worker; empty with `stderrBytes` 0 on server sessions. */
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
/** Characters of stderr quoted in handshake failure messages. */
export const STDERR_EXCERPT = 512
const LF = 0x0a
const CR = 0x0d
const UTF8 = new TextDecoder('utf-8', { fatal: true })
const FACTORY_AUTONOMY: readonly FactoryDroidAutonomy[] = ['off', 'low', 'medium', 'high']
/** Native OpenCode session IDs: the server validates the prefix only, so the rest is merely required to be safe alphanumerics. */
const OPENCODE_SESSION_ID = /^ses_[0-9A-Za-z]+$/
/** Canonical lowercase hyphenated UUID: what this client generates and what the pinned server echoes for conversation IDs. */
export const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
/** `PROFILE_NAME_PATTERN` of the pinned SDK (llm_profile_store.py), shared by the LLM and agent profile routes. */
export const OPENHANDS_PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
/** Any ASCII control character (including DEL); rejected in every server option that ends up on the wire. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/
/** A header-safe credential: printable ASCII without whitespace. */
const PRINTABLE_TOKEN = /^[\u0021-\u007e]+$/
/** Full native Amp thread IDs (`T-` plus a lowercase UUID); never a prefix. */
export const AMP_THREAD_ID = /^T-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const AMP_DEFAULT_ENDPOINT = 'https://ampcode.com'
const AMP_EFFORTS: readonly string[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const AMP_VISIBILITIES: readonly string[] = ['private', 'unlisted', 'workspace', 'group']
/** Native Cline bash-tool wall clock, reproduced by this process as the owning executor. */
const CLINE_COMMAND_TIMEOUT_SECONDS = 30
/** Per stream, matching the native tool's own bound; what the worker receives is that bounded prefix. */
const CLINE_COMMAND_MAX_OUTPUT_BYTES = 48_000
/** Native command requests that may be in flight at once; beyond it the worker is violating the protocol. */
const CLINE_MAX_ACTIVE_COMMANDS = 32
/** Bound on the owned command groups' teardown; the runner's own TERM → GRACE → KILL → DRAIN budget plus slack for the final result write. */
const CLINE_COMMAND_TEARDOWN_MS = GRACE_MS + DRAIN_MS + 1_000

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

/**
 * Owned child environment for the Cline worker and for every command this
 * session runs on its behalf: the same native roots and modes the worker
 * pins before importing the SDK, so a command can never write outside the
 * selected profile. `TMPDIR` is added per session from the owned temporary
 * directory.
 */
function clineSdkEnv(options: Readonly<ClineSdkOptions>): Readonly<Record<string, string>> {
  const data = join(options.configDir, 'data')
  return {
    CLINE_DIR: options.configDir,
    CLINE_DATA_DIR: data,
    CLINE_SESSION_DATA_DIR: join(data, 'sessions'),
    CLINE_DB_DATA_DIR: join(data, 'db'),
    CLINE_SESSION_BACKEND_MODE: 'local',
    CLINE_NO_AUTO_UPDATE: '1',
    CLINE_RUN_AS_HUB_DAEMON: '0',
  }
}

/** A native argv from the worker: NUL-free strings only; null when the frame is malformed. */
function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  const entries: readonly unknown[] = value
  const argv: string[] = []
  for (const entry of entries) {
    if (typeof entry !== 'string' || entry.includes('\0')) return null
    argv.push(entry)
  }
  return argv
}

/**
 * What the native tool receives as the command's output: the captured
 * stdout prefix, then a marked stderr section when there is one. This
 * process is the owning executor, so a bound it enforced is stated in the
 * output instead of silently shortening it.
 */
function commandOutput(outcome: Required<SubprocOutcome>): string {
  const stdout = outcome.stdout + (outcome.stdoutTruncated ? `\n[stdout truncated at ${CLINE_COMMAND_MAX_OUTPUT_BYTES} bytes]` : '')
  if (outcome.stderr === '' && !outcome.stderrTruncated) return stdout
  return `${stdout}\n[stderr]\n${outcome.stderr}${outcome.stderrTruncated ? `\n[stderr truncated at ${CLINE_COMMAND_MAX_OUTPUT_BYTES} bytes]` : ''}`
}

/** Anything but a clean exit 0 is a native tool error; the captured output still travels with it, never as a silent success. */
function commandError(outcome: Required<SubprocOutcome>): string | null {
  switch (outcome.termination) {
    case 'exited':
      if (outcome.exitCode !== 0) return `command exited with code ${outcome.exitCode}`
      break
    case 'signaled':
      return `command was terminated by ${outcome.signal ?? 'a signal'}`
    case 'timed-out':
      return `command exceeded the ${CLINE_COMMAND_TIMEOUT_SECONDS}s timeout`
    case 'cancelled':
      return 'command was cancelled'
    case 'launch-failed':
      return `command could not be launched (${outcome.launchError ?? 'unknown error'})`
    default:
      return outcome.callbackError ?? `command ended with termination ${JSON.stringify(outcome.termination)}`
  }
  return outcome.callbackError
}

/** Which backend each session harness is qualified on; anything else is `unsupported-backend`. */
const SESSION_BACKENDS: Readonly<Record<SessionHarness, SessionBackend>> = { pi: 'rpc', omp: 'sdk', opencode: 'rpc', 'claude-code': 'sdk', amp: 'sdk', cline: 'sdk', 'factory-droid': 'sdk', openhands: 'rpc' }

function isSessionHarness(name: string): name is SessionHarness {
  return name === 'pi' || name === 'omp' || name === 'opencode' || name === 'claude-code' || name === 'amp' || name === 'cline' || name === 'factory-droid' || name === 'openhands'
}

/** Resolve the harness first, then validate the backend before rejecting an unsupported pairing. `openhands` is session-only: it never goes through the adapter registry. */
function requireSessionHarness(name: unknown, backend: unknown): { harness: SessionHarness; backend: SessionBackend } {
  if (typeof name !== 'string') throw invalid('harness must be a string')
  const resolved = name === 'openhands' ? name : getAdapter(name).name
  if (backend !== 'cli' && backend !== 'rpc' && backend !== 'sdk') {
    throw invalid(`Unknown backend: ${JSON.stringify(backend)}. Expected one of: cli, rpc, sdk`)
  }
  if (!isSessionHarness(resolved)) {
    throw new HarnessError(`Harness "${name}" has no live session backend; only "pi" (rpc), "opencode" (rpc), "openhands" (rpc), "omp" (sdk), "claude-code" (sdk), "amp" (sdk), "cline" (sdk) and "factory-droid" (sdk) are supported`, 'unsupported-backend')
  }
  const qualified = SESSION_BACKENDS[resolved]
  if (backend !== qualified) {
    throw new HarnessError(`Live sessions for "${resolved}" are only implemented on backend "${qualified}", not "${backend}"`, 'unsupported-backend')
  }
  return { harness: resolved, backend: qualified }
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
    approval: resolved.harness === 'opencode' || resolved.harness === 'claude-code' || resolved.harness === 'cline',
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

/** Validate the caller's Cline SDK selection; every field is explicit, nothing is probed on disk (the worker qualifies the runtime and the package versions). */
function resolveClineSdk(raw: unknown): ResolvedClineSdkOptions {
  if (!isJsonObject(raw)) throw invalid('clineSdk must be a ClineSdkOptions object')
  const unsupported = Object.keys(raw).find((key) => !['packageRoot', 'configDir', 'provider', 'features', 'approval'].includes(key))
  if (unsupported !== undefined) throw invalid(`clineSdk contains an unsupported option ${JSON.stringify(unsupported)}`)
  const { packageRoot, configDir, provider, features, approval } = raw
  if (typeof packageRoot !== 'string' || !isAbsolute(packageRoot) || packageRoot.includes('\0')) {
    throw invalid('clineSdk.packageRoot must be the absolute path of the installed @cline/sdk package')
  }
  if (typeof configDir !== 'string' || !isAbsolute(configDir) || configDir.includes('\0')) {
    throw invalid('clineSdk.configDir must be the absolute path of the caller-selected Cline root')
  }
  if (typeof provider !== 'string' || provider.trim() === '' || provider.includes('\0')) {
    throw invalid('clineSdk.provider must be a non-blank native provider ID')
  }
  if (features !== 'builtin-only') {
    throw new HarnessError(
      `clineSdk.features must be "builtin-only", got ${JSON.stringify(features)}: native hooks, plugins, rules, skills, workflows, MCP servers, subagents, teams, checkpoints and detached commands are not owned by this session`,
      'unsupported-capability',
    )
  }
  if (approval !== undefined && approval !== 'upstream' && approval !== 'callback') {
    throw invalid(`clineSdk.approval must be "upstream" or "callback", got ${JSON.stringify(approval)}`)
  }
  return Object.freeze({ packageRoot, configDir, provider: provider.trim(), features: 'builtin-only', approval: approval ?? 'upstream' })
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
 * Normalize a native endpoint (an OpenCode or OpenHands server, or `AMP_URL`)
 * to its origin (`scheme://host[:port]`, lower case, default port dropped).
 * Only an absolute http(s) origin with at most a trailing slash is accepted:
 * no credentials, path, query, fragment, whitespace or control characters.
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
  if (url.username !== '' || url.password !== '') throw invalid(`${field} must not embed credentials`)
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
 * Validate the caller's OpenHands server selection. The endpoint is
 * normalized, the API key is kept verbatim and never echoed, the profile name
 * must already satisfy the server's own pattern, and the callback attestation
 * must be an explicit `true`.
 */
function resolveOpenHands(raw: unknown): Readonly<OpenHandsOptions> {
  if (!isJsonObject(raw)) throw invalid('openhands must be an OpenHandsOptions object')
  if (Object.keys(raw).some((key) => !['endpoint', 'apiKey', 'agentProfile', 'confirmNoUnwantedCallbacks'].includes(key))) {
    throw invalid('openhands contains an unsupported option')
  }
  const { apiKey, agentProfile, confirmNoUnwantedCallbacks } = raw
  const endpoint = normalizeEndpoint(raw.endpoint, 'openhands.endpoint')
  if (typeof apiKey !== 'string' || !PRINTABLE_TOKEN.test(apiKey)) {
    throw invalid('openhands.apiKey must be a non-empty printable ASCII token without whitespace')
  }
  if (typeof agentProfile !== 'string' || !OPENHANDS_PROFILE_NAME.test(agentProfile)) {
    throw invalid('openhands.agentProfile must be an exact server-side agent profile name matching ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')
  }
  if (confirmNoUnwantedCallbacks !== true) {
    throw invalid('openhands.confirmNoUnwantedCallbacks must be exactly true: the caller attests that the server has no unwanted webhooks or callbacks configured; this session neither verifies nor disables server-side callbacks')
  }
  return Object.freeze({ endpoint, apiKey, agentProfile, confirmNoUnwantedCallbacks: true })
}

/**
 * The literal server-side directory a server session runs in: absolute
 * POSIX, canonical (no empty, `.` or `..` segments, no trailing slash except
 * for the root itself). Nothing is resolved or checked locally.
 */
function requireServerWorkdir(raw: string, harness: SessionHarness): string {
  if (!raw.startsWith('/')) throw invalid(`workdir ${JSON.stringify(raw)} must be an absolute POSIX path on the ${harness} server`)
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

/** Resume target for a server session: the full native ID on the same normalized endpoint and literal workdir, with no session file. Verified against the server in `open`. */
function resolveServerReference(raw: unknown, workdir: string, endpoint: string, harness: 'opencode' | 'openhands'): SessionReference {
  if (!isJsonObject(raw)) throw invalid('resume must be a SessionReference object')
  const { sessionId, sessionFile, workdir: refWorkdir, endpoint: refEndpoint } = raw
  if (harness === 'opencode') {
    if (typeof sessionId !== 'string' || !OPENCODE_SESSION_ID.test(sessionId)) {
      throw invalid('resume.sessionId must be the full native OpenCode session ID (ses_ followed by alphanumerics)')
    }
  } else if (typeof sessionId !== 'string' || !CANONICAL_UUID.test(sessionId)) {
    throw invalid('resume.sessionId must be the full canonical lowercase conversation UUID of the OpenHands conversation')
  }
  if (sessionFile !== null) throw invalid(`resume.sessionFile must be null for ${harness} sessions; they live on the server, not in a local file`)
  if (refWorkdir !== workdir) {
    throw invalid(`resume.workdir ${JSON.stringify(refWorkdir)} does not match the session workdir ${JSON.stringify(workdir)}`)
  }
  if (refEndpoint === undefined) throw invalid(`resume.endpoint is required for ${harness} sessions`)
  const normalized = normalizeEndpoint(refEndpoint, 'resume.endpoint')
  if (normalized !== endpoint) {
    throw invalid(`resume.endpoint ${JSON.stringify(normalized)} does not match ${harness}.endpoint ${JSON.stringify(endpoint)}`)
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
  const rawClineSdk: unknown = spec.clineSdk
  let clineSdk: ResolvedClineSdkOptions | null = null
  if (harness === 'cline') {
    if (rawClineSdk === undefined) {
      throw invalid('clineSdk is required for harness "cline" on backend "sdk": packageRoot, configDir, provider and features are never guessed')
    }
    clineSdk = resolveClineSdk(rawClineSdk)
  } else if (rawClineSdk !== undefined) {
    throw invalid('clineSdk is only accepted for harness "cline" on backend "sdk"')
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
  const rawFactoryDroid: unknown = spec.factoryDroid
  let factoryDroid: Readonly<Required<FactoryDroidOptions>> | null = null
  if (harness === 'factory-droid') factoryDroid = resolveFactoryDroid(rawFactoryDroid)
  else if (rawFactoryDroid !== undefined) throw invalid('factoryDroid is only accepted for harness "factory-droid" on backend "sdk"')
  const rawOpenHands: unknown = spec.openhands
  let openhands: Readonly<OpenHandsOptions> | null = null
  if (harness === 'openhands') {
    if (rawOpenHands === undefined) throw invalid('openhands is required for harness "openhands": endpoint, apiKey, agentProfile and the callback attestation are never guessed')
    openhands = resolveOpenHands(rawOpenHands)
  } else if (rawOpenHands !== undefined) {
    throw invalid('openhands is only accepted for harness "openhands"')
  }
  /** Server sessions have no local process, workdir lease or environment. */
  const remote = opencode !== null || openhands !== null
  const rawWorkdir: unknown = spec.workdir
  if (typeof rawWorkdir !== 'string' || rawWorkdir === '' || rawWorkdir.includes('\0')) {
    throw invalid('workdir must be a non-empty string without NUL bytes')
  }
  const workdir = remote ? requireServerWorkdir(rawWorkdir, harness) : resolve(rawWorkdir)

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
  if (openhands !== null && model === null) {
    throw invalid('model is required for openhands: the exact native model the selected profile\'s LLM profile declares (no normalization or fallback)')
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
  if (remote && Object.keys(env).length > 0) {
    throw invalid(`env is not supported for ${harness}: the server process is caller-owned and its environment cannot be changed per session`)
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
  if (clineSdk !== null) {
    const owned = clineSdkEnv(clineSdk)
    for (const [key, value] of Object.entries(owned)) {
      const explicit = env[key]
      if (explicit !== undefined && explicit !== value) {
        throw invalid(`env.${key} ${JSON.stringify(explicit)} conflicts with the session-owned value ${JSON.stringify(value)} derived from clineSdk.configDir`)
      }
    }
    for (const key of Object.keys(env)) {
      // The worker deletes every other native path override before importing the SDK: honoring one here would be a silent lie.
      if (key.startsWith('CLINE_') && (key.endsWith('_DIR') || key.endsWith('_PATH')) && owned[key] === undefined) {
        throw new HarnessError(`env.${key} is an unsupported Cline storage override: every native path stays inside clineSdk.configDir`, 'unsupported-capability')
      }
    }
    if (env.TMPDIR !== undefined) {
      throw invalid('env.TMPDIR is not supported for cline: the session owns one temporary directory per session and pins TMPDIR to it')
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

  let executable: string | null =
    claudeSdk !== null ? process.execPath : harness === 'omp' ? 'bun' : harness === 'amp' || harness === 'cline' ? 'node' : harness === 'factory-droid' ? 'droid' : 'pi'
  const rawExecutable: unknown = spec.executable
  if (remote) {
    if (rawExecutable !== undefined) throw invalid(`executable is not supported for ${harness}: no local process is launched`)
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
  if (rawInstructions !== undefined && remote) {
    throw invalid(`instructions are not supported for ${harness}: the session has no local workdir to project AGENTS.md into`)
  }
  if (rawInstructions !== undefined && claudeSdk !== null && !claudeSdk.settingSources.includes('project')) {
    throw invalid('instructions require claudeSdk.settingSources to include "project": Claude Code only reads the projected CLAUDE.md from that source')
  }

  let resume: SessionReference | null = null
  if (spec.resume !== undefined) {
    if (opencode !== null) resume = resolveServerReference(spec.resume, workdir, opencode.endpoint, 'opencode')
    else if (openhands !== null) resume = resolveServerReference(spec.resume, workdir, openhands.endpoint, 'openhands')
    else if (ampSdk !== null) resume = resolveAmpReference(spec.resume, workdir, ampSdk.endpoint)
    else resume = resolveReference(spec.resume, workdir)
    if (claudeSdk !== null && !CLAUDE_SESSION_ID.test(resume.sessionId)) {
      throw invalid(`resume.sessionId ${JSON.stringify(resume.sessionId)} is not a native Claude session UUID`)
    }
  }
  if (ampSdk !== null && resume !== null && ampSdk.visibility !== undefined) {
    throw invalid('ampSdk.visibility only applies when a thread is created; it cannot be combined with resume')
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
    ampSdk,
    opencode,
    claudeSdk,
    clineSdk,
    factoryDroid,
    openhands,
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

/**
 * The Cline SDK worker: `src/harness/_cline_sdk.mjs` next to the Python
 * package when running from source (`sessions.ts`), the build-time copy
 * `cline-sdk.mjs` beside the bundle otherwise. Resolved by path only; the
 * optional SDK is loaded by the worker, never imported here.
 */
function clineSdkWorkerPath(): string {
  const source = basename(fileURLToPath(import.meta.url)) === 'sessions.ts'
  return fileURLToPath(new URL(source ? '../../src/harness/_cline_sdk.mjs' : './cline-sdk.mjs', import.meta.url))
}

/**
 * Drop a session-owned temporary directory after a failed setup: the launch
 * error is what the caller must see, and the directory sits under the system
 * temporary root. A live session removes it through the reported cleanup
 * path instead, and keeps it when that cleanup fails.
 */
function discardTempDir(dir: string | null): void {
  if (dir === null) return
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // the launch failure is the reported error
  }
}

/** What the leader process is called in diagnostics. */
function leaderName(spec: ResolvedSessionSpec): string {
  if (spec.claudeSdk !== null) return 'the Claude SDK worker'
  if (spec.clineSdk !== null) return 'the Cline SDK worker'
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
 * process backends; HTTP connections and event streams/sockets for
 * OpenCode/OpenHands) are owned until close or failure tears them down.
 * Turns are sequential; follow-up retains native identity. Consume
 * turn.events / events; native Factory onPermission/onQuestion are the
 * only callbacks, not an event-delivery API.
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
      // Optional SDK loading must remain isolated from ordinary CLI imports.
      const { FactoryDroidSession } = await import('./factory-droid-sdk.js')
      return FactoryDroidSession.launch(spec)
    }
    if (spec.openhands !== null) {
      // Lazy: the optional ws peer is only loaded for OpenHands.
      const { OpenHandsSession } = await import('./openhands.js')
      return OpenHandsSession.connect(spec)
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
   * `opencode`, `claude-code` and `cline` support it (`getSessionCapabilities(...).approval`);
   * the request must have been observed as a `permission.asked` (opencode),
   * `claude_permission` (claude-code) or `cline_permission` (cline with
   * `clineSdk.approval` set to `callback`) event of the selected session and
   * still be unanswered. Factory answers through onPermission/onQuestion.
   * OpenHands refuses: native waiting_for_confirmation fails the turn.
   */
  abstract respondApproval(requestId: string, response: OpenCodeApprovalResponse): Promise<void>

  /** Idempotent, concurrent-safe teardown of everything this handle owns. Cleanup failures are rethrown. */
  abstract close(): Promise<void>
}

/** One owned command group serving a native `shell_request`. */
interface CommandJob {
  readonly cancel: AbortController
  /** Settles once the group is gone and its result was queued; assigned right after registration, so teardown always finds it. */
  done: Promise<void>
  failure: unknown
}

/** Pi RPC, the OMP SDK bridge, the Claude SDK worker and the Cline SDK worker: one owned child process per session. Constructed only through `LiveSession.open`. */
class ProcessSession extends LiveSession {
  readonly #prepared: PreparedCommand
  readonly #child: OwnedChild
  readonly #sessionQueue: EventQueue
  readonly #pending = new Map<string, PendingRequest>()
  #prelude: { frame: JsonObject; requestId: string | null; bytes: number }[] = []
  #preludeBytes = 0
  #reference: SessionReference | null = null
  /** Worker-local permission IDs observed and not yet answered or cancelled (`claude_permission` on claude-code, `cline_permission` on cline). */
  readonly #pendingApprovals = new Set<string>()
  /** Unique temporary directory this session owns (cline only): pinned as `TMPDIR` for the worker and every command, removed once every owned group is gone. */
  readonly #tempDir: string | null
  /** Environment every owned command inherits: the session-owned Cline roots, modes and `TMPDIR`, exactly what the worker pins for itself. */
  readonly #commandEnv: Readonly<Record<string, string>>
  /** Live command groups by native request ID; their cancel and completion handles are kept independently of the stdout reader. */
  readonly #commands = new Map<string, CommandJob>()
  /** Worker-owned monotonic IDs detect replay without accumulating session-long history. */
  #commandSeq = 0
  #requestSeq = 0
  #turnSeq = 0
  #active: ProcessTurn | null = null
  #dead = false
  #teardown: Promise<void> | null = null
  #cleanupError: unknown = null

  private constructor(spec: ResolvedSessionSpec, prepared: PreparedCommand, child: ChildProcess, tempDir: string | null) {
    super(spec)
    this.#prepared = prepared
    this.#tempDir = tempDir
    this.#commandEnv = spec.clineSdk === null || tempDir === null ? {} : Object.freeze({ ...spec.env, ...clineSdkEnv(spec.clineSdk), TMPDIR: tempDir })
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
    if (resume !== null && resume.sessionFile !== null) {
      // Cline: the worker verifies the native manifest's ID, cwd and expected path before starting; there is no Pi/OMP JSONL header here.
      if (spec.claudeSdk !== null) verifyClaudeTranscript(resume, resume.sessionFile)
      else if (spec.clineSdk === null) verifySessionHeader(resume, resume.sessionFile, spec.backend)
    }
    const args: string[] = []
    // Explicit layering, never a parent mutation: inherited env, then the caller's entries, then the session-owned ones.
    const layered: Record<string, string> = { ...spec.env }
    let tempDir: string | null = null
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
    } else if (spec.clineSdk !== null) {
      const worker = clineSdkWorkerPath()
      if (!existsSync(worker)) throw new HarnessError(`Cline SDK worker is missing at ${worker}`, 'launch-failed')
      const { packageRoot, configDir, provider, features, approval } = spec.clineSdk
      // Owned and unique per session: the native detached-log recovery must never see another session's temporary files.
      try {
        tempDir = mkdtempSync(join(tmpdir(), 'harness-cline-'))
      } catch (err) {
        throw new HarnessError(`the Cline session temporary directory could not be created: ${describeError(err)}`, 'launch-failed')
      }
      // `instructions` is a flag, not content: the lease already projected CLINE.md, and the worker adds the native file mention to each prompt.
      args.push(worker, JSON.stringify({
        packageRoot, configDir, provider, features, approval, cwd: spec.workdir, model: spec.model, resume, tempDir,
        instructions: spec.instructions !== null,
      }))
      Object.assign(layered, clineSdkEnv(spec.clineSdk), { TMPDIR: tempDir })
    } else {
      args.push(...PI_ARGS)
      if (spec.model !== null) args.push('--model', spec.model)
      if (resume !== null && resume.sessionFile !== null) args.push('--session', resume.sessionFile)
    }
    const adapter = getAdapter(spec.harness)
    let prepared: PreparedCommand
    try {
      prepared = prepareCommand({
        cmd: executable,
        args,
        cwd: spec.workdir,
        env: layered,
        instructionsFile: join(spec.workdir, adapter.instructionsFilename),
        ...(spec.instructions === null ? {} : { instructionContent: spec.instructions }),
      })
    } catch (err) {
      discardTempDir(tempDir)
      throw err
    }
    let child: ChildProcess
    try {
      child = spawnGroupLeader(executable, args, spec.workdir, inheritedEnv(layered))
    } catch (err) {
      cleanupCommand(prepared)
      discardTempDir(tempDir)
      throw new HarnessError(`${leaderName(spec)} could not be launched: ${describeError(err)}`, 'launch-failed')
    }
    const session = new ProcessSession(spec, prepared, child, tempDir)
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
    if (this.spec.clineSdk !== null) {
      // The native manifest path is the session file, and the worker must have started in the requested workdir.
      if (typeof sessionFile !== 'string') return 'get_state returned no native Cline manifest path'
      const workdir = data.workdir
      if (typeof workdir !== 'string' || !samePath(workdir, this.spec.workdir)) {
        return `get_state reports workdir ${JSON.stringify(workdir)}, not the requested ${JSON.stringify(this.spec.workdir)}`
      }
    }
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
   * Answer an outstanding native permission request with `once` (native
   * allow with the original input) or `reject` (native deny with a fixed
   * message). Supported on `claude-code` (`claude_permission`) and on
   * `cline` with `clineSdk.approval` set to `callback` (`cline_permission`):
   * the request must have been observed as an event of this session and be
   * neither answered nor cancelled, and the worker validates it again before
   * resolving the native callback. Pi RPC, the OMP SDK bridge and a Cline
   * session left on upstream approvals expose no native permission replies.
   */
  async respondApproval(requestId: string, response: OpenCodeApprovalResponse): Promise<void> {
    const cline = this.spec.clineSdk
    if (this.spec.claudeSdk === null && cline === null) {
      throw new HarnessError(`${this.spec.harness} live sessions cannot answer permission requests; only "opencode", "claude-code" and "cline" support respondApproval`, 'unsupported-capability')
    }
    if (cline !== null && cline.approval !== 'callback') {
      throw new HarnessError('clineSdk.approval is "upstream": native approvals stay with the SDK, so this session never receives a request to answer', 'unsupported-capability')
    }
    const reply: unknown = response
    if (reply === 'always') {
      throw new HarnessError('permission reply "always" is unsupported: it would store a permission rule beyond this session', 'unsupported-capability')
    }
    if (reply !== 'once' && reply !== 'reject') throw invalid(`response must be "once" or "reject", got ${JSON.stringify(reply)}`)
    if (typeof requestId !== 'string' || requestId === '') throw invalid('requestId must be the worker approval ID of an observed permission event')
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
    if (typeof frame.id === 'string') {
      if (this.spec.claudeSdk !== null) {
        if (frame.type === 'claude_permission') this.#pendingApprovals.add(frame.id)
        else if (frame.type === 'claude_permission_cancelled') this.#pendingApprovals.delete(frame.id)
      } else if (this.spec.clineSdk !== null) {
        if (frame.type === 'cline_permission') this.#pendingApprovals.add(frame.id)
        else if (frame.type === 'cline_permission_cancelled') this.#pendingApprovals.delete(frame.id)
      }
    }
    this.#route(frame, typeof frame.id === 'string' ? frame.id : null, bytes)
    if (turn !== null && settles) this.#maybeComplete(turn)
  }

  /**
   * Frames from an SDK worker other than responses: `sdk_event` unwraps to
   * the exact native event and goes through event routing; `sdk_settled` is
   * the worker's authoritative turn completion (carrying the exact native
   * `result` on claude-code and cline) and is never exposed as an event. The
   * Claude worker additionally reports the persisted transcript
   * (`sdk_reference`), and either SDK worker may report a fatal native
   * failure (`sdk_failure`). The Cline worker delegates its native commands
   * back here (`shell_request` / `shell_cancel`), which are not
   * request/response frames. Anything else is a protocol violation.
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
    const cline = this.spec.clineSdk !== null
    if (cline && (frame.type === 'shell_request' || frame.type === 'shell_cancel')) {
      this.#onShellFrame(frame)
      return
    }
    if (claude && frame.type === 'sdk_reference') {
      this.#onReference(frame)
      return
    }
    if ((claude || cline) && frame.type === 'sdk_failure') {
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
    // The native Cline AgentResult is opaque: it carries no discriminating `type`, and its `finishReason` alone decides the turn.
    if (cline && result !== undefined && !isJsonObject(result)) {
      void this.#invalidate('protocol-error', 'sdk_settled "result" is not a native Cline AgentResult object')
      return
    }
    const turn = this.#active
    if (turn === null || turn.done) {
      // OMP: an idle settle mirrors an idle agent_settled. Claude and Cline: exactly one settlement per prompt, so a stray one is a violation.
      if (claude || cline) void this.#invalidate('protocol-error', 'sdk_settled arrived without an active turn')
      return
    }
    if ((claude || cline) && typeof error !== 'string' && result === undefined) {
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
    if (this.spec.clineSdk !== null) {
      const result = turn.result
      if (result === null) return
      const reason = result.finishReason
      if (reason === 'completed') {
        this.#finishTurn(turn, 'completed', result, null)
      } else if (reason === 'aborted') {
        this.#finishTurn(turn, 'interrupted', result, null)
      } else if (reason === 'max_iterations' || reason === 'mistake_limit' || reason === 'error') {
        this.#finishTurn(turn, 'agent-error', result, `native run finished with reason ${reason}`)
      } else {
        // The native reason set is qualified; an unknown one is a protocol violation, never a guessed status.
        void this.#invalidate('protocol-error', `sdk_settled result has unknown finishReason ${JSON.stringify(reason)}`, result)
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
   * The exit metadata of `SessionTurnResult` always describes the owned
   * leader (worker); a native Claude exit is described by the `sdk_failure`
   * frame passed as `raw`.
   *
   * On `cline` the owned command groups are cancelled and awaited here as
   * well, alongside the worker group and before the turn settles, so no
   * command outlives the session that asked for it. A command group that
   * will not stop keeps the lease and the owned temporary directory and is
   * reported as a cleanup failure, never as a clean disposal.
   */
  #invalidate(status: SessionTurnStatus, error: string | null, raw: JsonObject | null = null): Promise<void> {
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
    this.#teardown = this.#stopAll().catch((err: unknown) => {
      this.#cleanupError = err
    }).then(() => {
      if (turn !== null) this.#finishTurn(turn, status, raw ?? turn.lastAgentEnd, error)
      this.#sessionQueue.end()
      // A failed reap/termination, of the worker group or of an owned command group, must not release ownership of live resources.
      if (this.#cleanupError !== null) return
      try {
        cleanupCommand(this.#prepared)
        // Last: the temporary directory belongs to this process and outlives every owned group.
        if (this.#tempDir !== null) rmSync(this.#tempDir, { recursive: true, force: true })
      } catch (err) {
        this.#cleanupError = err
        return
      }
      const leader = child.leader
      if (!disposing || leader === null) return
      const name = leaderName(this.spec)
      if (leader.signal !== null) {
        this.#cleanupError = new HarnessError(`${name} did not dispose within the teardown budget and was terminated by ${leader.signal}`, 'adapter-error')
      } else if (leader.code !== 0) {
        const tail = child.stderr.text.trim().slice(0, STDERR_EXCERPT)
        this.#cleanupError = new HarnessError(`${name} failed to dispose (exit code ${leader.code ?? -1})${tail === '' ? '' : `; stderr: ${tail}`}`, 'adapter-error')
      }
    })
    return this.#teardown
  }

  /** Stop the worker group and every owned command group concurrently; both are awaited, and the first failure is raised once they settled. */
  async #stopAll(): Promise<void> {
    const failures: unknown[] = []
    const commands = this.#stopCommands().catch((err: unknown) => { failures.push(err) })
    const group = this.#child.stopGroup().catch((err: unknown) => { failures.push(err) })
    await commands
    await group
    if (failures.length > 0) throw failures[0]
  }

  /**
   * Cancel every owned command group and await its bounded teardown. No new
   * command is accepted from here on (`#dead` is already set), and a group
   * that outlasts the runner's own TERM → KILL → drain budget is a cleanup
   * failure: the caller keeps the lease and the temporary directory.
   */
  async #stopCommands(): Promise<void> {
    const jobs = [...this.#commands.values()]
    if (jobs.length === 0) return
    for (const job of jobs) job.cancel.abort()
    const stopped = Promise.allSettled(jobs.map((job) => job.done)).then(() => true)
    let timer: NodeJS.Timeout | undefined
    const budget = new Promise<false>((done) => { timer = setTimeout(() => done(false), CLINE_COMMAND_TEARDOWN_MS) })
    const complete = await Promise.race([stopped, budget]).finally(() => clearTimeout(timer))
    if (!complete) {
      throw new HarnessError(`${this.#commands.size} owned command process group(s) did not stop within ${CLINE_COMMAND_TEARDOWN_MS}ms`, 'adapter-error')
    }
    const failed = jobs.find((job) => job.failure !== null)
    if (failed) throw new HarnessError(`owned command cleanup could not be proved: ${describeError(failed.failure)}`, 'adapter-error')
  }

  // ---- owned command execution (cline) ----

  /**
   * The Cline worker asked this process to run a native command, or to
   * cancel one. The harness owns every command process group: the worker
   * resolved the argv through the native shell helpers and never spawns
   * anything itself, so `cmd` is executed verbatim and never interpolated
   * into a shell.
   */
  #onShellFrame(frame: JsonObject): void {
    const id = frame.id
    if (typeof id !== 'string' || id === '') {
      void this.#invalidate('protocol-error', `${JSON.stringify(frame.type)} frame has no non-empty string "id"`)
      return
    }
    if (frame.type === 'shell_cancel') {
      // Idempotent by contract: a command that already finished, or whose result is in flight, has nothing left to cancel.
      this.#commands.get(id)?.cancel.abort()
      return
    }
    const turn = this.#active
    if (turn === null || turn.done) {
      void this.#invalidate('protocol-error', `shell_request ${JSON.stringify(id)} arrived outside an active turn`)
      return
    }
    const sequence = /^shell-([1-9][0-9]{0,15})$/.exec(id)
    const number = sequence === null ? NaN : Number(sequence[1])
    if (!Number.isSafeInteger(number) || number <= this.#commandSeq) {
      void this.#invalidate('protocol-error', `shell_request has an invalid or reused sequence ${JSON.stringify(id)}`)
      return
    }
    if (this.#commands.size >= CLINE_MAX_ACTIVE_COMMANDS) {
      void this.#invalidate('protocol-error', `more than ${CLINE_MAX_ACTIVE_COMMANDS} native commands are in flight at once`)
      return
    }
    const cmd = stringArray(frame.cmd)
    if (cmd === null || cmd.length === 0 || cmd[0] === '') {
      void this.#invalidate('protocol-error', `shell_request ${JSON.stringify(id)} has no "cmd" argv of NUL-free strings`)
      return
    }
    const cwd = frame.cwd
    if (typeof cwd !== 'string' || !isAbsolute(cwd) || cwd.includes('\0')) {
      void this.#invalidate('protocol-error', `shell_request ${JSON.stringify(id)} has no absolute "cwd"`)
      return
    }
    const stdin = frame.stdin
    if (stdin !== null && typeof stdin !== 'string') {
      void this.#invalidate('protocol-error', `shell_request ${JSON.stringify(id)} has a non-string "stdin"`)
      return
    }
    this.#commandSeq = number
    // Registered before the run starts, so teardown finds the job even if the runner refuses it synchronously.
    const job: CommandJob = { cancel: new AbortController(), done: Promise.resolve(), failure: null }
    this.#commands.set(id, job)
    job.done = this.#runCommand(id, cmd, cwd, stdin, job)
  }

  /**
   * Run one native command on the shared subprocess runner: its own process
   * group, the native bash tool's wall clock and per-stream bound, streamed
   * progress the worker turns into native tool updates, and the runner's
   * bounded teardown on cancellation. An unexpected runner error retains
   * ownership rather than treating unproven cleanup as a native tool error.
   */
  async #runCommand(id: string, cmd: string[], cwd: string, stdin: string | null, job: CommandJob): Promise<void> {
    const cancel = job.cancel.signal
    try {
      const request = prepareLaunch(cmd, {
        cwd,
        timeoutSeconds: CLINE_COMMAND_TIMEOUT_SECONDS,
        maxOutputBytes: CLINE_COMMAND_MAX_OUTPUT_BYTES,
        stdin,
        extraEnv: this.#commandEnv,
        cancel,
      })
      const outcome = await runLifecycle(request, cancel, undefined, (chunk: string, stream: OutputStream) =>
        this.#child.write(`${JSON.stringify({ type: 'shell_output', id, stream, chunk })}\n`))
      const output = commandOutput(outcome)
      const error = commandError(outcome)
      await this.#child.write(`${JSON.stringify(error === null ? { type: 'shell_result', id, output } : { type: 'shell_result', id, output, error })}\n`)
    } catch (err) {
      job.failure = err
      void this.#invalidate('agent-error', `command cleanup could not be proved: ${describeError(err)}`)
    } finally {
      if (job.failure === null) this.#commands.delete(id)
    }
  }
}

/**
 * Validate the spec and open the native session. For `pi`/`omp`/`claude-code`/`cline`:
 * verify any resume target, take the workdir lease (projecting `instructions`
 * into AGENTS.md / CLAUDE.md / CLINE.md), spawn the leader (`pi --mode rpc`,
 * `bun` running the OMP SDK bridge worker, `node` running the Cline SDK
 * worker, which qualifies the runtime and the package versions and verifies
 * the native manifest identity, or the JavaScript runtime running the Claude
 * SDK worker, which qualifies the SDK/CLI versions and selects the native
 * session ID) and complete the `get_state` handshake; rejects with the lease
 * released, the process group stopped and any owned temporary directory
 * removed when any step fails. For `amp`: take the lease, run one finite
 * `open` worker that creates the thread (or verifies the resume target
 * through the SDK) and adopt its identity; rejects with the worker's process
 * group stopped and the lease released. For `factory-droid`: verify the SDK
 * pin and FACTORY_API_KEY, verify any saved resume target, take the lease,
 * spawn droid exec stream-jsonrpc and complete native
 * initialize_session/load_session through the installed SDK. For
 * OpenCode/OpenHands: qualify the caller-owned server (version, profile,
 * directory, identity) and subscribe to its stream/socket; failure closes
 * owned connections without touching the server itself.
 */
export async function openSession(spec: SessionSpec): Promise<LiveSession> {
  return LiveSession.open(spec)
}
