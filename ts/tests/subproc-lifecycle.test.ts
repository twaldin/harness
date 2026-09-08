import { afterEach, describe, expect, test } from 'bun:test'
import { spawn, spawnSync } from 'child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { RunSpec, SubprocOutcome } from '../src/base.js'
import { run, runAsync } from '../src/registry.js'
import { runSubprocess, runSubprocessAsync } from '../src/subproc.js'
import '../src/adapters/index.js'

const FIXTURE = join(import.meta.dir, '../../tests/process_tree.py')
const PYTHON = 'python3'
const ROLES = ['leader', 'child', 'grandchild'] as const
const STDOUT_TEXT = 'tree stdout \u2713 \u65e5\u672c\u8a9e \u{1d11e}\n'
const STDERR_MARKER = 'PROCESS_TREE_STDERR_MARKER\n'
// cleanup is 0.5s grace + 1.0s drain; anything beyond that plus scheduling slack is a hang
const CLEANUP_BUDGET = 1.5
const SLACK = 1.5

// ── process helpers ─────────────────────────────────────────────────────────
// These are integration tests against real kernel process state (signal
// delivery, orphan reaping by init); fake timers cannot drive that, so the
// helpers poll the platform with short real waits bounded by a deadline.

/** `ps` state letters, or null when the kernel no longer knows the pid. Zombies report `Z`. */
function processState(pid: number): string | null {
  try {
    process.kill(pid, 0)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return null
  }
  const probe = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf-8' })
  const state = (probe.stdout ?? '').trim()
  return state === '' ? null : state
}

function isRunning(pid: number): boolean {
  const state = processState(pid)
  return state !== null && !state.startsWith('Z')
}

function isZombie(pid: number): boolean {
  const state = processState(pid)
  return state !== null && state.startsWith('Z')
}

/** Pids still running after `ms` (reparented orphans are reaped asynchronously). */
async function waitGone(pids: number[], ms = 2000): Promise<number[]> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (!pids.some(isRunning)) return []
    await Bun.sleep(20)
  }
  return pids.filter(isRunning)
}

function recorded(dir: string): Partial<Record<(typeof ROLES)[number], number>> {
  const pids: Partial<Record<(typeof ROLES)[number], number>> = {}
  for (const role of ROLES) {
    const file = join(dir, `${role}.pid`)
    if (existsSync(file)) pids[role] = Number(readFileSync(file, 'utf-8'))
  }
  return pids
}

function recordedPids(dir: string): number[] {
  return Object.values(recorded(dir))
}

async function waitReady(dir: string, ms = 10000): Promise<void> {
  const deadline = Date.now() + ms
  while (!existsSync(join(dir, 'ready'))) {
    if (Date.now() > deadline) throw new Error(`fixture never became ready in ${dir}`)
    await Bun.sleep(10)
  }
}

function fixtureCmd(mode: string, dir: string): string[] {
  return [PYTHON, FIXTURE, mode, dir]
}

const dirs: string[] = []
const owned: number[] = []

function treeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'harness-lifecycle-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    owned.push(...recordedPids(dir))
    rmSync(dir, { recursive: true, force: true })
  }
  for (const pid of owned.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {}
  }
})

async function assertStopped(outcome: SubprocOutcome, dir: string, timeoutSeconds: number): Promise<void> {
  const pids = recorded(dir)
  expect(Object.keys(pids).sort()).toEqual([...ROLES].sort())
  expect(await waitGone(recordedPids(dir))).toEqual([])
  expect(outcome.durationSeconds).toBeLessThan(timeoutSeconds + CLEANUP_BUDGET + SLACK)
  expect(outcome.stdout).toBe(STDOUT_TEXT) // partial capture survives forced termination
  expect(outcome.stderr).toContain(STDERR_MARKER)
}

// ── timeout ─────────────────────────────────────────────────────────────────

describe('timeout', () => {
  test('async: kills a TERM-ignoring tree and reports timed-out', async () => {
    const dir = treeDir()
    const outcome = await runSubprocessAsync(fixtureCmd('tree', dir), { cwd: dir, timeoutSeconds: 1 })
    expect(outcome.timedOut).toBe(true)
    expect(outcome.exitCode).toBe(-1)
    expect(outcome.termination).toBe('timed-out')
    expect(outcome.launchError).toBeNull()
    expect(outcome.durationSeconds).toBeGreaterThanOrEqual(1)
    await assertStopped(outcome, dir, 1)
  })

  test('sync: kills a TERM-ignoring tree and reports timed-out', async () => {
    const dir = treeDir()
    const outcome = runSubprocess(fixtureCmd('tree', dir), { cwd: dir, timeoutSeconds: 1 })
    expect(outcome.timedOut).toBe(true)
    expect(outcome.exitCode).toBe(-1)
    expect(outcome.termination).toBe('timed-out')
    await assertStopped(outcome, dir, 1)
  })

  test('direct child is reaped, not left as a zombie', async () => {
    const dir = treeDir()
    const outcome = await runSubprocessAsync(fixtureCmd('solo', dir), { cwd: dir, timeoutSeconds: 1 })
    expect(outcome.termination).toBe('timed-out')
    const leader = recorded(dir).leader!
    expect(await waitGone([leader], 500)).toEqual([])
    expect(isZombie(leader)).toBe(false)
  })

  test('an unrelated session survives cleanup', async () => {
    const dir = treeDir()
    const bystander = spawn(PYTHON, ['-c', 'import time; time.sleep(60)'], { detached: true, stdio: 'ignore' })
    owned.push(bystander.pid!)
    await runSubprocessAsync(fixtureCmd('tree', dir), { cwd: dir, timeoutSeconds: 1 })
    expect(bystander.exitCode).toBeNull()
    expect(isRunning(bystander.pid!)).toBe(true)
  })
})

// ── AbortSignal ─────────────────────────────────────────────────────────────

describe('cancel', () => {
  test('async: abort after readiness returns a cancelled outcome and stops the tree', async () => {
    const dir = treeDir()
    const controller = new AbortController()
    const pending = runSubprocessAsync(fixtureCmd('tree', dir), {
      cwd: dir,
      timeoutSeconds: 20,
      cancel: controller.signal,
    })
    await waitReady(dir)
    const started = Date.now()
    controller.abort()
    const outcome = await pending
    expect(Date.now() - started).toBeLessThan((CLEANUP_BUDGET + SLACK) * 1000)
    expect(outcome.termination).toBe('cancelled')
    expect(outcome.exitCode).toBe(-1)
    expect(outcome.timedOut).toBe(false)
    expect(outcome.launchError).toBeNull()
    await assertStopped(outcome, dir, 0)
  })

  test('async: abort during startup still owns the process', async () => {
    const dir = treeDir()
    const controller = new AbortController()
    const pending = runSubprocessAsync(fixtureCmd('solo', dir), {
      cwd: dir,
      timeoutSeconds: 20,
      cancel: controller.signal,
    })
    controller.abort() // spawn has been requested but no handle has been observed yet
    const outcome = await pending
    expect(outcome.termination).toBe('cancelled')
    expect(outcome.exitCode).toBe(-1)
    if (existsSync(join(dir, 'leader.pid'))) {
      expect(await waitGone(recordedPids(dir), 500)).toEqual([])
    }
  })

  test('async: pre-aborted signal never launches', async () => {
    const dir = treeDir()
    const outcome = await runSubprocessAsync(['sh', '-c', 'touch launched; sleep 5'], {
      cwd: dir,
      timeoutSeconds: 5,
      cancel: AbortSignal.abort(),
    })
    expect(outcome.termination).toBe('cancelled')
    expect(outcome.exitCode).toBe(-1)
    expect(outcome.timedOut).toBe(false)
    expect(outcome.durationSeconds).toBeLessThan(1)
    await Bun.sleep(200) // a wrongly launched shell would create the file shortly after; nothing to await
    expect(existsSync(join(dir, 'launched'))).toBe(false)
  })

  test('sync: pre-aborted signal never launches', async () => {
    const dir = treeDir()
    const outcome = runSubprocess(['sh', '-c', 'touch launched; sleep 5'], {
      cwd: dir,
      timeoutSeconds: 5,
      cancel: AbortSignal.abort(),
    })
    expect(outcome.termination).toBe('cancelled')
    expect(outcome.exitCode).toBe(-1)
    expect(outcome.timedOut).toBe(false)
    expect(outcome.durationSeconds).toBeLessThan(1)
    await Bun.sleep(200) // a wrongly launched shell would create the file shortly after; nothing to await
    expect(existsSync(join(dir, 'launched'))).toBe(false)
  })

  test('async: aborting twice is harmless', async () => {
    const dir = treeDir()
    const controller = new AbortController()
    const pending = runSubprocessAsync(fixtureCmd('tree', dir), {
      cwd: dir,
      timeoutSeconds: 20,
      cancel: controller.signal,
    })
    await waitReady(dir)
    controller.abort()
    controller.abort()
    const outcome = await pending
    expect(outcome.termination).toBe('cancelled')
    expect(await waitGone(recordedPids(dir))).toEqual([])
  })
})

// ── leader exit with leftovers ──────────────────────────────────────────────

describe('leader exit', () => {
  test.each(['early-exit', 'closed-pipes'])('async: %s stops descendants even after pipe EOF', async (mode) => {
    const dir = treeDir()
    const outcome = await runSubprocessAsync(fixtureCmd(mode, dir), { cwd: dir, timeoutSeconds: 30 })
    expect(outcome.exitCode).toBe(7)
    expect(outcome.termination).toBe('exited')
    expect(outcome.signal).toBeNull()
    expect(outcome.timedOut).toBe(false)
    expect(outcome.durationSeconds).toBeLessThan(CLEANUP_BUDGET + SLACK + 1) // not the 30s run timeout
    await assertStopped(outcome, dir, 0)
  })

  test.each(['early-exit', 'closed-pipes'])('sync: %s stops descendants even after pipe EOF', async (mode) => {
    const dir = treeDir()
    const outcome = runSubprocess(fixtureCmd(mode, dir), { cwd: dir, timeoutSeconds: 30 })
    expect(outcome.exitCode).toBe(7)
    expect(outcome.termination).toBe('exited')
    expect(outcome.durationSeconds).toBeLessThan(CLEANUP_BUDGET + SLACK + 1)
    await assertStopped(outcome, dir, 0)
  })

  test('graceful tree receives SIGTERM and reaps itself', async () => {
    const dir = treeDir()
    const controller = new AbortController()
    const pending = runSubprocessAsync(fixtureCmd('graceful', dir), {
      cwd: dir,
      timeoutSeconds: 20,
      cancel: controller.signal,
    })
    await waitReady(dir)
    controller.abort()
    const outcome = await pending
    expect(outcome.termination).toBe('cancelled')
    const pids = recorded(dir)
    expect(await waitGone(recordedPids(dir))).toEqual([])
    for (const role of ROLES) {
      expect(existsSync(join(dir, `${role}.term`))).toBe(true)
      expect(isZombie(pids[role]!)).toBe(false)
    }
  })

  test('escaped pipe holder outside the group does not hang the run', async () => {
    const dir = treeDir()
    const outcome = await runSubprocessAsync(fixtureCmd('escaped', dir), { cwd: dir, timeoutSeconds: 30 })
    expect(outcome.exitCode).toBe(0)
    expect(outcome.termination).toBe('exited')
    expect(outcome.timedOut).toBe(false)
    expect(outcome.durationSeconds).toBeLessThan(CLEANUP_BUDGET + SLACK)
    expect(outcome.stdout).toBe(STDOUT_TEXT)
    const pids = recorded(dir)
    expect(isZombie(pids.leader!)).toBe(false)
    // Documented limitation: a descendant that left the group is not ours to stop.
    expect(isRunning(pids.child!)).toBe(true)
  })
})

// ── termination classification ──────────────────────────────────────────────

describe('classification', () => {
  test('self-signal is signaled, not timed-out', async () => {
    const dir = treeDir()
    const outcome = await runSubprocessAsync(fixtureCmd('self-signal', dir), { cwd: dir, timeoutSeconds: 10 })
    expect(outcome.termination).toBe('signaled')
    expect(outcome.signal).toBe('SIGTERM')
    expect(outcome.exitCode).toBe(-15) // documented: signal exits normalize to the negative signal number
    expect(outcome.timedOut).toBe(false)
    expect(outcome.durationSeconds).toBeLessThan(10 - SLACK)
  })

  test('partial UTF-8 decodes with replacement instead of raw bytes', async () => {
    const dir = treeDir()
    const outcome = await runSubprocessAsync(fixtureCmd('partial-utf8', dir), { cwd: dir, timeoutSeconds: 1 })
    expect(outcome.termination).toBe('timed-out')
    expect(outcome.stdout.startsWith('h\u00e9llo ')).toBe(true)
    expect(outcome.stdout.replace(/\ufffd+$/, '')).toBe('h\u00e9llo ')
    expect(outcome.stdout).toContain('\ufffd')
  })

  test('missing binary is launch-failed ENOENT (async and sync)', async () => {
    const dir = treeDir()
    const cmd = [join(dir, 'no-such-binary')]
    for (const outcome of [await runSubprocessAsync(cmd, { cwd: dir, timeoutSeconds: 5 }), runSubprocess(cmd, { cwd: dir, timeoutSeconds: 5 })]) {
      expect(outcome.termination).toBe('launch-failed')
      expect(outcome.launchError).toBe('ENOENT')
      expect(outcome.exitCode).toBe(-1)
      expect(outcome.timedOut).toBe(false)
      expect(outcome.signal).toBeNull()
      expect(outcome.durationSeconds).toBeLessThan(1)
    }
  })

  test.each([runSubprocess, runSubprocessAsync])('missing cwd is launch-failed ENOENT', async (run) => {
    const dir = treeDir()
    const outcome = await run(['sh', '-c', 'true'], { cwd: join(dir, 'gone'), timeoutSeconds: 5 })
    expect(outcome.termination).toBe('launch-failed')
    expect(outcome.launchError).toBe('ENOENT')
    expect(outcome.exitCode).toBe(-1)
  })

  test('non-executable file is launch-failed EACCES', async () => {
    const dir = treeDir()
    const script = join(dir, 'not-executable')
    writeFileSync(script, '#!/bin/sh\necho ran\n')
    chmodSync(script, 0o600)
    const outcome = await runSubprocessAsync([script], { cwd: dir, timeoutSeconds: 5 })
    expect(outcome.termination).toBe('launch-failed')
    expect(outcome.launchError).toBe('EACCES')
    expect(outcome.exitCode).toBe(-1)
    expect(outcome.timedOut).toBe(false)
  })

  test('normal exit reports exited with no signal or launch error', async () => {
    const dir = treeDir()
    const outcome = await runSubprocessAsync(['sh', '-c', 'exit 3'], { cwd: dir, timeoutSeconds: 5 })
    expect([outcome.exitCode, outcome.termination, outcome.signal, outcome.launchError]).toEqual([3, 'exited', null, null])
  })
})

// ── adapter-level classification ────────────────────────────────────────────

function installFakeClaude(dir: string): () => void {
  const binDir = join(dir, 'bin')
  mkdirSync(binDir, { recursive: true })
  const script = join(binDir, 'claude')
  writeFileSync(script, `#!/bin/sh\nexec ${PYTHON} "${FIXTURE}" "\${PROCESS_TREE_MODE:-tree}" "$PROCESS_TREE_DIR"\n`, { mode: 0o755 })
  const savedPath = process.env.PATH
  process.env.PATH = `${binDir}:${savedPath ?? ''}`
  return () => {
    process.env.PATH = savedPath
  }
}

describe('RunResult classification', () => {
  test('run(): RunSpec.cancel abort classifies the result as cancelled', async () => {
    const dir = treeDir()
    const restore = installFakeClaude(dir)
    try {
      const controller = new AbortController()
      const spec: RunSpec = {
        harness: 'claude-code',
        prompt: 'hi',
        workdir: dir,
        timeoutSeconds: 20,
        env: { PROCESS_TREE_DIR: dir },
        cancel: controller.signal,
      }
      const pending = run(spec)
      await waitReady(dir)
      controller.abort()
      const result = await pending
      expect(result.termination).toBe('cancelled')
      expect(result.exitCode).toBe(-1)
      expect(result.timedOut).toBe(false)
      expect(result.launchError).toBeNull()
      expect(result.costUsd).toBeNull()
      expect(result.stdout).toBe(STDOUT_TEXT)
      expect(await waitGone(recordedPids(dir))).toEqual([])
    } finally {
      restore()
    }
  })

  test('runAsync(): abort stops the tree', async () => {
    const dir = treeDir()
    const restore = installFakeClaude(dir)
    try {
      const controller = new AbortController()
      const pending = runAsync({
        harness: 'claude-code',
        prompt: 'hi',
        workdir: dir,
        timeoutSeconds: 20,
        env: { PROCESS_TREE_DIR: dir },
        cancel: controller.signal,
      })
      await waitReady(dir)
      controller.abort()
      const result = await pending
      expect(result.termination).toBe('cancelled')
      expect(await waitGone(recordedPids(dir))).toEqual([])
    } finally {
      restore()
    }
  })

  test('run(): missing CLI classifies as launch-failed', async () => {
    const dir = treeDir()
    const savedPath = process.env.PATH
    process.env.PATH = dir // no `claude` anywhere
    try {
      const result = await run({ harness: 'claude-code', prompt: 'hi', workdir: dir, timeoutSeconds: 5 })
      expect(result.termination).toBe('launch-failed')
      expect(result.launchError).toBe('ENOENT')
      expect(result.exitCode).toBe(-1)
      expect(result.timedOut).toBe(false)
    } finally {
      process.env.PATH = savedPath
    }
  })
})
