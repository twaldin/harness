// Shared subprocess conformance executor (tests/subprocess_cases.json) plus the
// Node smoke that exercises the published bundle, independently of Bun's test
// runtime. `bun test` imports the executor and runs the cases against src;
// `node tests/node-lifecycle.mjs` runs the same cases against dist and then the
// Node-only checks (FIFO ownership, pause() backpressure, supervisor lifetime).
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const TESTS_DIR = fileURLToPath(new URL('../../tests/', import.meta.url))
export const CASES_PATH = join(TESTS_DIR, 'subprocess_cases.json')
export const PROCESS_TREE = join(TESTS_DIR, 'process_tree.py')
export const PYTHON = 'python3'
export const ROLES = ['leader', 'child', 'grandchild']
export const LANGUAGE = 'typescript'
export const RUNNERS = ['sync', 'async']

const REQUIRED_CATEGORIES = ['spawn', 'stdinEof', 'signal', 'timeout', 'cancellation', 'grandchildren', 'flood', 'chunkBoundary']
const OPTION_NAMES = { timeoutSeconds: true, inactivityTimeoutSeconds: true, maxOutputBytes: true, stdin: true, onOutput: true, gracefulSignal: true }
const OUTCOME_FIELDS = {
  termination: true, exitCode: true, timedOut: true, signal: true, launchError: true, timeoutKind: true, callbackError: true,
  stdout: true, stderr: true, stdoutBytes: true, stderrBytes: true, stdoutTruncated: true, stderrTruncated: true,
}
const DERIVED_EXPECTATIONS = {
  stdoutLength: true, stderrLength: true, stdoutEqualsStdin: true, stdoutPattern: true, stderrContains: true,
  streamedStdout: true, streamedStderr: true, streamedNoReplacement: true,
  minDurationSeconds: true, maxDurationSeconds: true, maxCancelLatencySeconds: true,
  treeStopped: true, leaderReaped: true, childRunning: true, filesExist: true, filesAbsent: true,
}
const STREAMED_EXPECTATIONS = ['streamedStdout', 'streamedStderr', 'streamedNoReplacement']
const TREE_EXPECTATIONS = ['treeStopped', 'leaderReaped', 'childRunning']

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ── process helpers ─────────────────────────────────────────────────────────
// Integration tests against real kernel process state (signal delivery, orphan
// reaping by init); fake timers cannot drive that, so the helpers poll the
// platform with short real waits bounded by a deadline.

/** `ps` state letters, or null when the kernel no longer knows the pid. Zombies report `Z`. */
export function processState(pid) {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`invalid recorded PID: ${pid}`)
  try {
    process.kill(pid, 0)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return null
  }
  const probe = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf-8' })
  const state = (probe.stdout ?? '').trim()
  return state === '' ? null : state
}

export function isRunning(pid) {
  const state = processState(pid)
  return state !== null && !state.startsWith('Z')
}

export function isZombie(pid) {
  const state = processState(pid)
  return state !== null && state.startsWith('Z')
}

/** Pids still running after `ms` (reparented orphans are reaped asynchronously). */
export async function waitGone(pids, ms = 2000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (!pids.some(isRunning)) return []
    await sleep(20)
  }
  return pids.filter(isRunning)
}

/** `{ leader, child, grandchild }` pids the process_tree fixture recorded in `dir` (missing roles omitted). */
export function recorded(dir) {
  const pids = {}
  for (const role of ROLES) {
    const file = join(dir, `${role}.pid`)
    if (existsSync(file)) pids[role] = Number(readFileSync(file, 'utf-8'))
  }
  return pids
}

export function recordedPids(dir) {
  return Object.values(recorded(dir))
}

export function killRecorded(dir) {
  for (const pid of recordedPids(dir)) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {}
  }
}

export async function waitReady(dir, ms = 10000) {
  const deadline = Date.now() + ms
  while (!existsSync(join(dir, 'ready'))) {
    if (Date.now() > deadline) throw new Error(`fixture never became ready in ${dir}`)
    await sleep(10)
  }
}

// ── shared cases ────────────────────────────────────────────────────────────

export function loadSharedCases() {
  return JSON.parse(readFileSync(CASES_PATH, 'utf8'))
}

/** Coverage guard: every case runs here, and only with entry points that can honor its options. */
export function validateSharedManifest(manifest) {
  const ids = manifest.cases.map((kase) => kase.id)
  assert.equal(new Set(ids).size, ids.length, 'duplicate case ids')
  assert.deepEqual([...manifest.categories].sort(), [...REQUIRED_CATEGORIES].sort())
  assert.deepEqual([...new Set(manifest.cases.map((kase) => kase.category))].sort(), [...REQUIRED_CATEGORIES].sort(), 'a required category has no case')
  for (const kase of manifest.cases) {
    assert.deepEqual(Object.keys(kase.runners).sort(), ['python', LANGUAGE], `${kase.id}: runners must name both languages`)
    const runners = kase.runners[LANGUAGE]
    assert.ok(runners.length > 0 && runners.every((runner) => RUNNERS.includes(runner)), `${kase.id}: no TypeScript runner`)
    assert.ok('timeoutSeconds' in kase.options, `${kase.id}: timeoutSeconds must be explicit`)
    for (const key of Object.keys(kase.options)) assert.ok(Object.hasOwn(OPTION_NAMES, key), `${kase.id}: unknown option ${key}`)
    const expectations = Object.keys(kase.expect)
    for (const key of expectations) assert.ok(Object.hasOwn(OUTCOME_FIELDS, key) || Object.hasOwn(DERIVED_EXPECTATIONS, key), `${kase.id}: unknown expectation ${key}`)
    assert.ok([undefined, 'beforeLaunch', 'afterReady'].includes(kase.cancel), `${kase.id}: unknown cancel mode`)
    if (expectations.some((key) => STREAMED_EXPECTATIONS.includes(key))) assert.ok(kase.options.onOutput, `${kase.id}: streamed expectations need onOutput`)
    if (kase.acknowledgeChunks) assert.ok(kase.options.onOutput && kase.argv.includes('gated-pieces'), `${kase.id}: chunk acknowledgement needs a gated child and callback`)
    if (expectations.some((key) => TREE_EXPECTATIONS.includes(key)) || kase.cancel === 'afterReady') {
      assert.ok(kase.argv.includes('{tests}/process_tree.py'), `${kase.id}: needs the process_tree fixture`)
    }
    if (expectations.includes('maxCancelLatencySeconds')) assert.equal(kase.cancel, 'afterReady', `${kase.id}: cancel latency needs afterReady`)
    if (runners.includes('sync')) {
      // runSubprocess blocks its caller: it rejects onOutput and cannot observe an abort raised after launch.
      assert.ok(!kase.options.onOutput, `${kase.id}: the sync entry point cannot stream; list only async`)
      assert.notEqual(kase.cancel, 'afterReady', `${kase.id}: the sync entry point cannot be cancelled in flight; list only async`)
    }
  }
}

function substitute(value, dir) {
  return value.replaceAll('{python}', PYTHON).replaceAll('{tests}', TESTS_DIR.replace(/\/$/, '')).replaceAll('{dir}', dir)
}

/**
 * Runs one manifest case with `entry` (`{ runSubprocess, runSubprocessAsync }`
 * from src or dist) in `dir` and returns what was observed: the outcome, the
 * stdin text fed, streamed chunks and the cancel-to-return latency.
 */
export async function runSharedCase(entry, kase, runner, dir) {
  for (const [name, spec] of Object.entries(kase.files ?? {})) {
    writeFileSync(join(dir, name), spec.content)
    chmodSync(join(dir, name), spec.mode)
  }
  const cmd = kase.argv.map((arg) => substitute(arg, dir))
  const opts = { cwd: substitute(kase.cwd ?? '{dir}', dir) }
  const chunks = []
  let stdin = null
  for (const [key, value] of Object.entries(kase.options)) {
    if (key === 'onOutput') {
      if (value) opts.onOutput = (text, stream) => {
        chunks.push({ stream, text })
        if (kase.acknowledgeChunks) writeFileSync(join(dir, `chunk-${chunks.length - 1}`), '')
      }
      continue
    }
    if (key === 'stdin') {
      stdin = value !== null && typeof value === 'object' ? value.repeat.repeat(value.times) : value
      opts.stdin = stdin
      continue
    }
    opts[key] = value
  }
  let controller = null
  if (kase.cancel === 'beforeLaunch') opts.cancel = AbortSignal.abort()
  if (kase.cancel === 'afterReady') {
    controller = new AbortController()
    opts.cancel = controller.signal
  }
  const run = runner === 'sync' ? entry.runSubprocess : entry.runSubprocessAsync
  const pending = run(cmd, opts)
  let cancelledAt = null
  if (controller !== null) {
    try {
      await waitReady(dir)
      cancelledAt = performance.now()
    } finally {
      controller.abort()
      await pending
    }
  }
  const outcome = await pending
  const cancelLatency = cancelledAt === null ? null : (performance.now() - cancelledAt) / 1000
  return { outcome, stdin, chunks, cancelLatency }
}

const streamed = (observed, stream) => observed.chunks.filter((chunk) => chunk.stream === stream).map((chunk) => chunk.text).join('')

/** Asserts every `expect` entry of `kase` against `observed`; unknown keys fail loudly. */
export async function checkSharedCase(kase, observed, dir) {
  const { outcome } = observed
  for (const [key, expected] of Object.entries(kase.expect)) {
    const label = `${kase.id}: ${key}`
    if (Object.hasOwn(OUTCOME_FIELDS, key)) assert.equal(outcome[key], expected, label)
    else if (key === 'stdoutLength') assert.equal(outcome.stdout.length, expected, label)
    else if (key === 'stderrLength') assert.equal(outcome.stderr.length, expected, label)
    else if (key === 'stdoutEqualsStdin') assert.equal(outcome.stdout === observed.stdin, expected, label)
    else if (key === 'stdoutPattern') assert.match(outcome.stdout, new RegExp(expected, 'u'), label)
    else if (key === 'stderrContains') assert.ok(outcome.stderr.includes(expected), label)
    else if (key === 'streamedStdout') assert.equal(streamed(observed, 'stdout'), expected, label)
    else if (key === 'streamedStderr') assert.equal(streamed(observed, 'stderr'), expected, label)
    else if (key === 'streamedNoReplacement') assert.equal(observed.chunks.every((chunk) => !chunk.text.includes('\ufffd')), expected, label)
    else if (key === 'minDurationSeconds') assert.ok(outcome.durationSeconds >= expected, `${label}: ${outcome.durationSeconds}`)
    else if (key === 'maxDurationSeconds') assert.ok(outcome.durationSeconds <= expected, `${label}: ${outcome.durationSeconds}`)
    else if (key === 'maxCancelLatencySeconds') {
      assert.ok(observed.cancelLatency !== null && observed.cancelLatency <= expected, `${label}: ${observed.cancelLatency}`)
    } else if (key === 'treeStopped') {
      const pids = recorded(dir)
      assert.deepEqual(Object.keys(pids).sort(), [...ROLES].sort(), label)
      assert.equal((await waitGone(Object.values(pids))).length === 0, expected, label)
    } else if (key === 'leaderReaped') {
      const leader = recorded(dir).leader
      assert.ok(leader !== undefined, `${label}: fixture did not record its leader PID`)
      assert.equal((await waitGone([leader], 500)).length === 0 && !isZombie(leader), expected, label)
    } else if (key === 'childRunning') {
      const child = recorded(dir).child
      assert.ok(child !== undefined, `${label}: fixture did not record its child PID`)
      assert.equal(isRunning(child), expected, label)
    } else if (key === 'filesExist') {
      assert.deepEqual(expected.filter((name) => existsSync(join(dir, name))), expected, label)
    } else if (key === 'filesAbsent') {
      await sleep(200) // a wrongly launched child would create the file shortly after; nothing to await
      assert.deepEqual(expected.filter((name) => existsSync(join(dir, name))), [], label)
    } else {
      throw new Error(`${label}: unknown expectation`)
    }
  }
}

// ── Node smoke against the built bundle ────────────────────────────────────

async function waitUntil(predicate) {
  const deadline = performance.now() + 5000
  while (!predicate()) {
    assert.ok(performance.now() < deadline, 'process readiness/exit deadline exceeded')
    await sleep(10)
  }
}

async function smoke() {
  const { runSubprocess, runSubprocessAsync } = await import('../dist/index.js')
  const dist = { runSubprocess, runSubprocessAsync }
  const manifest = loadSharedCases()
  validateSharedManifest(manifest)

  const cwd = mkdtempSync(join(tmpdir(), 'harness-node-lifecycle-'))
  try {
    // ---- the shared conformance cases, against dist under Node ----
    let ran = 0
    for (const kase of manifest.cases) {
      for (const runner of kase.runners[LANGUAGE]) {
        const dir = mkdtempSync(join(cwd, `${kase.id}-${runner}-`))
        try {
          const observed = await runSharedCase(dist, kase, runner, dir)
          await checkSharedCase(kase, observed, dir)
          ran += 1
        } catch (err) {
          if (err instanceof Error) err.message = `${kase.id}[${runner}] against dist: ${err.message}`
          throw err
        } finally {
          killRecorded(dir)
        }
      }
    }

    for (const run of [runSubprocess, runSubprocessAsync]) {
      // A CI shell may inherit unrelated FIFOs. Check duplicates of our two
      // capture pipes by device/inode, not all FIFO descriptors in the process.
      const descriptors = await run(['python3', '-c', [
        'import json, os',
        'owned = {(os.fstat(fd).st_dev, os.fstat(fd).st_ino) for fd in (1, 2)}',
        'pipes = []',
        'for fd in range(256):',
        '    try:',
        '        info = os.fstat(fd)',
        '        if (info.st_dev, info.st_ino) in owned: pipes.append(fd)',
        '    except OSError: pass',
        'print(json.dumps(pipes))',
      ].join('\n')], { cwd })
      assert.deepEqual(JSON.parse(descriptors.stdout), [1, 2], 'private FIFO descriptors leaked into the child')
    }

    // ---- streaming under Node: the pause() backpressure path Bun cannot exercise ----
    assert.throws(() => runSubprocess(['true'], { cwd, onOutput: () => {} }), (err) => err.code === 'unsupported-capability')

    // A slow async consumer must throttle the producer: with pause() honored,
    // the child cannot finish 8 MiB while each 64 KiB read waits 10ms, so it is
    // still alive when half of the output has been delivered.
    const producer = join(cwd, 'producer.pid')
    let aliveAtHalf = null
    let delivered = 0
    let inFlight = 0
    let maxInFlight = 0
    const streamedOutcome = await runSubprocessAsync(['sh', '-c', `echo $$ > ${JSON.stringify(producer)}; head -c 8388608 /dev/zero | tr "\\0" s`], {
      cwd,
      maxOutputBytes: 0,
      onOutput: async (chunk, stream) => {
        assert.equal(stream, 'stdout')
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        await sleep(10)
        delivered += chunk.length
        inFlight -= 1
        if (aliveAtHalf === null && delivered >= 4_194_304) {
          try {
            process.kill(Number(readFileSync(producer, 'utf8')), 0)
            aliveAtHalf = true
          } catch {
            aliveAtHalf = false
          }
        }
      },
    })
    assert.equal(streamedOutcome.termination, 'exited')
    assert.equal(streamedOutcome.callbackError, null)
    assert.equal(maxInFlight, 1)
    assert.equal(delivered, 8_388_608)
    assert.equal(streamedOutcome.stdoutBytes, 8_388_608)
    assert.equal(streamedOutcome.stdout, '')
    assert.equal(streamedOutcome.stdoutTruncated, true)
    assert.equal(aliveAtHalf, true, 'producer finished before half of its output was consumed: no backpressure')

    // A stalled consumer never blocks cancellation. Whether output was lost
    // depends on how much the producer wrote versus what was read before the
    // forced close; the flag must agree with the producer's own count.
    const stallController = new AbortController()
    let firstChunk
    const sawFirst = new Promise((resolve) => { firstChunk = resolve })
    const count = join(cwd, 'count')
    const stalled = runSubprocessAsync(['sh', '-c', `i=0; while :; do i=$((i+1)); echo $i > ${JSON.stringify(count)}; echo tick; sleep 0.05; done`], {
      cwd,
      cancel: stallController.signal,
      onOutput: () => { firstChunk(); return new Promise(() => {}) },
    })
    await sawFirst
    stallController.abort()
    const abandoned = await stalled
    assert.equal(abandoned.termination, 'cancelled')
    assert.equal(abandoned.callbackError, 'onOutput callback did not complete before teardown finished')
    const attempted = Number(readFileSync(count, 'utf8'))
    if (abandoned.stdoutTruncated) assert.ok(abandoned.stdoutBytes < attempted * 5, 'flagged truncated but nothing was lost')
    else assert.ok(abandoned.stdoutBytes >= (attempted - 1) * 5, 'lost output without the truncated flag')
    assert.equal(abandoned.stdout, 'tick\n'.repeat(abandoned.stdoutBytes / 5))
    assert.ok(abandoned.durationSeconds < 3, 'stalled callback delayed cancellation teardown')

    const refused = await runSubprocessAsync(['sh', '-c', 'echo go; sleep 30'], {
      cwd,
      onOutput: () => { throw new RangeError('refused') },
    })
    assert.equal(refused.termination, 'callback-error')
    assert.equal(refused.callbackError, 'RangeError: refused')
    assert.equal(refused.exitCode, -1)
    assert.ok(refused.durationSeconds < 3, 'callback failure delayed teardown')

    // Hold the supervisor before its module loads, then kill its caller. It
    // must not mistake its new OS parent for the caller and launch an orphan.
    const ready = join(cwd, 'supervisor.pid')
    const release = join(cwd, 'release')
    const launched = join(cwd, 'target.pid')
    const preload = join(cwd, 'startup.cjs')
    writeFileSync(preload, `
      if (process.argv[2] === '--harness-supervise') {
        const fs = require('node:fs')
        const cp = require('node:child_process')
        const realSpawn = cp.spawn
        cp.spawn = (...args) => {
          const child = realSpawn(...args)
          if (child.pid) fs.writeFileSync(${JSON.stringify(launched)}, String(child.pid))
          return child
        }
        require('node:module').syncBuiltinESMExports()
        fs.writeFileSync(${JSON.stringify(ready)}, String(process.pid))
        const delay = new Int32Array(new SharedArrayBuffer(4))
        while (!fs.existsSync(${JSON.stringify(release)})) Atomics.wait(delay, 0, 0, 10)
      }
    `)
    const caller = spawn(process.execPath, ['--input-type=module', '-e', `
      import { runSubprocess } from ${JSON.stringify(new URL('../dist/index.js', import.meta.url).href)}
      runSubprocess(['sleep', '30'], { cwd: ${JSON.stringify(cwd)} })
    `], {
      stdio: 'ignore',
      env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require ${JSON.stringify(preload)}` },
    })
    try {
      await waitUntil(() => existsSync(ready))
      const exited = once(caller, 'exit')
      caller.kill('SIGKILL')
      await exited
      writeFileSync(release, '')
      const supervisor = Number(readFileSync(ready, 'utf8'))
      await waitUntil(() => {
        const state = spawnSync('ps', ['-o', 'stat=', '-p', String(supervisor)], { encoding: 'utf8' }).stdout.trim()
        return state === '' || state.startsWith('Z')
      })
      assert.equal(existsSync(launched), false, 'supervisor launched a target after its caller died')
    } finally {
      writeFileSync(release, '')
      caller.kill('SIGKILL')
      for (const file of [launched, ready]) {
        if (existsSync(file)) {
          try { process.kill(Number(readFileSync(file, 'utf8')), 'SIGKILL') } catch {}
        }
      }
    }

    // A bundled consumer's entry module is also import.meta.url inside the
    // library. Supervisor mode must finish before evaluating that consumer.
    const app = join(cwd, 'consumer.mjs')
    const bundle = join(cwd, 'consumer-bundle.mjs')
    const marker = join(cwd, 'consumer-ran')
    writeFileSync(app, `
      import assert from 'node:assert/strict'
      import { existsSync, writeFileSync } from 'node:fs'
      import { runSubprocess } from ${JSON.stringify(fileURLToPath(new URL('../dist/index.js', import.meta.url)))}
      assert.equal(existsSync(${JSON.stringify(marker)}), false, 'consumer evaluated inside supervisor')
      writeFileSync(${JSON.stringify(marker)}, '')
      const result = runSubprocess(['sh', '-c', 'printf bundled'], { cwd: ${JSON.stringify(cwd)} })
      assert.equal(result.stdout, 'bundled')
    `)
    const built = spawnSync('bun', ['build', app, '--outfile', bundle, '--target=node', '--packages=external'], { encoding: 'utf8' })
    assert.equal(built.status, 0, built.stderr)
    const bundled = spawnSync(process.execPath, [bundle], { encoding: 'utf8', timeout: 10_000, killSignal: 'SIGKILL' })
    assert.equal(bundled.status, 0, bundled.stderr)
    console.log(`PASS: ${ran} shared subprocess cases against the bundle under Node, plus FIFO ownership, streaming backpressure, stalled/failed callbacks, and supervisor parent-death ownership`)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}

function invokedDirectly() {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false // argv[1] is not a path (e.g. `bun test`)
  }
}

if (invokedDirectly()) await smoke()
