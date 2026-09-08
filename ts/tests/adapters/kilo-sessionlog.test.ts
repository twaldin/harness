import { describe, test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import '../../src/adapters/index.js'
import { getAdapter } from '../../src/registry.js'
import { deriveCost } from '../../src/pricing.js'

// Assistant rows carry modelID/providerID; user rows carry a `model` object and no tokens.
function assistant(model: string | null, input: number, output: number, cost: number): string {
  return JSON.stringify({ role: 'assistant', providerID: 'openai', modelID: model, tokens: { input, output, reasoning: 0, cache: { read: 0, write: 0 } }, cost })
}
const USER = JSON.stringify({ role: 'user', agent: 'build', model: { providerID: 'openai', modelID: 'gpt-5.4' } })

function seed(messages: string[]): { workdir: string; dbPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'harness-ts-kilo-'))
  const workdir = join(root, 'repo')
  const dbDir = join(workdir, '.harness', 'kilo')
  mkdirSync(dbDir, { recursive: true })
  const dbPath = join(dbDir, 'kilo.db')
  const db = new Database(dbPath)
  db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT, slug TEXT NOT NULL, directory TEXT NOT NULL, title TEXT NOT NULL, version TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL)')
  db.exec('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)')
  db.exec("INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated) VALUES ('s1', 'proj', NULL, 's1', '/tmp/repo', 'run', '7.2.24', 1, 1)")
  const insert = db.prepare("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, 's1', ?, ?, ?)")
  messages.forEach((data, i) => insert.run(`m${i}`, i, i, data))
  db.close()
  return { workdir, dbPath }
}

describe('kilo session log', () => {
  test('returns db selector path and parses assistant totals plus the session model', () => {
    const { workdir, dbPath } = seed([USER, assistant('gpt-5.4-mini-fast', 90, 30, 0.004)])
    const adapter = getAdapter('kilo')
    const path = adapter.sessionLogPath?.(workdir)
    expect(path?.startsWith(dbPath)).toBe(true)
    const telemetry = adapter.parseSessionLog?.(path!)
    expect(telemetry?.tokensIn).toBe(90)
    expect(telemetry?.tokensOut).toBe(30)
    expect(telemetry?.costUsd).toBe(0.004)
    expect(telemetry?.model).toBe('gpt-5.4-mini-fast')
  })

  test('zero cost is priced with the session model, not a default', () => {
    const { workdir } = seed([USER, assistant('gpt-5.4-mini', 1000, 100, 0)])
    const telemetry = getAdapter('kilo').parseSessionLog!(getAdapter('kilo').sessionLogPath!(workdir)!)
    expect(telemetry.model).toBe('gpt-5.4-mini')
    expect(telemetry.costUsd).toBe(deriveCost('gpt-5.4-mini', 1000, 100))
    expect(telemetry.costUsd).not.toBe(deriveCost('gpt-5.4', 1000, 100))
  })

  test.each(['claude-sonnet-4-6', null])('inconsistent or unavailable model %s prevents estimation', (otherModel) => {
    const { workdir } = seed([assistant('gpt-5.4-mini', 1000, 100, 0), assistant(otherModel, 10, 1, 0)])
    const telemetry = getAdapter('kilo').parseSessionLog!(getAdapter('kilo').sessionLogPath!(workdir)!)
    expect([telemetry.tokensIn, telemetry.tokensOut, telemetry.costUsd, telemetry.model]).toEqual([1010, 101, 0, null])
  })
})
