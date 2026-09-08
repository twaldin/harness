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
// The sync entry point cannot run this state machine on a blocked event
// loop, so it spawns a per-invocation supervisor (this very module run as a
// main script with a nonce guard) and reads the outcome from its stdout.
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { constants as osConstants } from 'node:os'
import { StringDecoder } from 'node:string_decoder'
import { fileURLToPath } from 'node:url'
import type { SubprocOutcome, Termination } from './base.js'
import { HarnessError } from './base.js'

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

/** Fully resolved inputs; what the engine and the supervisor request share. */
export interface LaunchRequest {
  cmd: string[]
  cwd: string
  /** Complete child environment (already merged with the caller's process env). */
  env: Record<string, string>
  timeoutMs: number
}

export interface RunSubprocessOptions {
  cwd: string
  /** Defaults to 1800. `0` times out immediately. */
  timeoutSeconds?: number
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

/** macOS/Linux only. Anything else fails here, before any launch — no leader-only fallback. */
export function assertSupportedPlatform(): void {
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    throw new HarnessError(
      `Subprocess lifecycle requires macOS or Linux (process groups); platform "${process.platform}" is unsupported`,
      'unsupported-capability',
    )
  }
}

export function prepareLaunch(cmd: readonly string[], opts: RunSubprocessOptions): LaunchRequest {
  assertSupportedPlatform()
  if (!Array.isArray(cmd) || cmd.length === 0 || !cmd.every((arg) => typeof arg === 'string') || cmd[0] === '') {
    throw new HarnessError('cmd must be a non-empty array of strings', 'invalid-options')
  }
  if (typeof opts.cwd !== 'string' || opts.cwd === '') {
    throw new HarnessError('cwd must be a non-empty string', 'invalid-options')
  }
  const timeoutMs = (opts.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new HarnessError(`timeoutSeconds must be a finite non-negative number, got ${String(opts.timeoutSeconds)}`, 'invalid-options')
  }
  if (opts.cancel !== undefined && !(opts.cancel instanceof AbortSignal)) {
    throw new HarnessError('cancel must be an AbortSignal', 'invalid-options')
  }
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  Object.assign(env, opts.extraEnv ?? {})
  return { cmd: [...cmd], cwd: opts.cwd, env, timeoutMs }
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

/** Incremental UTF-8 decoding: split multi-byte sequences survive chunk boundaries; invalid bytes become U+FFFD. */
class Collector {
  readonly #decoder = new StringDecoder('utf8')
  #text = ''

  push(chunk: Buffer): void {
    this.#text += this.#decoder.write(chunk)
  }

  finish(): string {
    this.#text += this.#decoder.end()
    return this.#text
  }
}

interface LeaderExit {
  code: number | null
  signal: NodeJS.Signals | null
}

type StopReason = 'timed-out' | 'cancelled'

/**
 * Run one command to a terminal outcome. Never rejects for child-process
 * conditions; only for programming errors. `onLaunch` receives the process
 * group id as soon as the leader exists.
 */
export function runLifecycle(request: LaunchRequest, cancel?: AbortSignal, onLaunch?: (pgid: number) => void): Promise<Required<SubprocOutcome>> {
  // Executor form: the child's event handlers need resolve/reject in scope and
  // the project's lib target predates Promise.withResolvers.
  return new Promise((resolve, reject) => {
    if (cancel?.aborted) {
      resolve(cancelledBeforeLaunch())
      return
    }
    const start = performance.now()

    const child = spawn(request.cmd[0]!, request.cmd.slice(1), {
      cwd: request.cwd,
      env: request.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    })
    if (child.pid !== undefined) onLaunch?.(child.pid)
    const stdout = new Collector()
    const stderr = new Collector()
    child.stdout!.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr!.on('data', (chunk: Buffer) => stderr.push(chunk))

    let leader: LeaderExit | null = null
    let stopReason: StopReason | null = null
    let stopping = false
    let finished = false
    let groupGone = false
    let pipesClosed = false
    let groupStopped = false
    let processError: Error | null = null
    let timeoutTimer: NodeJS.Timeout | undefined
    let probeTimer: NodeJS.Timeout | undefined
    let drainTimer: NodeJS.Timeout | undefined

    const dispose = (): void => {
      finished = true
      clearTimeout(timeoutTimer)
      clearInterval(probeTimer)
      clearTimeout(drainTimer)
      cancel?.removeEventListener('abort', onAbort)
      child.stdout!.destroy()
      child.stderr!.destroy()
      child.unref()
    }

    const finish = (outcome: Required<SubprocOutcome>): void => {
      if (finished) return
      dispose()
      resolve(outcome)
    }

    const finishFromState = (): void => {
      if (finished) return
      if (leader === null || processError !== null) {
        dispose()
        reject(processError ?? new HarnessError('Owned subprocess did not exit before the cleanup deadline'))
        return
      }
      const durationSeconds = (performance.now() - start) / 1000
      const out = stdout.finish()
      const err = stderr.finish()
      if (stopReason) {
        finish(terminalOutcome(stopReason, durationSeconds, {
          stdout: out,
          stderr: err,
          timedOut: stopReason === 'timed-out',
          signal: leader?.signal ?? null,
        }))
      } else if (leader?.signal) {
        finish(terminalOutcome('signaled', durationSeconds, {
          exitCode: -osConstants.signals[leader.signal],
          stdout: out,
          stderr: err,
          signal: leader.signal,
        }))
      } else {
        finish(terminalOutcome('exited', durationSeconds, {
          exitCode: leader?.code ?? -1,
          stdout: out,
          stderr: err,
        }))
      }
    }

    const finishIfClosed = (): void => {
      if (pipesClosed && groupStopped && leader !== null) finishFromState()
    }

    const group = (signal: NodeJS.Signals | 0): boolean => {
      if (groupGone) return false
      groupGone = !signalGroup(child.pid!, signal)
      return !groupGone
    }

    // TERM → grace → KILL → bounded drain. Once the group is empty (or has
    // been force-killed) the pipes get `DRAIN_MS` to close on their own: an
    // escaped descendant may still hold them, and we never wait on it longer.
    const stopGroup = (reason: StopReason | null): void => {
      if (stopping) return
      stopping = true
      clearTimeout(timeoutTimer)
      if (reason && leader === null) stopReason = reason
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
    child.once('close', () => {
      if (finished) return
      pipesClosed = true
      finishIfClosed()
    })

    timeoutTimer = setTimeout(() => stopGroup('timed-out'), request.timeoutMs)
    cancel?.addEventListener('abort', onAbort, { once: true })
  })
}

// ---- synchronous entry: per-invocation supervisor ----

function isLaunchRequest(value: unknown): value is LaunchRequest {
  if (typeof value !== 'object' || value === null) return false
  return 'cmd' in value && Array.isArray(value.cmd) && value.cmd.length > 0 && value.cmd.every((arg) => typeof arg === 'string')
    && 'cwd' in value && typeof value.cwd === 'string'
    && 'env' in value && typeof value.env === 'object' && value.env !== null
    && Object.values(value.env).every((item) => typeof item === 'string')
    && 'timeoutMs' in value && typeof value.timeoutMs === 'number'
}

const TERMINATIONS: readonly Termination[] = ['exited', 'signaled', 'timed-out', 'cancelled', 'launch-failed']

function isOutcome(value: unknown): value is Required<SubprocOutcome> {
  if (typeof value !== 'object' || value === null) return false
  return 'exitCode' in value && typeof value.exitCode === 'number'
    && 'durationSeconds' in value && typeof value.durationSeconds === 'number'
    && 'stdout' in value && typeof value.stdout === 'string'
    && 'stderr' in value && typeof value.stderr === 'string'
    && 'timedOut' in value && typeof value.timedOut === 'boolean'
    && 'termination' in value && TERMINATIONS.some((t) => t === value.termination)
    && 'signal' in value && (value.signal === null || typeof value.signal === 'string')
    && 'launchError' in value && (value.launchError === null || typeof value.launchError === 'string')
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
  process.stdout.write(`${announced ? '' : `${LAUNCHED_PREFIX}-\n`}${JSON.stringify(outcome)}`, () => process.exit(0))
}

/** Blocks the calling thread by running the async engine inside a supervisor process. */
export function runLifecycleSync(request: LaunchRequest): Required<SubprocOutcome> {
  const nonce = randomUUID()
  const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), SUPERVISOR_FLAG, nonce, String(process.pid)], {
    env: { ...process.env, [SUPERVISOR_ENV]: nonce },
    input: JSON.stringify(request),
    stdio: ['pipe', 'pipe', 'pipe'],
    encoding: 'utf8',
    maxBuffer: Infinity,
    timeout: request.timeoutMs + GRACE_MS + DRAIN_MS + SUPERVISOR_MARGIN_MS,
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
  supervise().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`)
    process.exit(70)
  })
}
