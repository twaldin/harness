import { describe, test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import '../../src/adapters/index.js'
import { getAdapter, parseOutput } from '../../src/registry.js'
import { deriveCost } from '../../src/pricing.js'

const OUTCOME = { exitCode: 0, durationSeconds: 1, stdout: '', stderr: '', timedOut: false }

// Assistant rows carry modelID/providerID; user rows carry a `model` object and no tokens.
function assistant(model: string | null, input: number, output: number, cost: number): string {
  return JSON.stringify({ role: 'assistant', providerID: 'openai', modelID: model, tokens: { input, output, reasoning: 0, cache: { read: 0, write: 0 } }, cost })
}
const USER = JSON.stringify({ role: 'user', agent: 'build', model: { providerID: 'openai', modelID: 'gpt-5.4' } })

// packages/core/src/session/sql.ts: session.model is not required.
function seedDb(dbPath: string, directory: string, messages: string[] = [USER, assistant('gpt-5.4', 70, 20, 0.002)]): void {
  const db = new Database(dbPath)
  db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT, slug TEXT NOT NULL, directory TEXT NOT NULL, title TEXT NOT NULL, version TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL)')
  db.exec('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)')
  db.prepare("INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated) VALUES ('s1', 'proj', NULL, 's1', ?, 'run', '1.14.46', 1, 1)").run(directory)
  const insert = db.prepare("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, 's1', ?, ?, ?)")
  messages.forEach((data, i) => insert.run(`m${i}`, i, i, data))
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

describe('opencode session log model', () => {
  function telemetry(messages: string[]) {
    const root = mkdtempSync(join(tmpdir(), 'harness-ts-opencode-'))
    const workdir = join(root, 'repo')
    mkdirSync(workdir)
    const dbPath = join(root, 'opencode.db')
    seedDb(dbPath, workdir, messages)
    return getAdapter('opencode').parseSessionLog!(`${dbPath}#session(repo)`)
  }

  test('reports the model from assistant rows and prices zero cost with it', () => {
    const result = telemetry([USER, assistant('gpt-5.4-mini', 1000, 100, 0)])
    expect(result.model).toBe('gpt-5.4-mini')
    expect(result.costUsd).toBe(deriveCost('gpt-5.4-mini', 1000, 100))
    expect(result.costUsd).not.toBe(deriveCost('gpt-5.4', 1000, 100))
  })

  test.each(['claude-sonnet-4-6', null])('inconsistent or unavailable model %s prevents estimation', (otherModel) => {
    const result = telemetry([assistant('gpt-5.4-mini', 1000, 100, 0), assistant(otherModel, 10, 1, 0)])
    expect([result.tokensIn, result.tokensOut, result.costUsd, result.model]).toEqual([1010, 101, 0, null])
  })
})
