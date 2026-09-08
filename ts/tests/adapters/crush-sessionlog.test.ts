import { describe, test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import '../../src/adapters/index.js'
import { getAdapter } from '../../src/registry.js'
import { deriveCost } from '../../src/pricing.js'

// internal/db/migrations/20250424200609_initial.sql (+ provider column, 20250627).
const SCHEMA = [
  "CREATE TABLE sessions (id TEXT PRIMARY KEY, parent_session_id TEXT, title TEXT NOT NULL, message_count INTEGER NOT NULL DEFAULT 0, prompt_tokens INTEGER NOT NULL DEFAULT 0, completion_tokens INTEGER NOT NULL DEFAULT 0, cost REAL NOT NULL DEFAULT 0.0, updated_at INTEGER NOT NULL, created_at INTEGER NOT NULL)",
  "CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, parts TEXT NOT NULL DEFAULT '[]', model TEXT, provider TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, finished_at INTEGER)",
]

function seed(models: (string | null)[], cost: number, withMessages = true): { workdir: string; dbPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'harness-ts-crush-'))
  const workdir = join(root, 'repo')
  const dataDir = join(workdir, '.harness', 'crush-data')
  mkdirSync(dataDir, { recursive: true })
  const dbPath = join(dataDir, 'crush.db')
  const db = new Database(dbPath)
  for (const statement of withMessages ? SCHEMA : SCHEMA.slice(0, 1)) db.exec(statement)
  db.prepare("INSERT INTO sessions (id, parent_session_id, title, prompt_tokens, completion_tokens, cost, updated_at, created_at) VALUES ('s1', NULL, 'run', 111, 22, ?, 1, 1)").run(cost)
  if (withMessages) {
    const insert = db.prepare("INSERT INTO messages (id, session_id, role, model, provider, created_at, updated_at) VALUES (?, 's1', ?, ?, 'openai', ?, ?)")
    models.forEach((model, i) => {
      insert.run(`u${i}`, 'user', model, i, i)
      insert.run(`a${i}`, 'assistant', model, i, i)
    })
  }
  db.close()
  return { workdir, dbPath }
}

describe('crush session log', () => {
  test('returns db selector path and parses sqlite totals plus the session model', () => {
    const { workdir, dbPath } = seed(['claude-sonnet-4-6', 'claude-sonnet-4-6'], 0.005)
    const adapter = getAdapter('crush')
    const path = adapter.sessionLogPath?.(workdir)
    expect(path?.startsWith(dbPath)).toBe(true)
    const telemetry = adapter.parseSessionLog?.(path!)
    expect(telemetry?.tokensIn).toBe(111)
    expect(telemetry?.tokensOut).toBe(22)
    expect(telemetry?.costUsd).toBe(0.005)
    expect(telemetry?.model).toBe('claude-sonnet-4-6')
  })

  test('totals survive a DB without a messages table', () => {
    const { workdir } = seed([], 0.005, false)
    const telemetry = getAdapter('crush').parseSessionLog!(getAdapter('crush').sessionLogPath!(workdir)!)
    expect([telemetry.tokensIn, telemetry.tokensOut, telemetry.costUsd, telemetry.model]).toEqual([111, 22, 0.005, null])
  })

  test('zero cost is priced with the session model, not a default', () => {
    const { workdir } = seed(['gpt-5.4-mini'], 0)
    const telemetry = getAdapter('crush').parseSessionLog!(getAdapter('crush').sessionLogPath!(workdir)!)
    expect(telemetry.model).toBe('gpt-5.4-mini')
    expect(telemetry.costUsd).toBe(deriveCost('gpt-5.4-mini', 111, 22))
    expect(telemetry.costUsd).not.toBe(deriveCost('gpt-5.4', 111, 22))
  })

  test.each(['claude-sonnet-4-6', null])('inconsistent or unavailable model %s prevents estimation', (otherModel) => {
    const { workdir } = seed(['gpt-5.4-mini', otherModel], 0)
    const telemetry = getAdapter('crush').parseSessionLog!(getAdapter('crush').sessionLogPath!(workdir)!)
    expect([telemetry.tokensIn, telemetry.tokensOut, telemetry.costUsd, telemetry.model]).toEqual([111, 22, 0, null])
  })
})
