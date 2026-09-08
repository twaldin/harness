import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { HarnessError } from '../src/base.js'
import type { ErrorCode, OutputStream, RunSpec } from '../src/base.js'
import { run, runAsync } from '../src/registry.js'
import { runSubprocess, runSubprocessAsync } from '../src/subproc.js'
import '../src/adapters/index.js'

// These are integration tests against real child processes and pipes: real
// backpressure, real pipe buffers, real deadlines. Fake timers cannot drive
// that, so children sleep for real and the few timing assertions are bounded
// by the engine's own cleanup budget rather than guessed waits.
const ROOT = mkdtempSync(join(tmpdir(), 'harness-ts-io-'))
// cleanup is 0.5s grace + 1.0s drain; anything beyond that plus scheduling slack is a hang
const CLEANUP_BUDGET = 1.5
const SLACK = 1.5
const ABANDONED = 'onOutput callback did not complete before teardown finished'

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true })
})

let counter = 0
function workdir(): string {
  const dir = join(ROOT, `wd-${counter++}`)
  mkdirSync(dir)
  return dir
}

function leaderPid(cwd: string): number {
  return Number(readFileSync(join(cwd, 'leader.pid'), 'utf8').trim())
}

/** Polls real kernel process state; reaping happens asynchronously. */
async function waitGone(pid: number): Promise<void> {
  const deadline = performance.now() + 5000
  while (isRunning(pid) && performance.now() < deadline) await Bun.sleep(5)
}

/** Unbuffered Python child: exact control over write boundaries and flushes. */
function py(code: string): string[] {
  return ['python3', '-u', '-c', code]
}

interface Chunk {
  stream: OutputStream
  text: string
}

/** Collects callback chunks separately, preserving each stream's order. */
function collector(): { chunks: Chunk[]; onOutput: (chunk: string, stream: OutputStream) => void; joined: (stream: OutputStream) => string } {
  const chunks: Chunk[] = []
  return {
    chunks,
    onOutput: (text, stream) => {
      chunks.push({ stream, text })
    },
    joined: (stream) => chunks.filter((c) => c.stream === stream).map((c) => c.text).join(''),
  }
}

function expectCode(fn: () => unknown, code: ErrorCode): void {
  let caught: unknown
  try {
    fn()
  } catch (err) {
    caught = err
  }
  expect(caught).toBeInstanceOf(HarnessError)
  expect((caught as HarnessError).code).toBe(code)
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// ── stdin ───────────────────────────────────────────────────────────────────

describe('stdin', () => {
  const ECHO_AFTER_FLOOD = 'import sys; sys.stdout.write("x" * 300000); sys.stdout.flush(); data = sys.stdin.buffer.read(); sys.stdout.write(str(len(data)))'

  test.each([runSubprocessAsync, runSubprocess])('%p: a payload larger than the pipe is delivered whole while output floods concurrently', async (entry) => {
    const payload = 'p'.repeat(1_000_000) + '\u00e9'
    const outcome = await entry(py(ECHO_AFTER_FLOOD), { cwd: workdir(), timeoutSeconds: 20, stdin: payload, maxOutputBytes: 4_000_000 })
    expect(outcome.termination).toBe('exited')
    expect(outcome.exitCode).toBe(0)
    expect(outcome.stdout).toBe('x'.repeat(300000) + String(1_000_002))
    expect(outcome.stdoutBytes).toBe(300000 + 7)
    expect(outcome.stdoutTruncated).toBe(false)
  })

  test('the child sees EOF after the payload, and immediately when stdin is omitted or empty', async () => {
    const cwd = workdir()
    const cmd = py('import sys; sys.stdout.write(repr(sys.stdin.read()))')
    expect((await runSubprocessAsync(cmd, { cwd, stdin: 'two\nlines\n' })).stdout).toBe("'two\\nlines\\n'")
    expect((await runSubprocessAsync(cmd, { cwd })).stdout).toBe("''")
    expect((await runSubprocessAsync(cmd, { cwd, stdin: '' })).stdout).toBe("''")
    expect((await runSubprocessAsync(cmd, { cwd, stdin: null })).stdout).toBe("''")
    expect(runSubprocess(cmd, { cwd, stdin: 'sync \u2713' }).stdout).toBe("'sync \u2713'")
  })

  test('a child that exits without reading a large payload reports its own exit (early EPIPE is not an error)', async () => {
    const outcome = await runSubprocessAsync(['sh', '-c', 'exit 3'], { cwd: workdir(), stdin: 'z'.repeat(2_000_000) })
    expect([outcome.termination, outcome.exitCode, outcome.launchError]).toEqual(['exited', 3, null])
    expect(outcome.durationSeconds).toBeLessThan(CLEANUP_BUDGET)
  })

  test('a non-string stdin is rejected before launch', () => {
    const cwd = workdir()
    expectCode(() => runSubprocess(['sh', '-c', 'touch launched'], { cwd, stdin: 42 as unknown as string }), 'invalid-options')
    expect(existsSync(join(cwd, 'launched'))).toBe(false)
  })
})

// ── bounded capture and decoding ────────────────────────────────────────────

describe('capture', () => {
  test('a multi-byte sequence split across chunks decodes whole in capture and callback', async () => {
    const seen = collector()
    const outcome = await runSubprocessAsync(
      py('import sys,time; sys.stdout.buffer.write(b"a\\xe2"); sys.stdout.flush(); time.sleep(0.2); sys.stdout.buffer.write(b"\\x9c\\x93b"); sys.stdout.flush()'),
      { cwd: workdir(), onOutput: seen.onOutput },
    )
    expect(outcome.stdout).toBe('a\u2713b')
    expect(seen.joined('stdout')).toBe('a\u2713b')
    expect(seen.chunks.every((c) => !c.text.includes('\ufffd'))).toBe(true)
    expect(outcome.stdoutBytes).toBe(5)
  })

  test('the cap cuts on raw bytes: a sequence split by the cap is omitted, not replaced; the stream keeps flowing to the callback', async () => {
    const seen = collector()
    const outcome = await runSubprocessAsync(py('import sys; sys.stdout.write("ab\u00e9cd")'), {
      cwd: workdir(),
      maxOutputBytes: 3, // 'a','b', first byte of 'é'
      onOutput: seen.onOutput,
    })
    expect(outcome.stdout).toBe('ab')
    expect(outcome.stdoutBytes).toBe(6)
    expect(outcome.stdoutTruncated).toBe(true)
    expect(outcome.stderrTruncated).toBe(false)
    expect(seen.joined('stdout')).toBe('ab\u00e9cd')
  })

  test('output exactly at the cap is not truncated; one byte more is', async () => {
    const cwd = workdir()
    const exact = await runSubprocessAsync(py('import sys; sys.stdout.write("abcd")'), { cwd, maxOutputBytes: 4 })
    expect([exact.stdout, exact.stdoutBytes, exact.stdoutTruncated]).toEqual(['abcd', 4, false])
    const over = await runSubprocessAsync(py('import sys; sys.stdout.write("abcde")'), { cwd, maxOutputBytes: 4 })
    expect([over.stdout, over.stdoutBytes, over.stdoutTruncated]).toEqual(['abcd', 5, true])
  })

  test('genuinely invalid or EOF-incomplete UTF-8 decodes with replacement in both capture and callback', async () => {
    const seen = collector()
    const outcome = await runSubprocessAsync(py('import sys; sys.stdout.buffer.write(b"x\\xff y\\xe2\\x9c")'), { cwd: workdir(), onOutput: seen.onOutput })
    expect(outcome.stdout).toBe('x\ufffd y\ufffd')
    expect(seen.joined('stdout')).toBe('x\ufffd y\ufffd')
    expect(outcome.stdoutTruncated).toBe(false)
  })

  test.each([runSubprocessAsync, runSubprocess])('%p: a zero cap keeps nothing but still counts and flags; the callback still receives everything', async (entry) => {
    const seen = collector()
    const opts = { cwd: workdir(), maxOutputBytes: 0, ...(entry === runSubprocessAsync ? { onOutput: seen.onOutput } : {}) }
    const outcome = await entry(['sh', '-c', 'printf hello; printf oops >&2'], opts)
    expect([outcome.stdout, outcome.stderr]).toEqual(['', ''])
    expect([outcome.stdoutBytes, outcome.stderrBytes]).toEqual([5, 4])
    expect([outcome.stdoutTruncated, outcome.stderrTruncated]).toEqual([true, true])
    if (entry === runSubprocessAsync) {
      expect(seen.joined('stdout')).toBe('hello')
      expect(seen.joined('stderr')).toBe('oops')
    }
  })

  test.each([runSubprocessAsync, runSubprocess])('%p: noisy output beyond the default cap is drained without growth or hang', async (entry) => {
    const outcome = await entry(py('import sys; b = b"y" * 65536\nfor _ in range(80): sys.stdout.buffer.write(b)'), { cwd: workdir(), timeoutSeconds: 30 })
    expect([outcome.termination, outcome.exitCode]).toEqual(['exited', 0])
    expect(outcome.stdoutBytes).toBe(80 * 65536)
    expect(outcome.stdout.length).toBe(1_048_576)
    expect(outcome.stdoutTruncated).toBe(true)
    expect(outcome.stderrTruncated).toBe(false)
  }, 35_000)

  test('a silent exit reports zero bytes and no truncation', async () => {
    const outcome = await runSubprocessAsync(['true'], { cwd: workdir() })
    expect([outcome.stdoutBytes, outcome.stderrBytes, outcome.stdoutTruncated, outcome.stderrTruncated, outcome.callbackError, outcome.timeoutKind])
      .toEqual([0, 0, false, false, null, null])
  })

  test('the sync supervisor result pipe survives the worst-case JSON expansion of a full capture', () => {
    // 64 KiB of NUL bytes per stream escape to six characters each.
    const outcome = runSubprocess(py('import sys; z = b"\\x00" * 65536; sys.stdout.buffer.write(z); sys.stderr.buffer.write(z)'), { cwd: workdir(), maxOutputBytes: 65536 })
    expect(outcome.stdout).toBe('\u0000'.repeat(65536))
    expect(outcome.stderr).toBe('\u0000'.repeat(65536))
    expect([outcome.stdoutTruncated, outcome.stderrTruncated]).toEqual([false, false])
  })

  test('maxOutputBytes must be a non-negative safe integer', () => {
    const cwd = workdir()
    for (const bad of [-1, 1.5, Number.POSITIVE_INFINITY, Number.NaN, 2 ** 53]) {
      expectCode(() => runSubprocess(['true'], { cwd, maxOutputBytes: bad }), 'invalid-options')
    }
  })
})

// ── callbacks ───────────────────────────────────────────────────────────────

describe('onOutput', () => {
  test('chunks arrive live, on separate streams, in per-stream order', async () => {
    const seen = collector()
    const cwd = workdir()
    const outcome = await runSubprocessAsync(
      py(
        'import os,sys,time\n'
        + 'sys.stdout.write("one "); sys.stderr.write("err1 ")\n'
        + 'while not os.path.exists("delivered"): time.sleep(0.01)\n'
        + 'sys.stdout.write("two"); sys.stderr.write("err2")',
      ),
      {
        cwd, timeoutSeconds: 5,
        onOutput: (text, stream) => {
          seen.onOutput(text, stream)
          // Exit requires live delivery on both streams, not a startup-time guess.
          if (seen.joined('stdout') === 'one ' && seen.joined('stderr') === 'err1 ') {
            writeFileSync(join(cwd, 'delivered'), '')
          }
        },
      },
    )
    expect(outcome.exitCode).toBe(0)
    expect(seen.joined('stdout')).toBe('one two')
    expect(seen.joined('stderr')).toBe('err1 err2')
    expect(outcome.callbackError).toBeNull()
    expect(outcome.stdout).toBe('one two')
  }, 10_000)

  test('an async callback is awaited one at a time; reading pauses meanwhile and nothing is lost', async () => {
    let inFlight = 0
    let maxInFlight = 0
    let delivered = 0
    const outcome = await runSubprocessAsync(py('import sys; b = b"z" * 65536\nfor _ in range(24): sys.stdout.buffer.write(b)'), {
      cwd: workdir(),
      timeoutSeconds: 30,
      maxOutputBytes: 4_000_000,
      onOutput: async (chunk) => {
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        await Bun.sleep(15)
        delivered += chunk.length
        inFlight -= 1
      },
    })
    expect(maxInFlight).toBe(1)
    expect(delivered).toBe(24 * 65536)
    expect(outcome.stdout.length).toBe(24 * 65536)
    expect([outcome.termination, outcome.exitCode, outcome.callbackError, outcome.stdoutTruncated]).toEqual(['exited', 0, null, false])
  })

  test('a throwing callback ends the run as callback-error and stops the group', async () => {
    const cwd = workdir()
    const outcome = await runSubprocessAsync(['sh', '-c', `echo $$ > leader.pid; echo ready; while :; do sleep 0.1; done`], {
      cwd,
      timeoutSeconds: 20,
      onOutput: () => {
        throw new TypeError('consumer refused')
      },
    })
    expect(outcome.termination).toBe('callback-error')
    expect(outcome.exitCode).toBe(-1)
    expect(outcome.timedOut).toBe(false)
    expect(outcome.timeoutKind).toBeNull()
    expect(outcome.callbackError).toBe('TypeError: consumer refused')
    expect(outcome.stdout).toBe('ready\n') // capture survives the failed delivery
    expect(outcome.durationSeconds).toBeLessThan(CLEANUP_BUDGET + SLACK)
    expect(isRunning(leaderPid(cwd))).toBe(false)
  })

  test('a rejecting async callback ends the run as callback-error with the rejection message', async () => {
    let calls = 0
    const outcome = await runSubprocessAsync(['sh', '-c', 'while :; do echo tick; sleep 0.05; done'], {
      cwd: workdir(),
      timeoutSeconds: 20,
      onOutput: async () => {
        calls += 1
        await Bun.sleep(20)
        throw new Error('async refusal')
      },
    })
    expect(outcome.termination).toBe('callback-error')
    expect(outcome.callbackError).toBe('Error: async refusal')
    expect(calls).toBe(1) // callbacks stop after the first failure
    expect(outcome.stdoutBytes).toBeGreaterThan(0)
  })

  test('a non-Error rejection is stringified', async () => {
    const outcome = await runSubprocessAsync(['sh', '-c', 'echo x; sleep 5'], {
      cwd: workdir(),
      onOutput: () => Promise.reject('plain string'),
    })
    expect([outcome.termination, outcome.callbackError]).toEqual(['callback-error', 'plain string'])
  })

  test('a callback failing after the leader exited keeps the exit reason and still reports the error', async () => {
    const cwd = workdir()
    const outcome = await runSubprocessAsync(['sh', '-c', 'echo $$ > leader.pid; echo done; exit 4'], {
      cwd,
      onOutput: async () => {
        await waitGone(leaderPid(cwd)) // fail only once the leader's exit has been observed
        throw new Error('late failure')
      },
    })
    expect([outcome.termination, outcome.exitCode, outcome.timedOut]).toEqual(['exited', 4, false])
    expect(outcome.callbackError).toBe('Error: late failure')
    expect(outcome.stdout).toBe('done\n')
  })

  test('a stalled callback cannot block cancellation; the abandoned delivery is flagged and its late rejection consumed', async () => {
    const cwd = workdir()
    const controller = new AbortController()
    let sawChunk!: () => void
    const firstChunk = new Promise<void>((resolve) => { sawChunk = resolve })
    let rejectStall!: (err: Error) => void
    const stall = new Promise<void>((_, reject) => { rejectStall = reject })
    let calls = 0
    // Each tick is 5 bytes; `count` records how many the shell attempted, so what the run
    // read can be checked against what was written whether or not the runtime honors pause().
    const pending = runSubprocessAsync(['sh', '-c', 'echo $$ > leader.pid; i=0; while :; do i=$((i+1)); echo $i > count; echo tick; sleep 0.05; done'], {
      cwd,
      timeoutSeconds: 20,
      cancel: controller.signal,
      onOutput: () => {
        calls += 1
        sawChunk()
        return stall
      },
    })
    await firstChunk
    const started = performance.now()
    controller.abort()
    const outcome = await pending
    expect((performance.now() - started) / 1000).toBeLessThan(CLEANUP_BUDGET + SLACK)
    expect(outcome.termination).toBe('cancelled')
    expect(outcome.callbackError).toBe(ABANDONED)
    const attempted = Number(readFileSync(join(cwd, 'count'), 'utf8').trim())
    if (outcome.stdoutTruncated) expect(outcome.stdoutBytes).toBeLessThan(attempted * 5)
    else expect(outcome.stdoutBytes).toBeGreaterThanOrEqual((attempted - 1) * 5)
    expect(outcome.stdout).toBe('tick\n'.repeat(outcome.stdoutBytes / 5))
    expect(calls).toBe(1)
    expect(isRunning(leaderPid(cwd))).toBe(false)
    // The engine attached its own handlers: rejecting now must not surface as an unhandled rejection.
    rejectStall(new Error('rejected after the run finished'))
    await Promise.resolve()
  })

  test('a stalled callback cannot block the wall timeout', async () => {
    const outcome = await runSubprocessAsync(['sh', '-c', 'echo tick; sleep 30'], {
      cwd: workdir(),
      timeoutSeconds: 0.3,
      onOutput: () => new Promise<void>(() => {}),
    })
    expect([outcome.termination, outcome.timedOut, outcome.timeoutKind]).toEqual(['timed-out', true, 'wall'])
    expect(outcome.callbackError).toBe(ABANDONED)
    expect(outcome.durationSeconds).toBeLessThan(0.3 + CLEANUP_BUDGET + SLACK)
  })

  test('a stalled callback after a normal exit is abandoned at the drain deadline, visibly', async () => {
    const outcome = await runSubprocessAsync(['sh', '-c', 'echo only; exit 0'], {
      cwd: workdir(),
      onOutput: () => new Promise<void>(() => {}),
    })
    expect([outcome.termination, outcome.exitCode]).toEqual(['exited', 0])
    expect(outcome.callbackError).toBe(ABANDONED)
    expect(outcome.stdout).toBe('only\n')
    expect(outcome.durationSeconds).toBeLessThan(CLEANUP_BUDGET + SLACK)
  })

  test('the synchronous entry point rejects a callback before launching anything', () => {
    const cwd = workdir()
    expectCode(() => runSubprocess(['sh', '-c', 'touch launched'], { cwd, onOutput: () => {} }), 'unsupported-capability')
    expectCode(() => runSubprocess(['true'], { cwd, onOutput: 'nope' as unknown as () => void }), 'invalid-options')
    expect(existsSync(join(cwd, 'launched'))).toBe(false)
  })
})

// ── deadlines ───────────────────────────────────────────────────────────────

describe('deadlines', () => {
  test.each([runSubprocessAsync, runSubprocess])('%p: silence is not failure by default', async (entry) => {
    const outcome = await entry(['sh', '-c', 'sleep 0.6; echo late'], { cwd: workdir(), timeoutSeconds: 10 })
    expect([outcome.termination, outcome.stdout, outcome.timeoutKind]).toEqual(['exited', 'late\n', null])
  })

  test.each([runSubprocessAsync, runSubprocess])('%p: inactivity opt-in ends a silent run as timed-out/inactivity', async (entry) => {
    const outcome = await entry(['sh', '-c', 'echo start; sleep 30'], { cwd: workdir(), timeoutSeconds: 20, inactivityTimeoutSeconds: 0.3 })
    expect([outcome.termination, outcome.timedOut, outcome.exitCode, outcome.timeoutKind]).toEqual(['timed-out', true, -1, 'inactivity'])
    expect(outcome.stdout).toBe('start\n')
    expect(outcome.durationSeconds).toBeLessThan(0.3 + CLEANUP_BUDGET + SLACK)
  })

  test('the inactivity window restarts on every byte, and counts from launch', async () => {
    const chatty = await runSubprocessAsync(py('import sys,time\nfor _ in range(12): sys.stdout.write("."); time.sleep(0.1)'), {
      cwd: workdir(),
      inactivityTimeoutSeconds: 0.8,
    })
    expect([chatty.termination, chatty.stdout]).toEqual(['exited', '............'])
    const mute = await runSubprocessAsync(['sleep', '5'], { cwd: workdir(), inactivityTimeoutSeconds: 0.3 })
    expect([mute.termination, mute.timeoutKind]).toEqual(['timed-out', 'inactivity'])
  })

  test('time spent awaiting a callback does not count as inactivity', async () => {
    // Without the exclusion the 0.4s window would expire during the first 0.7s callback wait.
    const outcome = await runSubprocessAsync(['sh', '-c', 'echo a; sleep 0.2; echo b; sleep 0.6'], {
      cwd: workdir(),
      inactivityTimeoutSeconds: 0.4,
      onOutput: () => Bun.sleep(700),
    })
    expect([outcome.termination, outcome.stdout, outcome.callbackError]).toEqual(['exited', 'a\nb\n', null])
  })

  test('the wall timeout reports timeoutKind wall and wins over a later inactivity deadline', async () => {
    const outcome = await runSubprocessAsync(['sleep', '5'], { cwd: workdir(), timeoutSeconds: 0.2, inactivityTimeoutSeconds: 5 })
    expect([outcome.termination, outcome.timeoutKind]).toEqual(['timed-out', 'wall'])
  })

  test.each([runSubprocessAsync, runSubprocess])('%p: timeoutSeconds null disables the wall clock', async (entry) => {
    const outcome = await entry(['sh', '-c', 'sleep 0.3; echo ok'], { cwd: workdir(), timeoutSeconds: null })
    expect([outcome.termination, outcome.stdout, outcome.timedOut]).toEqual(['exited', 'ok\n', false])
  })

  test('invalid deadlines are rejected before launch', () => {
    const cwd = workdir()
    for (const bad of [0, -1, Number.POSITIVE_INFINITY, Number.NaN, '1' as unknown as number]) {
      expectCode(() => runSubprocess(['true'], { cwd, inactivityTimeoutSeconds: bad }), 'invalid-options')
    }
    for (const bad of [-1, Number.POSITIVE_INFINITY, Number.NaN, '1' as unknown as number]) {
      expectCode(() => runSubprocess(['true'], { cwd, timeoutSeconds: bad }), 'invalid-options')
    }
  })
})

// ── high-level run ──────────────────────────────────────────────────────────

describe('run()', () => {
  function fakeAgent(dir: string, body: string): string {
    const script = join(dir, 'fake-agent')
    writeFileSync(script, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
    return script
  }

  test('streams, feeds stdin and reports the I/O fields; the JSON parser tolerates arbitrary chunking', async () => {
    const dir = workdir()
    const executable = fakeAgent(dir, 'read line; printf \'{"type":"result","total_cost_usd":0.5,"usage":{"input_tokens":3,"output_tokens":4},"stdin":"%s"}\' "$line"')
    const seen = collector()
    const spec: RunSpec = { harness: 'claude-code', prompt: 'hi', workdir: dir, executable, stdin: 'from-caller\n', onOutput: seen.onOutput, maxOutputBytes: 512 }
    for (const entrypoint of [run, runAsync]) {
      seen.chunks.length = 0
      const result = await entrypoint(spec)
      expect([result.termination, result.exitCode, result.parseError, result.callbackError, result.timeoutKind]).toEqual(['exited', 0, null, null, null])
      expect(result.costUsd).toBe(0.5)
      expect([result.tokensIn, result.tokensOut]).toEqual([3, 4])
      expect(result.stdout).toContain('"stdin":"from-caller"')
      expect(seen.joined('stdout')).toBe(result.stdout)
      expect([result.stdoutBytes, result.stdoutTruncated, result.stderrBytes, result.stderrTruncated]).toEqual([result.stdout.length, false, 0, false])
    }
    expect(readdirSync(dir)).toEqual(['fake-agent'])
  })

  test('a callback failure is a callback-error result, not a rejection, and the workdir is cleaned', async () => {
    const dir = workdir()
    const executable = fakeAgent(dir, 'echo start; sleep 5')
    const result = await runAsync({
      harness: 'codex', prompt: 'hi', workdir: dir, executable, instructions: 'projected', timeoutSeconds: 10,
      onOutput: () => {
        throw new Error('nope')
      },
    })
    expect([result.termination, result.exitCode, result.callbackError, result.parseError]).toEqual(['callback-error', -1, 'Error: nope', null])
    expect(readdirSync(dir)).toEqual(['fake-agent'])
  })

  test('inactivity applies through run() and is reported on the result', async () => {
    const dir = workdir()
    const executable = fakeAgent(dir, 'echo start; sleep 5')
    const result = await run({ harness: 'codex', prompt: 'hi', workdir: dir, executable, inactivityTimeoutSeconds: 0.3, timeoutSeconds: null })
    expect([result.termination, result.timedOut, result.timeoutKind]).toEqual(['timed-out', true, 'inactivity'])
  })
})

test('pending callback backpressures the producer on Bun as well as Node', async () => {
  const cwd = workdir()
  const controller = new AbortController()
  let producerFinished = false
  const outcome = await runSubprocessAsync(py(
    "import os\nfor _ in range(512): os.write(1, b'x' * 65536)\nopen('complete', 'w').close()\n",
  ), {
    cwd, maxOutputBytes: 1, timeoutSeconds: 5, cancel: controller.signal,
    onOutput: async () => {
      // Real pipe/kernel backpressure: fake timers cannot give the producer CPU time.
      await Bun.sleep(300)
      producerFinished = existsSync(join(cwd, 'complete'))
      controller.abort()
    },
  })
  expect(producerFinished).toBe(false)
  expect(outcome.termination).toBe('cancelled')
  expect(outcome.stdout).toBe('x')
  expect(outcome.stdoutTruncated).toBe(true)
})

test.each([runSubprocess, runSubprocessAsync])('long finite deadlines do not overflow runtime timers', async (entry) => {
  const result = await entry(py("import time; time.sleep(0.05); print('finished')"), {
    cwd: workdir(), timeoutSeconds: 3_000_000, inactivityTimeoutSeconds: 3_000_000,
  })
  expect(result.termination).toBe('exited')
  expect(result.stdout).toBe('finished\n')
})
