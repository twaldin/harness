import { describe, test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import '../../src/adapters/index.js'
import { getAdapter } from '../../src/registry.js'

describe('openclaude session log', () => {
  test('finds latest claude-style jsonl and parses totals', () => {
    const home = mkdtempSync(join(tmpdir(), 'harness-ts-openclaude-'))
    const workdir = join(home, 'my_repo')
    mkdirSync(workdir, { recursive: true })
    const encoded = realpathSync(workdir).replace(/[\/_]/g, '-')
    const dir = join(home, '.claude', 'projects', encoded)
    mkdirSync(dir, { recursive: true })
    const logPath = join(dir, 'abc.jsonl')
    writeFileSync(logPath, [
      JSON.stringify({ message: { model: 'gpt-5.4', usage: { input_tokens: 100, output_tokens: 20 } }, total_cost_usd: 0.002 }),
      JSON.stringify({ message: { usage: { input_tokens: 50, output_tokens: 10 } }, costUSD: 0.001 }),
    ].join('\n'))

    process.env.HOME = home
    const adapter = getAdapter('openclaude')
    const resolved = adapter.sessionLogPath?.(workdir)
    expect(resolved).toBe(logPath)

    const telemetry = adapter.parseSessionLog?.(logPath)
    expect(telemetry?.tokensIn).toBe(150)
    expect(telemetry?.tokensOut).toBe(30)
    expect(telemetry?.costUsd).toBe(0.003)
    expect(telemetry?.model).toBe('gpt-5.4')
  })
})
