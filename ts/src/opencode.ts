// OpenCode live sessions: direct HTTP + SSE against a caller-owned OpenCode
// server (pinned anomalyco/opencode v1.18.29, qualified through
// GET /global/health). Loaded lazily by sessions.ts; nothing here is a child
// process and nothing is discovered: endpoint, credentials and the literal
// server-side workdir are explicit.
//
// Ownership: the session owns its HTTP requests and the `GET /event` stream,
// nothing else. It never disposes instances, deletes sessions, touches
// config/provider/auth/TUI routes or the server process. `close()` therefore
// releases the local transport only: a prompt that is still running on the
// server keeps running there. `interrupt()` (POST /session/{id}/abort) is the
// only abort this handle ever sends.
//
// Turn protocol: POST /session/{id}/message is synchronous and returns the
// run's final assistant message once the native run loop finished. A turn
// settles only when (1) that HTTP 200 body validated (role assistant, own
// session, `parentID` equal to the submitted `messageID`), (2) our own user
// message echoed as `message.updated` on the stream and (3) `session.status`
// idle followed that echo; the idle event is enqueued before the response,
// so queued events drain first. Earlier idle/busy transitions, tool
// completions, response headers or a 204 never complete a turn. A final
// assistant whose `parentID` is not the submitted message (a concurrent
// writer, or native synthetic follow-ups such as auto-compaction and subtask
// summaries) cannot be correlated and fails the handle as `protocol-error`
// with the native response retained in `result.raw`.
import { randomBytes } from 'node:crypto'
import type { ReadableStreamDefaultReader } from 'node:stream/web'
import type { ErrorCode } from './base.js'
import { HarnessError } from './base.js'
import { describeError } from './lifecycle.js'
import { EventQueue, LiveSession, MAX_FRAME_BYTES, TurnCore, deadline, invalid, isJsonObject, requirePrompt } from './sessions.js'
import type {
  JsonObject, OpenCodeOptions, ResolvedSessionSpec, OpenCodeApprovalResponse, SessionEvent, SessionReference,
  SessionTurn, SessionTurnStatus,
} from './sessions.js'

/** The only server release this transport is qualified against (`GET /global/health` → `version`). */
const OPENCODE_VERSION = '1.18.29'
/** Bound on the per-turn lineage and outstanding-permission ID sets; overflow is a protocol error. */
const MAX_IDS = 4096
const MAX_PERMISSIONS = 1024
const SESSION_EVENT_TYPES: Record<string, true | undefined> = {
  'session.status': true,
  'permission.asked': true,
  'permission.replied': true,
  'message.updated': true,
  'message.removed': true,
  'message.part.updated': true,
  'message.part.removed': true,
  'message.part.delta': true,
}
const UTF8 = new TextDecoder('utf-8', { fatal: true })

function mediaType(value: string): string {
  const end = value.indexOf(';')
  return (end === -1 ? value : value.slice(0, end)).trim().toLowerCase()
}
const LF = 0x0a
const CR = 0x0d
const COLON = 0x3a
const SPACE = 0x20
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const EMPTY = new Uint8Array(0)

let lastStamp = 0
let stampCounter = 0

/** Native `msg_` ID shape (id/id.ts at the pin): 48-bit big-endian `(ms << 12) | counter` as hex plus 14 random base62 characters. */
function nextMessageId(): string {
  const now = Date.now()
  if (now !== lastStamp) {
    lastStamp = now
    stampCounter = 0
  }
  stampCounter++
  const value = BigInt(now) * 0x1000n + BigInt(stampCounter)
  let hex = ''
  for (let i = 0; i < 6; i++) hex += Number((value >> BigInt(40 - 8 * i)) & 0xffn).toString(16).padStart(2, '0')
  let tail = ''
  for (const byte of randomBytes(14)) tail += BASE62.charAt(byte % 62)
  return `msg_${hex}${tail}`
}

/** `fetch` wraps the socket failure in a bare "fetch failed"; the cause names it. Never includes request or response bodies. */
function describeTransportError(err: unknown): string {
  if (err instanceof Error && err.cause instanceof Error) return `${err.message}: ${describeError(err.cause)}`
  return describeError(err)
}

/** Strict UTF-8 JSON; the parser's message is dropped because V8 quotes the offending body in it. */
function decodeJson(body: Uint8Array, what: string): unknown {
  try {
    return JSON.parse(UTF8.decode(body))
  } catch {
    throw new HarnessError(`${what} is not strict UTF-8 JSON`, 'protocol-error')
  }
}

/** The native message a frame is about, wherever the pinned event schemas put it (`messageID`, `info.id`, `part.messageID`). */
function frameMessageId(props: JsonObject): string | null {
  if (typeof props.messageID === 'string') return props.messageID
  const info = props.info
  if (isJsonObject(info) && typeof info.id === 'string') return info.id
  const part = props.part
  if (isJsonObject(part) && typeof part.messageID === 'string') return part.messageID
  return null
}

/** The session a frame belongs to; null for global frames (`server.*`, file watchers, ...). */
function frameSessionId(props: JsonObject): string | null {
  if (typeof props.sessionID === 'string') return props.sessionID
  const info = props.info
  if (isJsonObject(info) && typeof info.sessionID === 'string') return info.sessionID
  const part = props.part
  if (isJsonObject(part) && typeof part.sessionID === 'string') return part.sessionID
  return null
}

interface Reply {
  status: number
  contentType: string
  body: Uint8Array
}

/** One owned request: its abort handle, the round-trip timer and the reason it was aborted locally, if any. */
interface Inflight {
  readonly controller: AbortController
  timer: NodeJS.Timeout | null
  reason: HarnessError | null
}

interface Outcome {
  status: SessionTurnStatus
  raw: JsonObject
  error: string | null
}

interface AbortState {
  acked: boolean
  timer: NodeJS.Timeout
}

class HttpTurn extends TurnCore {
  /** The `messageID` we submitted; the run's final assistant must name it as `parentID`. */
  readonly messageId: string
  /** Message IDs this turn owns: the submitted user message and every assistant whose `parentID` is it. Cleared on settlement. */
  readonly lineage = new Set<string>()
  /** Our user message was echoed as `message.updated`. */
  echoSeen = false
  /** `session.status` idle observed after the echo. */
  idleSeen = false
  /** Validated prompt response awaiting the stream barrier. */
  outcome: Outcome | null = null
  /** Native response retained for `result.raw` even when the turn fails after receiving it. */
  raw: JsonObject | null = null
  abort: AbortState | null = null

  constructor(id: string, queue: EventQueue, messageId: string) {
    super(id, queue)
    this.messageId = messageId
    this.lineage.add(messageId)
  }
}

/**
 * Incremental `text/event-stream` decoder: LF, CR and CRLF line endings,
 * comments, ignored fields (`event`, `id`, `retry`) and multi-line `data`
 * joined with LF. Every partial line and every pending event is bounded by
 * `MAX_FRAME_BYTES`; violations and invalid UTF-8 throw `protocol-error`.
 */
class SseDecoder {
  #line: Uint8Array[] = []
  #lineBytes = 0
  #data: string[] = []
  #dataBytes = 0
  #frameBytes = 0
  #skipLf = false

  feed(chunk: Uint8Array, dispatch: (data: string, bytes: number) => void): void {
    let from = 0
    if (this.#skipLf) {
      this.#skipLf = false
      if (chunk[0] === LF) from = 1
    }
    while (from < chunk.length) {
      let end = from
      while (end < chunk.length) {
        const byte = chunk[end]
        if (byte === LF || byte === CR) break
        end++
      }
      if (end === chunk.length) {
        const rest = chunk.subarray(from)
        this.#lineBytes += rest.length
        if (this.#lineBytes + this.#frameBytes > MAX_FRAME_BYTES) throw new HarnessError(`event stream line exceeds ${MAX_FRAME_BYTES} bytes`, 'protocol-error')
        this.#line.push(rest)
        return
      }
      let line = chunk.subarray(from, end)
      if (this.#line.length > 0) {
        this.#line.push(line)
        line = Buffer.concat(this.#line, this.#lineBytes + line.length)
        this.#line = []
        this.#lineBytes = 0
      }
      let delimiterBytes = 1
      if (chunk[end] === CR) {
        if (end + 1 < chunk.length) {
          if (chunk[end + 1] === LF) { end++; delimiterBytes++ }
        } else {
          this.#skipLf = true
        }
      }
      from = end + 1
      this.#onLine(line, delimiterBytes, dispatch)
    }
  }

  /** EOF inside a partial line or an undispatched event is a truncated stream. */
  end(): void {
    if (this.#line.length > 0 || this.#data.length > 0) {
      throw new HarnessError('event stream ended inside an unterminated event', 'protocol-error')
    }
  }

  #onLine(line: Uint8Array, delimiterBytes: number, dispatch: (data: string, bytes: number) => void): void {
    this.#frameBytes += line.length + delimiterBytes
    if (this.#frameBytes > MAX_FRAME_BYTES) throw new HarnessError(`event stream frame exceeds ${MAX_FRAME_BYTES} bytes`, 'protocol-error')
    if (line.length === 0) {
      this.#frameBytes = 0
      if (this.#data.length === 0) return
      const data = this.#data.join('\n')
      const bytes = this.#dataBytes + this.#data.length - 1
      this.#data = []
      this.#dataBytes = 0
      dispatch(data, bytes)
      return
    }
    if (line[0] === COLON) return
    const colon = line.indexOf(COLON)
    const field = colon === -1 ? line : line.subarray(0, colon)
    if (field.length !== 4 || field[0] !== 0x64 || field[1] !== 0x61 || field[2] !== 0x74 || field[3] !== 0x61) return
    let value = colon === -1 ? EMPTY : line.subarray(colon + 1)
    if (value[0] === SPACE) value = value.subarray(1)
    this.#dataBytes += value.length
    if (this.#dataBytes > MAX_FRAME_BYTES) throw new HarnessError(`event stream event exceeds ${MAX_FRAME_BYTES} bytes`, 'protocol-error')
    try {
      this.#data.push(UTF8.decode(value))
    } catch {
      throw new HarnessError('event stream data is not valid UTF-8', 'protocol-error')
    }
  }
}

/**
 * A live OpenCode session over HTTP + SSE. Constructed only through
 * `LiveSession.open` (via `connect`), which qualifies the server, resolves or
 * creates the native session and subscribes to `/event` before returning.
 */
export class OpenCodeSession extends LiveSession {
  readonly #options: Readonly<OpenCodeOptions>
  readonly #authorization: string | null
  readonly #directoryQuery: string
  readonly #sessionQueue: EventQueue
  readonly #inflight = new Set<Inflight>()
  /** Permission requests of the selected session observed as `permission.asked` and not yet replied. Cleared on turn settlement. */
  readonly #pendingPermissions = new Set<string>()
  #reference: SessionReference | null = null
  #connected: { resolve: () => void; reject: (err: HarnessError) => void } | null = null
  #pump: Promise<void> = Promise.resolve()
  #ready = false
  #sawConnected = false
  #turnSeq = 0
  #active: HttpTurn | null = null
  #dead = false
  #teardown: Promise<void> | null = null

  private constructor(spec: ResolvedSessionSpec, options: Readonly<OpenCodeOptions>) {
    super(spec)
    this.#options = options
    this.#authorization = options.auth === 'basic'
      ? `Basic ${Buffer.from(`${options.username ?? ''}:${options.password ?? ''}`, 'utf8').toString('base64')}`
      : null
    this.#directoryQuery = `directory=${encodeURIComponent(spec.workdir)}`
    this.#sessionQueue = new EventQueue(spec.maxBufferBytes, () => {
      void this.#invalidate('protocol-error', `unconsumed session events exceeded maxBufferBytes (${spec.maxBufferBytes})`)
    })
  }

  /** Qualify the server, establish the session identity and subscribe to its events. Rejects with every owned connection closed. */
  static async connect(spec: ResolvedSessionSpec): Promise<LiveSession> {
    if (spec.opencode === null) throw invalid('opencode options are required for an OpenCode session')
    const session = new OpenCodeSession(spec, spec.opencode)
    try {
      await session.#handshake()
    } catch (err) {
      await session.#invalidate('closed', null)
      throw err
    }
    session.#ready = true
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
   * Submit the prompt as a native user message with an explicit `messageID`
   * and a single text part. A non-200 prompt response settles the turn as
   * `agent-error` immediately (no run was started); a 200 is held until the
   * stream barrier described in the module header is met.
   */
  startTurn(prompt: string): SessionTurn {
    requirePrompt(prompt)
    if (this.#dead) throw new HarnessError('session is closed', 'session-closed')
    if (this.#active !== null) {
      throw new HarnessError('a turn is still active; concurrent turns are unsupported', 'unsupported-capability')
    }
    const id = `turn-${++this.#turnSeq}`
    const turn = new HttpTurn(id, new EventQueue(this.spec.maxBufferBytes, () => {
      turn.eventsTruncated = true
      void this.#invalidate('protocol-error', `unconsumed events of ${id} exceeded maxBufferBytes (${this.spec.maxBufferBytes})`)
    }), nextMessageId())
    this.#active = turn
    if (this.spec.timeoutSeconds !== null) {
      const seconds = this.spec.timeoutSeconds
      turn.timer = deadline(seconds, () => {
        void this.#invalidate('timed-out', `${id} exceeded timeoutSeconds (${seconds})`)
      })
    }
    void this.#submit(turn, prompt)
    return turn.handle
  }

  /**
   * POST /session/{id}/abort, then wait for the native prompt to settle and
   * the stream to report idle. Bounded by `requestTimeoutSeconds` end to end;
   * exceeding it fails the handle as `protocol-error`. A run that had already
   * completed normally still reports `completed`.
   */
  async interrupt(): Promise<void> {
    if (this.#dead) throw new HarnessError('session is closed', 'session-closed')
    const turn = this.#active
    if (turn === null) throw new HarnessError('no active turn to interrupt', 'unsupported-capability')
    if (turn.abort === null) {
      const seconds = this.spec.requestTimeoutSeconds
      const abort: AbortState = {
        acked: false,
        timer: deadline(seconds, () => {
          void this.#invalidate('protocol-error', `interrupt of ${turn.id} did not settle within requestTimeoutSeconds (${seconds})`)
        }),
      }
      turn.abort = abort
      void this.#abort(turn, abort)
    }
    await turn.promise
  }

  /**
   * Reply to an outstanding `permission.asked` of this session with `once` or
   * `reject` (POST /permission/{id}/reply). `always` is refused before any
   * request: upstream stores it as an instance-wide allow rule shared by every
   * client of the server. Note that a native `reject` also settles every other
   * pending request of the same session; each one is reported through its own
   * `permission.replied` event.
   */
  async respondApproval(requestId: string, response: OpenCodeApprovalResponse): Promise<void> {
    const reply: unknown = response
    if (reply === 'always') {
      throw new HarnessError('permission reply "always" is unsupported: OpenCode stores it as an instance-wide rule that changes behavior for every client of the server', 'unsupported-capability')
    }
    if (reply !== 'once' && reply !== 'reject') throw invalid(`response must be "once" or "reject", got ${JSON.stringify(reply)}`)
    if (typeof requestId !== 'string' || !/^per_[0-9A-Za-z]+$/.test(requestId)) throw invalid('requestId must be a safe native permission ID')
    if (this.#dead) throw new HarnessError('session is closed', 'session-closed')
    if (!this.#pendingPermissions.has(requestId)) {
      throw invalid(`no outstanding permission request ${JSON.stringify(requestId)} was observed for session ${this.reference.sessionId}`)
    }
    this.#pendingPermissions.delete(requestId)
    let result: Reply
    try {
      result = await this.#exchange('POST', `/permission/${encodeURIComponent(requestId)}/reply`, { scoped: true, json: { reply }, accept: 'application/json' })
    } catch (err) {
      if (!(err instanceof HarnessError) || err.code === 'session-closed') throw err
      void this.#invalidate(err.code === 'launch-failed' ? 'disconnected' : 'protocol-error', err.message)
      throw err
    }
    if (result.status === 404) throw invalid(`permission request ${JSON.stringify(requestId)} is no longer outstanding on the server`)
    try {
      if (result.status !== 200 || mediaType(result.contentType) !== 'application/json' || decodeJson(result.body, 'permission reply response') !== true) {
        throw new HarnessError(`permission reply for ${JSON.stringify(requestId)} was not acknowledged (HTTP ${result.status})`, 'protocol-error')
      }
    } catch (err) {
      await this.#invalidate('protocol-error', (err as Error).message)
      throw err
    }
  }

  /**
   * Idempotent, concurrent-safe: aborts every owned request and the event
   * stream, settles an active turn as `closed` and ends the idle stream. The
   * server is not contacted; a prompt still running there keeps running.
   */
  async close(): Promise<void> {
    await this.#invalidate('closed', null)
  }

  // ---- startup ----

  async #handshake(): Promise<void> {
    const workdir = this.spec.workdir
    const health = await this.#json('GET', '/global/health', false)
    if (health.healthy !== true || typeof health.version !== 'string') {
      throw new HarnessError('GET /global/health did not report {healthy: true, version}', 'protocol-error')
    }
    if (health.version !== OPENCODE_VERSION) {
      throw new HarnessError(`OpenCode server version ${JSON.stringify(health.version)} is not the qualified ${OPENCODE_VERSION}`, 'unsupported-backend')
    }
    const path = await this.#json('GET', '/path', true)
    if (path.directory !== workdir) {
      throw new HarnessError(`OpenCode resolved directory ${JSON.stringify(path.directory)} for the requested workdir ${JSON.stringify(workdir)}`, 'protocol-error')
    }
    const resume = this.spec.resume
    const info = resume === null
      ? await this.#json('POST', '/session', true)
      : await this.#json('GET', `/session/${encodeURIComponent(resume.sessionId)}`, true)
    const sessionId = info.id
    if (typeof sessionId !== 'string' || !sessionId.startsWith('ses_')) throw new HarnessError('OpenCode session has no native ses_ ID', 'protocol-error')
    if (resume !== null && sessionId !== resume.sessionId) {
      throw new HarnessError(`OpenCode returned session ${JSON.stringify(sessionId)}, not the requested ${JSON.stringify(resume.sessionId)}`, 'protocol-error')
    }
    if (info.directory !== workdir) {
      throw new HarnessError(`OpenCode session ${sessionId} lives in ${JSON.stringify(info.directory)}, not the requested workdir ${JSON.stringify(workdir)}`, 'protocol-error')
    }
    this.#reference = Object.freeze({ sessionId, sessionFile: null, workdir, endpoint: this.#options.endpoint })
    if (resume !== null) {
      const status = (await this.#json('GET', '/session/status', true))[sessionId]
      if (status !== undefined && (!isJsonObject(status) || status.type !== 'idle')) {
        throw new HarnessError(`OpenCode session ${sessionId} is not idle; this handle did not start its run`, 'protocol-error')
      }
    }
    await this.#subscribe()
  }

  /** GET /event with the directory, then wait for the native `server.connected` frame within `requestTimeoutSeconds`. */
  async #subscribe(): Promise<void> {
    const { response, inflight } = await this.#send('GET', '/event', { scoped: true, accept: 'text/event-stream', timer: 'headers' })
    const contentType = response.headers.get('content-type') ?? ''
    const body = response.body
    if (response.status !== 200) {
      this.#abortInflight(inflight, new HarnessError(`GET /event answered HTTP ${response.status}`, 'launch-failed'))
      this.#settleInflight(inflight)
      throw new HarnessError(`GET /event answered HTTP ${response.status}`, 'launch-failed')
    }
    if (mediaType(contentType) !== 'text/event-stream' || body === null) {
      this.#abortInflight(inflight, new HarnessError('GET /event is not a text/event-stream response', 'protocol-error'))
      this.#settleInflight(inflight)
      throw new HarnessError(`GET /event answered content-type ${JSON.stringify(contentType)}, not text/event-stream`, 'protocol-error')
    }
    const seconds = this.spec.requestTimeoutSeconds
    const connected = new Promise<void>((resolve, reject) => {
      this.#connected = { resolve, reject }
    })
    const timer = deadline(seconds, () => {
      void this.#invalidate('protocol-error', `server.connected was not received within requestTimeoutSeconds (${seconds})`)
    })
    this.#pump = this.#pumpStream(body.getReader(), inflight)
    try {
      await connected
    } finally {
      clearTimeout(timer)
      this.#connected = null
    }
  }

  async #pumpStream(reader: ReadableStreamDefaultReader<Uint8Array>, inflight: Inflight): Promise<void> {
    const decoder = new SseDecoder()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (this.#dead) return
        if (done) {
          decoder.end()
          void this.#invalidate('disconnected', 'the event stream ended (server disposed or connection closed); no reconnect is attempted')
          return
        }
        decoder.feed(value, (data, bytes) => this.#onFrame(data, bytes))
      }
    } catch (err) {
      if (this.#dead) return
      if (err instanceof HarnessError) void this.#invalidate('protocol-error', err.message)
      else void this.#invalidate('disconnected', `event stream failed: ${describeTransportError(err)}`)
    } finally {
      this.#settleInflight(inflight)
    }
  }

  // ---- HTTP ----

  /**
   * Issue one request; resolves once the headers arrived. `timer` selects
   * what `requestTimeoutSeconds` bounds: the whole round trip, only the
   * headers (the event stream, whose body is open-ended), or nothing (the
   * synchronous prompt: upstream sends its headers only when the native run
   * finished, so the turn deadline is its only bound). Throws
   * `session-closed`, `launch-failed` (transport) or `protocol-error`
   * (timeout); redirects are never followed.
   */
  async #send(method: 'GET' | 'POST', path: string, init: { scoped: boolean; json?: JsonObject; accept: string; timer: 'round-trip' | 'headers' | 'none' }): Promise<{ response: Response; inflight: Inflight }> {
    if (this.#dead) throw new HarnessError('session is closed', 'session-closed')
    const seconds = this.spec.requestTimeoutSeconds
    const inflight: Inflight = { controller: new AbortController(), timer: null, reason: null }
    if (init.timer !== 'none') {
      inflight.timer = deadline(seconds, () => {
        this.#abortInflight(inflight, new HarnessError(`${method} ${path} was not answered within requestTimeoutSeconds (${seconds})`, this.#ready ? 'protocol-error' : 'launch-failed'))
      })
    }
    this.#inflight.add(inflight)
    const headers: Record<string, string> = { accept: init.accept, connection: 'close' }
    if (this.#authorization !== null) headers.authorization = this.#authorization
    let body: string | undefined
    if (init.json !== undefined) {
      headers['content-type'] = 'application/json'
      body = JSON.stringify(init.json)
    }
    const url = `${this.#options.endpoint}${path}${init.scoped ? `?${this.#directoryQuery}` : ''}`
    let response: Response
    try {
      response = await fetch(url, { method, headers, body, redirect: 'manual', signal: inflight.controller.signal })
    } catch (err) {
      this.#settleInflight(inflight)
      if (this.#dead) throw new HarnessError('session is closed', 'session-closed')
      throw inflight.reason ?? new HarnessError(`${method} ${path} failed: ${describeTransportError(err)}`, 'launch-failed')
    }
    if (init.timer === 'headers' && inflight.timer !== null) {
      clearTimeout(inflight.timer)
      inflight.timer = null
    }
    return { response, inflight }
  }

  /** Stream the body up to `MAX_FRAME_BYTES`; anything larger aborts the request as a protocol error. */
  async #readBody(response: Response, inflight: Inflight): Promise<Uint8Array> {
    const body = response.body
    if (body === null) return EMPTY
    const reader = body.getReader()
    const chunks: Uint8Array[] = []
    let length = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        length += value.length
        if (length > MAX_FRAME_BYTES) {
          const oversize = new HarnessError(`response body exceeds ${MAX_FRAME_BYTES} bytes`, 'protocol-error')
          this.#abortInflight(inflight, oversize)
          throw oversize
        }
        chunks.push(value)
      }
    } catch (err) {
      if (this.#dead) throw new HarnessError('session is closed', 'session-closed')
      if (err instanceof HarnessError) throw err
      throw inflight.reason ?? new HarnessError(`response body could not be read: ${describeTransportError(err)}`, 'launch-failed')
    }
    return chunks.length === 1 ? chunks[0] ?? EMPTY : Buffer.concat(chunks, length)
  }

  /** A whole bounded round trip: headers and body within `requestTimeoutSeconds`. */
  async #exchange(method: 'GET' | 'POST', path: string, init: { scoped: boolean; json?: JsonObject; accept: string }): Promise<Reply> {
    const { response, inflight } = await this.#send(method, path, { ...init, timer: 'round-trip' })
    try {
      const body = await this.#readBody(response, inflight)
      return { status: response.status, contentType: response.headers.get('content-type') ?? '', body }
    } finally {
      this.#settleInflight(inflight)
    }
  }

  /** Startup JSON round trip: any non-200 (including redirects and 401/404) is `launch-failed`; a malformed 200 is `protocol-error`. */
  async #json(method: 'GET' | 'POST', path: string, scoped: boolean): Promise<JsonObject> {
    const reply = await this.#exchange(method, path, { scoped, accept: 'application/json' })
    if (reply.status !== 200) {
      const detail = reply.status === 0 || (reply.status >= 300 && reply.status < 400)
        ? `redirected (HTTP ${reply.status}); redirects are not followed`
        : reply.status === 401 || reply.status === 403
          ? `rejected the credentials (HTTP ${reply.status})`
          : `answered HTTP ${reply.status}`
      throw new HarnessError(`${method} ${path} ${detail}`, 'launch-failed')
    }
    if (mediaType(reply.contentType) !== 'application/json') {
      throw new HarnessError(`${method} ${path} answered content-type ${JSON.stringify(reply.contentType)}, not application/json`, 'protocol-error')
    }
    const parsed = decodeJson(reply.body, `${method} ${path} response`)
    if (!isJsonObject(parsed)) throw new HarnessError(`${method} ${path} response is not a JSON object`, 'protocol-error')
    return parsed
  }

  #abortInflight(inflight: Inflight, reason: HarnessError): void {
    if (inflight.reason === null) inflight.reason = reason
    inflight.controller.abort(reason)
  }

  #settleInflight(inflight: Inflight): void {
    if (inflight.timer !== null) {
      clearTimeout(inflight.timer)
      inflight.timer = null
    }
    this.#inflight.delete(inflight)
  }

  // ---- turns ----

  /** Verify the session is idle on the server (a run this handle did not start cannot be correlated), then submit. */
  async #submit(turn: HttpTurn, prompt: string): Promise<void> {
    const sessionId = this.reference.sessionId
    const body: JsonObject = { messageID: turn.messageId, parts: [{ type: 'text', text: prompt }] }
    const model = this.spec.model
    if (model !== null) {
      const slash = model.indexOf('/')
      body.model = { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) }
    }
    let reply: Reply
    try {
      const status = await this.#exchange('GET', '/session/status', { scoped: true, accept: 'application/json' })
      if (this.#dead || turn.done) return
      if (status.status !== 200 || mediaType(status.contentType) !== 'application/json') {
        void this.#invalidate('protocol-error', `GET /session/status answered HTTP ${status.status} before the prompt of ${turn.id}`)
        return
      }
      const statuses = decodeJson(status.body, 'GET /session/status response')
      if (!isJsonObject(statuses)) throw new HarnessError('GET /session/status did not return a status object', 'protocol-error')
      const current = statuses[sessionId]
      if (current !== undefined && (!isJsonObject(current) || current.type !== 'idle')) {
        void this.#invalidate('protocol-error', `session ${sessionId} is not idle; the prompt of ${turn.id} was not sent`)
        return
      }
      // Upstream sends headers only at run completion; the turn deadline bounds this request.
      const { response, inflight } = await this.#send('POST', `/session/${encodeURIComponent(sessionId)}/message`, { scoped: true, json: body, accept: 'application/json', timer: 'none' })
      try {
        reply = { status: response.status, contentType: response.headers.get('content-type') ?? '', body: await this.#readBody(response, inflight) }
      } finally {
        this.#settleInflight(inflight)
      }
    } catch (err) {
      if (this.#dead || turn.done) return
      const failure = err instanceof HarnessError ? err : new HarnessError(describeTransportError(err), 'launch-failed')
      void this.#invalidate(failure.code === 'launch-failed' ? 'disconnected' : 'protocol-error', `prompt of ${turn.id} failed: ${failure.message}`)
      return
    }
    if (this.#dead || turn.done) return
    this.#onPromptReply(turn, reply)
  }

  /** Classify the synchronous prompt response; a valid 200 is held until the stream barrier is met. */
  #onPromptReply(turn: HttpTurn, reply: Reply): void {
    const { status } = reply
    if (status === 204 || status === 0 || (status >= 300 && status < 400)) {
      void this.#invalidate('protocol-error', `prompt of ${turn.id} answered HTTP ${status}; the synchronous message route must return the final assistant message`)
      return
    }
    if (status !== 200) {
      let raw: JsonObject | null = null
      try {
        const parsed = decodeJson(reply.body, 'prompt error response')
        if (isJsonObject(parsed)) raw = parsed
      } catch {
        // a non-JSON error body is simply not retained
      }
      this.#finishTurn(turn, 'agent-error', raw, `prompt of ${turn.id} was rejected with HTTP ${status}`)
      return
    }
    if (mediaType(reply.contentType) !== 'application/json') {
      void this.#invalidate('protocol-error', `prompt of ${turn.id} answered content-type ${JSON.stringify(reply.contentType)}, not application/json`)
      return
    }
    let payload: unknown
    try {
      payload = decodeJson(reply.body, 'prompt response')
    } catch (err) {
      void this.#invalidate('protocol-error', err instanceof Error ? err.message : String(err))
      return
    }
    if (isJsonObject(payload)) turn.raw = payload
    if (!isJsonObject(payload) || !isJsonObject(payload.info) || !Array.isArray(payload.parts)) {
      void this.#invalidate('protocol-error', `prompt of ${turn.id} answered without an {info, parts} message`)
      return
    }
    const info = payload.info
    const sessionId = this.reference.sessionId
    if (info.role !== 'assistant' || info.sessionID !== sessionId) {
      void this.#invalidate('protocol-error', `prompt of ${turn.id} answered with a ${JSON.stringify(info.role)} message of session ${JSON.stringify(info.sessionID)}, not an assistant message of ${sessionId}`)
      return
    }
    if (info.parentID !== turn.messageId) {
      void this.#invalidate('protocol-error', `prompt of ${turn.id} answered with assistant ${JSON.stringify(info.id)} whose parentID ${JSON.stringify(info.parentID)} is not the submitted message ${turn.messageId}: the native run cannot be correlated to this turn (a concurrent writer, or a synthetic follow-up such as auto-compaction or a subtask summary, which are unsupported)`)
      return
    }
    if (typeof info.id !== 'string' || !info.id.startsWith('msg_') || !isJsonObject(info.time) || typeof info.time.completed !== 'number' || !Number.isFinite(info.time.completed) || info.time.completed < 0) {
      void this.#invalidate('protocol-error', 'prompt response assistant has no valid message ID or completed timestamp')
      return
    }
    const error = info.error
    let outcome: Outcome
    if (error !== undefined && error !== null) {
      if (!isJsonObject(error) || typeof error.name !== 'string' || error.name === '') {
        void this.#invalidate('protocol-error', `prompt of ${turn.id} answered with a malformed assistant error`)
        return
      }
      if (error.name === 'MessageAbortedError') {
        outcome = { status: 'interrupted', raw: payload, error: null }
      } else {
        const data = error.data
        const message = isJsonObject(data) && typeof data.message === 'string' ? data.message : `assistant message ended with error ${error.name}`
        outcome = { status: 'agent-error', raw: payload, error: message }
      }
    } else {
      const finish = info.finish
      const finished = typeof finish === 'string' && finish !== '' && finish !== 'tool-calls' && finish !== 'unknown'
      if (!finished) {
        // Strict terminal contract: an error-free assistant without a terminal finish (e.g. a subtask closed with
        // "tool-calls" by an abort) is unsupported even while our own abort is in flight; abort true alone proves nothing.
        void this.#invalidate('protocol-error', `prompt of ${turn.id} answered with an assistant message that neither finished (finish ${JSON.stringify(finish)}) nor failed`)
        return
      }
      outcome = { status: 'completed', raw: payload, error: null }
    }
    turn.outcome = outcome
    this.#maybeComplete(turn)
  }

  async #abort(turn: HttpTurn, abort: AbortState): Promise<void> {
    let reply: Reply
    try {
      reply = await this.#exchange('POST', `/session/${encodeURIComponent(this.reference.sessionId)}/abort`, { scoped: true, accept: 'application/json' })
    } catch (err) {
      if (this.#dead || turn.done) return
      const failure = err instanceof HarnessError ? err : new HarnessError(describeTransportError(err), 'launch-failed')
      void this.#invalidate(failure.code === 'launch-failed' ? 'disconnected' : 'protocol-error', `abort of ${turn.id} failed: ${failure.message}`)
      return
    }
    if (this.#dead || turn.done) return
    let acknowledged = false
    if (reply.status === 200 && mediaType(reply.contentType) === 'application/json') {
      try {
        acknowledged = decodeJson(reply.body, 'abort response') === true
      } catch {
        acknowledged = false
      }
    }
    if (!acknowledged) {
      void this.#invalidate('protocol-error', `abort of ${turn.id} was not acknowledged with true (HTTP ${reply.status})`)
      return
    }
    abort.acked = true
    this.#maybeComplete(turn)
  }

  /** The dual barrier: validated response, own echo, idle after the echo, and (when interrupting) the abort acknowledgement. */
  #maybeComplete(turn: HttpTurn): void {
    if (this.#dead || turn.done) return
    const outcome = turn.outcome
    if (outcome === null || !turn.echoSeen || !turn.idleSeen) return
    if (turn.abort !== null && !turn.abort.acked) return
    this.#finishTurn(turn, outcome.status, outcome.raw, outcome.error)
  }

  #finishTurn(turn: HttpTurn, status: SessionTurnStatus, raw: JsonObject | null, error: string | null): void {
    if (turn.done) return
    turn.done = true
    clearTimeout(turn.timer)
    if (turn.abort !== null) clearTimeout(turn.abort.timer)
    if (this.#active === turn) this.#active = null
    turn.lineage.clear()
    this.#pendingPermissions.clear()
    turn.settle({
      sessionId: this.#reference?.sessionId ?? '',
      turnId: turn.id,
      status,
      raw,
      error,
      exitCode: null,
      signal: null,
      stderr: '',
      stderrBytes: 0,
      stderrTruncated: false,
      eventsTruncated: turn.eventsTruncated,
    })
    turn.queue.end()
  }

  // ---- event stream ----

  /**
   * One decoded SSE event. Frames of other sessions are dropped; global
   * frames and frames of the selected session are surfaced in stream order.
   * During a turn, frames about messages outside the turn's lineage (a
   * concurrent writer, native housekeeping such as summaries or pruning of
   * earlier messages) go to `events` with `turnId` null rather than being
   * claimed as the turn's own.
   */
  #onFrame(data: string, bytes: number): void {
    if (this.#dead) return
    let frame: unknown
    try {
      frame = JSON.parse(data)
    } catch {
      void this.#invalidate('protocol-error', 'event stream event is not JSON')
      return
    }
    if (!isJsonObject(frame)) {
      void this.#invalidate('protocol-error', 'event stream event is not a JSON object')
      return
    }
    const type = frame.type
    if (typeof type !== 'string' || type === '') {
      void this.#invalidate('protocol-error', 'event stream event has no string "type"')
      return
    }
    if (!this.#sawConnected) {
      if (type !== 'server.connected') {
        void this.#invalidate('protocol-error', 'first SSE event was not server.connected')
        return
      }
      this.#sawConnected = true
      this.#connected?.resolve()
    }
    const reference = this.#reference
    if (reference === null) return
    const props = isJsonObject(frame.properties) ? frame.properties : null
    const sessionId = props === null ? null : frameSessionId(props)
    if (sessionId !== null && sessionId !== reference.sessionId) return
    if (SESSION_EVENT_TYPES[type] === true && sessionId === null) {
      void this.#invalidate('protocol-error', `${type} event has no session identity`)
      return
    }
    if (type === 'message.updated') {
      const info = props?.info
      if (!isJsonObject(info) || info.sessionID !== reference.sessionId || typeof info.id !== 'string' || !info.id.startsWith('msg_') || (info.role !== 'user' && info.role !== 'assistant')) {
        void this.#invalidate('protocol-error', 'message.updated has malformed or conflicting native identity')
        return
      }
    }
    if (type === 'permission.asked' && (typeof props?.id !== 'string' || !/^per_[0-9A-Za-z]+$/.test(props.id))) {
      void this.#invalidate('protocol-error', 'permission.asked has no safe native permission ID')
      return
    }
    const turn = this.#active !== null && !this.#active.done ? this.#active : null
    const messageId = props === null ? null : frameMessageId(props)
    let requestId = messageId
    if (props !== null && sessionId !== null) {
      if (type === 'permission.asked' && typeof props.id === 'string') {
        requestId = props.id
        if (this.#pendingPermissions.size >= MAX_PERMISSIONS && !this.#pendingPermissions.has(props.id)) {
          void this.#invalidate('protocol-error', `more than ${MAX_PERMISSIONS} outstanding permission requests`)
          return
        }
        this.#pendingPermissions.add(props.id)
      } else if (type === 'permission.replied' && typeof props.requestID === 'string') {
        requestId = props.requestID
        this.#pendingPermissions.delete(props.requestID)
      } else if (type === 'session.status') {
        const status = isJsonObject(props.status) ? props.status.type : undefined
        if (status !== 'idle' && status !== 'busy' && status !== 'retry') {
          void this.#invalidate('protocol-error', 'session.status event has no supported status.type')
          return
        }
        if (status === 'idle') {
          if (turn !== null && turn.echoSeen) turn.idleSeen = true
        } else if (turn !== null && (status === 'busy' || status === 'retry')) {
          turn.idleSeen = false
        } else if (turn === null && (status === 'busy' || status === 'retry')) {
          void this.#invalidate('protocol-error', `session ${reference.sessionId} became ${status} without a turn from this handle: another writer owns the run`)
          return
        }
      } else if (type === 'message.updated' && turn !== null && isJsonObject(props.info)) {
        const info = props.info
        if (info.role === 'user' && info.id === turn.messageId) {
          turn.echoSeen = true
        } else if (info.role === 'assistant' && info.parentID === turn.messageId && typeof info.id === 'string') {
          if (turn.lineage.size >= MAX_IDS && !turn.lineage.has(info.id)) {
            void this.#invalidate('protocol-error', `${turn.id} produced more than ${MAX_IDS} assistant messages`)
            return
          }
          turn.lineage.add(info.id)
        }
      }
    }
    const owned = turn !== null && !type.startsWith('server.') && (messageId === null || turn.lineage.has(messageId))
    const event: SessionEvent = {
      backend: this.spec.backend,
      harness: this.spec.harness,
      sessionId: reference.sessionId,
      turnId: owned && turn !== null ? turn.id : null,
      requestId,
      type,
      raw: frame,
    }
    ;(owned && turn !== null ? turn.queue : this.#sessionQueue).push(event, bytes)
    if (type === 'server.instance.disposed') {
      void this.#invalidate('disconnected', 'server instance was disposed')
      return
    }
    if (turn !== null && type === 'session.status') this.#maybeComplete(turn)
  }

  // ---- teardown ----

  /**
   * Fail or close the session once: abort every owned request and the event
   * stream, wait for the stream pump to exit, settle the active turn with
   * `status` (keeping any native response already received as `raw`) and end
   * the idle event stream. Nothing is sent to the server.
   */
  #invalidate(status: SessionTurnStatus, error: string | null): Promise<void> {
    if (this.#teardown !== null) return this.#teardown
    this.#dead = true
    const rejectCode: ErrorCode =
      status === 'closed' ? 'session-closed' : status === 'protocol-error' || status === 'timed-out' ? 'protocol-error' : 'launch-failed'
    const reason = new HarnessError(error ?? 'session closed', rejectCode)
    if (this.#connected !== null) this.#connected.reject(reason)
    for (const inflight of this.#inflight) this.#abortInflight(inflight, reason)
    const turn = this.#active
    if (turn !== null) clearTimeout(turn.timer)
    this.#teardown = this.#pump.then(() => {
      if (turn !== null) this.#finishTurn(turn, status, turn.raw, error)
      this.#sessionQueue.end()
    })
    return this.#teardown
  }
}
