// Exercise the published bundle under Node, independently of Bun's test runtime.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { runSubprocess, runSubprocessAsync } from '../dist/index.js'

async function waitUntil(predicate) {
  const deadline = performance.now() + 5000
  while (!predicate()) {
    assert.ok(performance.now() < deadline, 'process readiness/exit deadline exceeded')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const cwd = mkdtempSync(join(tmpdir(), 'harness-node-lifecycle-'))
try {
  for (const run of [runSubprocess, runSubprocessAsync]) {
    const normal = await run([process.execPath, '-e', 'process.stdout.write("synthetic λ"); process.exitCode = 7'], { cwd })
    assert.equal(normal.termination, 'exited')
    assert.equal(normal.exitCode, 7)
    assert.equal(normal.stdout, 'synthetic λ')

    const signaled = await run([process.execPath, '-e', 'process.kill(process.pid, "SIGTERM")'], { cwd })
    assert.equal(signaled.termination, 'signaled')
    assert.equal(signaled.signal, 'SIGTERM')
    assert.equal(signaled.timedOut, false)

    const timeout = await run(['sh', '-c', 'trap "" TERM; echo synthetic-ready; while :; do sleep 1; done'], {
      cwd, timeoutSeconds: 0.2,
    })
    assert.equal(timeout.termination, 'timed-out')
    assert.equal(timeout.exitCode, -1)
    assert.match(timeout.stdout, /synthetic-ready/)
    assert.ok(timeout.durationSeconds < 3, 'TERM-resistant group cleanup exceeded deadline')

    const missing = await run([join(cwd, 'missing-cli')], { cwd })
    assert.equal(missing.termination, 'launch-failed')
    assert.equal(missing.launchError, 'ENOENT')
  }

  const controller = new AbortController()
  const pending = runSubprocessAsync(['sh', '-c', 'sleep 30'], { cwd, cancel: controller.signal })
  controller.abort()
  const cancelled = await pending
  assert.equal(cancelled.termination, 'cancelled')
  assert.equal(cancelled.timedOut, false)

  // ---- streaming and I/O under Node: the pause() backpressure path Bun cannot exercise ----
  for (const run of [runSubprocess, runSubprocessAsync]) {
    const fed = await run(['sh', '-c', 'cat; printf " %s" "$(cat)"'], { cwd, stdin: 'a'.repeat(200_000) + ' λ', maxOutputBytes: 300_000 })
    assert.equal(fed.termination, 'exited')
    assert.equal(fed.stdout, 'a'.repeat(200_000) + ' λ ')
    assert.equal(fed.stdoutBytes, 200_000 + 4)
    assert.equal(fed.stdoutTruncated, false)

    const capped = await run(['sh', '-c', 'head -c 3000000 /dev/zero | tr "\\0" q; printf "e\\303" >&2'], { cwd, maxOutputBytes: 1000 })
    assert.equal(capped.stdout, 'q'.repeat(1000))
    assert.equal(capped.stdoutBytes, 3_000_000)
    assert.equal(capped.stdoutTruncated, true)
    assert.equal(capped.stderr, 'e\ufffd') // genuinely incomplete at EOF decodes with replacement
    assert.equal(capped.stderrTruncated, false)

    const idle = await run(['sh', '-c', 'echo up; sleep 30'], { cwd, timeoutSeconds: null, inactivityTimeoutSeconds: 0.2 })
    assert.equal(idle.termination, 'timed-out')
    assert.equal(idle.timeoutKind, 'inactivity')
    assert.equal(idle.stdout, 'up\n')
    assert.ok(idle.durationSeconds < 3, 'inactivity teardown exceeded deadline')
  }
  assert.throws(() => runSubprocess(['true'], { cwd, onOutput: () => {} }), (err) => err.code === 'unsupported-capability')

  // A slow async consumer must throttle the producer: with pause() honored,
  // the child cannot finish 8 MiB while each 64 KiB read waits 10ms, so it is
  // still alive when half of the output has been delivered.
  const producer = join(cwd, 'producer.pid')
  let aliveAtHalf = null
  let delivered = 0
  let inFlight = 0
  let maxInFlight = 0
  const streamed = await runSubprocessAsync(['sh', '-c', `echo $$ > ${JSON.stringify(producer)}; head -c 8388608 /dev/zero | tr "\\0" s`], {
    cwd,
    maxOutputBytes: 0,
    onOutput: async (chunk, stream) => {
      assert.equal(stream, 'stdout')
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 10))
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
  assert.equal(streamed.termination, 'exited')
  assert.equal(streamed.callbackError, null)
  assert.equal(maxInFlight, 1)
  assert.equal(delivered, 8_388_608)
  assert.equal(streamed.stdoutBytes, 8_388_608)
  assert.equal(streamed.stdout, '')
  assert.equal(streamed.stdoutTruncated, true)
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
  console.log('PASS: bundled Node sync/async outcomes, streaming backpressure and I/O fields, startup cancellation and supervisor parent-death ownership')
} finally {
  rmSync(cwd, { recursive: true, force: true })
}
