import { describe, test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import '../../src/adapters/index.js'
import { getAdapter } from '../../src/registry.js'

describe('kilo session log', () => {
  test('returns db selector path and parses sqlite totals', () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-ts-kilo-'))
    const workdir = join(root, 'repo')
    mkdirSync(workdir, { recursive: true })
    const dbDir = join(workdir, '.harness', 'kilo')
    mkdirSync(dbDir, { recursive: true })
    const dbPath = join(dbDir, 'kilo.db')
    const db = new Database(dbPath)
    db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT NOT NULL, time_updated INTEGER NOT NULL)')
    db.exec('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, data TEXT NOT NULL)')
    db.exec("INSERT INTO session (id, directory, time_updated) VALUES ('s1', '/tmp/repo', 1)")
    db.exec("INSERT INTO message (id, session_id, data) VALUES ('m1', 's1', '{\"role\":\"assistant\",\"tokens\":{\"input\":90,\"output\":30},\"cost\":0.004}')")
    db.close()

    const adapter = getAdapter('kilo')
    const path = adapter.sessionLogPath?.(workdir)
    expect(path?.startsWith(dbPath)).toBe(true)
    const telemetry = adapter.parseSessionLog?.(path!)
    expect(telemetry?.tokensIn).toBe(90)
    expect(telemetry?.tokensOut).toBe(30)
    expect(telemetry?.costUsd).toBe(0.004)
  })
})
