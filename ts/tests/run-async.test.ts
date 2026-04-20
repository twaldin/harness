import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { runAsync } from '../src/registry.js'
import { runSubprocessAsync } from '../src/subproc.js'
import '../src/adapters/index.js'
import type { RunSpec } from '../src/base.js'

const FIXTURES_DIR = join(import.meta.dir, '../../tests/fixtures')
const TMP_DIR = join(import.meta.dir, '../../.tmp-run-async-tests')
const BIN_DIR = join(TMP_DIR, 'bin')

function loadFixture(name: string) {
  return JSON.parse(require('fs').readFileSync(join(FIXTURES_DIR, `${name}.json`), 'utf-8'))
}

let savedPath: string | undefined

beforeAll(() => {
  mkdirSync(BIN_DIR, { recursive: true })

  // Build a fake 'claude' binary that outputs the fixture stdout and exits 0
  const fx = loadFixture('claude-code')
  const stdoutPayload = fx.sampleOutput.stdout as string
  const payloadFile = join(TMP_DIR, 'claude-stdout.txt')
  writeFileSync(payloadFile, stdoutPayload, 'utf-8')
  const script = `#!/bin/sh\ncat '${payloadFile}'\nexit 0\n`
  writeFileSync(join(BIN_DIR, 'claude'), script, { mode: 0o755 })

  savedPath = process.env.PATH
  process.env.PATH = `${BIN_DIR}:${savedPath ?? ''}`
})

afterAll(() => {
  if (savedPath !== undefined) process.env.PATH = savedPath
  try {
    rmSync(TMP_DIR, { recursive: true, force: true })
  } catch {}
})

describe('runAsync (integration via fake CLI)', () => {
  test('result fields match claude-code fixture', async () => {
    const fx = loadFixture('claude-code')
    const sample = fx.sampleOutput
    const expected = fx.expectedParsed

    const spec: RunSpec = {
      harness: 'claude-code',
      prompt: fx.spec.prompt,
      workdir: TMP_DIR,
      model: fx.spec.model,
      instructions: fx.spec.instructions,
      timeoutSeconds: fx.spec.timeoutSeconds,
    }

    const result = await runAsync(spec)

    expect(result.harness).toBe('claude-code')
    expect(result.exitCode).toBe(0)
    expect(result.timedOut).toBe(false)
    expect(result.stdout).toBe(sample.stdout)
    if (expected.costUsd !== null) {
      expect(result.costUsd).toBeCloseTo(expected.costUsd, 5)
    }
    expect(result.tokensIn).toBe(expected.tokensIn)
    expect(result.tokensOut).toBe(expected.tokensOut)
  })
})

describe('runSubprocessAsync', () => {
  test('captures stdout and stderr', async () => {
    const outcome = await runSubprocessAsync(['sh', '-c', 'echo hello && echo bye >&2'], {
      cwd: TMP_DIR,
      timeoutSeconds: 10,
    })
    expect(outcome.exitCode).toBe(0)
    expect(outcome.stdout).toContain('hello')
    expect(outcome.stderr).toContain('bye')
    expect(outcome.timedOut).toBe(false)
    expect(outcome.durationSeconds).toBeGreaterThanOrEqual(0)
  })

  test('non-zero exit code', async () => {
    const outcome = await runSubprocessAsync(['sh', '-c', 'exit 7'], {
      cwd: TMP_DIR,
      timeoutSeconds: 10,
    })
    expect(outcome.exitCode).toBe(7)
    expect(outcome.timedOut).toBe(false)
  })

  test('timeout returns timedOut=true and exitCode=-1', async () => {
    const outcome = await runSubprocessAsync(['sh', '-c', 'sleep 5'], {
      cwd: TMP_DIR,
      timeoutSeconds: 1,
    })
    expect(outcome.timedOut).toBe(true)
    expect(outcome.exitCode).toBe(-1)
  })

  test('passes extra env vars', async () => {
    const outcome = await runSubprocessAsync(['sh', '-c', 'echo $HARNESS_ASYNC_VAR'], {
      cwd: TMP_DIR,
      timeoutSeconds: 10,
      extraEnv: { HARNESS_ASYNC_VAR: 'async_ok' },
    })
    expect(outcome.stdout.trim()).toBe('async_ok')
  })

  test('two parallel runs finish in ~max(A,B) not A+B', async () => {
    const delay = 0.3

    const job = () =>
      runSubprocessAsync(['sh', '-c', `sleep ${delay} && echo done`], {
        cwd: TMP_DIR,
        timeoutSeconds: 10,
      })

    const start = Date.now()
    const results = await Promise.all([job(), job()])
    const elapsed = (Date.now() - start) / 1000

    // Sequential would take ~0.6s; parallel should finish in ~0.3s (allow 2x slack)
    expect(elapsed).toBeLessThan(delay * 2 + 0.1)
    for (const r of results) {
      expect(r.stdout).toContain('done')
    }
  })
})
