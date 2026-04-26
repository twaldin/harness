import { describe, test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import '../../src/adapters/index.js'
import { getAdapter } from '../../src/registry.js'

describe('qwen session log', () => {
  test('uses qwen logs.json and returns raw conversation', () => {
    const home = mkdtempSync(join(tmpdir(), 'harness-ts-qwen-'))
    const workdir = join(home, 'repo')
    mkdirSync(workdir, { recursive: true })
    const logPath = join(home, '.qwen', 'tmp', 'repo', 'logs.json')
    mkdirSync(join(home, '.qwen', 'tmp', 'repo'), { recursive: true })
    writeFileSync(logPath, JSON.stringify([{ role: 'user', content: 'x' }]))

    process.env.HOME = home
    const adapter = getAdapter('qwen')
    expect(adapter.sessionLogPath?.(workdir)).toBe(logPath)
    const telemetry = adapter.parseSessionLog?.(logPath)
    expect(telemetry?.tokensIn).toBeNull()
    expect(telemetry?.tokensOut).toBeNull()
    expect(Array.isArray(telemetry?.raw)).toBe(true)
  })
})
