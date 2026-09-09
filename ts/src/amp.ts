// Amp live sessions: the caller-installed @ampcode/sdk (pinned
// 0.1.0-20260823161614-g3631dc6) driving the pinned native CLI
// (0.0.1788883237-g0b98e3) through the shared worker
// `src/harness/_amp_sdk.mjs`. Loaded lazily by sessions.ts; nothing here
// imports the SDK or talks to the CLI directly.
//
// Ownership: one finite Node worker process group per operation (`open`,
// then one per turn), each run through the shared subprocess runner, which
// supplies the bounded stdout/stderr capture, the wall deadline,
// cancellation and the TERM → KILL → drain teardown of the whole group (the
// worker, the SDK's CLI child and its descendants). The workdir lease with
// any projected AGENTS.md is held from `open` until `close()`.
//
// Worker protocol: one JSON request on stdin, strict JSONL envelopes on
// stdout. `open`: `amp_open` (thread identity) then `amp_done` completed.
// `turn`: native events as `amp_event` (the ones before the native init may
// precede `amp_open`), `amp_open` once the native init validated identity and
// cwd, then more `amp_event`s and one `amp_done` carrying the last native
// result and the CLI's observed exit. `amp_error` is only the sole envelope of
// a preflight failure. The worker exits 0 after its terminal envelope. A
// native failure keeps its `amp_done` status on the turn (the session stays
// open; the next turn is a fresh worker against the same thread), a native
// or parent-detected protocol violation, a worker that failed on its own, a
// deadline or `close()` invalidates the session. A turn completes only after
// the worker's process group is gone, never on the envelope alone, and never
// on the native assistant's stop reason.
import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ErrorCode, SubprocOutcome } from './base.js'
import { HarnessError } from './base.js'
import { cleanupCommand, prepareCommand } from './instructions.js'
import type { PreparedCommand } from './instructions.js'
import { assertSupportedPlatform, describeError } from './lifecycle.js'
import { getAdapter } from './registry.js'
import {
  AMP_THREAD_ID, EventQueue, LiveSession, MAX_FRAME_BYTES, STDERR_EXCERPT, TurnCore, deadline, invalid, isJsonObject, requirePrompt, samePath,
} from './sessions.js'
import type {
  JsonObject, ResolvedAmpSdkOptions, ResolvedSessionSpec, SessionEvent, SessionReference, SessionTurn, SessionTurnStatus,
} from './sessions.js'
import { runSubprocessAsync } from './subproc.js'

type Operation = 'open' | 'turn'

/** Native outcome a worker reports in `amp_done`; the CLI's own exit metadata, never a worker status. */
type DoneStatus = 'completed' | 'agent-error' | 'protocol-error' | 'exited' | 'signaled'
const DONE_STATUSES: readonly string[] = ['completed', 'agent-error', 'protocol-error', 'exited', 'signaled']
const ERROR_CODES: readonly string[] = ['launch-failed', 'invalid-options', 'unsupported-capability']

interface Done {
  status: DoneStatus
  raw: JsonObject | null
  error: string | null
  exitCode: number | null
  signal: string | null
}

/** How an operation ended once its worker group is gone; `fatal` invalidates the session. */
interface Verdict {
  status: SessionTurnStatus
  error: string | null
  fatal: boolean
  /** Rejection code when the operation was `open`. */
  code: ErrorCode
}

/** One finite worker run: its process group (through the runner), the stdout frame parser state and everything it reported. */
class Run {
  readonly kind: Operation
  readonly controller = new AbortController()
  outcome!: Promise<Required<SubprocOutcome> | null>
  /** The runner's outcome once settled; null until then or when supervision itself failed (`supervision`). */
  result: Required<SubprocOutcome> | null = null
  supervision: unknown = null
  /** Undelivered text after the last newline. */
  tail = ''
  opened: SessionReference | null = null
  done: Done | null = null
  /** `amp_error`: the worker never reached the SDK. */
  failure: HarnessError | null = null
  /** First envelope the parent could not validate; the group is stopped as soon as it is set. */
  violation: string | null = null
  events = 0

  constructor(kind: Operation) {
    this.kind = kind
  }
}

class AmpTurn extends TurnCore {
  run: Run | null = null
  interrupted = false
}

function isDoneStatus(value: unknown): value is DoneStatus {
  return typeof value === 'string' && DONE_STATUSES.includes(value)
}

function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && ERROR_CODES.includes(value)
}

/**
 * The worker's `amp_done` is authoritative for the native outcome. Native
 * completion, agent errors and CLI exits settle the turn only (the next turn
 * starts a fresh worker against the same thread); a native protocol error,
 * observed by the worker's guarded parser, invalidates the session.
 */
function nativeVerdict(done: Done): Verdict {
  return { status: done.status, error: done.error, fatal: done.status === 'protocol-error', code: done.status === 'protocol-error' ? 'protocol-error' : 'launch-failed' }
}

/**
 * The Amp SDK worker: `src/harness/_amp_sdk.mjs` next to the Python package
 * when running from source (`amp.ts`), the build-time copy `amp-sdk.mjs`
 * beside the bundle otherwise. Resolved by path only; the SDK itself is
 * loaded by the worker, never imported here.
 */
function ampSdkWorkerPath(): string {
  const source = basename(fileURLToPath(import.meta.url)) === 'amp.ts'
  return fileURLToPath(new URL(source ? '../../src/harness/_amp_sdk.mjs' : './amp-sdk.mjs', import.meta.url))
}

/**
 * A live Amp session. Constructed only through `LiveSession.open` (via
 * `launch`), which takes the lease, runs the `open` worker to create or
 * verify the native thread and adopts its identity before returning.
 */
export class AmpSession extends LiveSession {
  readonly #options: ResolvedAmpSdkOptions
  readonly #executable: string
  readonly #worker: string
  readonly #prepared: PreparedCommand
  readonly #sessionQueue: EventQueue
  #reference: SessionReference | null = null
  #run: Run | null = null
  #turnSeq = 0
  #active: AmpTurn | null = null
  #dead = false
  /** Why the session was invalidated; what an in-flight `open` rejects with. */
  #failure: HarnessError | null = null
  #teardown: Promise<void> | null = null
  #cleanupError: unknown = null

  private constructor(spec: ResolvedSessionSpec, options: ResolvedAmpSdkOptions, executable: string, worker: string, prepared: PreparedCommand) {
    super(spec)
    this.#options = options
    this.#executable = executable
    this.#worker = worker
    this.#prepared = prepared
    this.#sessionQueue = new EventQueue(spec.maxBufferBytes, () => {
      void this.#invalidate('protocol-error', `unconsumed session events exceeded maxBufferBytes (${spec.maxBufferBytes})`)
    })
  }

  /** Take the workdir lease, run the `open` worker and adopt the thread identity. Rejects with the group stopped and the lease released. */
  static async launch(spec: ResolvedSessionSpec): Promise<LiveSession> {
    const options = spec.ampSdk
    if (options === null) throw invalid('ampSdk options are required for an Amp session')
    const executable = spec.executable
    if (executable === null) throw invalid('harness "amp" resolved without a worker runtime executable')
    assertSupportedPlatform()
    const worker = ampSdkWorkerPath()
    if (!existsSync(worker)) throw new HarnessError(`Amp SDK worker is missing at ${worker}`, 'launch-failed')
    const adapter = getAdapter(spec.harness)
    const prepared = prepareCommand({
      cmd: executable,
      args: [worker],
      cwd: spec.workdir,
      env: { ...spec.env },
      instructionsFile: join(spec.workdir, adapter.instructionsFilename),
      ...(spec.instructions === null ? {} : { instructionContent: spec.instructions }),
    })
    const session = new AmpSession(spec, options, executable, worker, prepared)
    try {
      await session.#open()
    } catch (err) {
      await session.#invalidate('closed', null)
      if (session.#cleanupError !== null) throw session.#cleanupError
      throw err
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
   * Reserve the turn slot and start one `turn` worker for the explicit thread
   * ID. The native init must report the identity within
   * `requestTimeoutSeconds`; the whole run is bounded by `timeoutSeconds`.
   */
  startTurn(prompt: string): SessionTurn {
    requirePrompt(prompt)
    if (this.#dead) throw new HarnessError('session is closed', 'session-closed')
    if (this.#active !== null || this.#run !== null) {
      throw new HarnessError('a turn is still active; concurrent turns are unsupported', 'unsupported-capability')
    }
    const id = `turn-${++this.#turnSeq}`
    const turn = new AmpTurn(id, new EventQueue(this.spec.maxBufferBytes, () => {
      turn.eventsTruncated = true
      void this.#invalidate('protocol-error', `unconsumed events of ${id} exceeded maxBufferBytes (${this.spec.maxBufferBytes})`)
    }))
    this.#active = turn
    const seconds = this.spec.requestTimeoutSeconds
    turn.timer = deadline(seconds, () => {
      void this.#invalidate('protocol-error', `${id} native initialization did not report the thread within requestTimeoutSeconds (${seconds})`)
    })
    let run: Run
    try {
      run = this.#start('turn', prompt)
    } catch (err) {
      clearTimeout(turn.timer)
      this.#active = null
      throw err
    }
    turn.run = run
    void this.#await(turn, run)
    return turn.handle
  }

  /**
   * Stop the active turn's worker group. Resolves once the turn settled: as
   * `interrupted`, or with the native outcome when the worker had already
   * reported `amp_done`. The session stays open for the next explicit-ID turn.
   */
  async interrupt(): Promise<void> {
    if (this.#dead) throw new HarnessError('session is closed', 'session-closed')
    const turn = this.#active
    if (turn === null) throw new HarnessError('no active turn to interrupt', 'unsupported-capability')
    if (!turn.interrupted) {
      turn.interrupted = true
      turn.run?.controller.abort()
    }
    await turn.promise
  }

  /** The Amp SDK exposes no permission replies; approvals stay inside the CLI. */
  respondApproval(): Promise<void> {
    return Promise.reject(new HarnessError('amp live sessions cannot answer permission requests; only "opencode" supports respondApproval', 'unsupported-capability'))
  }

  /** Idempotent, concurrent-safe: stop any in-flight worker group, settle the active turn as `closed`, release the lease. Cleanup failures are rethrown. */
  async close(): Promise<void> {
    await this.#invalidate('closed', null)
    if (this.#cleanupError !== null) throw this.#cleanupError
  }

  // ---- operations ----

  /** Run the `open` worker to completion and require the completed identity. Throws the failure to report; teardown is the caller's. */
  async #open(): Promise<void> {
    const run = this.#start('open', null)
    const outcome = await run.outcome
    if (this.#run === run) this.#run = null
    if (this.#failure !== null) throw this.#failure
    if (outcome === null) throw new HarnessError(`Amp SDK worker supervision failed: ${describeError(run.supervision)}`, 'launch-failed')
    const verdict = this.#classify(run, outcome, null)
    if (verdict.status === 'completed' && !verdict.fatal && this.#reference !== null) return
    const excerpt = outcome.stderr.trim().slice(0, STDERR_EXCERPT)
    const error = verdict.error ?? `open ended as ${verdict.status}`
    throw new HarnessError(`${error}${excerpt === '' ? '' : `; stderr: ${excerpt}`}`, verdict.code)
  }

  /** Spawn one worker through the shared runner with the request on stdin. Synchronous up to the spawn. */
  #start(kind: Operation, prompt: string | null): Run {
    const options = this.#options
    const spec = this.spec
    const sessionId = this.#reference?.sessionId ?? spec.resume?.sessionId ?? null
    const request: JsonObject = {
      operation: kind,
      packageRoot: options.packageRoot,
      cliPath: options.cliPath,
      executor: options.executor,
      mode: options.mode,
      ...(options.effort === undefined ? {} : { effort: options.effort }),
      // Creation only: validation already rejected visibility together with resume.
      ...(kind === 'open' && options.visibility !== undefined ? { visibility: options.visibility } : {}),
      ...(options.settingsFile === undefined ? {} : { settingsFile: options.settingsFile }),
      cwd: spec.workdir,
      endpoint: options.endpoint,
      sessionId,
      ...(prompt === null ? {} : { prompt }),
      maxBufferBytes: spec.maxBufferBytes,
    }
    const run = new Run(kind)
    run.outcome = runSubprocessAsync([this.#executable, this.#worker], {
      cwd: spec.workdir,
      timeoutSeconds: kind === 'open' ? spec.requestTimeoutSeconds : spec.timeoutSeconds,
      maxOutputBytes: spec.maxBufferBytes,
      stdin: `${JSON.stringify(request)}\n`,
      extraEnv: { ...spec.env },
      cancel: run.controller.signal,
      onOutput: (chunk, stream) => {
        if (stream === 'stdout') this.#onStdout(run, chunk)
      },
    }).then(
      (outcome) => {
        run.result = outcome
        return outcome
      },
      (err: unknown) => {
        // Only programming errors or a group that could not be reaped: ownership of live resources is not released.
        run.supervision = err
        this.#cleanupError ??= err instanceof HarnessError ? err : new HarnessError(`Amp SDK worker supervision failed: ${describeError(err)}`, 'adapter-error')
        return null
      },
    )
    this.#run = run
    return run
  }

  /** Settle a turn once its worker group is gone; a fatal verdict invalidates the session instead. */
  async #await(turn: AmpTurn, run: Run): Promise<void> {
    const outcome = await run.outcome
    if (this.#run === run) this.#run = null
    if (this.#dead) return // invalidation owns the settlement
    if (outcome === null) {
      void this.#invalidate('disconnected', `Amp SDK worker supervision failed: ${describeError(run.supervision)}`)
      return
    }
    const verdict = this.#classify(run, outcome, turn)
    if (verdict.fatal) {
      void this.#invalidate(verdict.status, verdict.error)
      return
    }
    this.#finishTurn(turn, verdict.status, verdict.error)
  }

  /** Classify a finished run: parent-detected violations first, then the runner's termination, then what the worker reported. */
  #classify(run: Run, outcome: Required<SubprocOutcome>, turn: AmpTurn | null): Verdict {
    // The runner's wall deadline is `requestTimeoutSeconds` for open and `timeoutSeconds` for turns.
    if (run.violation !== null) return { status: 'protocol-error', error: run.violation, fatal: true, code: 'protocol-error' }
    if (run.failure !== null) {
      return { status: 'disconnected', error: run.failure.message, fatal: true, code: run.failure.code }
    }
    switch (outcome.termination) {
      case 'launch-failed':
        return { status: 'disconnected', error: `Amp SDK worker could not be launched: ${outcome.launchError ?? 'EIO'}`, fatal: true, code: 'launch-failed' }
      case 'timed-out':
        return {
          status: 'timed-out',
          error: turn === null
            ? `open did not complete within requestTimeoutSeconds (${this.spec.requestTimeoutSeconds})`
            : `${turn.id} exceeded timeoutSeconds (${String(this.spec.timeoutSeconds)})`,
          fatal: true,
          code: 'protocol-error',
        }
      case 'callback-error':
        return { status: 'protocol-error', error: outcome.callbackError ?? 'stdout delivery failed', fatal: true, code: 'protocol-error' }
      case 'cancelled':
        if (run.done !== null) return nativeVerdict(run.done)
        if (turn !== null && turn.interrupted) return { status: 'interrupted', error: null, fatal: false, code: 'session-closed' }
        return { status: 'closed', error: null, fatal: true, code: 'session-closed' }
      case 'exited':
      case 'signaled':
        break
    }
    if (run.tail !== '') return { status: 'protocol-error', error: 'stdout ended inside an unterminated frame', fatal: true, code: 'protocol-error' }
    if (run.done !== null && (outcome.exitCode !== 0 || outcome.termination === 'signaled')) {
      return { status: 'protocol-error', error: 'Amp SDK worker failed after amp_done', fatal: true, code: 'protocol-error' }
    }
    if (outcome.termination === 'signaled') {
      return { status: 'signaled', error: `Amp SDK worker was terminated by ${outcome.signal ?? 'a signal'}`, fatal: true, code: 'launch-failed' }
    }
    if (outcome.exitCode !== 0) {
      return { status: 'exited', error: `Amp SDK worker exited with code ${outcome.exitCode}${run.done === null ? '' : ' after amp_done'}`, fatal: true, code: 'launch-failed' }
    }
    if (run.done === null) return { status: 'protocol-error', error: 'Amp SDK worker exited without amp_done', fatal: true, code: 'protocol-error' }
    return nativeVerdict(run.done)
  }

  // ---- stdout framing ----

  #onStdout(run: Run, text: string): void {
    if (run.violation !== null || this.#dead) return
    const data = run.tail + text
    let from = 0
    for (;;) {
      const at = data.indexOf('\n', from)
      if (at === -1) {
        run.tail = data.slice(from)
        if (Buffer.byteLength(run.tail) > MAX_FRAME_BYTES) this.#fail(run, `stdout frame exceeds ${MAX_FRAME_BYTES} bytes`)
        return
      }
      let line = data.slice(from, at)
      from = at + 1
      if (line.endsWith('\r')) line = line.slice(0, -1)
      if (line !== '') this.#onLine(run, line)
      if (run.violation !== null || this.#dead) {
        run.tail = ''
        return
      }
    }
  }

  #onLine(run: Run, line: string): void {
    const bytes = Buffer.byteLength(line)
    if (bytes > MAX_FRAME_BYTES) {
      this.#fail(run, `stdout frame exceeds ${MAX_FRAME_BYTES} bytes`)
      return
    }
    let frame: unknown
    try {
      frame = JSON.parse(line)
    } catch (err) {
      this.#fail(run, `stdout frame is not JSON: ${describeError(err)}`)
      return
    }
    if (!isJsonObject(frame) || typeof frame.type !== 'string' || frame.type === '') {
      this.#fail(run, 'stdout frame is not a JSON object with a string "type"')
      return
    }
    if (run.done !== null) {
      this.#fail(run, `${frame.type} envelope after amp_done`)
      return
    }
    if (run.failure !== null) {
      this.#fail(run, `${frame.type} envelope after amp_error`)
      return
    }
    switch (frame.type) {
      case 'amp_error':
        this.#onError(run, frame)
        return
      case 'amp_open':
        this.#onOpen(run, frame)
        return
      case 'amp_event': {
        if (run.kind === 'open') {
          this.#fail(run, 'amp_event envelope during the open operation')
          return
        }
        const event = frame.event
        if (!isJsonObject(event) || typeof event.type !== 'string' || event.type === '') {
          this.#fail(run, 'amp_event envelope carries no native event object with a string "type"')
          return
        }
        run.events++
        this.#route(event, bytes)
        return
      }
      case 'amp_done':
        this.#onDone(run, frame)
        return
      default:
        this.#fail(run, `unknown worker envelope type ${JSON.stringify(frame.type)}`)
    }
  }

  #onError(run: Run, frame: JsonObject): void {
    if (run.opened !== null || run.events > 0) {
      this.#fail(run, 'amp_error after the worker started reporting')
      return
    }
    const { code, error } = frame
    if (!isErrorCode(code) || typeof error !== 'string' || error === '') {
      this.#fail(run, 'amp_error envelope has no supported code and non-empty error')
      return
    }
    run.failure = new HarnessError(error, code)
  }

  /** Thread identity as validated by the worker; must be the full ID the session expects, in this workdir, on this endpoint. */
  #onOpen(run: Run, frame: JsonObject): void {
    if (run.opened !== null) {
      this.#fail(run, 'duplicate amp_open envelope')
      return
    }
    const { sessionId, workdir, endpoint } = frame
    if (typeof sessionId !== 'string' || !AMP_THREAD_ID.test(sessionId)) {
      this.#fail(run, 'amp_open reports no full native thread ID')
      return
    }
    if (typeof workdir !== 'string' || !samePath(workdir, this.spec.workdir)) {
      this.#fail(run, `amp_open reports workdir ${JSON.stringify(workdir)}, not the session workdir ${JSON.stringify(this.spec.workdir)}`)
      return
    }
    if (endpoint !== this.#options.endpoint) {
      this.#fail(run, `amp_open reports endpoint ${JSON.stringify(endpoint)}, not ${JSON.stringify(this.#options.endpoint)}`)
      return
    }
    const expected = this.#reference?.sessionId ?? this.spec.resume?.sessionId ?? null
    if (expected !== null && sessionId !== expected) {
      this.#fail(run, `Amp SDK reported thread ${JSON.stringify(sessionId)}, not ${JSON.stringify(expected)}`)
      return
    }
    const turn = this.#active
    if (turn !== null) clearTimeout(turn.timer)
    const reference: SessionReference = Object.freeze({ sessionId, sessionFile: null, workdir: this.spec.workdir, endpoint: this.#options.endpoint })
    run.opened = reference
    this.#reference ??= reference
  }

  #onDone(run: Run, frame: JsonObject): void {
    const { status, raw, error, exitCode, signal } = frame
    if (!isDoneStatus(status)) {
      this.#fail(run, `amp_done reports unsupported status ${JSON.stringify(status)}`)
      return
    }
    if (raw !== null && !isJsonObject(raw)) {
      this.#fail(run, 'amp_done "raw" is neither null nor an object')
      return
    }
    if (error !== null && (typeof error !== 'string' || error === '')) {
      this.#fail(run, 'amp_done "error" is neither null nor a non-empty string')
      return
    }
    if (exitCode !== null && !Number.isInteger(exitCode)) {
      this.#fail(run, 'amp_done "exitCode" is neither null nor an integer')
      return
    }
    if (signal !== null && (typeof signal !== 'string' || signal === '')) {
      this.#fail(run, 'amp_done "signal" is neither null nor a non-empty string')
      return
    }
    if (status === 'completed' && run.opened === null) {
      this.#fail(run, 'amp_done completed without amp_open')
      return
    }
    // Native initialization has concluded either way; a native failure is retained, not reported as a stalled init.
    const turn = this.#active
    if (turn !== null) clearTimeout(turn.timer)
    run.done = {
      status,
      raw: isJsonObject(raw) ? raw : null,
      error: typeof error === 'string' ? error : null,
      exitCode: typeof exitCode === 'number' ? exitCode : null,
      signal: typeof signal === 'string' ? signal : null,
    }
  }

  /** Record the first violation and stop the worker group; the verdict is drawn once the runner finished its teardown. */
  #fail(run: Run, reason: string): void {
    if (run.violation !== null) return
    run.violation = reason
    run.controller.abort()
  }

  #route(event: JsonObject, bytes: number): void {
    if (this.#dead) return
    const reference = this.reference
    const turn = this.#active !== null && !this.#active.done ? this.#active : null
    const item: SessionEvent = {
      backend: this.spec.backend,
      harness: this.spec.harness,
      sessionId: reference.sessionId,
      turnId: turn?.id ?? null,
      requestId: null,
      type: typeof event.type === 'string' ? event.type : '',
      raw: event,
    }
    ;(turn?.queue ?? this.#sessionQueue).push(item, bytes)
  }

  // ---- settlement and teardown ----

  #finishTurn(turn: AmpTurn, status: SessionTurnStatus, error: string | null): void {
    if (turn.done) return
    turn.done = true
    clearTimeout(turn.timer)
    if (this.#active === turn) this.#active = null
    const run = turn.run
    const result = run?.result ?? null
    const done = run?.done ?? null
    turn.settle({
      sessionId: this.#reference?.sessionId ?? '',
      turnId: turn.id,
      status,
      raw: done?.raw ?? null,
      error,
      exitCode: done?.exitCode ?? null,
      signal: done?.signal ?? null,
      stderr: result?.stderr ?? '',
      stderrBytes: result?.stderrBytes ?? 0,
      stderrTruncated: result?.stderrTruncated ?? false,
      eventsTruncated: turn.eventsTruncated,
    })
    turn.queue.end()
  }

  /**
   * Fail or close the session once: stop any in-flight worker group and wait
   * for the runner's owned teardown, then settle the active turn with
   * `status`, end the idle event stream and release the lease. A group that
   * could not be reaped keeps the lease (reported by `close()`).
   */
  #invalidate(status: SessionTurnStatus, error: string | null): Promise<void> {
    if (this.#teardown !== null) return this.#teardown
    this.#dead = true
    const rejectCode: ErrorCode =
      status === 'closed' ? 'session-closed' : status === 'protocol-error' || status === 'timed-out' ? 'protocol-error' : 'launch-failed'
    this.#failure = new HarnessError(error ?? 'session closed', rejectCode)
    const run = this.#run
    const turn = this.#active
    if (turn !== null) clearTimeout(turn.timer)
    run?.controller.abort()
    const pending: Promise<unknown> = run === null ? Promise.resolve() : run.outcome
    this.#teardown = pending.then(() => {
      if (turn !== null) this.#finishTurn(turn, status, error)
      this.#sessionQueue.end()
      if (this.#cleanupError !== null) return
      try {
        cleanupCommand(this.#prepared)
      } catch (err) {
        this.#cleanupError = err
      }
    })
    return this.#teardown
  }
}
