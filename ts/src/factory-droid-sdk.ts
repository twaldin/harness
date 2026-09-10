// Factory Droid live sessions: the caller-installed @factory/droid-sdk 0.9.1
// public `DroidClient` (node entry) driving exactly one owned
// `droid exec --input-format stream-jsonrpc --output-format stream-jsonrpc`
// child through a Harness-owned local stdio transport. Loaded lazily by
// sessions.ts; the SDK itself is imported here on `launch`, never before, so a
// missing or mismatched SDK is a `launch-failed` before any child exists.
//
// Division of labour (the approved SDK injection seam):
// - The SDK owns the protocol: it builds every JSON-RPC request
//   (`initialize_session` / `load_session` / `add_user_message` /
//   `interrupt_session` / `close_session`), validates the typed responses,
//   dispatches `droid.request_permission` / `droid.ask_user` to the caller's
//   native callbacks and writes the native replies. Nothing here hand-codes a
//   replacement wire client.
// - The session owns the process (`OwnedChild`: fresh process group, strict
//   LF framing within MAX_FRAME_BYTES, TERM → GRACE_MS → KILL → DRAIN_MS
//   teardown) and observes every incoming frame *before* the SDK sees it:
//   strict UTF-8 JSON-object envelopes, response correlation against the
//   request IDs the SDK actually sent, session/turn correlation of
//   notifications, unknown notifications retained verbatim, independent
//   validation of the handshake identity (native session ID, saved
//   `session_start` header, restored cwd) and bounded request / callback
//   deadlines. The SDK's high-level `DroidSession` / stream wrappers are not
//   used: their cwd fallbacks, cumulative-usage fallbacks and dropped unknown
//   notifications are exactly what this seam avoids.
//
// Turn protocol: `startTurn` reserves the local slot synchronously and sends
// `add_user_message` with a fresh UUID `messageId`. A turn settles only once
// (1) the request was acknowledged and (2) the native `agent_turn_completed`
// notification of this session arrived whose `turnId`, when present, equals
// that `messageId`. `completed` → completed; `cancelled` /
// `permission_rejected` → interrupted; every other native reason →
// agent-error with the reason retained; a rejected `add_user_message` →
// agent-error with the native error envelope as `result.raw`. Usage stays raw:
// `tokenUsage` on the terminal notification is per turn, `cumulativeTokenUsage`
// and `session_token_usage_changed` are session totals, `factoryCredits` are
// credits, never USD; nothing is normalized or summed.
//
// Droid CLI 0.213.0 advertises protocol 1.204.0. The published SDK advertises
// an older protocol, so compatibility is gated against the qualified CLI,
// not by requiring the client and server version strings to be identical.
//
// Startup version gates: the handshake response must advertise the qualified
// CLI's `factoryProtocolVersion` 1.204.0 (checked here) and the legacy
// `factoryApiVersion` 1.0.0 the SDK's own envelope schema requires of every
// frame it parses. Either mismatch, and a native error response to
// `initialize_session` / `load_session`, fails the open as `protocol-error`.
import { randomUUID } from 'node:crypto'
import type { ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type * as Sdk from '@factory/droid-sdk/node'
import type { ErrorCode } from './base.js'
import { HarnessError } from './base.js'
import { encodeProjectDir, factorySessionsDir } from './adapters/factory-droid.js'
import { cleanupCommand, prepareCommand } from './instructions.js'
import type { PreparedCommand } from './instructions.js'
import { GRACE_MS, assertSupportedPlatform, describeError } from './lifecycle.js'
import { OwnedChild, inheritedEnv, spawnGroupLeader } from './owned-process.js'
import type { OwnedChildFailure } from './owned-process.js'
import { getAdapter } from './registry.js'
import {
  EventQueue, LiveSession, STDERR_EXCERPT, TurnCore, deadline, decodeFrameText, invalid, isJsonObject, parseFrame, readSessionHeader,
  realpathOrSelf, requirePrompt, samePath,
} from './sessions.js'
import type {
  FactoryDroidCallback, FactoryDroidOptions, JsonObject, ResolvedSessionSpec, SessionEvent, SessionReference, SessionTurn, SessionTurnStatus,
} from './sessions.js'

/** The only SDK release this backend is qualified against; anything else is `launch-failed`. */
const SDK_PIN = '0.9.1'
const CLI_PROTOCOL = '1.204.0'
/** Native attribution the SDK's own transport would set; preserved verbatim on the owned child. */
const UPSTREAM_CLIENT_TYPE = 'sdk'
const DROID_ARGS: readonly string[] = ['exec', '--input-format', 'stream-jsonrpc', '--output-format', 'stream-jsonrpc']
const HANDSHAKE_METHODS: Readonly<Record<string, true | undefined>> = { 'droid.initialize_session': true, 'droid.load_session': true }
const ENVELOPE_TYPES: Readonly<Record<string, true | undefined>> = { request: true, notification: true, response: true }

type SdkModule = typeof Sdk
type CallbackName = 'onPermission' | 'onQuestion'
/** The native `droid.request_permission` / `droid.ask_user` requests as the public handler setters type them (the node entry does not export the event names). */
type PermissionEvent = Parameters<Parameters<Sdk.DroidClient['setPermissionHandler']>[0]>[0]
type QuestionEvent = Parameters<Parameters<Sdk.DroidClient['setAskUserHandler']>[0]>[0]

/** A request the SDK wrote that is still unanswered; the deadline is the session's, not the SDK's. */
interface Outstanding {
  method: string
  /** `params.messageId` of an `add_user_message`, to attribute its response to the turn. */
  messageId: string | null
  timer: NodeJS.Timeout | undefined
}

interface AbortState {
  acked: boolean
  timer: NodeJS.Timeout | undefined
}

class DroidTurn extends TurnCore {
  /** Native `messageId` submitted with `add_user_message`; the terminal notification's `turnId` must name it when present. */
  readonly messageId: string
  promptAcked = false
  /** Failed `add_user_message` response envelope exactly as observed on the wire. */
  rejection: JsonObject | null = null
  /** The native `agent_turn_completed` notification correlated to this turn. */
  terminal: JsonObject | null = null
  abort: AbortState | null = null

  constructor(id: string, queue: EventQueue, messageId: string) {
    super(id, queue)
    this.messageId = messageId
  }
}

/** What the session lends its transport: the owned stdin writer, the group teardown and the liveness view. */
interface TransportHooks {
  send(message: string): Promise<void>
  close(): Promise<void>
  connected(): boolean
}

/**
 * The transport handed to `DroidClient`: a thin, typed seam over the session's
 * owned child. The SDK writes through `send`, reads through the handler it
 * registers with `onMessage`, and its `close()` (reached only through the
 * session's own teardown) is the group teardown itself.
 */
class OwnedStdioTransport implements Sdk.StringFramedDroidClientTransport {
  #onMessage: ((message: string) => void) | null = null
  readonly #hooks: TransportHooks

  constructor(hooks: TransportHooks) {
    this.#hooks = hooks
  }

  send(message: string): Promise<void> {
    return this.#hooks.send(message)
  }

  onMessage(handler: (message: string) => void): void {
    this.#onMessage = handler
  }

  onError(): void {
    // Transport failures reach the SDK as rejected pending requests through the session's `client.close()`; no second error channel.
  }

  close(): Promise<void> {
    return this.#hooks.close()
  }

  get isConnected(): boolean {
    return this.#hooks.connected()
  }

  /** Forward one validated incoming frame to the SDK. */
  deliver(message: string): void {
    this.#onMessage?.(message)
  }
}

/** Where Droid persists `sessionId` opened in `workdir` under the effective env: `<sessions>/<encoded realpath(workdir)>/<id>.jsonl`. */
function nativeSessionFile(sessionsDir: string, workdir: string, sessionId: string): string {
  return join(sessionsDir, encodeProjectDir(realpathOrSelf(workdir)), `${sessionId}.jsonl`)
}

/** The saved native header: exact `session_start` record for `sessionId` recorded in `workdir`. Returns the problem, if any. */
function checkSavedHeader(file: string, sessionId: string, workdir: string): string | null {
  let header: JsonObject
  try {
    header = readSessionHeader(file, false)
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
  if (header.type !== 'session_start') return `session file ${JSON.stringify(file)} header type is ${JSON.stringify(header.type)}, not "session_start"`
  if (header.id !== sessionId) return `session file ${JSON.stringify(file)} belongs to session ${JSON.stringify(header.id)}, not ${JSON.stringify(sessionId)}`
  if (typeof header.cwd !== 'string' || !samePath(header.cwd, workdir)) {
    return `session file ${JSON.stringify(file)} was recorded in ${JSON.stringify(header.cwd)}, not ${JSON.stringify(workdir)}`
  }
  return null
}

/** Native JSON-RPC IDs are strings or numbers; events and correlation use the string form. */
function envelopeId(value: unknown): string | null {
  if (typeof value === 'string' && value !== '') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return null
}

/** Native error text of a failed response envelope (`error.message`), if any. */
function responseError(frame: JsonObject): string | null {
  const error = frame.error
  return isJsonObject(error) && typeof error.message === 'string' ? error.message : null
}

/** One line per schema violation, path first; the SDK's zod issues carry exactly these two fields. */
function issues(list: readonly { path: readonly (string | number)[]; message: string }[]): string {
  return list.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')
}

/**
 * A live Factory Droid session. Constructed only through `LiveSession.open`
 * (via `launch`), which pins the SDK, requires `FACTORY_API_KEY`, verifies any
 * resume target against the saved native file, takes the workdir lease, spawns
 * the CLI and completes the native handshake before returning.
 */
export class FactoryDroidSession extends LiveSession {
  readonly #options: Readonly<Required<FactoryDroidOptions>>
  readonly #prepared: PreparedCommand
  readonly #sdk: SdkModule
  readonly #sessionsDir: string
  readonly #child: OwnedChild
  readonly #transport: OwnedStdioTransport
  readonly #client: Sdk.DroidClient
  readonly #sessionQueue: EventQueue
  /** Requests the SDK sent, by envelope ID, until their response arrives. */
  readonly #outstanding = new Map<string, Outstanding>()
  /** Raw `params` of CLI requests awaiting a callback reply, by envelope ID: callbacks see the native JSON, not the SDK's parsed copy. */
  readonly #nativeRequests = new Map<string, JsonObject>()
  #prelude: { type: string; raw: JsonObject; requestId: string | null; bytes: number }[] = []
  #preludeBytes = 0
  /** The one native sessionId notifications may name before the handshake resolves; verified against the adopted identity before the prelude is flushed. */
  #preludeSessionId: string | null = null
  #reference: SessionReference | null = null
  /** Raw envelope of the handshake response as observed on the wire (its native error text names a rejected handshake). */
  #handshakeResponse: JsonObject | null = null
  #turnSeq = 0
  #active: DroidTurn | null = null
  #dead = false
  #teardown: Promise<void> | null = null
  #cleanupError: unknown = null
  /** The failure that invalidated the session, for `openSession` to rethrow. */
  #failure: HarnessError | null = null

  private constructor(spec: ResolvedSessionSpec, options: Readonly<Required<FactoryDroidOptions>>, prepared: PreparedCommand, child: ChildProcess, sdk: SdkModule, sessionsDir: string) {
    super(spec)
    this.#options = options
    this.#prepared = prepared
    this.#sdk = sdk
    this.#sessionsDir = sessionsDir
    this.#sessionQueue = new EventQueue(spec.maxBufferBytes, () => {
      void this.#invalidate('protocol-error', `unconsumed session events exceeded maxBufferBytes (${spec.maxBufferBytes})`)
    })
    this.#child = new OwnedChild(child, 'droid', spec.maxBufferBytes, {
      line: (bytes) => this.#onLine(bytes),
      fail: (status: OwnedChildFailure, error) => void this.#invalidate(status, error),
    })
    this.#transport = new OwnedStdioTransport({
      send: (message) => this.#send(message),
      close: () => this.#child.stopGroup(),
      connected: () => !this.#child.stopped && this.#child.leader === null,
    })
    // The session's per-request deadline (`#send`) is authoritative; the SDK's own timers sit one grace period behind it as a backstop.
    const backstop = Math.min(spec.requestTimeoutSeconds * 1000 + GRACE_MS, 2_147_483_647)
    this.#client = new sdk.DroidClient({ transport: this.#transport, requestTimeout: backstop, sessionInitTimeout: backstop })
    if (options.onPermission !== null) {
      const callback = options.onPermission
      this.#client.setPermissionHandler((event) => this.#permission(event, callback))
    }
    if (options.onQuestion !== null) {
      const callback = options.onQuestion
      this.#client.setAskUserHandler((event) => this.#question(event, callback))
    }
  }

  /**
   * Pin the SDK, require the environment API key, verify any resume target,
   * take the workdir lease, spawn `droid exec` and complete the native
   * handshake. Every rejection happens with the lease released and the
   * process group stopped; nothing is spawned before the SDK and the key are
   * confirmed.
   */
  static async launch(spec: ResolvedSessionSpec): Promise<LiveSession> {
    const executable = spec.executable
    const options = spec.factoryDroid
    if (executable === null || options === null) throw invalid('factory-droid sessions need a leader executable and factoryDroid options')
    assertSupportedPlatform()
    let sdk: SdkModule
    try {
      // Optional peer dependency: resolved only when this backend is opened, so the specifier is genuinely runtime-selected.
      sdk = await import('@factory/droid-sdk/node')
    } catch (err) {
      throw new HarnessError(`@factory/droid-sdk ${SDK_PIN} is not installed (harness "factory-droid" on backend "sdk" needs it as an optional peer dependency): ${describeError(err)}`, 'launch-failed')
    }
    if (sdk.SDK_VERSION !== SDK_PIN) {
      throw new HarnessError(`installed @factory/droid-sdk ${sdk.SDK_VERSION} is not the qualified ${SDK_PIN}`, 'launch-failed')
    }
    const identity = `${sdk.SDK_TAG.metadata.language}/${sdk.SDK_TAG.metadata.version}`
    for (const [key, owned] of [['FACTORY_UPSTREAM_CLIENT_TYPE', UPSTREAM_CLIENT_TYPE], ['FACTORY_UPSTREAM_SDK', identity]] as const) {
      const explicit = spec.env[key]
      if (explicit !== undefined && explicit !== owned) {
        throw invalid(`env.${key} ${JSON.stringify(explicit)} conflicts with the SDK attribution ${JSON.stringify(owned)} the session owns`)
      }
    }
    // Explicit layering, never a parent mutation: inherited env, then the caller's entries, then the SDK attribution.
    const layered: Record<string, string> = { ...spec.env, FACTORY_UPSTREAM_CLIENT_TYPE: UPSTREAM_CLIENT_TYPE, FACTORY_UPSTREAM_SDK: identity }
    const env = inheritedEnv(layered)
    if (env.FACTORY_API_KEY === undefined || env.FACTORY_API_KEY === '') {
      throw new HarnessError('FACTORY_API_KEY is not set in the effective environment (inherited process env overlaid with spec.env); Factory Droid SDK sessions authenticate with that environment API key only', 'launch-failed')
    }
    const sessionsDir = factorySessionsDir(env)
    const resume = spec.resume
    if (resume !== null) {
      if (resume.sessionFile === null) throw invalid('resume needs sessionFile: a session that was never persisted cannot be resumed')
      const expected = nativeSessionFile(sessionsDir, spec.workdir, resume.sessionId)
      if (!samePath(resume.sessionFile, expected)) {
        throw invalid(`resume.sessionFile ${JSON.stringify(resume.sessionFile)} is not where Droid persists session ${resume.sessionId} for this workdir under the effective FACTORY_HOME_OVERRIDE / HOME (${JSON.stringify(expected)})`)
      }
      const problem = checkSavedHeader(resume.sessionFile, resume.sessionId, spec.workdir)
      if (problem !== null) throw invalid(`resume.sessionFile ${problem}`)
    }
    const adapter = getAdapter(spec.harness)
    const prepared = prepareCommand({
      cmd: executable,
      args: [...DROID_ARGS],
      cwd: spec.workdir,
      env: layered,
      instructionsFile: join(spec.workdir, adapter.instructionsFilename),
      ...(spec.instructions === null ? {} : { instructionContent: spec.instructions }),
    })
    let child: ChildProcess
    try {
      child = spawnGroupLeader(executable, DROID_ARGS, spec.workdir, env)
    } catch (err) {
      cleanupCommand(prepared)
      throw new HarnessError(`droid could not be launched: ${describeError(err)}`, 'launch-failed')
    }
    const session = new FactoryDroidSession(spec, options, prepared, child, sdk, sessionsDir)
    try {
      await session.#handshake()
    } catch (err) {
      const failure = session.#failure ?? session.#startupFailure(err)
      await session.#invalidate(failure.code === 'protocol-error' ? 'protocol-error' : 'disconnected', failure.message)
      if (session.#cleanupError !== null) throw session.#cleanupError
      throw failure
    }
    return session
  }

  get reference(): SessionReference {
    if (this.#reference === null) throw new HarnessError('session handshake has not completed', 'protocol-error')
    return this.#reference
  }

  get events(): AsyncIterable<SessionEvent> {
    return this.#sessionQueue
  }

  get active(): SessionTurn | null {
    return this.#active?.handle ?? null
  }

  get closed(): boolean {
    return this.#dead
  }

  /**
   * Reserve the slot and send `add_user_message` with a fresh native
   * `messageId` through the SDK. The acknowledgement alone never completes
   * the turn; a native rejection settles it as `agent-error` with the error
   * envelope retained, and an acknowledged turn that never reaches
   * `agent_turn_completed` is reported by the turn deadline as `timed-out`.
   */
  startTurn(prompt: string): SessionTurn {
    requirePrompt(prompt)
    if (this.#dead) throw new HarnessError('session is closed', 'session-closed')
    if (this.#active !== null) {
      throw new HarnessError('a turn is still active; concurrent turns are unsupported', 'unsupported-capability')
    }
    const id = `turn-${++this.#turnSeq}`
    const turn = new DroidTurn(id, new EventQueue(this.spec.maxBufferBytes, () => {
      turn.eventsTruncated = true
      void this.#invalidate('protocol-error', `unconsumed events of ${id} exceeded maxBufferBytes (${this.spec.maxBufferBytes})`)
    }), randomUUID())
    this.#active = turn
    if (this.spec.timeoutSeconds !== null) {
      const seconds = this.spec.timeoutSeconds
      turn.timer = deadline(seconds, () => {
        void this.#invalidate('timed-out', `${id} exceeded timeoutSeconds (${seconds})`)
      })
    }
    // Native message attribution (`userMessageSource: sdk`) exactly as the SDK's own session wrapper sends it; the schema types the enum value.
    const params = this.#sdk.AddUserMessageRequestParamsSchema.parse({ messageId: turn.messageId, text: prompt, userMessageSource: UPSTREAM_CLIENT_TYPE })
    this.#client.addUserMessage(params).then(
      () => {
        turn.promptAcked = true
        this.#maybeComplete(turn)
      },
      (err: unknown) => {
        if (this.#dead || turn.done) return
        turn.promptAcked = true
        if (turn.rejection === null) {
          // The SDK failed without a native error response (schema, send or timeout failure): not a prompt rejection.
          void this.#invalidate('protocol-error', `droid.add_user_message for ${id} failed: ${describeError(err)}`)
          return
        }
        this.#maybeComplete(turn)
      },
    )
    return turn.handle
  }

  /**
   * Send `interrupt_session` through the SDK and wait for the turn to settle:
   * the interrupt acknowledgement plus the native `agent_turn_completed`
   * (`cancelled` → interrupted; a turn that completed normally first stays
   * completed). An interrupt the CLI rejects or never answers fails the
   * session as `protocol-error` within `requestTimeoutSeconds`; after an
   * acknowledgement, settlement has the same separate deadline even when
   * the turn timeout is disabled.
   */
  async interrupt(): Promise<void> {
    if (this.#dead) throw new HarnessError('session is closed', 'session-closed')
    const turn = this.#active
    if (turn === null) throw new HarnessError('no active turn to interrupt', 'unsupported-capability')
    if (turn.abort === null) {
      const abort: AbortState = { acked: false, timer: undefined }
      turn.abort = abort
      this.#client.interruptSession().then(
        () => {
          if (this.#dead || turn.done) return
          abort.acked = true
          abort.timer = deadline(this.spec.requestTimeoutSeconds, () => {
            void this.#invalidate('protocol-error', `droid.interrupt_session was acknowledged but ${turn.id} did not settle within requestTimeoutSeconds (${this.spec.requestTimeoutSeconds})`)
          })
          this.#maybeComplete(turn)
        },
        (err: unknown) => {
          if (this.#dead || turn.done) return
          void this.#invalidate('protocol-error', `droid.interrupt_session for ${turn.id} failed: ${describeError(err)}`)
        },
      )
    }
    await turn.promise
  }

  /** Factory Droid answers its native permission / question requests through `factoryDroid.onPermission` / `onQuestion`, not through the generic reply. */
  respondApproval(): Promise<void> {
    return Promise.reject(new HarnessError('factory-droid live sessions answer permission requests through factoryDroid.onPermission / onQuestion callbacks; only "opencode" supports respondApproval', 'unsupported-capability'))
  }

  /**
   * Idempotent, concurrent-safe teardown: best-effort native `close_session`
   * bounded by GRACE_MS while the CLI still runs, then the SDK client closes
   * the owned transport (stdin EOF, TERM → GRACE_MS → KILL the group, bounded
   * drain) and the lease is released. Cleanup failures are rethrown.
   */
  async close(): Promise<void> {
    await this.#invalidate('closed', null)
    if (this.#cleanupError !== null) throw this.#cleanupError
  }

  // ---- handshake ----

  async #handshake(): Promise<void> {
    const options = this.#options
    const sdk = this.#sdk
    const overrides = {
      ...(options.disabledTools === null ? {} : { disabledToolIds: [...options.disabledTools] }),
      ...(options.autoRejectPermissionRequests === null ? {} : { autoRejectPermissionRequests: options.autoRejectPermissionRequests }),
      ...(options.disableBuiltinSkills === null ? {} : { disableBuiltinSkills: options.disableBuiltinSkills }),
      sessionOriginHint: UPSTREAM_CLIENT_TYPE,
    }
    const resume = this.spec.resume
    if (resume !== null) {
      // Same request the SDK's `resumeSession` issues (the schema types the enum hint); model and autonomy stay the saved ones by construction.
      await this.#client.loadSession(sdk.LoadSessionRequestParamsSchema.parse({ sessionId: resume.sessionId, ...overrides }))
    } else {
      // String enums are opaque to TS comparisons; the wire value is what the caller named.
      const autonomyLevel = options.autonomy === null ? undefined : Object.values(sdk.AutonomyLevel).find((level) => String(level) === options.autonomy)
      if (options.autonomy !== null && autonomyLevel === undefined) throw invalid(`factoryDroid.autonomy ${JSON.stringify(options.autonomy)} is not an AutonomyLevel of @factory/droid-sdk ${SDK_PIN}`)
      // Same request the SDK's `createSession` issues: `machineId` default, SDK tag with the language/version stamp, `sdk` origin hint.
      await this.#client.initializeSession(sdk.InitializeSessionRequestParamsSchema.parse({
        machineId: 'default',
        cwd: this.spec.workdir,
        ...(this.spec.model === null ? {} : { modelId: this.spec.model }),
        ...(autonomyLevel === undefined ? {} : { autonomyLevel }),
        ...overrides,
        tags: [sdk.SDK_TAG],
      }))
    }
    const reference = this.#reference
    if (reference === null) throw new HarnessError('the handshake response was not observed on the owned transport', 'protocol-error')
    if (this.#client.sessionId !== reference.sessionId) {
      throw new HarnessError(`the SDK adopted session ${JSON.stringify(this.#client.sessionId)}, not the native ${JSON.stringify(reference.sessionId)}`, 'protocol-error')
    }
  }

  /** Classify an SDK handshake rejection: a native `initialize_session` / `load_session` error response and every other broken handshake are `protocol-error`; only the process's own ending (exit / signal / lost transport) keeps its status. */
  #startupFailure(err: unknown): HarnessError {
    if (err instanceof HarnessError) return err
    const response = this.#handshakeResponse
    const native = response === null ? null : responseError(response)
    const excerpt = this.#child.stderr.text.trim().slice(0, STDERR_EXCERPT)
    const tail = excerpt === '' ? '' : `; stderr: ${excerpt}`
    if (native !== null) {
      return new HarnessError(`droid rejected the ${this.spec.resume === null ? 'initialize_session' : 'load_session'} request: ${native}${tail}`, 'protocol-error')
    }
    return new HarnessError(`droid handshake failed: ${describeError(err)}${tail}`, 'protocol-error')
  }

  /**
   * Validate the raw handshake response and adopt the native identity. Runs
   * synchronously inside the frame handler so that frames sharing the same
   * chunk are already stamped with the session ID. Returns the problem, if any.
   */
  #adoptIdentity(frame: JsonObject, method: string): string | null {
    this.#handshakeResponse = frame
    const protocol = frame.factoryProtocolVersion
    if (protocol !== CLI_PROTOCOL) {
      return `Droid CLI 0.213.0 uses protocol ${CLI_PROTOCOL}; received ${JSON.stringify(protocol)}`
    }
    const result = frame.result
    if (!isJsonObject(result)) return null // a native error response: the SDK rejects the handshake, `#startupFailure` names it
    if (result.isAgentLoopInProgress === true) return `${method} reports an agent loop already in progress`
    const resume = this.spec.resume
    let sessionId: string
    if (resume === null) {
      if (typeof result.sessionId !== 'string' || result.sessionId === '') return `${method} returned no sessionId`
      sessionId = result.sessionId
      const problem = checkSavedHeader(nativeSessionFile(this.#sessionsDir, this.spec.workdir, sessionId), sessionId, this.spec.workdir)
      if (problem !== null) return `saved native session ${problem}`
    } else {
      sessionId = resume.sessionId
      if (result.sessionId !== undefined && result.sessionId !== sessionId) {
        return `${method} loaded session ${JSON.stringify(result.sessionId)}, not ${JSON.stringify(sessionId)}`
      }
      const session = result.session
      if (isJsonObject(session) && session.id !== undefined && session.id !== sessionId) {
        return `${method} loaded session ${JSON.stringify(session.id)}, not ${JSON.stringify(sessionId)}`
      }
      if (typeof result.cwd !== 'string') return `${method} returned no cwd; the restored working directory cannot be verified`
      if (!samePath(result.cwd, this.spec.workdir)) {
        return `${method} restored the session in ${JSON.stringify(result.cwd)}, not ${JSON.stringify(this.spec.workdir)}`
      }
    }
    if (this.#preludeSessionId !== null && this.#preludeSessionId !== sessionId) {
      return `notifications before the handshake named session ${JSON.stringify(this.#preludeSessionId)}, but ${method} established ${JSON.stringify(sessionId)}`
    }
    this.#reference = Object.freeze({ sessionId, sessionFile: nativeSessionFile(this.#sessionsDir, this.spec.workdir, sessionId), workdir: this.spec.workdir })
    const prelude = this.#prelude
    this.#prelude = []
    this.#preludeBytes = 0
    for (const entry of prelude) this.#route(entry.type, entry.raw, entry.requestId, entry.bytes)
    return null
  }

  // ---- outgoing (SDK → CLI) ----

  /** The SDK wrote a frame: record request IDs for correlation and deadlines, then write it to the owned stdin. */
  #send(message: string): Promise<void> {
    const child = this.#child
    if (child.stopped) return Promise.reject(new HarnessError('the owned droid transport is closed', 'session-closed'))
    let frame: unknown
    try {
      frame = JSON.parse(message)
    } catch (err) {
      return Promise.reject(new HarnessError(`the SDK produced a non-JSON frame: ${describeError(err)}`, 'protocol-error'))
    }
    if (isJsonObject(frame) && frame.type === 'request') {
      const id = envelopeId(frame.id)
      const method = typeof frame.method === 'string' ? frame.method : ''
      if (id === null || method === '') return Promise.reject(new HarnessError('the SDK produced a request without id or method', 'protocol-error'))
      if (this.#outstanding.has(id)) return Promise.reject(new HarnessError(`the SDK reused request id ${JSON.stringify(id)}`, 'protocol-error'))
      const params = frame.params
      const seconds = this.spec.requestTimeoutSeconds
      this.#outstanding.set(id, {
        method,
        messageId: isJsonObject(params) && typeof params.messageId === 'string' ? params.messageId : null,
        // Requests written during teardown (the best-effort close_session) are bounded by the teardown budget instead.
        timer: this.#dead ? undefined : deadline(seconds, () => {
          void this.#invalidate('protocol-error', `request ${id} (${method}) was not answered within requestTimeoutSeconds (${seconds})`)
        }),
      })
    } else if (isJsonObject(frame) && frame.type === 'response') {
      // The SDK answered a CLI request itself (default `cancel` / `cancelled`, or a validated callback reply): the raw params are no longer needed.
      const id = envelopeId(frame.id)
      if (id !== null) this.#nativeRequests.delete(id)
    }
    child.write(`${message}\n`)
    return Promise.resolve()
  }

  // ---- incoming (CLI → SDK) ----

  /**
   * Every stdout line: strict UTF-8 JSON-RPC 2.0 object envelope, validated
   * and observed here first (correlation, identity, events), then forwarded
   * verbatim to the SDK's message handler. During teardown frames are only
   * forwarded so the best-effort `close_session` can still resolve.
   */
  #onLine(bytes: Buffer): void {
    let text: string
    let frame: JsonObject
    try {
      text = decodeFrameText(bytes)
      frame = parseFrame(text)
    } catch (err) {
      void this.#invalidate('protocol-error', err instanceof Error ? err.message : String(err))
      return
    }
    if (this.#dead) {
      this.#transport.deliver(text)
      return
    }
    const problem = this.#observe(frame, bytes.length)
    if (problem !== null) {
      void this.#invalidate('protocol-error', problem)
      return
    }
    this.#transport.deliver(text)
  }

  /** Validate and route one incoming envelope; returns the protocol problem, if any. */
  #observe(frame: JsonObject, bytes: number): string | null {
    if (frame.jsonrpc !== '2.0') return 'stdout frame is not a JSON-RPC 2.0 envelope'
    const type = frame.type
    if (typeof type !== 'string' || ENVELOPE_TYPES[type] === undefined) return `stdout frame has envelope type ${JSON.stringify(type)}, expected request, notification or response`
    if (type === 'response') return this.#onResponse(frame, bytes)
    if (typeof frame.method !== 'string' || frame.method === '') return `${type} frame has no string "method"`
    if (type === 'request') {
      const id = envelopeId(frame.id)
      if (id === null) return 'request frame has no string or number "id"'
      if (this.#nativeRequests.has(id)) return `duplicate native request ${JSON.stringify(id)}`
      this.#nativeRequests.set(id, isJsonObject(frame.params) ? frame.params : {})
      this.#route('request', frame, id, bytes)
      return null
    }
    if (frame.method !== 'droid.session_notification') {
      this.#route(frame.method, frame, null, bytes)
      return null
    }
    const params = frame.params
    if (!isJsonObject(params)) return 'droid.session_notification has no params object'
    const inner = params.notification
    if (!isJsonObject(inner) || typeof inner.type !== 'string' || inner.type === '') return 'droid.session_notification carries no notification with a string "type"'
    // Every notification names our session or none: a foreign delta must not be stamped with this session even when the terminal is correct.
    const sessionId = params.sessionId
    if (sessionId !== undefined) {
      if (typeof sessionId !== 'string' || sessionId === '') return 'droid.session_notification has a non-string sessionId'
      const reference = this.#reference
      if (reference !== null) {
        if (sessionId !== reference.sessionId) return `notification for session ${JSON.stringify(sessionId)} arrived on session ${reference.sessionId}`
      } else if (this.#preludeSessionId === null) {
        this.#preludeSessionId = sessionId
      } else if (this.#preludeSessionId !== sessionId) {
        return `notifications for sessions ${JSON.stringify(this.#preludeSessionId)} and ${JSON.stringify(sessionId)} arrived before the session identity`
      }
    }
    const turn = this.#active
    if (inner.type === 'agent_turn_completed' && turn !== null && !turn.done) {
      if (typeof inner.reason !== 'string' || inner.reason === '') return 'agent_turn_completed has no string "reason"'
      if (inner.turnId !== undefined && inner.turnId !== turn.messageId) {
        return `agent_turn_completed names turn ${JSON.stringify(inner.turnId)}, expected the submitted message ${turn.messageId}`
      }
      turn.terminal = inner
      this.#route(inner.type, inner, null, bytes)
      this.#maybeComplete(turn)
      return null
    }
    this.#route(inner.type, inner, null, bytes)
    return null
  }

  #onResponse(frame: JsonObject, bytes: number): string | null {
    const id = envelopeId(frame.id)
    if (id === null) return 'response frame has no string or number "id"'
    const outstanding = this.#outstanding.get(id)
    if (outstanding === undefined) return `unexpected or duplicate response for request ${JSON.stringify(id)}`
    if (!('result' in frame) && !('error' in frame)) return `response for ${id} carries neither result nor error`
    this.#outstanding.delete(id)
    clearTimeout(outstanding.timer)
    if (HANDSHAKE_METHODS[outstanding.method] !== undefined) {
      if (this.#reference !== null) return `unexpected second ${outstanding.method} response`
      // The handshake response is consumed here (it becomes `reference`), not surfaced as an idle event.
      return this.#adoptIdentity(frame, outstanding.method)
    }
    const turn = this.#active
    if (outstanding.messageId !== null && turn !== null && !turn.done && turn.messageId === outstanding.messageId && 'error' in frame) {
      turn.rejection = frame
    }
    this.#route('response', frame, id, bytes)
    return null
  }

  #route(type: string, raw: JsonObject, requestId: string | null, bytes: number): void {
    if (this.#dead) return
    const reference = this.#reference
    if (reference === null) {
      if (this.#preludeBytes + bytes > this.spec.maxBufferBytes) {
        void this.#invalidate('protocol-error', 'events before session identity exceeded maxBufferBytes')
        return
      }
      this.#preludeBytes += bytes
      this.#prelude.push({ type, raw, requestId, bytes })
      return
    }
    const turn = this.#active
    const event: SessionEvent = {
      backend: this.spec.backend,
      harness: this.spec.harness,
      sessionId: reference.sessionId,
      turnId: turn !== null && !turn.done ? turn.id : null,
      requestId,
      type,
      raw,
    }
    ;(turn !== null && !turn.done ? turn.queue : this.#sessionQueue).push(event, bytes)
  }

  // ---- native callbacks ----

  /**
   * Run a caller callback against the native request params, bounded by
   * `requestTimeoutSeconds`, then validate its reply with the SDK's own
   * schema. Any failure (throw, timeout, non-object, invalid or unoffered
   * reply) fails closed: the cause is retained on the session result as
   * `agent-error`, the SDK never receives a reply and the owned group is torn
   * down.
   */
  async #reply<T>(name: CallbackName, requestId: string, callback: FactoryDroidCallback, validate: (reply: JsonObject) => T): Promise<T> {
    const params = this.#nativeRequests.get(requestId)
    this.#nativeRequests.delete(requestId)
    try {
      if (this.#dead) throw new HarnessError('session is closed', 'session-closed')
      if (params === undefined) throw new HarnessError(`native request ${JSON.stringify(requestId)} was not observed on the owned transport`, 'protocol-error')
      const seconds = this.spec.requestTimeoutSeconds
      let timer: NodeJS.Timeout | undefined
      const expiry = new Promise<never>((_, reject) => {
        timer = deadline(seconds, () => reject(new HarnessError(`did not reply within requestTimeoutSeconds (${seconds})`, 'protocol-error')))
      })
      // The caller gets its own copy: the event `raw` stays the native JSON and the offered options the reply is checked against
      // (the SDK's parsed `event.params`) cannot be edited through the callback argument.
      const snapshot = structuredClone(params)
      let reply: unknown
      try {
        reply = await Promise.race([Promise.resolve().then(() => callback(snapshot)), expiry])
      } finally {
        clearTimeout(timer)
      }
      if (!isJsonObject(reply)) throw invalid(`returned ${reply === null ? 'null' : typeof reply}, not the native reply object`)
      return validate(reply)
    } catch (err) {
      void this.#invalidate('agent-error', `factoryDroid.${name} ${err instanceof Error ? err.message : String(err)}`)
      throw err
    }
  }

  #permission(event: PermissionEvent, callback: FactoryDroidCallback): Promise<Sdk.RequestPermissionResult> {
    return this.#reply('onPermission', String(event.id), callback, (reply) => {
      const parsed = this.#sdk.RequestPermissionResultSchema.safeParse(reply)
      if (!parsed.success) throw invalid(`returned an invalid permission reply: ${issues(parsed.error.issues)}`)
      const offered = event.params.options.map((option) => option.value)
      if (!offered.includes(parsed.data.selectedOption)) {
        throw invalid(`selected ${JSON.stringify(parsed.data.selectedOption)}, which droid did not offer (offered: ${offered.map((value) => JSON.stringify(value)).join(', ')})`)
      }
      return parsed.data
    })
  }

  #question(event: QuestionEvent, callback: FactoryDroidCallback): Promise<Sdk.AskUserResult> {
    return this.#reply('onQuestion', String(event.id), callback, (reply) => {
      if (typeof reply.cancelled !== 'boolean') throw invalid('returned a question reply without a boolean "cancelled"')
      const parsed = this.#sdk.AskUserResultSchema.safeParse({ ...reply, answers: reply.answers === undefined ? [] : reply.answers })
      if (!parsed.success) throw invalid(`returned an invalid question reply: ${issues(parsed.error.issues)}`)
      const asked = event.params.questions.map((question) => question.index)
      for (const answer of parsed.data.answers) {
        if (!asked.includes(answer.index)) throw invalid(`answered question ${answer.index}, which droid did not ask (asked: ${asked.join(', ')})`)
      }
      return parsed.data
    })
  }

  // ---- turn completion ----

  #maybeComplete(turn: DroidTurn): void {
    if (this.#dead || turn.done || !turn.promptAcked) return
    if (turn.abort !== null && !turn.abort.acked) return
    const rejection = turn.rejection
    if (rejection !== null) {
      this.#finishTurn(turn, 'agent-error', rejection, responseError(rejection) ?? 'prompt rejected')
      return
    }
    const terminal = turn.terminal
    if (terminal === null) return
    const reason = terminal.reason
    if (reason === 'completed') this.#finishTurn(turn, 'completed', terminal, null)
    else if (reason === 'cancelled' || reason === 'permission_rejected') this.#finishTurn(turn, 'interrupted', terminal, null)
    else this.#finishTurn(turn, 'agent-error', terminal, `agent turn ended with reason ${JSON.stringify(reason)}`)
  }

  #finishTurn(turn: DroidTurn, status: SessionTurnStatus, raw: JsonObject | null, error: string | null): void {
    if (turn.done) return
    turn.done = true
    clearTimeout(turn.timer)
    clearTimeout(turn.abort?.timer)
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
   * Fail or close the session once. Public methods refuse immediately; every
   * request deadline is cleared; on a plain `close()` with the CLI still
   * running the native `close_session` is attempted for at most GRACE_MS;
   * then the SDK client is closed, which rejects its pending requests and
   * closes the owned transport (the bounded group teardown); finally the
   * active turn settles with `status`, the idle stream ends and the lease is
   * released unless the reap failed.
   */
  #invalidate(status: SessionTurnStatus, error: string | null): Promise<void> {
    if (this.#teardown !== null) return this.#teardown
    this.#dead = true
    const child = this.#child
    for (const outstanding of this.#outstanding.values()) clearTimeout(outstanding.timer)
    this.#outstanding.clear()
    this.#nativeRequests.clear()
    const rejectCode: ErrorCode =
      status === 'closed' ? 'session-closed' : status === 'protocol-error' || status === 'timed-out' ? 'protocol-error' : 'launch-failed'
    const excerpt = child.stderr.text.trim().slice(0, STDERR_EXCERPT)
    this.#failure = new HarnessError(`${error ?? 'session closed'}${status !== 'closed' && excerpt !== '' ? `; stderr: ${excerpt}` : ''}`, rejectCode)
    const turn = this.#active
    if (turn !== null) {
      clearTimeout(turn.timer)
      clearTimeout(turn.abort?.timer)
    }
    const graceful = status === 'closed' && this.#reference !== null && child.leader === null && !child.stopped
    this.#teardown = (async () => {
      if (graceful) {
        // Best effort, never awaited beyond the grace budget: the transport close below owns the group either way.
        let timer: NodeJS.Timeout | undefined
        await Promise.race([
          this.#client.closeSession({ reason: 'other' }).catch(() => {}),
          new Promise<void>((done) => {
            timer = setTimeout(done, GRACE_MS)
          }),
        ])
        clearTimeout(timer)
      }
      child.stop()
      try {
        await this.#client.close()
      } catch (err) {
        this.#cleanupError = err
      }
      if (turn !== null) this.#finishTurn(turn, status, turn.terminal ?? turn.rejection, error)
      this.#sessionQueue.end()
      // A failed reap/termination must not release ownership of live resources.
      if (this.#cleanupError !== null) return
      try {
        cleanupCommand(this.#prepared)
      } catch (err) {
        this.#cleanupError = err
      }
    })()
    return this.#teardown
  }
}
