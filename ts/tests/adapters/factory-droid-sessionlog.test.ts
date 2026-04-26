import { describe, test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import '../../src/adapters/index.js'
import { getAdapter } from '../../src/registry.js'

describe('factory-droid session log', () => {
  test('finds trajectory json and parses usage', () => {
    const home = mkdtempSync(join(tmpdir(), 'harness-ts-factory-'))
    const workdir = join(home, 'repo')
    mkdirSync(workdir, { recursive: true })
    const root = join(home, '.factory')
    const sessionDir = join(root, 'sessions', 'repo')
    mkdirSync(sessionDir, { recursive: true })
    const logPath = join(sessionDir, 'one.json')
    writeFileSync(logPath, JSON.stringify({ usage: { input_tokens: 200, output_tokens: 80 }, total_cost_usd: 0.02 }))

    process.env.HOME = home
    delete process.env.FACTORY_HOME
    const adapter = getAdapter('factory-droid')
    expect(adapter.sessionLogPath?.(workdir)).toBe(logPath)
    const telemetry = adapter.parseSessionLog?.(logPath)
    expect(telemetry?.tokensIn).toBe(200)
    expect(telemetry?.tokensOut).toBe(80)
    expect(telemetry?.costUsd).toBe(0.02)
  })
})
