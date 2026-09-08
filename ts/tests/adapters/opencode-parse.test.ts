import { describe, test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import '../../src/adapters/index.js'
import { parseOutput } from '../../src/registry.js'

const OUTCOME = { exitCode: 0, durationSeconds: 1, stdout: '', stderr: '', timedOut: false }

function seedDb(dbPath: string, directory: string): void {
  const db = new Database(dbPath)
  db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT NOT NULL, time_updated INTEGER NOT NULL, model TEXT)')
  db.exec('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, data TEXT NOT NULL)')
  db.prepare('INSERT INTO session (id, directory, time_updated, model) VALUES (?, ?, 1, ?)').run('s1', directory, 'gpt-5.4')
  db.exec("INSERT INTO message (id, session_id, data) VALUES ('m1', 's1', '{\"tokens\":{\"input\":70,\"output\":20},\"cost\":0.002}')")
  db.close()
}

describe('opencode parseOutput honors the run env', () => {
  test('reads OPENCODE_DB from spec.env and the XDG data home from an explicit HOME', () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-ts-opencode-'))
    const workdir = join(root, 'repo')
    mkdirSync(workdir)

    const explicitDb = join(root, 'explicit.db')
    seedDb(explicitDb, workdir)
    const viaDb = parseOutput({ harness: 'opencode', prompt: 'x', workdir, env: { OPENCODE_DB: explicitDb } }, OUTCOME)
    expect(viaDb.tokensIn).toBe(70)
    expect(viaDb.tokensOut).toBe(20)
    expect(viaDb.costUsd).toBe(0.002)

    const home = join(root, 'home')
    mkdirSync(join(home, '.local', 'share', 'opencode'), { recursive: true })
    seedDb(join(home, '.local', 'share', 'opencode', 'opencode.db'), workdir)
    const viaHome = parseOutput({ harness: 'opencode', prompt: 'x', workdir, env: { HOME: home } }, OUTCOME)
    expect(viaHome.tokensIn).toBe(70)

    const missing = parseOutput({ harness: 'opencode', prompt: 'x', workdir, env: { OPENCODE_DB: join(root, 'missing.db') } }, OUTCOME)
    expect(missing.tokensIn).toBeNull()
  })
})
