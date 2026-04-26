import { describe, test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import '../../src/adapters/index.js'
import { getAdapter } from '../../src/registry.js'

describe('continue-cli session log', () => {
  test('resolves and parses latest session json', () => {
    const home = mkdtempSync(join(tmpdir(), 'harness-ts-continue-'))
    const workdir = join(home, 'repo')
    mkdirSync(workdir, { recursive: true })
    const dir = join(home, '.continue', 'sessions', 'repo')
    mkdirSync(dir, { recursive: true })
    const logPath = join(dir, 'session.json')
    writeFileSync(logPath, JSON.stringify({ usage: { input_tokens: 12, output_tokens: 7 }, total_cost_usd: 0.11, model: 'gpt-5.4' }))

    process.env.HOME = home
    delete process.env.CONTINUE_SESSION_DIR

    const adapter = getAdapter('continue-cli')
    const resolved = adapter.sessionLogPath?.(workdir)
    expect(resolved).toBe(logPath)

    const telemetry = adapter.parseSessionLog?.(resolved!)
    expect(telemetry?.tokensIn).toBe(12)
    expect(telemetry?.tokensOut).toBe(7)
    expect(telemetry?.costUsd).toBe(0.11)
  })
})
