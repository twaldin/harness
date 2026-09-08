import { afterAll, describe, test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import '../../src/adapters/index.js'
import { buildCommand, getAdapter, parseOutput } from '../../src/registry.js'

const SESSION = 'ses_kilo_1234'
const OTHER = 'ses_kilo_9999'

// Assistant rows carry modelID/providerID; user rows carry a `model` object and no tokens.
function assistant(model: string | null, input: number, output: number, cost: number): string {
  return JSON.stringify({ role: 'assistant', providerID: 'openai', modelID: model, tokens: { input, output, reasoning: 0, cache: { read: 0, write: 0 } }, cost })
}
const USER = JSON.stringify({ role: 'user', agent: 'build', model: { providerID: 'openai', modelID: 'gpt-5.4' } })

function seedDb(dbPath: string, sessions: { id: string; messages: string[] }[]): void {
  mkdirSync(join(dbPath, '..'), { recursive: true })
  const db = new Database(dbPath)
  db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT, slug TEXT NOT NULL, directory TEXT NOT NULL, title TEXT NOT NULL, version TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL)')
  db.exec('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)')
  const session = db.prepare("INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated) VALUES (?, 'proj', NULL, ?, '/tmp/repo', 'run', '7.2.24', ?, ?)")
  const message = db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)')
  sessions.forEach((s, si) => {
    session.run(s.id, s.id, si, si)
    s.messages.forEach((data, mi) => message.run(`${s.id}-m${mi}`, s.id, mi, mi, data))
  })
  db.close()
}

/** `kilo run --format json` stdout: one JSON envelope per line with the native sessionID. */
function events(sessionID: string): string {
  return [
    JSON.stringify({ type: 'step_start', timestamp: 1, sessionID, part: { type: 'step-start', sessionID } }),
    JSON.stringify({ type: 'step_finish', timestamp: 2, sessionID, part: { type: 'step-finish', sessionID } }),
  ].join('\n') + '\n'
}

function outcome(stdout: string) {
  return { exitCode: 0, durationSeconds: 1, stdout, stderr: '', timedOut: false }
}

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function fresh(): { root: string; workdir: string } {
  const root = mkdtempSync(join(tmpdir(), 'harness-ts-kilo-'))
  roots.push(root)
  const workdir = join(root, 'repo')
  mkdirSync(workdir)
  return { root, workdir }
}

describe('kilo parseOutput correlates by native session ID', () => {
  test('reads the exact session from the per-workdir default DB the builder selects', () => {
    const { workdir } = fresh()
    const built = buildCommand({ harness: 'kilo', prompt: 'x', workdir })
    const dbPath = built.env['KILO_DB']!
    expect(dbPath).toBe(join(workdir, '.harness', 'kilo', 'kilo.db'))
    expect(built.directories).toEqual([join(workdir, '.harness', 'kilo')])
    seedDb(dbPath, [
      { id: OTHER, messages: [USER, assistant('gpt-5.4', 99999, 1, 9)] },
      { id: SESSION, messages: [USER, assistant('gpt-5.4-mini-fast', 90, 30, 0.004)] },
    ])
    expect(parseOutput({ harness: 'kilo', prompt: 'x', workdir }, outcome(events(SESSION)))).toEqual({ tokensIn: 90, tokensOut: 30, costUsd: 0.004, raw: { sessionID: SESSION, costSource: 'reported' } })
    expect(parseOutput({ harness: 'kilo', prompt: 'x', workdir }, outcome('no events\n'))).toEqual({ tokensIn: null, tokensOut: null, costUsd: null, raw: null })
  })

  test('a relative KILO_DB stays verbatim in the command env and resolves against the XDG kilo data dir', () => {
    const { root, workdir } = fresh()
    const xdg = join(root, 'xdg')
    const env = { KILO_DB: 'runs/mine.db', XDG_DATA_HOME: xdg }
    const built = buildCommand({ harness: 'kilo', prompt: 'x', workdir, env })
    expect(built.env['KILO_DB']).toBe('runs/mine.db')
    expect(built.directories).toEqual([])
    seedDb(join(xdg, 'kilo', 'runs', 'mine.db'), [{ id: SESSION, messages: [assistant('gpt-5.4', 12, 3, 0)] }])
    const parsed = parseOutput({ harness: 'kilo', prompt: 'x', workdir, env }, outcome(events(SESSION)))
    expect(parsed).toEqual({ tokensIn: 12, tokensOut: 3, costUsd: 0, raw: { sessionID: SESSION, costSource: 'reported' } })
  })

  test('an explicit empty KILO_DB selects upstream channel storage, including the legacy opencode-* file', () => {
    const { root, workdir } = fresh()
    const home = join(root, 'home')
    const env = { KILO_DB: '', HOME: home }
    expect(buildCommand({ harness: 'kilo', prompt: 'x', workdir, env }).directories).toEqual([])
    seedDb(join(home, '.local', 'share', 'kilo', 'opencode-dev.db'), [{ id: SESSION, messages: [assistant('gpt-5.4', 7, 1, 0.01)] }])
    seedDb(join(home, '.local', 'share', 'kilo', 'kilo.db'), [{ id: OTHER, messages: [assistant('gpt-5.4', 99999, 1, 9)] }])
    expect(parseOutput({ harness: 'kilo', prompt: 'x', workdir, env }, outcome(events(SESSION))).tokensIn).toBe(7)
    const disabled = parseOutput({ harness: 'kilo', prompt: 'x', workdir, env: { ...env, KILO_DISABLE_CHANNEL_DB: 'true' } }, outcome(events(SESSION)))
    expect(disabled).toEqual({ tokensIn: null, tokensOut: null, costUsd: null, raw: { sessionID: SESSION, costSource: 'unavailable' } })
  })
})

describe('kilo session log selector', () => {
  function telemetry(messages: string[], selector: (dbPath: string) => string = (dbPath) => `${dbPath}#session=${encodeURIComponent(SESSION)}`) {
    const dbPath = join(fresh().root, 'kilo.db')
    seedDb(dbPath, [{ id: SESSION, messages }])
    return getAdapter('kilo').parseSessionLog!(selector(dbPath))
  }

  test('sessionLogPath has no identity to name', () => {
    expect(getAdapter('kilo').sessionLogPath!(fresh().workdir)).toBeNull()
  })

  test('reports literal upstream totals for the exact session and never prices a reported zero', () => {
    const result = telemetry([USER, assistant('gpt-5.4-mini', 1000, 100, 0)])
    expect(result).toMatchObject({ tokensIn: 1000, tokensOut: 100, costUsd: 0, model: 'gpt-5.4-mini', raw: { sessionID: SESSION, costSource: 'reported' } })
  })

  test('the legacy basename selector and a bare DB path read nothing', () => {
    for (const legacy of [(p: string) => `${p}#session(repo)`, (p: string) => p]) {
      expect(telemetry([assistant('gpt-5.4', 3, 4, 0)], legacy)).toMatchObject({ tokensIn: null, costUsd: null, model: null, raw: null })
    }
  })

  test.each(['claude-sonnet-4-6', null])('mixed or missing model %s still sums totals and never prices them', (otherModel) => {
    const result = telemetry([assistant('gpt-5.4-mini', 1000, 100, 0), assistant(otherModel, 10, 1, 0)])
    expect([result.tokensIn, result.tokensOut, result.costUsd, result.model]).toEqual([1010, 101, 0, null])
  })
})
