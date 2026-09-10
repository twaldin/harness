// OpenHands live sessions: direct HTTP + WebSocket against a caller-owned
// OpenHands Agent Server (pinned OpenHands/software-agent-sdk v1.45.0,
// qualified through GET /server_info). Loaded lazily by sessions.ts together
// with the optional `ws` peer; nothing here is a child process and nothing is
// discovered: endpoint, credential, agent profile, model and the literal
// server-side workdir are explicit.
//
// Ownership: the session owns its HTTP requests and one session socket
// (`/sockets/session/{uuid}`, live-only), nothing else. It never provisions
// or initializes the server, never lists/seeds/activates profiles, never
// deletes, pauses, forks or reconfigures conversations, never answers native
// confirmations and never sends provider credentials. `close()` releases the
// local transport only: a run that is still going on the server keeps going
// there. `interrupt()` (POST /interrupt) is the only abort this handle sends.
//
// Turn protocol: GET the exact conversation and refuse to append into a run
// this handle did not start; POST /events with `run: false`; wait for the
// durable echo of our own user MessageEvent; POST /run. A turn settles only
// when (1) that run was acknowledged, (2) a durable `execution_status`
// transition to a terminal value (finished / error / stuck / paused /
// waiting_for_confirmation) was observed after the run was issued and (3) the
// transient `full_state` snapshot the server publishes at the end of the run
// carried that same status. Acknowledgements, `running`, recoverable
// AgentErrorEvents and stale snapshots never complete a turn; a missing
// barrier runs into the turn deadline.
import { randomUUID } from 'node:crypto'
import type WebSocket from 'ws'
import type { ErrorCode } from './base.js'
import { HarnessError } from './base.js'
import { DRAIN_MS, describeError } from './lifecycle.js'
import {
  CANONICAL_UUID, EventQueue, LiveSession, MAX_FRAME_BYTES, OPENHANDS_PROFILE_NAME, TurnCore, deadline, invalid, isJsonObject, requirePrompt,
} from './sessions.js'
import type {
  JsonObject, OpenHandsOptions, ResolvedSessionSpec, SessionEvent, SessionReference, SessionTurn, SessionTurnStatus,
} from './sessions.js'

/** The only server release this transport is qualified against; every package version reported by GET /server_info must equal it. */
const OPENHANDS_VERSION = '1.45.0'
const VERSION_FIELDS = ['version', 'sdk_version', 'tools_version', 'workspace_version'] as const
const UTF8 = new TextDecoder('utf-8', { fatal: true })
const EMPTY = new Uint8Array(0)

/** `ConversationExecutionStatus` of the pinned SDK. */
type ExecutionStatus = 'idle' | 'running' | 'paused' | 'waiting_for_confirmation' | 'finished' | 'error' | 'stuck' | 'deleting'

function isExecutionStatus(value: unknown): value is ExecutionStatus {
  return value === 'idle' || value === 'running' || value === 'paused' || value === 'waiting_for_confirmation' ||
    value === 'finished' || value === 'error' || value === 'stuck' || value === 'deleting'
}

/** Statuses the pre-submission check refuses: a run or confirmation this handle did not start, or a conversation being deleted. */
function isBusy(status: ExecutionStatus): boolean {
  return status === 'running' || status === 'waiting_for_confirmation' || status === 'deleting'
}

/** Values a durable `execution_status` transition may settle a turn with once the matching `full_state` snapshot follows. */
function isTerminal(status: ExecutionStatus): boolean {
  return status === 'finished' || status === 'error' || status === 'stuck' || status === 'paused' || status === 'waiting_for_confirmation'
}

function mediaType(value: string): string {
  const end = value.indexOf(';')
  return (end === -1 ? value : value.slice(0, end)).trim().toLowerCase()
}

/** `fetch` wraps the socket failure in a bare "fetch failed"; the cause names it. Never includes request or response bodies. */
function describeTransportError(err: unknown): string {
  if (err instanceof Error && err.cause instanceof Error) return `${err.message}: ${describeError(err.cause)}`
  return describeError(err)
}

/** Strict UTF-8 JSON; the parser's message is dropped because V8 quotes the offending body in it. */
function decodeJson(body: Uint8Array, what: string): unknown {
  try {
    return JSON.parse(UTF8.decode(body), (_key: string, value: unknown) => {
      if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('non-finite JSON number')
      return value
    })
  } catch {
    throw new HarnessError(`${what} is not strict UTF-8 JSON`, 'protocol-error')
  }
}

/** Startup mapping of an unexpected HTTP status: redirects are not followed, credentials are never echoed. */
function startupFailure(method: string, path: string, status: number): HarnessError {
  const detail = status === 0 || (status >= 300 && status < 400)
    ? `redirected (HTTP ${status}); redirects are not followed`
    : status === 401 || status === 403
      ? `rejected the credentials (HTTP ${status})`
      : status === 404
        ? 'answered HTTP 404 (not found)'
        : `answered HTTP ${status}`
  return new HarnessError(`${method} ${path} ${detail}`, 'launch-failed')
}

/** The concatenated text of a native `llm_message.content` list, or null when it is not a list of content objects. */
function contentText(content: unknown): string | null {
  if (!Array.isArray(content)) return null
  let text = ''
  for (const item of content) {
    if (!isJsonObject(item)) return null
    if (item.type === 'text' && typeof item.text === 'string') text += item.text
  }
  return text
}

function toBuffer(data: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(data)) return data
  if (Array.isArray(data)) return Buffer.concat(data)
  return Buffer.from(data)
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

interface AbortState {
  sent: boolean
  acked: boolean
  timer: NodeJS.Timeout
}

/** Identity of the selected server-side agent profile as returned by GET /api/agent-profiles/{name}. */
interface ProfileIdentity {
  readonly id: string
  readonly revision: number
}

class SocketTurn extends TurnCore {
  readonly prompt: string
  /** POST /events was issued (set before the request is awaited). */
  submitted = false
  /** POST /events answered 200 `{success: true}`. */
  eventsAcked = false
  /** Our user message was echoed as a durable MessageEvent. */
  echoSeen = false
  /** Bounds the user-echo handshake (`requestTimeoutSeconds`). */
  echoTimer: NodeJS.Timeout | null = null
  /** POST /run was issued (set before the request is awaited) / answered 200 `{success: true}`. */
  runIssued = false
  runAcked = false
  /** Durable terminal `execution_status` transition observed after the run was issued, with its native value. */
  terminal: { event: JsonObject; status: ExecutionStatus } | null = null
  /** The transient `full_state` value that followed `terminal` with the same status. */
  finalState: JsonObject | null = null
  /** Detail of the last durable ConversationErrorEvent / AgentErrorEvent of this turn. */
  lastError: string | null = null
  abort: AbortState | null = null

  constructor(id: string, queue: EventQueue, prompt: string) {
    super(id, queue)
    this.prompt = prompt
  }

  /** Native evidence retained for `result.raw`: the final snapshot and the durable terminal transition, once either exists. */
  get raw(): JsonObject | null {
    if (this.terminal === null) return null
    return { state: this.finalState, terminal_event: this.terminal.event }
  }
}

/**
 * A live OpenHands conversation over HTTP + WebSocket. Constructed only
 * through `LiveSession.open` (via `connect`), which qualifies the server and
 * the selected profile, creates or resumes the exact conversation and waits
 * for the session socket's `sync` frame before returning.
 */
export class OpenHandsSession extends LiveSession {
  readonly #options: Readonly<OpenHandsOptions>
  readonly #Socket: typeof WebSocket
  readonly #sessionQueue: EventQueue
  readonly #inflight = new Set<Inflight>()
  #reference: SessionReference | null = null
  #profile: ProfileIdentity | null = null
  #socket: WebSocket | null = null
  /** Settles once the owned socket emitted `close` (immediately while none was opened). */
  #socketClosed: Promise<void> = Promise.resolve()
  #sync: { resolve: () => void; reject: (err: HarnessError) => void } | null = null
  #synced = false
  /** Highest durable `seq` accepted so far; the `sync` baseline (`through_seq`, or -1 for an empty log) before any live durable frame. */
  #lastSeq = -1
  #ready = false
  #turnSeq = 0
  #active: SocketTurn | null = null
  #dead = false
  #teardown: Promise<void> | null = null

  private constructor(spec: ResolvedSessionSpec, options: Readonly<OpenHandsOptions>, socketClass: typeof WebSocket) {
    super(spec)
    this.#options = options
    this.#Socket = socketClass
    this.#sessionQueue = new EventQueue(spec.maxBufferBytes, () => {
      void this.#invalidate('protocol-error', `unconsumed session events exceeded maxBufferBytes (${spec.maxBufferBytes})`)
    })
  }

  /** Qualify the server and profile, establish the conversation identity and subscribe to its session socket. Rejects with every owned connection closed. */
  static async connect(spec: ResolvedSessionSpec): Promise<LiveSession> {
    if (spec.openhands === null) throw invalid('openhands options are required for an OpenHands session')
    let ws: typeof WebSocket
    try {
      // Node's peer is optional and Bun provides this module in its runtime;
      // static loading would make Node's optional dependency eager on import.
      ws = (await import('ws')).default
    } catch (err) {
      throw new HarnessError(`openhands sessions need the optional "ws" package (ws ^8), which could not be loaded: ${describeError(err)}`, 'launch-failed')
    }
    const session = new OpenHandsSession(spec, spec.openhands, ws)
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
   * Reserve the turn slot and submit the prompt as a native user message
   * (`run: false`), then start the run once the message was acknowledged and
   * echoed. Native HTTP rejections settle the turn as `agent-error`; a busy
   * conversation is refused before anything is appended.
   */
  startTurn(prompt: string): SessionTurn {
    requirePrompt(prompt)
    if (this.#dead) throw new HarnessError('session is closed', 'session-closed')
    if (this.#active !== null) {
      throw new HarnessError('a turn is still active; concurrent turns are unsupported', 'unsupported-capability')
    }
    const id = `turn-${++this.#turnSeq}`
    const turn = new SocketTurn(id, new EventQueue(this.spec.maxBufferBytes, () => {
      turn.eventsTruncated = true
      void this.#invalidate('protocol-error', `unconsumed events of ${id} exceeded maxBufferBytes (${this.spec.maxBufferBytes})`)
    }), prompt)
    this.#active = turn
    if (this.spec.timeoutSeconds !== null) {
      const seconds = this.spec.timeoutSeconds
      turn.timer = deadline(seconds, () => {
        void this.#invalidate('timed-out', `${id} exceeded timeoutSeconds (${seconds})`)
      })
    }
    void this.#submit(turn)
    return turn.handle
  }

  /**
   * POST /interrupt once, then wait for both its `{success: true}`
   * acknowledgement and the native paused/terminal outcome, bounded by
   * `requestTimeoutSeconds` end to end; exceeding it fails the handle as
   * `protocol-error`. A run that had already completed normally still
   * reports `completed`; the acknowledgement alone never means interrupted.
   */
  async interrupt(): Promise<void> {
    if (this.#dead) throw new HarnessError('session is closed', 'session-closed')
    const turn = this.#active
    if (turn === null) throw new HarnessError('no active turn to interrupt', 'unsupported-capability')
    if (turn.abort === null) {
      const seconds = this.spec.requestTimeoutSeconds
      const abort: AbortState = {
        sent: false,
        acked: false,
        timer: deadline(seconds, () => {
          this.#interruptFailed(turn, 'protocol-error', `interrupt of ${turn.id} did not settle within requestTimeoutSeconds (${seconds})`)
        }),
      }
      turn.abort = abort
      if (turn.runAcked) void this.#abort(turn, abort)
    }
    await turn.promise
  }

  /** Native confirmations are never answered by this handle; a `waiting_for_confirmation` run fails the turn instead. */
  respondApproval(): Promise<void> {
    return Promise.reject(new HarnessError('openhands live sessions cannot answer permission requests; only "opencode" supports respondApproval', 'unsupported-capability'))
  }

  /**
   * Idempotent, concurrent-safe: aborts every owned request, terminates the
   * owned socket, settles an active turn as `closed` and ends the idle
   * stream. The server is not contacted; a run still going there keeps going.
   */
  async close(): Promise<void> {
    await this.#invalidate('closed', null)
  }

  // ---- startup ----

  async #handshake(): Promise<void> {
    const info = await this.#startupObject('GET', '/server_info')
    for (const field of VERSION_FIELDS) {
      const value = info[field]
      if (typeof value !== 'string' || value === '') throw new HarnessError(`GET /server_info did not report a string ${field}`, 'protocol-error')
      if (value !== OPENHANDS_VERSION) {
        throw new HarnessError(`OpenHands server ${field} ${JSON.stringify(value)} is not the qualified ${OPENHANDS_VERSION}`, 'unsupported-backend')
      }
    }
    const profile = await this.#resolveProfile()
    this.#profile = profile
    const resume = this.spec.resume
    const workdir = this.spec.workdir
    let conversation: JsonObject
    let sessionId: string
    if (resume !== null) {
      sessionId = resume.sessionId
      conversation = await this.#startupObject('GET', `/api/conversations/${sessionId}`)
    } else {
      sessionId = randomUUID()
      const path = '/api/conversations'
      const reply = await this.#exchange('POST', path, {
        conversation_id: sessionId,
        agent_profile_id: profile.id,
        workspace: { kind: 'LocalWorkspace', working_dir: workdir },
        worktree: false,
        autotitle: false,
      })
      if (reply.status === 200) {
        throw new HarnessError(`POST ${path} answered HTTP 200 for the fresh conversation ${sessionId}: the ID already existed and an existing conversation is never reused`, 'protocol-error')
      }
      if (reply.status !== 201) throw startupFailure('POST', path, reply.status)
      conversation = this.#object(reply, `POST ${path}`)
    }
    this.#checkConversation(conversation, sessionId)
    this.#reference = Object.freeze({ sessionId, sessionFile: null, workdir, endpoint: this.#options.endpoint })
    await this.#subscribe()
  }

  /** GET the exact agent profile (never listed or seeded), then its referenced LLM profile without exposing secrets; verify the requested model. */
  async #resolveProfile(): Promise<ProfileIdentity> {
    const name = this.#options.agentProfile
    const agentPath = `/api/agent-profiles/${encodeURIComponent(name)}`
    const detail = await this.#startupObject('GET', agentPath)
    const profile = detail.profile
    if (detail.name !== name || !isJsonObject(profile) || profile.name !== name) {
      throw new HarnessError(`GET ${agentPath} did not return the agent profile ${JSON.stringify(name)}`, 'protocol-error')
    }
    const { id, revision, agent_kind: kind, llm_profile_ref: ref } = profile
    if (typeof id !== 'string' || !CANONICAL_UUID.test(id)) throw new HarnessError(`agent profile ${JSON.stringify(name)} has no canonical UUID id`, 'protocol-error')
    if (!Number.isSafeInteger(revision) || typeof revision !== 'number' || revision < 0) {
      throw new HarnessError(`agent profile ${JSON.stringify(name)} has no non-negative integer revision`, 'protocol-error')
    }
    if (kind === 'acp') {
      throw new HarnessError(`agent profile ${JSON.stringify(name)} selects an ACP agent; only native OpenHands agents (agent_kind "openhands") are supported`, 'unsupported-capability')
    }
    if (kind !== 'openhands') throw new HarnessError(`agent profile ${JSON.stringify(name)} has agent_kind ${JSON.stringify(kind)}, not "openhands"`, 'protocol-error')
    if (typeof ref !== 'string' || !OPENHANDS_PROFILE_NAME.test(ref)) {
      throw new HarnessError(`agent profile ${JSON.stringify(name)} has no valid llm_profile_ref`, 'protocol-error')
    }
    const llmPath = `/api/profiles/${encodeURIComponent(ref)}`
    const llm = await this.#startupObject('GET', llmPath)
    const config = llm.config
    if (llm.name !== ref || !isJsonObject(config)) throw new HarnessError(`GET ${llmPath} did not return the LLM profile ${JSON.stringify(ref)}`, 'protocol-error')
    if (config.model !== this.spec.model) {
      throw new HarnessError(`LLM profile ${JSON.stringify(ref)} declares model ${JSON.stringify(config.model)}, not the requested ${JSON.stringify(this.spec.model)}`, 'protocol-error')
    }
    return { id, revision }
  }

  /**
   * Identity, workspace, provenance and agent checks of a native
   * ConversationInfo; the same on create, resume and before every turn.
   * Throws `protocol-error`; returns the (known) execution status.
   */
  #checkConversation(info: JsonObject, sessionId: string): ExecutionStatus {
    const profile = this.#profile
    if (profile === null) throw new HarnessError('agent profile was not resolved', 'protocol-error')
    if (info.id !== sessionId) throw new HarnessError(`OpenHands returned conversation ${JSON.stringify(info.id)}, not ${sessionId}`, 'protocol-error')
    const workspace = info.workspace
    if (!isJsonObject(workspace) || workspace.kind !== 'LocalWorkspace' || workspace.working_dir !== this.spec.workdir) {
      throw new HarnessError(`conversation ${sessionId} runs in workspace ${JSON.stringify(workspace)}, not LocalWorkspace ${JSON.stringify(this.spec.workdir)}`, 'protocol-error')
    }
    const launched = info.launched_agent_profile
    if (!isJsonObject(launched) || launched.agent_profile_id !== profile.id || launched.revision !== profile.revision) {
      throw new HarnessError(`conversation ${sessionId} was launched from agent profile ${JSON.stringify(launched)}, not the selected ${profile.id} revision ${profile.revision}`, 'protocol-error')
    }
    const agent = info.agent
    if (!isJsonObject(agent) || agent.kind !== 'Agent' || !isJsonObject(agent.llm)) {
      throw new HarnessError(`conversation ${sessionId} is not driven by a native OpenHands Agent`, 'protocol-error')
    }
    if (agent.llm.model !== this.spec.model) {
      throw new HarnessError(`conversation ${sessionId} uses model ${JSON.stringify(agent.llm.model)}, not the requested ${JSON.stringify(this.spec.model)}`, 'protocol-error')
    }
    const status = info.execution_status
    if (!isExecutionStatus(status)) throw new HarnessError(`conversation ${sessionId} reports unknown execution_status ${JSON.stringify(status)}`, 'protocol-error')
    return status
  }

  /** Open the live-only session socket with the optional `ws` peer, authenticate with the first frame and wait for `sync` within `requestTimeoutSeconds`. */
  async #subscribe(): Promise<void> {
    if (this.#dead) throw new HarnessError('session is closed', 'session-closed')
    const sessionId = this.reference.sessionId
    const url = `${this.#options.endpoint.replace(/^http/, 'ws')}/sockets/session/${sessionId}`
    const seconds = this.spec.requestTimeoutSeconds
    const socket = new this.#Socket(url, {
      maxPayload: MAX_FRAME_BYTES,
      perMessageDeflate: false,
      followRedirects: false,
      skipUTF8Validation: false,
      handshakeTimeout: Math.min(seconds * 1000, 2_147_483_647),
    })
    this.#socket = socket
    this.#socketClosed = new Promise((done) => {
      socket.once('close', (code: number) => {
        done()
        this.#onSocketClose(code)
      })
    })
    socket.on('error', (err: Error) => this.#onSocketError(err))
    socket.on('open', () => {
      socket.send(JSON.stringify({ type: 'auth', session_api_key: this.#options.apiKey }))
    })
    socket.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
      if (this.#dead) return
      if (isBinary) {
        void this.#invalidate('protocol-error', 'session socket sent a binary frame; only text frames are valid')
        return
      }
      this.#onFrame(toBuffer(data))
    })
    const synced = new Promise<void>((resolve, reject) => {
      this.#sync = { resolve, reject }
    })
    const timer = deadline(seconds, () => {
      void this.#invalidate('protocol-error', `session socket sync plus initial full_state was not received within requestTimeoutSeconds (${seconds})`)
    })
    try {
      await synced
    } finally {
      clearTimeout(timer)
      this.#sync = null
    }
  }

  #onSocketError(err: Error): void {
    if (this.#dead) return
    const code = 'code' in err && typeof err.code === 'string' ? err.code : ''
    if (code.startsWith('WS_ERR_')) {
      void this.#invalidate('protocol-error', `session socket frame violation: ${err.message}`)
    } else {
      void this.#invalidate('disconnected', `session socket failed: ${describeError(err)}`)
    }
  }

  #onSocketClose(code: number): void {
    if (this.#dead) return
    if (code === 1002 || code === 1003 || code === 1007 || code === 1009) {
      void this.#invalidate('protocol-error', `session socket reported a protocol/data violation (close code ${code})`)
      return
    }
    if (!this.#synced) {
      const detail = code === 4001 ? 'rejected the credentials (close code 4001)' : code === 4004 ? 'reported the conversation as not found (close code 4004)' : `closed before sync (close code ${code})`
      void this.#invalidate('disconnected', `session socket ${detail}`)
      return
    }
    void this.#invalidate('disconnected', `the session socket closed (close code ${code}); no reconnect is attempted`)
  }

  // ---- HTTP ----

  /**
   * One bounded round trip (headers and body within `requestTimeoutSeconds`,
   * body capped at `MAX_FRAME_BYTES`). `/api/*` requests carry the session
   * key header; redirects are never followed. Throws `session-closed`,
   * `launch-failed` (transport) or `protocol-error` (timeout, oversize).
   */
  async #exchange(method: 'GET' | 'POST', path: string, json?: JsonObject): Promise<Reply> {
    if (this.#dead) throw new HarnessError('session is closed', 'session-closed')
    const seconds = this.spec.requestTimeoutSeconds
    const inflight: Inflight = { controller: new AbortController(), timer: null, reason: null }
    inflight.timer = deadline(seconds, () => {
      this.#abortInflight(inflight, new HarnessError(`${method} ${path} was not answered within requestTimeoutSeconds (${seconds})`, this.#ready ? 'protocol-error' : 'launch-failed'))
    })
    this.#inflight.add(inflight)
    const headers: Record<string, string> = { accept: 'application/json', connection: 'close' }
    if (path.startsWith('/api/')) headers['x-session-api-key'] = this.#options.apiKey
    let body: string | undefined
    if (json !== undefined) {
      headers['content-type'] = 'application/json'
      body = JSON.stringify(json)
    }
    try {
      let response: Response
      try {
        response = await fetch(`${this.#options.endpoint}${path}`, { method, headers, body, redirect: 'manual', signal: inflight.controller.signal })
      } catch (err) {
        if (this.#dead) throw new HarnessError('session is closed', 'session-closed')
        throw inflight.reason ?? new HarnessError(`${method} ${path} failed: ${describeTransportError(err)}`, 'launch-failed')
      }
      return { status: response.status, contentType: response.headers.get('content-type') ?? '', body: await this.#readBody(response, inflight) }
    } finally {
      this.#settleInflight(inflight)
    }
  }

  /** Stream the body up to `MAX_FRAME_BYTES`; anything larger aborts the request as a protocol error. */
  async #readBody(response: Response, inflight: Inflight): Promise<Uint8Array> {
    const stream = response.body
    if (stream === null) return EMPTY
    const reader = stream.getReader()
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

  /** The JSON object body of a reply; a non-JSON or non-object body is `protocol-error`. */
  #object(reply: Reply, what: string): JsonObject {
    if (mediaType(reply.contentType) !== 'application/json') {
      throw new HarnessError(`${what} answered content-type ${JSON.stringify(reply.contentType)}, not application/json`, 'protocol-error')
    }
    const parsed = decodeJson(reply.body, `${what} response`)
    if (!isJsonObject(parsed)) throw new HarnessError(`${what} response is not a JSON object`, 'protocol-error')
    return parsed
  }

  /** Startup GET: any non-200 is `launch-failed`; a malformed 200 is `protocol-error`. */
  async #startupObject(method: 'GET', path: string): Promise<JsonObject> {
    const reply = await this.#exchange(method, path)
    if (reply.status !== 200) throw startupFailure(method, path, reply.status)
    return this.#object(reply, `${method} ${path}`)
  }

  /** The JSON body of a rejected request, when it is a JSON object; retained in `result.raw` next to the numeric status. */
  #rejection(reply: Reply): JsonObject {
    let body: JsonObject | null = null
    try {
      const parsed = decodeJson(reply.body, 'error response')
      if (isJsonObject(parsed)) body = parsed
    } catch {
      // a non-JSON error body is simply not retained
    }
    return { http_status: reply.status, body }
  }

  /** `{success: true}` acknowledgement of a mutating request; anything else is `protocol-error` (reported by the caller). */
  #acknowledged(reply: Reply): boolean {
    if (mediaType(reply.contentType) !== 'application/json') return false
    try {
      const parsed = decodeJson(reply.body, 'acknowledgement')
      return isJsonObject(parsed) && parsed.success === true
    } catch {
      return false
    }
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

  /** A request of an active turn failed at the transport or protocol level: the handle is invalid (ignored once the turn or session already ended). */
  #turnRequestFailed(turn: SocketTurn, what: string, err: unknown): void {
    if (this.#dead || turn.done) return
    const failure = err instanceof HarnessError ? err : new HarnessError(describeTransportError(err), 'launch-failed')
    void this.#invalidate(failure.code === 'launch-failed' ? 'disconnected' : 'protocol-error', `${what} of ${turn.id} failed: ${failure.message}`)
  }

  // ---- turns ----

  /** Re-verify the exact conversation and refuse to append into a run this handle did not start; then POST /events with `run: false`. */
  async #submit(turn: SocketTurn): Promise<void> {
    const sessionId = this.reference.sessionId
    const conversationPath = `/api/conversations/${sessionId}`
    let reply: Reply
    try {
      reply = await this.#exchange('GET', conversationPath)
    } catch (err) {
      this.#turnRequestFailed(turn, 'pre-submission check', err)
      return
    }
    if (this.#dead || turn.done) return
    if (reply.status !== 200) {
      void this.#invalidate('protocol-error', `GET ${conversationPath} answered HTTP ${reply.status} before the prompt of ${turn.id}`)
      return
    }
    let info: JsonObject
    let status: ExecutionStatus
    try {
      info = this.#object(reply, `GET ${conversationPath}`)
      status = this.#checkConversation(info, sessionId)
    } catch (err) {
      void this.#invalidate('protocol-error', err instanceof Error ? err.message : String(err))
      return
    }
    if (isBusy(status)) {
      this.#finishTurn(turn, 'agent-error', info, `conversation ${sessionId} is ${status}; the prompt of ${turn.id} was not sent because this handle did not start that run`)
      return
    }
    turn.submitted = true
    const seconds = this.spec.requestTimeoutSeconds
    turn.echoTimer = deadline(seconds, () => {
      void this.#invalidate('protocol-error', `the user message of ${turn.id} was not echoed by the session socket within requestTimeoutSeconds (${seconds})`)
    })
    const eventsPath = `${conversationPath}/events`
    try {
      reply = await this.#exchange('POST', eventsPath, { role: 'user', content: [{ type: 'text', text: turn.prompt }], run: false })
    } catch (err) {
      this.#turnRequestFailed(turn, 'prompt', err)
      return
    }
    if (this.#dead || turn.done) return
    if (reply.status !== 200) {
      this.#finishTurn(turn, 'agent-error', this.#rejection(reply), `POST ${eventsPath} was rejected with HTTP ${reply.status}`)
      return
    }
    if (!this.#acknowledged(reply)) {
      void this.#invalidate('protocol-error', `POST ${eventsPath} did not acknowledge the prompt of ${turn.id} with {success: true}`)
      return
    }
    turn.eventsAcked = true
    this.#maybeRun(turn)
  }

  /** POST /run once the message was acknowledged and echoed; an early interrupt waits until this owned run is accepted. */
  #maybeRun(turn: SocketTurn): void {
    if (this.#dead || turn.done || turn.runIssued || !turn.eventsAcked || !turn.echoSeen) return
    turn.runIssued = true
    void this.#run(turn)
  }

  async #run(turn: SocketTurn): Promise<void> {
    const runPath = `/api/conversations/${this.reference.sessionId}/run`
    let reply: Reply
    try {
      reply = await this.#exchange('POST', runPath)
    } catch (err) {
      this.#turnRequestFailed(turn, 'run', err)
      return
    }
    if (this.#dead || turn.done) return
    if (reply.status !== 200) {
      this.#finishTurn(turn, 'agent-error', this.#rejection(reply), `POST ${runPath} was rejected with HTTP ${reply.status}`)
      return
    }
    if (!this.#acknowledged(reply)) {
      void this.#invalidate('protocol-error', `POST ${runPath} did not acknowledge the run of ${turn.id} with {success: true}`)
      return
    }
    turn.runAcked = true
    this.#maybeComplete(turn)
    if (!turn.done && turn.abort !== null) void this.#abort(turn, turn.abort)
  }

  #interruptFailed(turn: SocketTurn, status: 'protocol-error' | 'disconnected', error: string): void {
    if (this.#dead || turn.done) return
    // Preserve observed native completion, but close in the same loop tick:
    // a failed mutation must never release a usable follow-up slot.
    this.#maybeComplete(turn, true)
    void this.#invalidate(status, error)
  }

  async #abort(turn: SocketTurn, abort: AbortState): Promise<void> {
    if (this.#dead || turn.done || abort.sent) return
    abort.sent = true
    const interruptPath = `/api/conversations/${this.reference.sessionId}/interrupt`
    let reply: Reply
    try {
      reply = await this.#exchange('POST', interruptPath)
    } catch (err) {
      const failure = err instanceof HarnessError ? err : new HarnessError(describeTransportError(err), 'launch-failed')
      this.#interruptFailed(turn, failure.code === 'launch-failed' ? 'disconnected' : 'protocol-error', `interrupt of ${turn.id} failed: ${failure.message}`)
      return
    }
    if (this.#dead || turn.done) return
    if (reply.status !== 200 || !this.#acknowledged(reply)) {
      this.#interruptFailed(turn, 'protocol-error', `interrupt of ${turn.id} was not acknowledged with {success: true} (HTTP ${reply.status})`)
      return
    }
    abort.acked = true
    this.#maybeComplete(turn)
  }

  /** The native completion barrier also waits for a pending interrupt. A failed
   * interrupt may preserve finished/error/stuck only while closing the handle. */
  #maybeComplete(turn: SocketTurn, interruptFailed = false): void {
    if (this.#dead || turn.done) return
    const terminal = turn.terminal
    const state = turn.finalState
    if (!turn.echoSeen || !turn.runIssued || !turn.runAcked || terminal === null || state === null) return
    if (turn.abort?.sent && !turn.abort.acked) {
      if (!interruptFailed || (terminal.status !== 'finished' && terminal.status !== 'error' && terminal.status !== 'stuck')) return
    }
    const raw = { state, terminal_event: terminal.event }
    switch (terminal.status) {
      case 'finished':
        this.#finishTurn(turn, 'completed', raw, null)
        return
      case 'paused':
        this.#finishTurn(turn, 'interrupted', raw, null)
        return
      case 'stuck':
        this.#finishTurn(turn, 'stuck', raw, 'native stuck detection stopped the run (execution_status "stuck")')
        return
      case 'error':
        this.#finishTurn(turn, 'agent-error', raw, turn.lastError ?? 'the native run ended with execution_status "error"')
        return
      case 'waiting_for_confirmation': {
        const message = `the native run of ${turn.id} stopped for approval (execution_status "waiting_for_confirmation"); approvals are unsupported on openhands and this handle never answers, resumes or rejects them, so the handle is released while the conversation stays pending on the server`
        this.#finishTurn(turn, 'agent-error', raw, message)
        void this.#invalidate('agent-error', message)
        return
      }
      default:
        return
    }
  }

  #finishTurn(turn: SocketTurn, status: SessionTurnStatus, raw: JsonObject | null, error: string | null): void {
    if (turn.done) return
    turn.done = true
    clearTimeout(turn.timer)
    clearTimeout(turn.echoTimer ?? undefined)
    if (turn.abort !== null) clearTimeout(turn.abort.timer)
    if (this.#active === turn) this.#active = null
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

  // ---- session socket ----

  /**
   * One text frame of the session socket. The first must be `sync`; durable
   * frames must continue the sequence strictly (duplicates, gaps and anything
   * at or below the baseline are protocol errors, never silently reconciled).
   * Known frame and event shapes are validated; unknown outer types and
   * inner kinds pass through in wire order with the whole envelope as `raw`.
   */
  #onFrame(bytes: Buffer): void {
    if (bytes.length > MAX_FRAME_BYTES) {
      void this.#invalidate('protocol-error', `session socket frame exceeds ${MAX_FRAME_BYTES} bytes`)
      return
    }
    let frame: unknown
    try {
      frame = decodeJson(bytes, 'session socket frame')
    } catch {
      void this.#invalidate('protocol-error', 'session socket frame is not strict UTF-8 JSON')
      return
    }
    if (!isJsonObject(frame)) {
      void this.#invalidate('protocol-error', 'session socket frame is not a JSON object')
      return
    }
    const type = frame.type
    if (typeof type !== 'string' || type === '') {
      void this.#invalidate('protocol-error', 'session socket frame has no string "type"')
      return
    }
    if (!this.#synced) {
      if (type !== 'sync') {
        void this.#invalidate('protocol-error', `first session socket frame was ${JSON.stringify(type)}, not sync`)
        return
      }
      const { from_seq: fromSeq, through_seq: throughSeq } = frame
      if (fromSeq !== undefined && fromSeq !== null) {
        void this.#invalidate('protocol-error', 'sync frame echoes a replay cursor although none was requested')
        return
      }
      if (throughSeq !== undefined && throughSeq !== null && (!Number.isSafeInteger(throughSeq) || typeof throughSeq !== 'number' || throughSeq < 0)) {
        void this.#invalidate('protocol-error', 'sync frame has a malformed through_seq')
        return
      }
      this.#lastSeq = typeof throughSeq === 'number' ? throughSeq : -1
      this.#synced = true
      this.#route(frame, type, null, bytes.length)
      return
    }
    if (type === 'sync') {
      void this.#invalidate('protocol-error', 'session socket sent a second sync frame')
      return
    }
    if (type === 'error') {
      if (typeof frame.code !== 'string' || typeof frame.detail !== 'string') {
        void this.#invalidate('protocol-error', 'session socket error frame has no string code / detail')
        return
      }
      this.#route(frame, type, null, bytes.length)
      void this.#invalidate('protocol-error', `session socket reported an error frame (${frame.code}); this handle only ever sends the auth frame`)
      return
    }
    if (type !== 'durable' && type !== 'transient') {
      this.#route(frame, type, null, bytes.length)
      return
    }
    const event = frame.event
    if (!isJsonObject(event) || typeof event.kind !== 'string' || event.kind === '' || typeof event.id !== 'string' || event.id === '') {
      void this.#invalidate('protocol-error', `${type} frame carries no native event with string "kind" and "id"`)
      return
    }
    if (type === 'durable') {
      const seq = frame.seq
      if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) {
        void this.#invalidate('protocol-error', 'durable frame has no non-negative integer seq')
        return
      }
      if (seq !== this.#lastSeq + 1) {
        void this.#invalidate('protocol-error', `durable frame seq ${seq} does not continue ${this.#lastSeq} (duplicate, backward or gap; the live-only subscription is not reconciled)`)
        return
      }
      this.#lastSeq = seq
    }
    const problem = this.#validateEvent(event)
    if (problem !== null) {
      void this.#invalidate('protocol-error', `${event.kind} event ${problem}`)
      return
    }
    const turn = this.#active !== null && !this.#active.done ? this.#active : null
    this.#route(frame, event.kind, event.id, bytes.length)
    if (type === 'transient' && event.kind === 'ConversationStateUpdateEvent' && event.key === 'full_state') this.#sync?.resolve()
    if (turn !== null) this.#onTurnEvent(turn, type, event)
  }

  /** Shape checks for the native event kinds this transport interprets; unknown kinds are not inspected. */
  #validateEvent(event: JsonObject): string | null {
    if (event.kind === 'ConversationStateUpdateEvent') {
      if (typeof event.key !== 'string') return 'has no string key'
      if (event.key === 'execution_status' && !isExecutionStatus(event.value)) return `carries unknown execution_status ${JSON.stringify(event.value)}`
      if (event.key === 'full_state' && (!isJsonObject(event.value) || !isExecutionStatus(event.value.execution_status))) {
        return 'full_state snapshot has no known execution_status'
      }
    } else if (event.kind === 'MessageEvent') {
      if (typeof event.source !== 'string') return 'has no string source'
      const message = event.llm_message
      if (!isJsonObject(message) || typeof message.role !== 'string' || !Array.isArray(message.content)) return 'has no llm_message with role and content list'
    }
    return null
  }

  /** Turn correlation from a validated durable/transient native event (already surfaced). */
  #onTurnEvent(turn: SocketTurn, frameType: string, event: JsonObject): void {
    const kind = event.kind
    if (frameType === 'durable' && kind === 'MessageEvent') {
      const message = event.llm_message
      if (turn.submitted && !turn.echoSeen && event.source === 'user' && isJsonObject(message) && message.role === 'user' && contentText(message.content) === turn.prompt) {
        turn.echoSeen = true
        clearTimeout(turn.echoTimer ?? undefined)
        turn.echoTimer = null
        this.#maybeRun(turn)
      }
      return
    }
    if (kind === 'ConversationStateUpdateEvent') {
      if (frameType === 'durable' && event.key === 'execution_status') {
        const value = event.value
        if (turn.runIssued && turn.finalState === null) {
          turn.terminal = isExecutionStatus(value) && isTerminal(value) ? { event, status: value } : null
        }
      } else if (frameType === 'transient' && event.key === 'full_state') {
        const value = event.value
        if (turn.terminal !== null && turn.finalState === null && isJsonObject(value)) {
          if (value.execution_status === turn.terminal.status) turn.finalState = value
          else turn.terminal = null
          this.#maybeComplete(turn)
        }
      }
      return
    }
    if (frameType === 'durable' && kind === 'ConversationErrorEvent' && typeof event.detail === 'string' && event.detail !== '') {
      turn.lastError = event.detail
    } else if (frameType === 'durable' && kind === 'AgentErrorEvent' && typeof event.error === 'string' && event.error !== '') {
      turn.lastError = event.error
    }
  }

  #route(frame: JsonObject, type: string, requestId: string | null, bytes: number): void {
    if (this.#dead || this.#reference === null) return
    const turn = this.#active !== null && !this.#active.done ? this.#active : null
    const event: SessionEvent = {
      backend: this.spec.backend,
      harness: this.spec.harness,
      sessionId: this.#reference.sessionId,
      turnId: turn === null ? null : turn.id,
      requestId,
      type,
      raw: frame,
    }
    ;(turn === null ? this.#sessionQueue : turn.queue).push(event, bytes)
  }

  // ---- teardown ----

  /**
   * Fail or close the session once: abort every owned request, terminate the
   * owned socket, wait (bounded) for it to close, settle the active turn with
   * `status` (keeping any native evidence already received as `raw`) and end
   * the idle event stream. Nothing is sent to the server.
   */
  #invalidate(status: SessionTurnStatus, error: string | null): Promise<void> {
    if (this.#teardown !== null) return this.#teardown
    this.#dead = true
    const rejectCode: ErrorCode =
      status === 'closed' ? 'session-closed' : status === 'protocol-error' || status === 'timed-out' ? 'protocol-error' : 'launch-failed'
    const reason = new HarnessError(error ?? 'session closed', rejectCode)
    if (this.#sync !== null) this.#sync.reject(reason)
    for (const inflight of this.#inflight) this.#abortInflight(inflight, reason)
    const turn = this.#active
    if (turn !== null) {
      clearTimeout(turn.timer)
      clearTimeout(turn.echoTimer ?? undefined)
      if (turn.abort !== null) clearTimeout(turn.abort.timer)
    }
    const socket = this.#socket
    if (socket !== null) socket.terminate()
    this.#teardown = Promise.race([
      this.#socketClosed,
      new Promise<void>((done) => setTimeout(done, DRAIN_MS)),
    ]).then(() => {
      if (turn !== null) this.#finishTurn(turn, status, turn.raw, error)
      this.#sessionQueue.end()
    })
    return this.#teardown
  }
}
