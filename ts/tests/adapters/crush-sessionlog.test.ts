import { describe, test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import '../../src/adapters/index.js'
import { getAdapter } from '../../src/registry.js'

describe('crush session log', () => {
  test('returns db selector path and parses sqlite totals', () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-ts-crush-'))
    const workdir = join(root, 'repo')
    mkdirSync(workdir, { recursive: true })
    const dataDir = join(workdir, '.harness', 'crush-data')
    mkdirSync(dataDir, { recursive: true })
    const dbPath = join(dataDir, 'crush.db')
    const db = new Database(dbPath)
    db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, parent_session_id TEXT, prompt_tokens INTEGER, completion_tokens INTEGER, cost REAL, model TEXT, updated_at INTEGER)')
    db.exec("INSERT INTO sessions (id, parent_session_id, prompt_tokens, completion_tokens, cost, model, updated_at) VALUES ('s1', NULL, 111, 22, 0.005, 'gpt-5.4', 1)")
    db.close()

    const adapter = getAdapter('crush')
    const path = adapter.sessionLogPath?.(workdir)
    expect(path?.startsWith(dbPath)).toBe(true)
    const telemetry = adapter.parseSessionLog?.(path!)
    expect(telemetry?.tokensIn).toBe(111)
    expect(telemetry?.tokensOut).toBe(22)
    expect(telemetry?.costUsd).toBe(0.005)
  })
})
