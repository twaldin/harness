import { afterAll, describe, test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import '../../src/adapters/index.js'
import { buildCommand, getAdapter, parseOutput } from '../../src/registry.js'

const SESSION = '6f1c2d3e-4a5b-4c6d-8e7f-90a1b2c3d4e5'
const OTHER = '00000000-0000-4000-8000-000000000000'

// internal/db/migrations/20250424200609_initial.sql (+ provider column, 20250627).
const SCHEMA = [
  "CREATE TABLE sessions (id TEXT PRIMARY KEY, parent_session_id TEXT, title TEXT NOT NULL, message_count INTEGER NOT NULL DEFAULT 0, prompt_tokens INTEGER NOT NULL DEFAULT 0, completion_tokens INTEGER NOT NULL DEFAULT 0, cost REAL NOT NULL DEFAULT 0.0, updated_at INTEGER NOT NULL, created_at INTEGER NOT NULL)",
  "CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, parts TEXT NOT NULL DEFAULT '[]', model TEXT, provider TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, finished_at INTEGER)",
]

interface Session { id: string; promptTokens: number; completionTokens: number; cost: number; models: (string | null)[]; provider?: string }

function seedDb(dbPath: string, sessions: Session[], withMessages = true): void {
  mkdirSync(join(dbPath, '..'), { recursive: true })
  const db = new Database(dbPath)
  for (const statement of withMessages ? SCHEMA : SCHEMA.slice(0, 1)) db.exec(statement)
  const session = db.prepare("INSERT INTO sessions (id, parent_session_id, title, prompt_tokens, completion_tokens, cost, updated_at, created_at) VALUES (?, NULL, 'run', ?, ?, ?, ?, ?)")
  const message = withMessages ? db.prepare('INSERT INTO messages (id, session_id, role, model, provider, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)') : null
  sessions.forEach((s, si) => {
    session.run(s.id, s.promptTokens, s.completionTokens, s.cost, si, si)
    s.models.forEach((model, mi) => {
      message?.run(`${s.id}-u${mi}`, s.id, 'user', model, s.provider ?? 'openai', mi, mi)
      message?.run(`${s.id}-a${mi}`, s.id, 'assistant', model, s.provider ?? 'openai', mi, mi)
    })
  })
  db.close()
}

/** `crush run --verbose` stderr, as charm log prints it (level styled, no timestamp). */
function created(sessionID: string): string {
  return `\x1b[1;32mINFO\x1b[0m  Created session for non-interactive run \x1b[2msession_id=\x1b[0m${sessionID}\n`
}

function outcome(stderr: string) {
  return { exitCode: 0, durationSeconds: 1, stdout: 'answer\n', stderr, timedOut: false }
}

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function fresh(): { root: string; workdir: string } {
  const root = mkdtempSync(join(tmpdir(), 'harness-ts-crush-'))
  roots.push(root)
  const workdir = join(root, 'repo')
  mkdirSync(workdir)
  return { root, workdir }
}

describe('crush parseOutput correlates by native session ID', () => {
  test('reads exactly the created session from the default data dir, not the newest', () => {
    const { workdir } = fresh()
    const built = buildCommand({ harness: 'crush', prompt: 'x', workdir })
    expect(built.args.slice(0, 4)).toEqual(['run', '--verbose', '--data-dir', join(workdir, '.harness', 'crush-data')])
    seedDb(join(workdir, '.harness', 'crush-data', 'crush.db'), [
      { id: SESSION, promptTokens: 111, completionTokens: 22, cost: 0.005, models: ['claude-sonnet-4-6', 'claude-sonnet-4-6'] },
      { id: OTHER, promptTokens: 99999, completionTokens: 1, cost: 9, models: ['gpt-5.4'] },
    ])
    const spec = { harness: 'crush', prompt: 'x', workdir }
    expect(parseOutput(spec, outcome(created(SESSION)))).toEqual({ tokensIn: 111, tokensOut: 22, costUsd: 0.005, raw: { sessionID: SESSION, costSource: 'reported' } })

    const nulls = { tokensIn: null, tokensOut: null, costUsd: null, raw: null }
    expect(parseOutput(spec, outcome(''))).toEqual(nulls)
    expect(parseOutput(spec, outcome(`INFO  Continuing session for non-interactive run session_id=${SESSION}\n`))).toEqual(nulls)
    expect(parseOutput(spec, outcome(`DEBUG request session_id=${SESSION}\n`))).toEqual(nulls)
    expect(parseOutput(spec, outcome(created(SESSION) + created(OTHER)))).toEqual(nulls)
    expect(parseOutput(spec, { ...outcome(''), stdout: created(SESSION) })).toEqual(nulls)
  })

  test('a relative CRUSH_DATA_DIR resolves against the workdir like --data-dir; an empty one restores the default', () => {
    const { workdir } = fresh()
    const relative = buildCommand({ harness: 'crush', prompt: 'x', workdir, env: { CRUSH_DATA_DIR: 'state/crush' } })
    expect(relative.args[3]).toBe(join(workdir, 'state', 'crush'))
    expect(relative.directories).toEqual([])
    seedDb(join(workdir, 'state', 'crush', 'crush.db'), [{ id: SESSION, promptTokens: 5, completionTokens: 6, cost: 0, models: ['gpt-5.4'] }])
    const parsed = parseOutput({ harness: 'crush', prompt: 'x', workdir, env: { CRUSH_DATA_DIR: 'state/crush' } }, outcome(created(SESSION)))
    expect(parsed).toEqual({ tokensIn: 5, tokensOut: 6, costUsd: 0, raw: { sessionID: SESSION, costSource: 'reported' } })

    const empty = buildCommand({ harness: 'crush', prompt: 'x', workdir, env: { CRUSH_DATA_DIR: '' } })
    expect(empty.args[3]).toBe(join(workdir, '.harness', 'crush-data'))
    expect(empty.directories).toEqual([join(workdir, '.harness', 'crush-data')])
  })

  test('a missing database keeps the identity with unavailable cost', () => {
    const { workdir } = fresh()
    expect(parseOutput({ harness: 'crush', prompt: 'x', workdir }, outcome(created(SESSION)))).toEqual({ tokensIn: null, tokensOut: null, costUsd: null, raw: { sessionID: SESSION, costSource: 'unavailable' } })
  })
})

describe('crush session log selector', () => {
  function telemetry(session: Omit<Session, 'id'>, withMessages = true, selector: (dbPath: string) => string = (dbPath) => `${dbPath}#session=${SESSION}`) {
    const dbPath = join(fresh().root, 'crush.db')
    seedDb(dbPath, [{ id: SESSION, ...session }], withMessages)
    return getAdapter('crush').parseSessionLog!(selector(dbPath))
  }

  test('sessionLogPath has no identity to name', () => {
    expect(getAdapter('crush').sessionLogPath!(fresh().workdir)).toBeNull()
  })

  test('reports the upstream aggregates and the unanimous assistant model', () => {
    const result = telemetry({ promptTokens: 111, completionTokens: 22, cost: 0.005, models: ['claude-sonnet-4-6', 'claude-sonnet-4-6'] })
    expect(result).toMatchObject({ tokensIn: 111, tokensOut: 22, costUsd: 0.005, model: 'claude-sonnet-4-6', raw: { sessionID: SESSION, costSource: 'reported' } })
  })

  test('totals survive a DB without a messages table', () => {
    const result = telemetry({ promptTokens: 111, completionTokens: 22, cost: 0.005, models: [] }, false)
    expect([result.tokensIn, result.tokensOut, result.costUsd, result.model]).toEqual([111, 22, 0.005, null])
  })

  test('a reported zero cost is preserved, never repriced', () => {
    const result = telemetry({ promptTokens: 111, completionTokens: 22, cost: 0, models: ['gpt-5.4-mini'] })
    expect([result.costUsd, result.model, result.raw]).toEqual([0, 'gpt-5.4-mini', { sessionID: SESSION, costSource: 'reported' }])
  })

  test.each(['claude-sonnet-4-6', null])('inconsistent or unavailable model %s hides the model only', (otherModel) => {
    const result = telemetry({ promptTokens: 111, completionTokens: 22, cost: 0, models: ['gpt-5.4-mini', otherModel] })
    expect([result.tokensIn, result.tokensOut, result.costUsd, result.model]).toEqual([111, 22, 0, null])
  })

  test('the legacy basename selector, a bare path and an unknown ID read nothing', () => {
    const session = { promptTokens: 1, completionTokens: 1, cost: 0, models: ['gpt-5.4'] }
    for (const legacy of [(p: string) => `${p}#session(repo)`, (p: string) => p]) {
      expect(telemetry(session, true, legacy)).toMatchObject({ tokensIn: null, costUsd: null, model: null, raw: null })
    }
    expect(telemetry(session, true, (p) => `${p}#session=${OTHER}`)).toMatchObject({ tokensIn: null, model: null, raw: { sessionID: OTHER, costSource: 'unavailable' } })
  })
})
