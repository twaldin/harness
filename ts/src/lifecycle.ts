// Internal subprocess lifecycle engine shared by the sync and async entry
// points. Not exported from the package index.
//
// Every run owns a fresh POSIX process group (spawn `detached: true` → setsid,
// so pgid === leader pid). The group is the ownership boundary: whatever the
// leader forks stays inside it unless a descendant deliberately escapes via
// setsid/setpgid, which is unsupported. Teardown is bounded: SIGTERM the
// group, grace `GRACE_MS`, escalate to SIGKILL, then wait at most `DRAIN_MS`
// for the stdio pipes to close before force-closing them. Leftovers are
// stopped even after a normal leader exit, and the leader's own outcome is
// preserved in that case.
//
// Output handling: each stream is captured up to `maxOutputBytes` raw bytes
// (the rest is drained and counted) and, when an `onOutput` callback is
// given, streamed through an independent incremental decoder. Callbacks are
// serialized; while one is pending the pipes are not read, so the child
// blocks on a full pipe rather than output queueing here. Timers and
// cancellation stay live during that pause, and the forced drain deadline
// never waits for a callback. Reading resumes when the callback settles.
//
// The sync entry point cannot run this state machine on a blocked event
// loop, so it spawns a per-invocation supervisor (this very module run as a
// main script with a nonce guard) and reads the outcome from its stdout.
import { spawn, spawnSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { constants as osConstants } from 'node:os'
import { StringDecoder } from 'node:string_decoder'
import { fileURLToPath } from 'node:url'
import type { OutputCallback, OutputStream, SubprocOutcome, Termination, TimeoutKind } from './base.js'
import { HarnessError } from './base.js'
import { outputPipes } from './pipes.js'
import type { OutputPipe } from './pipes.js'

/** SIGTERM grace before escalating to SIGKILL. */
export const GRACE_MS = 500
/** After escalation: how long pipes may stay open before they are force-closed. */
export const DRAIN_MS = 1000
const PROBE_MS = 20
/** Extra slack the sync supervisor process gets beyond the run's own bounded lifecycle. */
const SUPERVISOR_MARGIN_MS = 10_000
const SUPERVISOR_ENV = 'HARNESS_TS_SUPERVISOR'
const SUPERVISOR_FLAG = '--harness-supervise'
const DEFAULT_TIMEOUT_SECONDS = 1800
const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576
/** `callbackError` when the run finished while an `onOutput` promise was still pending. */
const CALLBACK_ABANDONED = 'onOutput callback did not complete before teardown finished'

/** Fully resolved inputs; what the engine and the supervisor request share. */
export interface LaunchRequest {
  cmd: string[]
  cwd: string
  /** Complete child environment (already merged with the caller's process env). */
  env: Record<string, string>
  /** Wall-clock deadline; null disables it. */
  timeoutMs: number | null
  /** Silence deadline; null disables it. */
  inactivityMs: number | null
  /** Per-stream raw byte capture cap. */
  maxOutputBytes: number
  /** UTF-8 payload for the child's stdin followed by EOF; null means EOF from the start. */
  stdin: string | null
}

export interface RunSubprocessOptions {
  cwd: string
  /** Defaults to 1800. `0` times out immediately; `null` disables the wall clock. */
  timeoutSeconds?: number | null
  /** Seconds without stdout/stderr bytes before the run times out with `timeoutKind: 'inactivity'`. Off by default. */
  inactivityTimeoutSeconds?: number | null
  /** Per-stream capture cap in raw bytes; default 1048576. Beyond it output is drained, counted and flagged truncated. */
  maxOutputBytes?: number
  /** Written to stdin as UTF-8 then EOF. Omitted, `null` or empty: stdin is EOF from the start. */
  stdin?: string | null
  /** Streams decoded output as it arrives; see `OutputCallback`. Only the async entry point can deliver it. */
  onOutput?: OutputCallback
  /** Merged over `process.env`; explicit values win. */
  extraEnv?: Record<string, string>
  /**
   * Abort to stop the run: the process group is torn down and the outcome
   * reports `termination: 'cancelled'`. An already-aborted signal never
   * launches. The synchronous entry point can only observe the pre-aborted
   * state; a signal aborted while it blocks has no effect.
   */
  cancel?: AbortSignal
}

function errnoCode(err: unknown): string | null {
  if (err instanceof Error && 'code' in err && typeof err.code === 'string') return err.code
  return null
}

/** `<ErrorName>: <message>` for errors, `String(value)` otherwise; mirrors Python's `<TypeName>: <message>`. */
export function describeError(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err)
}

/** macOS/Linux only. Anything else fails here, before any launch — no leader-only fallback. */
export function assertSupportedPlatform(): void {
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    throw new HarnessError(
      `Subprocess lifecycle requires macOS or Linux (process groups); platform "${process.platform}" is unsupported`,
      'unsupported-capability',
    )
  }
}

function invalid(message: string): HarnessError {
  return new HarnessError(message, 'invalid-options')
}

/** Seconds → milliseconds; `null` (or undefined without a default) disables the deadline. */
function resolveDeadline(name: string, raw: unknown, defaultSeconds: number | null, minimum: 0 | 1): number | null {
  if (raw === null || (raw === undefined && defaultSeconds === null)) return null
  const seconds = raw === undefined ? defaultSeconds : raw
  const ok = typeof seconds === 'number' && Number.isFinite(seconds) && (minimum === 0 ? seconds >= 0 : seconds > 0)
  if (!ok) throw invalid(`${name} must be null or a finite ${minimum === 0 ? 'non-negative' : 'positive'} number, got ${String(raw)}`)
  return Math.min((seconds as number) * 1000, Number.MAX_VALUE)
}

/**
 * Validate and resolve everything a launch needs. Pure: the public `run`
 * entry points call this before touching the workdir so invalid I/O options
 * never leave a lease or projected instructions behind.
 */
export function prepareLaunch(cmd: readonly string[], opts: RunSubprocessOptions): LaunchRequest {
  assertSupportedPlatform()
  if (!Array.isArray(cmd) || cmd.length === 0 || !cmd.every((arg) => typeof arg === 'string') || cmd[0] === '') {
    throw invalid('cmd must be a non-empty array of strings')
  }
  if (typeof opts.cwd !== 'string' || opts.cwd === '') {
    throw invalid('cwd must be a non-empty string')
  }
  const timeoutMs = resolveDeadline('timeoutSeconds', opts.timeoutSeconds, DEFAULT_TIMEOUT_SECONDS, 0)
  const inactivityMs = resolveDeadline('inactivityTimeoutSeconds', opts.inactivityTimeoutSeconds, null, 1)
  const maxOutputBytes = opts.maxOutputBytes === undefined ? DEFAULT_MAX_OUTPUT_BYTES : opts.maxOutputBytes
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 0) {
    throw invalid(`maxOutputBytes must be a non-negative safe integer, got ${String(opts.maxOutputBytes)}`)
  }
  const stdinRaw: unknown = opts.stdin
  if (stdinRaw !== undefined && stdinRaw !== null && typeof stdinRaw !== 'string') {
    throw invalid('stdin must be a string or null')
  }
  const stdin = typeof stdinRaw === 'string' && stdinRaw !== '' ? stdinRaw : null
  if (opts.onOutput !== undefined && typeof opts.onOutput !== 'function') {
    throw invalid('onOutput must be a function')
  }
  if (opts.cancel !== undefined && !(opts.cancel instanceof AbortSignal)) {
    throw invalid('cancel must be an AbortSignal')
  }
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  Object.assign(env, opts.extraEnv ?? {})
  return { cmd: [...cmd], cwd: opts.cwd, env, timeoutMs, inactivityMs, maxOutputBytes, stdin }
}

function terminalOutcome(termination: Termination, durationSeconds: number, extra: Partial<SubprocOutcome> = {}): Required<SubprocOutcome> {
  return {
    exitCode: -1,
    durationSeconds,
    stdout: '',
    stderr: '',
    timedOut: false,
    termination,
    signal: null,
    launchError: null,
    stdoutBytes: 0,
    stderrBytes: 0,
    stdoutTruncated: false,
    stderrTruncated: false,
    callbackError: null,
    timeoutKind: null,
    ...extra,
  }
}

/** Outcome for a `cancel` signal that was already aborted: nothing was launched. */
export function cancelledBeforeLaunch(): Required<SubprocOutcome> {
  return terminalOutcome('cancelled', 0)
}

/**
 * Signal (or probe with 0) every member of a process group. `true` when the
 * group still has members. EPERM counts as alive: on macOS killpg reports
 * EPERM rather than ESRCH while the only remaining member is an unreaped
 * zombie leader, and a member that changed uid is alive but untouchable —
 * both resolve through the bounded deadlines, not by ignoring the group.
 */
function signalGroup(pgid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pgid, signal)
    return true
  } catch (err) {
    const code = errnoCode(err)
    if (code === 'ESRCH') return false
    if (code === 'EPERM') return true
    throw err
  }
}

/**
 * Bounded capture of one stream: keeps the first `cap` raw bytes, counts the
 * rest. Decoding is incremental, so a multi-byte sequence split across
 * chunks survives. A sequence cut by the cap is dropped rather than decoded
 * to U+FFFD; a sequence left incomplete by the stream's real end (or by a
 * forced close, where the rest is unknown) is decoded with replacement.
 */
class Capture {
  readonly #decoder = new StringDecoder('utf8')
  readonly #cap: number
  #text = ''
  #kept = 0
  /** Raw bytes read, including bytes beyond the cap. */
  bytes = 0
  /** Set when a forced pipe close left output unread. */
  unread = false

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

  get truncated(): boolean {
    return this.bytes > this.#cap || this.unread
  }

  finish(): string {
    if (this.bytes <= this.#cap) this.#text += this.#decoder.end()
    return this.#text
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object' && value !== null && 'then' in value && typeof value.then === 'function'
}

interface LeaderExit {
  code: number | null
  signal: NodeJS.Signals | null
}

type StopReason = 'timed-out' | 'cancelled' | 'callback-error'

/**
 * Run one command to a terminal outcome. Never rejects for child-process
 * conditions; only for programming errors. `onLaunch` receives the process
 * group id as soon as the leader exists.
 */
export function runLifecycle(
  request: LaunchRequest,
  cancel?: AbortSignal,
  onLaunch?: (pgid: number) => void,
  onOutput?: OutputCallback,
): Promise<Required<SubprocOutcome>> {
  // Executor form: the child's event handlers need resolve/reject in scope and
  // the project's lib target predates Promise.withResolvers.
  return new Promise((resolve, reject) => {
    if (cancel?.aborted) {
      resolve(cancelledBeforeLaunch())
      return
    }
    const start = performance.now()

    let pipes: [OutputPipe, OutputPipe]
    let child: ChildProcess
    try {
      pipes = outputPipes()
    } catch (error) {
      resolve(terminalOutcome('launch-failed', (performance.now() - start) / 1000, { launchError: errnoCode(error) ?? 'EIO' }))
      return
    }
    try {
      child = spawn(request.cmd[0]!, request.cmd.slice(1), {
        cwd: request.cwd,
        env: request.env,
        stdio: [request.stdin === null ? 'ignore' : 'pipe', pipes[0].writeFd!, pipes[1].writeFd!],
        detached: true,
      })
    } catch (error) {
      for (const pipe of pipes) pipe.close()
      resolve(terminalOutcome('launch-failed', (performance.now() - start) / 1000, { launchError: errnoCode(error) ?? 'EIO' }))
      return
    }
    for (const pipe of pipes) pipe.closeWriter()
    if (child.pid !== undefined) onLaunch?.(child.pid)
    if (child.stdin) {
      // EPIPE (the child exited or closed stdin before reading it all) is not
      // an outcome condition; the leader's own exit reports what happened.
      child.stdin.on('error', () => {})
      child.stdin.end(request.stdin, 'utf8')
    }
    const stdout = new Capture(request.maxOutputBytes)
    const stderr = new Capture(request.maxOutputBytes)

    let leader: LeaderExit | null = null
    let stopReason: StopReason | null = null
    let stopKind: TimeoutKind | null = null
    let stopping = false
    let finished = false
    let groupGone = false
    let pipesClosed = false
    let groupStopped = false
    let processError: Error | null = null
    let timeoutTimer: NodeJS.Timeout | undefined
    let inactivityTimer: NodeJS.Timeout | undefined
    let probeTimer: NodeJS.Timeout | undefined
    let drainTimer: NodeJS.Timeout | undefined
    let readTimer: NodeJS.Timeout | undefined
    // One callback outstanding, no delivery queue. Descriptor reads pause
    // while awaiting the consumer on both Node and Bun.
    let callbacksOn = onOutput !== undefined
    let pending: PromiseLike<unknown> | null = null
    let callbackError: string | null = null
    let paused = false
    let pausedAt = 0
    let silenceSince = start

    const dispose = (): void => {
      finished = true
      callbacksOn = false
      clearTimeout(timeoutTimer)
      clearTimeout(inactivityTimer)
      clearInterval(probeTimer)
      clearTimeout(drainTimer)
      clearInterval(readTimer)
      cancel?.removeEventListener('abort', onAbort)
      child.stdin?.destroy()
      for (const pipe of pipes) pipe.close()
      child.unref()
    }

    const finish = (outcome: Required<SubprocOutcome>): void => {
      if (finished) return
      dispose()
      resolve(outcome)
    }

    const forceClose = (): void => {
      // Drain a bounded amount without callbacks, then flag any pipe without
      // observed EOF. An escaped descendant may still own its write end.
      for (const [pipe, capture] of [[pipes[0], stdout], [pipes[1], stderr]] as const) {
        for (let i = 0; i < 16; i++) {
          const chunk = pipe.read()
          if (chunk === null) break
          capture.push(chunk)
        }
        if (!pipe.eof) capture.unread = true
      }
    }

    const finishFromState = (): void => {
      if (finished) return
      if (leader === null || processError !== null) {
        dispose()
        reject(processError ?? new HarnessError('Owned subprocess did not exit before the cleanup deadline'))
        return
      }
      const durationSeconds = (performance.now() - start) / 1000
      if (!pipesClosed) forceClose()
      if (pending !== null) {
        pending = null
        callbackError ??= CALLBACK_ABANDONED
      }
      const io: Partial<SubprocOutcome> = {
        stdout: stdout.finish(),
        stderr: stderr.finish(),
        stdoutBytes: stdout.bytes,
        stderrBytes: stderr.bytes,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
        callbackError,
      }
      if (stopReason) {
        finish(terminalOutcome(stopReason, durationSeconds, {
          ...io,
          timedOut: stopReason === 'timed-out',
          timeoutKind: stopKind,
          signal: leader?.signal ?? null,
        }))
      } else if (leader?.signal) {
        finish(terminalOutcome('signaled', durationSeconds, {
          ...io,
          exitCode: -osConstants.signals[leader.signal],
          signal: leader.signal,
        }))
      } else {
        finish(terminalOutcome('exited', durationSeconds, { ...io, exitCode: leader?.code ?? -1 }))
      }
    }

    /** Natural completion also waits for delivery to settle; the drain deadline calls `finishFromState` directly and abandons it. */
    const finishIfClosed = (): void => {
      if (pipesClosed && groupStopped && leader !== null && pending === null) finishFromState()
    }

    const group = (signal: NodeJS.Signals | 0): boolean => {
      if (groupGone) return false
      groupGone = !signalGroup(child.pid!, signal)
      return !groupGone
    }

    // TERM → grace → KILL → bounded drain. Once the group is empty (or has
    // been force-killed) the pipes get `DRAIN_MS` to close on their own: an
    // escaped descendant may still hold them, and we never wait on it longer.
    const stopGroup = (reason: StopReason | null, kind: TimeoutKind | null = null): void => {
      if (stopping) return
      stopping = true
      clearTimeout(timeoutTimer)
      clearTimeout(inactivityTimer)
      if (reason && leader === null) {
        stopReason = reason
        stopKind = kind
      }
      if (!group('SIGTERM')) {
        groupStopped = true
        drainTimer = setTimeout(finishFromState, DRAIN_MS)
        finishIfClosed()
        return
      }
      const graceEnd = performance.now() + GRACE_MS
      probeTimer = setInterval(() => {
        const alive = group(0)
        if (alive && performance.now() < graceEnd) return
        clearInterval(probeTimer)
        if (alive) group('SIGKILL')
        groupStopped = true
        drainTimer = setTimeout(finishFromState, DRAIN_MS)
        finishIfClosed()
      }, PROBE_MS)
    }

    const onAbort = (): void => {
      if (finished || leader !== null) return
      stopGroup('cancelled')
    }

    const armInactivity = (delayMs: number): void => {
      clearTimeout(inactivityTimer)
      const deadline = performance.now() + delayMs
      const tick = (): void => {
        const remaining = deadline - performance.now()
        if (remaining <= 0) stopGroup('timed-out', 'inactivity')
        else inactivityTimer = setTimeout(tick, Math.min(remaining, 2_147_483_647))
      }
      inactivityTimer = setTimeout(tick, Math.min(delayMs, 2_147_483_647))
    }
    const touchActivity = (): void => {
      if (request.inactivityMs === null || stopping) return
      silenceSince = performance.now()
      armInactivity(request.inactivityMs)
    }

    const pauseReading = (): void => {
      if (paused) return
      paused = true
      pausedAt = performance.now()
      clearTimeout(inactivityTimer)
    }
    const resumeReading = (): void => {
      if (!paused || finished) return
      paused = false
      if (request.inactivityMs === null || stopping) return
      const now = performance.now()
      silenceSince += now - pausedAt
      armInactivity(Math.max(0, request.inactivityMs - (now - silenceSince)))
    }

    const failCallback = (err: unknown): void => {
      callbacksOn = false
      callbackError = describeError(err)
      resumeReading()
      stopGroup('callback-error')
      finishIfClosed()
    }

    const invoke = (text: string, stream: OutputStream): void => {
      let result: unknown
      try {
        result = onOutput!(text, stream)
      } catch (err) {
        failCallback(err)
        return
      }
      if (!isThenable(result)) return
      const promise = result
      pending = promise
      pauseReading()
      promise.then(
        () => {
          if (pending !== promise) return // abandoned at the drain deadline; nothing to resume
          pending = null
          settle()
        },
        (err: unknown) => {
          if (pending !== promise) return // late rejection after finish: consumed, not reported twice
          pending = null
          failCallback(err)
        },
      )
    }

    /** Resume descriptor reads only after the outstanding callback settles. */
    const settle = (): void => {
      if (pending !== null) return
      resumeReading()
      queueMicrotask(pump)
      finishIfClosed()
    }


    const outputs = [
      { pipe: pipes[0], capture: stdout, name: 'stdout' as const, decoder: new StringDecoder('utf8'), ended: false },
      { pipe: pipes[1], capture: stderr, name: 'stderr' as const, decoder: new StringDecoder('utf8'), ended: false },
    ]
    const pump = (): void => {
      if (finished || pending !== null) return
      try {
        // Bound each tick so noisy output cannot starve timers/cancellation.
        for (let pass = 0; pass < 8; pass++) {
          for (const output of outputs) {
            if (output.ended) continue
            const chunk = output.pipe.read()
            let text = ''
            if (chunk !== null) {
              output.capture.push(chunk)
              touchActivity()
              if (callbacksOn) text = output.decoder.write(chunk)
            } else if (output.pipe.eof) {
              output.ended = true
              if (callbacksOn) text = output.decoder.end()
            }
            if (text !== '' && callbacksOn) invoke(text, output.name)
            if (finished || pending !== null) return
          }
        }
        pipesClosed = outputs.every((output) => output.ended)
        finishIfClosed()
      } catch (error) {
        processError = error instanceof Error ? error : new Error(String(error))
        stopGroup(null)
      }
    }

    child.once('error', (err) => {
      if (finished) return
      if (child.pid === undefined) {
        finish(terminalOutcome('launch-failed', (performance.now() - start) / 1000, { launchError: errnoCode(err) ?? err.name }))
        return
      }
      processError = err
      stopGroup(null)
    })
    child.once('exit', (code, signal) => {
      if (finished) return
      leader = { code, signal }
      // Leftovers may outlive the leader and hold the pipes; never wait for the run timeout on them.
      stopGroup(null)
    })

    readTimer = setInterval(pump, PROBE_MS)
    if (request.timeoutMs !== null) {
      const deadline = start + request.timeoutMs
      const tick = (): void => {
        const remaining = deadline - performance.now()
        if (remaining <= 0) stopGroup('timed-out', 'wall')
        else timeoutTimer = setTimeout(tick, Math.min(remaining, 2_147_483_647))
      }
      timeoutTimer = setTimeout(tick, Math.min(Math.max(0, deadline - performance.now()), 2_147_483_647))
    }
    if (request.inactivityMs !== null) armInactivity(request.inactivityMs)
    cancel?.addEventListener('abort', onAbort, { once: true })
  })
}

// ---- synchronous entry: per-invocation supervisor ----

function isDeadline(value: unknown): value is number | null {
  return value === null || typeof value === 'number'
}

function isLaunchRequest(value: unknown): value is LaunchRequest {
  if (typeof value !== 'object' || value === null) return false
  return 'cmd' in value && Array.isArray(value.cmd) && value.cmd.length > 0 && value.cmd.every((arg) => typeof arg === 'string')
    && 'cwd' in value && typeof value.cwd === 'string'
    && 'env' in value && typeof value.env === 'object' && value.env !== null
    && Object.values(value.env).every((item) => typeof item === 'string')
    && 'timeoutMs' in value && isDeadline(value.timeoutMs)
    && 'inactivityMs' in value && isDeadline(value.inactivityMs)
    && 'maxOutputBytes' in value && typeof value.maxOutputBytes === 'number'
    && 'stdin' in value && (value.stdin === null || typeof value.stdin === 'string')
}

const TERMINATIONS: readonly Termination[] = ['exited', 'signaled', 'timed-out', 'cancelled', 'callback-error', 'launch-failed']

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function isOutcome(value: unknown): value is Required<SubprocOutcome> {
  if (typeof value !== 'object' || value === null) return false
  return 'exitCode' in value && typeof value.exitCode === 'number'
    && 'durationSeconds' in value && typeof value.durationSeconds === 'number'
    && 'stdout' in value && typeof value.stdout === 'string'
    && 'stderr' in value && typeof value.stderr === 'string'
    && 'timedOut' in value && typeof value.timedOut === 'boolean'
    && 'termination' in value && TERMINATIONS.some((t) => t === value.termination)
    && 'signal' in value && isNullableString(value.signal)
    && 'launchError' in value && isNullableString(value.launchError)
    && 'stdoutBytes' in value && typeof value.stdoutBytes === 'number'
    && 'stderrBytes' in value && typeof value.stderrBytes === 'number'
    && 'stdoutTruncated' in value && typeof value.stdoutTruncated === 'boolean'
    && 'stderrTruncated' in value && typeof value.stderrTruncated === 'boolean'
    && 'callbackError' in value && isNullableString(value.callbackError)
    && 'timeoutKind' in value && (value.timeoutKind === null || value.timeoutKind === 'wall' || value.timeoutKind === 'inactivity')
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk))
    process.stdin.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    process.stdin.once('error', reject)
  })
}

// Supervisor stdout protocol: one `launched <pgid|->` header line as soon as
// the leader exists, then the outcome JSON. The header lets the parent clean
// up the owned group if it ever has to hard-kill the supervisor.
const LAUNCHED_PREFIX = 'launched '

async function supervise(): Promise<void> {
  delete process.env[SUPERVISOR_ENV]
  const parsed: unknown = JSON.parse(await readStdin())
  if (!isLaunchRequest(parsed)) throw new Error('supervisor received a malformed launch request')
  const controller = new AbortController()
  const parent = Number(process.argv[4])
  if (!Number.isInteger(parent) || parent < 1) throw new Error('supervisor requires its caller PID')
  // Capture identity in the caller, not here: it may die before this module
  // loads. A broken result pipe also cancels rather than crashing with EPIPE.
  process.stdout.on('error', () => controller.abort())
  if (process.ppid !== parent) controller.abort()
  const watch = setInterval(() => {
    if (process.ppid !== parent) controller.abort()
  }, 250)
  let announced = false
  const outcome = await runLifecycle(parsed, controller.signal, (pgid) => {
    announced = true
    process.stdout.write(`${LAUNCHED_PREFIX}${pgid}\n`)
  })
  clearInterval(watch)
  await new Promise<void>((resolve) => {
    process.stdout.write(`${announced ? '' : `${LAUNCHED_PREFIX}-\n`}${JSON.stringify(outcome)}`, () => resolve())
  })
  process.exit(0)
}

/**
 * Upper bound on the supervisor's result pipe. The outcome carries at most
 * `maxOutputBytes` captured bytes per stream; JSON escaping expands a byte to
 * at most six characters (`\u0000`) and an invalid byte decodes to a
 * three-byte U+FFFD, so 6× per stream covers both, plus fixed fields.
 */
function supervisorMaxBuffer(maxOutputBytes: number): number {
  return 12 * maxOutputBytes + 65_536
}

/** Blocks the calling thread by running the async engine inside a supervisor process. Cannot stream: `onOutput` is rejected by the caller. */
export function runLifecycleSync(request: LaunchRequest): Required<SubprocOutcome> {
  const nonce = randomUUID()
  const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), SUPERVISOR_FLAG, nonce, String(process.pid)], {
    env: { ...process.env, [SUPERVISOR_ENV]: nonce },
    input: JSON.stringify(request),
    stdio: ['pipe', 'pipe', 'pipe'],
    encoding: 'utf8',
    maxBuffer: supervisorMaxBuffer(request.maxOutputBytes),
    // No wall clock means no last-resort cap either: inactivity and cancellation are the run's own business.
    timeout: request.timeoutMs === null ? undefined : Math.min(request.timeoutMs + GRACE_MS + DRAIN_MS + SUPERVISOR_MARGIN_MS, Number.MAX_SAFE_INTEGER),
    killSignal: 'SIGKILL',
  })
  const stdout = result.stdout ?? ''
  const headerEnd = stdout.indexOf('\n')
  const header = headerEnd === -1 ? stdout : stdout.slice(0, headerEnd)
  const pgid = header.startsWith(LAUNCHED_PREFIX) ? Number.parseInt(header.slice(LAUNCHED_PREFIX.length), 10) : Number.NaN
  if (result.error || result.status !== 0) {
    // Last-resort cap tripped or the supervisor crashed: the target group is
    // still ours, so kill it here rather than leaking it, and say so.
    let cleanup = ''
    if (Number.isInteger(pgid) && pgid > 1) {
      cleanup = signalGroup(pgid, 'SIGKILL')
        ? `; sent SIGKILL to orphaned process group ${pgid}`
        : `; process group ${pgid} had already exited`
    }
    const detail = result.error ? result.error.message : `exit ${result.status ?? `signal ${result.signal}`}`
    throw new HarnessError(`Subprocess supervisor failed (${detail}${cleanup}): ${(result.stderr ?? '').trim()}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(headerEnd === -1 ? '' : stdout.slice(headerEnd + 1))
  } catch {
    throw new HarnessError(`Subprocess supervisor produced malformed output: ${(result.stderr ?? '').trim()}`)
  }
  if (!isOutcome(parsed)) throw new HarnessError('Subprocess supervisor produced a malformed outcome')
  return parsed
}

const supervisorNonce = process.env[SUPERVISOR_ENV]
if (typeof supervisorNonce === 'string' && supervisorNonce !== '' && process.argv[2] === SUPERVISOR_FLAG && process.argv[3] === supervisorNonce) {
  // A consumer may bundle this module into its entry script. Finish and exit
  // supervisor mode before that consumer's top-level code can run again.
  await supervise().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`)
    process.exit(70)
  })
}
