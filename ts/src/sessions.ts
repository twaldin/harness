// Live sessions: one owned child process per session, strict JSONL framing on
// stdout, correlated requests on stdin, and single-consumer bounded event
// iterators. Two backends share the transport and lifecycle:
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
// Ownership mirrors the one-shot engine in lifecycle.ts: the child leads a
// fresh POSIX process group, teardown is TERM → GRACE_MS → KILL → bounded
// DRAIN_MS reap/drain, and the workdir lease (with any projected AGENTS.md)
// is held until the tree is gone. Any transport or protocol violation
// invalidates the handle and triggers that same bounded teardown.
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

/** `rpc` drives `pi`; `sdk` drives `omp` through the owned Bun bridge. Any other pairing (and `cli`) is `unsupported-backend`. */
export type SessionBackend = 'rpc' | 'sdk'

/** The harnesses with a live session backend. */
type SessionHarness = 'pi' | 'omp'

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

/** A parsed JSON object frame; array and scalar frames are protocol errors. */
export type JsonObject = Record<string, unknown>

/** Identity of a native session: the full native ID plus the file it persists to. */
export interface SessionReference {
  /** Full native session ID; never a prefix. */
  sessionId: string
  /** Absolute session file, or null while the native session has not been persisted yet. */
  sessionFile: string | null
  /** Absolute working directory the session was opened in. */
  workdir: string
}

export interface SessionSpec {
  harness: string
  workdir: string
  /** Required; `rpc` for `pi`, `sdk` for `omp`. */
  backend: SessionBackend
  /** Passed through as `--model <trimmed>` (rpc) or to the SDK worker (sdk); absent leaves the model to the harness's own defaults. */
  model?: string
  /** Layered over the inherited process env; never mutated. On `sdk`, entries conflicting with the owned `PI_CODING_AGENT_DIR` / `PI_CONFIG_DIR` are rejected. */
  env?: Record<string, string>
  /** Replaces the `pi` binary (rpc) or the `bun` binary running the bridge worker (sdk): a bare name resolved on PATH or an absolute path. */
  executable?: string
  /** Only `upstream` is supported; `bypass` is rejected. */
  permissionPolicy?: PermissionPolicy
  /** Projected into `AGENTS.md` for the session's lifetime. */
  instructions?: string
  /** Resume an existing native session; needs `sessionFile` and the full `sessionId`. */
  resume?: SessionReference
  /** Wall-clock limit per turn; defaults to 1800. `null` disables it. */
  timeoutSeconds?: number | null
  /** Bound on every native request/response round trip; defaults to 30. */
  requestTimeoutSeconds?: number
  /** Bytes of unconsumed events buffered per turn (and for idle session events); defaults to 1 MiB. Overflow is a protocol error, never a silent drop. */
  maxBufferBytes?: number
  /** Required on `sdk`, rejected on `rpc`. */
  ompSdk?: OmpSdkOptions
}

/** `SessionSpec` after defaults and validation; the read-only snapshot a `LiveSession` exposes. */
interface ResolvedSessionSpec {
  readonly harness: SessionHarness
  readonly workdir: string
  readonly backend: SessionBackend
  readonly model: string | null
  readonly env: Readonly<Record<string, string>>
  readonly executable: string
  readonly permissionPolicy: PermissionPolicy
  readonly instructions: string | null
  readonly resume: SessionReference | null
  readonly timeoutSeconds: number | null
  readonly requestTimeoutSeconds: number
  readonly maxBufferBytes: number
  /** Frozen copy of the caller's selection on `sdk`; null on `rpc`. */
  readonly ompSdk: Readonly<OmpSdkOptions> | null
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

/** One native frame, response frames included. Unknown native event types pass through untouched in `raw`; on `sdk`, `raw` is the exact native SDK event, never the bridge wrapper. */
export interface SessionEvent {
  backend: SessionBackend
  harness: SessionHarness
  sessionId: string
  /** Null for frames that arrived while no turn was active. */
  turnId: string | null
  /** The native `id` correlation field when the frame carries one. */
  requestId: string | null
  /** Native `type` string. */
  type: string
  raw: JsonObject
}

export interface SessionTurnResult {
  sessionId: string
  turnId: string
  status: SessionTurnStatus
  /** Last `agent_end` payload, the failed `prompt` response when the prompt was rejected, or the failing `sdk_settled` bridge frame. */
  raw: JsonObject | null
  error: string | null
  /** Leader exit code once reaped, else null. Signaled exits report `-signum`. */
  exitCode: number | null
  signal: string | null
  /** Bounded prefix of the session's stderr so far. */
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
/** Largest stdout frame accepted (bytes, excluding the delimiter). */
const MAX_FRAME_BYTES = 1_048_576
const PROBE_MS = 20
/** Characters of stderr quoted in handshake failure messages. */
const STDERR_EXCERPT = 512
const LF = 0x0a
const CR = 0x0d

function invalid(message: string): HarnessError {
  return new HarnessError(message, 'invalid-options')
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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
function samePath(a: string, b: string): boolean {
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
const SESSION_BACKENDS: Readonly<Record<SessionHarness, SessionBackend>> = { pi: 'rpc', omp: 'sdk' }

function isSessionHarness(name: string): name is SessionHarness {
  return name === 'pi' || name === 'omp'
}

/** Resolve the harness first, then validate the backend before rejecting an unsupported pairing. */
function requireSessionHarness(name: unknown, backend: unknown): { harness: SessionHarness; backend: SessionBackend } {
  if (typeof name !== 'string') throw invalid('harness must be a string')
  const adapter = getAdapter(name)
  if (backend !== 'cli' && backend !== 'rpc' && backend !== 'sdk') {
    throw invalid(`Unknown backend: ${JSON.stringify(backend)}. Expected one of: cli, rpc, sdk`)
  }
  if (!isSessionHarness(adapter.name)) {
    throw new HarnessError(`Harness "${name}" has no live session backend; only "pi" (rpc) and "omp" (sdk) are supported`, 'unsupported-backend')
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
    approval: false,
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

function resolveReference(raw: unknown, workdir: string): SessionReference {
  if (!isJsonObject(raw)) throw invalid('resume must be a SessionReference object')
  const { sessionId, sessionFile, workdir: refWorkdir } = raw
  if (typeof sessionId !== 'string' || sessionId === '') throw invalid('resume.sessionId must be the full non-empty native session ID')
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

/** Apply defaults and validate. Pure: nothing is touched on disk. */
function resolveSessionSpec(spec: SessionSpec): ResolvedSessionSpec {
  if (!isJsonObject(spec)) throw invalid('spec must be a SessionSpec object')
  const { harness, backend } = requireSessionHarness(spec.harness, spec.backend)
  const rawOmpSdk: unknown = spec.ompSdk
  let ompSdk: Readonly<OmpSdkOptions> | null = null
  if (backend === 'sdk') {
    if (rawOmpSdk === undefined) throw invalid('ompSdk is required on backend "sdk": packageRoot, agentDir and auth are never guessed')
    ompSdk = resolveOmpSdk(rawOmpSdk)
  } else if (rawOmpSdk !== undefined) {
    throw invalid('ompSdk is only accepted for harness "omp" on backend "sdk"')
  }
  const rawWorkdir: unknown = spec.workdir
  if (typeof rawWorkdir !== 'string' || rawWorkdir === '' || rawWorkdir.includes('\0')) {
    throw invalid('workdir must be a non-empty string without NUL bytes')
  }
  const workdir = resolve(rawWorkdir)

  let model: string | null = null
  const rawModel: unknown = spec.model
  if (rawModel !== undefined) {
    if (typeof rawModel !== 'string' || rawModel.includes('\0')) throw invalid('model must be a string without NUL bytes')
    model = rawModel.trim()
    if (model === '') throw invalid('model must not be empty')
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

  let executable = backend === 'sdk' ? 'bun' : 'pi'
  const rawExecutable: unknown = spec.executable
  if (rawExecutable !== undefined) {
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

  const resume = spec.resume === undefined ? null : resolveReference(spec.resume, workdir)

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
  return spec.backend === 'sdk' ? 'the OMP SDK bridge' : 'pi'
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
class EventQueue implements AsyncIterable<SessionEvent> {
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
}

class TurnState {
  readonly id: string
  readonly queue: EventQueue
  readonly promise: Promise<SessionTurnResult>
  readonly settle: (result: SessionTurnResult) => void
  timer: NodeJS.Timeout | undefined
  promptAcked = false
  /** Failed `prompt` response or failing `sdk_settled` frame; the turn ends as `agent-error` once every outstanding ack is in. */
  failure: JsonObject | null = null
  settled = false
  lastAgentEnd: JsonObject | null = null
  /** Last assistant message from the last `agent_end`; earlier retries do not determine the result. */
  lastAssistant: JsonObject | null = null
  abort: AbortState | null = null
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

function lastAssistantMessage(messages: unknown): JsonObject | null {
  if (!Array.isArray(messages)) return null
  for (let i = messages.length - 1; i >= 0; i--) {
    const message: unknown = messages[i]
    if (isJsonObject(message) && message.role === 'assistant') return message
  }
  return null
}

/**
 * An open live session (Pi RPC or the OMP SDK bridge). Obtain one through
 * `openSession`; the process group, workdir lease and projected instructions
 * are owned until `close()` (or an internal failure) tears them down. Turns
 * are sequential: the next `startTurn` after a settled result is a follow-up
 * in the same native session. There is no callback API; consume
 * `turn.events` / `events`.
 */
export class LiveSession {
  readonly spec: ResolvedSessionSpec
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
  #requestSeq = 0
  #turnSeq = 0
  #active: TurnState | null = null
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
    this.spec = spec
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

  /** Open through the same validated contract as `openSession`. */
  static async open(input: SessionSpec): Promise<LiveSession> {
    const spec = resolveSessionSpec(input)
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
      cmd: spec.executable,
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
      child = spawn(spec.executable, args, {
        cwd: spec.workdir,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
      })
    } catch (err) {
      cleanupCommand(prepared)
      throw new HarnessError(`${leaderName(spec)} could not be launched: ${describeError(err)}`, 'launch-failed')
    }
    const session = new LiveSession(spec, prepared, child)
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
   * Reserve the single turn slot and send the prompt. Synchronous: the turn is
   * accepted locally before the write; a native rejection settles it as
   * `agent-error`. Prompts handled entirely by a local Pi extension or input
   * hook may acknowledge without ever settling; the turn deadline reports
   * those as `timed-out` rather than fabricating a completion.
   */
  startTurn(prompt: string): SessionTurn {
    if (typeof prompt !== 'string' || prompt.trim() === '' || prompt.includes('\0')) {
      throw invalid('prompt must be a non-empty string without NUL bytes')
    }
    if (this.#dead) throw new HarnessError('session is closed', 'session-closed')
    if (this.#active !== null) {
      throw new HarnessError('a turn is still active; concurrent turns are unsupported', 'unsupported-capability')
    }
    const id = `turn-${++this.#turnSeq}`
    const turn = new TurnState(id, new EventQueue(this.spec.maxBufferBytes, () => {
      turn.eventsTruncated = true
      void this.#invalidate('protocol-error', `unconsumed events of ${id} exceeded maxBufferBytes (${this.spec.maxBufferBytes})`)
    }))
    this.#active = turn
    if (this.spec.timeoutSeconds !== null) {
      const seconds = this.spec.timeoutSeconds
      turn.timer = setTimeout(() => {
        void this.#invalidate('timed-out', `${id} exceeded timeoutSeconds (${seconds})`)
      }, Math.min(seconds * 1000, 2_147_483_647))
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
      const timer = setTimeout(() => {
        void this.#invalidate('protocol-error', `request ${id} (${command}) was not answered within requestTimeoutSeconds (${seconds})`)
      }, Math.min(seconds * 1000, 2_147_483_647))
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

  #maybeComplete(turn: TurnState): void {
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

  #finishTurn(turn: TurnState, status: SessionTurnStatus, raw: JsonObject | null, error: string | null): void {
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
   */
  #invalidate(status: SessionTurnStatus, error: string | null): Promise<void> {
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
      const leader = this.#leader
      if (!disposing || leader === null) return
      if (leader.signal !== null) {
        this.#cleanupError = new HarnessError(`the OMP SDK bridge did not dispose within the teardown budget and was terminated by ${leader.signal}`, 'adapter-error')
      } else if (leader.code !== 0) {
        const tail = this.#stderr.text.trim().slice(0, STDERR_EXCERPT)
        this.#cleanupError = new HarnessError(`the OMP SDK bridge failed to dispose (exit code ${leader.code ?? -1})${tail === '' ? '' : `; stderr: ${tail}`}`, 'adapter-error')
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
 * Validate the spec, verify any resume target, take the workdir lease
 * (projecting `instructions` into AGENTS.md), spawn the leader (`pi --mode rpc`,
 * or `bun` running the OMP SDK bridge worker) and complete the `get_state`
 * handshake. Rejects with the lease released and the process group stopped
 * when any step fails.
 */
export async function openSession(spec: SessionSpec): Promise<LiveSession> {
  return LiveSession.open(spec)
}
