// One owned child process, shared by Pi RPC, the OMP/Claude/Cline SDK workers
// and the Factory Droid SDK transport:
// bounded stderr capture, strict LF framing of stdout within MAX_FRAME_BYTES,
// serialized backpressured stdin writes, exit/EOF classification and the
// bounded teardown TERM → GRACE_MS → KILL → DRAIN_MS reap/pipe drain of the
// whole process group. The child must have been spawned `detached` so that
// its PID is the group ID; ownership never rests on PID discovery.
//
// This module knows nothing about frames beyond their byte boundaries: the
// session decodes and interprets each line and decides what a failure means
// for its turns. `OwnedChild` reports its own failures through `fail` at most
// once and stays silent once `stop()` was called.
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { constants as osConstants } from 'node:os'
import { StringDecoder } from 'node:string_decoder'
import { HarnessError } from './base.js'
import { DRAIN_MS, GRACE_MS, describeError } from './lifecycle.js'

/** Largest stdout frame (and, on `opencode`, SSE event / HTTP JSON body) accepted in bytes. */
export const MAX_FRAME_BYTES = 1_048_576
const PROBE_MS = 20
const LF = 0x0a
const CR = 0x0d

export interface LeaderExit {
  code: number | null
  signal: NodeJS.Signals | null
}

/** What an owned child can report on its own: transport loss, oversized framing, or an ending nobody asked for. */
export type OwnedChildFailure = 'disconnected' | 'protocol-error' | 'exited' | 'signaled'

export interface OwnedChildHandlers {
  /** One complete line: LF-terminated, trailing CR stripped, never empty, at most MAX_FRAME_BYTES. */
  line(bytes: Buffer): void
  /**
   * The child failed the session: launch/process error, stdin write failure,
   * oversized frame, an unterminated frame at EOF, or the leader ended while
   * nobody stopped it. Fires at most once and never after `stop()`.
   */
  fail(status: OwnedChildFailure, error: string): void
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms))
}

/** Signal (or probe with 0) a whole process group; `true` while it still has members (EPERM counts as alive, see lifecycle.ts). */
export function signalGroup(pgid: number, signal: NodeJS.Signals | 0): boolean {
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

/** The child's complete environment: the inherited process env with `overlay` layered on top. Explicit layering, never a parent mutation. */
export function inheritedEnv(overlay: Readonly<Record<string, string>>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  Object.assign(env, overlay)
  return env
}

/** Spawn a session leader: owned stdio pipes and a fresh POSIX process group (so `pid` doubles as the group to signal). Throws synchronously on spawn errors. */
export function spawnGroupLeader(executable: string, args: readonly string[], cwd: string, env: Readonly<Record<string, string>>): ChildProcess {
  return spawn(executable, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true })
}

/** Bounded stderr prefix: keeps the first `cap` raw bytes decoded incrementally, counts everything. */
export class BoundedCapture {
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
 * A spawned, group-leading child with owned stdio pipes. Constructed right
 * after `spawn(..., { detached: true, stdio: ['pipe', 'pipe', 'pipe'] })`;
 * the session drives it through `write` and ends it through `stop` +
 * `stopGroup`.
 */
export class OwnedChild {
  readonly pid: number | null
  readonly stderr: BoundedCapture
  leader: LeaderExit | null = null
  stdoutClosed = false
  stderrClosed = false
  /** Set by `stop()`: no further lines or failures are reported. */
  stopped = false
  readonly #child: ChildProcess
  readonly #name: string
  readonly #handlers: OwnedChildHandlers
  readonly #partial: Buffer[] = []
  #partialBytes = 0
  #writes: Promise<void> = Promise.resolve()
  #ending = false
  #failed = false
  #onLeaderKnown: (() => void)[] = []
  #onStdioClosed: (() => void)[] = []

  /** `name` is what the leader is called in diagnostics; `stderrCap` bounds the retained stderr prefix. */
  constructor(child: ChildProcess, name: string, stderrCap: number, handlers: OwnedChildHandlers) {
    this.#child = child
    this.#name = name
    this.#handlers = handlers
    this.pid = child.pid ?? null
    this.stderr = new BoundedCapture(stderrCap)
    child.stdin?.on('error', () => {}) // EPIPE surfaces through stdout EOF / leader exit, not as a write failure
    child.stdout?.on('data', (chunk: Buffer) => this.#onStdout(chunk))
    child.stderr?.on('data', (chunk: Buffer) => this.stderr.push(chunk))
    const stdoutDone = (): void => this.#onStdoutEnd()
    child.stdout?.once('end', stdoutDone)
    child.stdout?.once('close', stdoutDone)
    const stderrDone = (): void => {
      this.stderrClosed = true
      this.#notifyStdio()
    }
    child.stderr?.once('end', stderrDone)
    child.stderr?.once('close', stderrDone)
    child.once('exit', (code, signal) => this.#onExit({ code, signal }))
    child.once('error', (err) => {
      this.#fail('disconnected', this.pid === null ? `${name} could not be launched: ${describeError(err)}` : `${name} process error: ${describeError(err)}`)
    })
  }

  /** Bytes of an unterminated trailing frame. */
  get partialBytes(): number {
    return this.#partialBytes
  }

  /** Leader exit code once reaped, else null; signaled exits report `-signum`. */
  get exitCode(): number | null {
    const leader = this.leader
    return leader === null ? null : leader.signal !== null ? -osConstants.signals[leader.signal] : leader.code
  }

  get signal(): NodeJS.Signals | null {
    return this.leader?.signal ?? null
  }

  /** Stop reporting lines and failures; the session has taken over (teardown follows through `stopGroup`). */
  stop(): void {
    this.stopped = true
  }

  /**
   * Serialized, backpressured stdin write; a write failure is reported as
   * `disconnected`. The returned promise settles (never rejects) when this
   * queued write finishes or the transport stops, so a caller streaming on someone else's behalf
   * — the Cline session forwarding a parent-owned command's output — can
   * hand this child's backpressure back to its own producer.
   */
  write(line: string): Promise<void> {
    this.#writes = this.#writes.then(async () => {
      if (this.stopped) return
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
      this.#fail('disconnected', `stdin write failed: ${describeError(err)}`)
    })
    return this.#writes
  }

  /**
   * stdin EOF, TERM the group, GRACE_MS, KILL, then a bounded group / leader /
   * stdio drain before force-closing the pipes. Throws `adapter-error` when the
   * leader was not reaped within the budget: ownership of live resources must
   * not be released on that path.
   */
  async stopGroup(): Promise<void> {
    const child = this.#child
    try {
      child.stdin?.end()
    } catch {
      // already gone
    }
    try {
      if (this.pid !== null) {
        const pgid = this.pid
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
        const groupGone = this.pid === null || !signalGroup(this.pid, 0)
        const leaderReaped = this.leader !== null || this.pid === null
        if (groupGone && leaderReaped && this.stdoutClosed && this.stderrClosed) break
        await sleep(PROBE_MS)
      }
    } finally {
      child.stdout?.destroy()
      child.stderr?.destroy()
      child.stdin?.destroy()
      child.unref()
    }
    if (this.pid !== null && this.leader === null) {
      throw new HarnessError(`${this.#name} process ${this.pid} was not reaped within the teardown budget`, 'adapter-error')
    }
  }

  #fail(status: OwnedChildFailure, error: string): void {
    if (this.stopped || this.#failed) return
    this.#failed = true
    this.#handlers.fail(status, error)
  }

  // ---- stdout framing ----

  #onStdout(chunk: Buffer): void {
    if (this.stopped) return
    let from = 0
    while (from < chunk.length) {
      const at = chunk.indexOf(LF, from)
      if (at === -1) {
        const rest = chunk.subarray(from)
        this.#partial.push(rest)
        this.#partialBytes += rest.length
        if (this.#partialBytes > MAX_FRAME_BYTES) this.#fail('protocol-error', `stdout frame exceeds ${MAX_FRAME_BYTES} bytes`)
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
      if (this.stopped) return
    }
  }

  #onLine(bytes: Buffer): void {
    if (bytes.length > 0 && bytes[bytes.length - 1] === CR) bytes = bytes.subarray(0, bytes.length - 1)
    if (bytes.length === 0) return
    if (bytes.length > MAX_FRAME_BYTES) {
      this.#fail('protocol-error', `stdout frame exceeds ${MAX_FRAME_BYTES} bytes`)
      return
    }
    this.#handlers.line(bytes)
  }

  // ---- process end classification ----

  #onExit(exit: LeaderExit): void {
    this.leader = exit
    for (const fn of this.#onLeaderKnown.splice(0)) fn()
    if (!this.stopped) void this.#naturalEnd()
  }

  #onStdoutEnd(): void {
    if (this.stdoutClosed) return
    this.stdoutClosed = true
    this.#notifyStdio()
    if (!this.stopped) void this.#naturalEnd()
  }

  #notifyStdio(): void {
    if (this.stdoutClosed && this.stderrClosed) for (const fn of this.#onStdioClosed.splice(0)) fn()
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
        if (this.leader !== null && this.stdoutClosed) done()
        else {
          this.#onLeaderKnown.push(() => this.stdoutClosed && done())
          this.#onStdioClosed.push(() => this.leader !== null && done())
        }
      }),
      sleep(GRACE_MS),
    ])
    if (this.stopped) return
    if (this.stdoutClosed && this.#partialBytes > 0) {
      this.#fail('protocol-error', 'stdout ended inside an unterminated frame')
      return
    }
    const leader = this.leader
    const name = this.#name
    if (leader === null) {
      this.#fail('disconnected', `${name} closed stdout while still running`)
    } else if (leader.signal !== null) {
      this.#fail('signaled', `${name} was terminated by ${leader.signal}`)
    } else {
      this.#fail('exited', `${name} exited with code ${leader.code ?? -1}`)
    }
  }
}
