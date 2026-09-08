// Exercise the published bundle under Node, independently of Bun's test runtime.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runSubprocess, runSubprocessAsync } from '../dist/index.js'

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
  console.log('PASS: bundled Node sync/async exit, signal, timeout, launch failure and startup cancellation')
} finally {
  rmSync(cwd, { recursive: true, force: true })
}
