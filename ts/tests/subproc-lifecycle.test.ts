import { afterEach, describe, expect, test } from 'bun:test'
import { spawn } from 'child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { RunSpec } from '../src/base.js'
import { run, runAsync } from '../src/registry.js'
import { runSubprocess, runSubprocessAsync } from '../src/subproc.js'
import '../src/adapters/index.js'
import {
  LANGUAGE,
  PROCESS_TREE,
  PYTHON,
  checkSharedCase,
  isRunning,
  loadSharedCases,
  recordedPids,
  runSharedCase,
  validateSharedManifest,
  waitGone,
  waitReady,
} from './node-lifecycle.mjs'

// The cross-language scenarios live in ../../tests/subprocess_cases.json. The
// executor and process helpers are plain JS in node-lifecycle.mjs so that this
// suite (against src) and the Node smoke (against dist) assert the exact same
// expectations; tests/test_subproc_lifecycle.py mirrors them in Python.
// TypeScript-only behavior (abort during startup, RunResult classification)
// stays as ordinary tests below.

const STDOUT_TEXT = 'tree stdout \u2713 \u65e5\u672c\u8a9e \u{1d11e}\n'
// cleanup is 0.5s grace + 1.0s drain; anything beyond that plus scheduling slack is a hang
const CLEANUP_BUDGET = 1.5
const SLACK = 1.5

function fixtureCmd(mode: string, dir: string): string[] {
  return [PYTHON, PROCESS_TREE, mode, dir]
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

// ── shared cases (tests/subprocess_cases.json) ─────────────────────────────

const manifest: { cases: Array<{ id: string; runners: Record<'python' | 'typescript', Array<'sync' | 'async'>> }> } = loadSharedCases()
const entry = { runSubprocess, runSubprocessAsync }

describe('shared cases', () => {
  test('every case is applicable here and uses understood options/expectations', () => {
    validateSharedManifest(manifest)
  })

  const params = manifest.cases.flatMap((kase) => kase.runners.typescript.map((runner) => [`${kase.id}[${runner}]`, kase, runner] as const))
  test.each(params)('%s', async (_label, kase, runner) => {
    const dir = treeDir()
    const observed = await runSharedCase(entry, kase, runner, dir)
    await checkSharedCase(kase, observed, dir)
  }, 40_000)
})

// ── TypeScript-only lifecycle behavior ─────────────────────────────────────

describe('timeout', () => {
  test('an unrelated session survives cleanup', async () => {
    const dir = treeDir()
    const bystander = spawn(PYTHON, ['-c', 'import time; time.sleep(60)'], { detached: true, stdio: 'ignore' })
    owned.push(bystander.pid!)
    await runSubprocessAsync(fixtureCmd('tree', dir), { cwd: dir, timeoutSeconds: 1 })
    expect(bystander.exitCode).toBeNull()
    expect(isRunning(bystander.pid!)).toBe(true)
  })
})

describe('cancel', () => {
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
    const pids = recordedPids(dir)
    if (pids.length > 0) {
      expect(await waitGone(pids, 500)).toEqual([])
    }
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
    const started = performance.now()
    controller.abort()
    controller.abort()
    const outcome = await pending
    expect((performance.now() - started) / 1000).toBeLessThan(CLEANUP_BUDGET + SLACK)
    expect(outcome.termination).toBe('cancelled')
    expect(await waitGone(recordedPids(dir))).toEqual([])
  })
})

// ── adapter-level classification ────────────────────────────────────────────

function installFakeClaude(dir: string): () => void {
  const binDir = join(dir, 'bin')
  mkdirSync(binDir, { recursive: true })
  const script = join(binDir, 'claude')
  writeFileSync(script, `#!/bin/sh\nexec ${PYTHON} "${PROCESS_TREE}" "\${PROCESS_TREE_MODE:-tree}" "$PROCESS_TREE_DIR"\n`, { mode: 0o755 })
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
