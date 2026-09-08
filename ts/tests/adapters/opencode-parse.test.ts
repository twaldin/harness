import { afterAll, beforeAll, describe, test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import '../../src/adapters/index.js'
import { buildCommand, getAdapter, parseOutput } from '../../src/registry.js'

const SESSION = 'ses_7f3a2b1c'
const OTHER = 'ses_0000ffff'

// Assistant rows carry modelID/providerID; user rows carry a `model` object and no tokens.
function assistant(model: string | null, input: unknown, output: unknown, cost: unknown, provider = 'openai'): string {
  return JSON.stringify({ role: 'assistant', providerID: provider, modelID: model, tokens: { input, output, reasoning: 0, cache: { read: 0, write: 0 } }, cost })
}
const USER = JSON.stringify({ role: 'user', agent: 'build', model: { providerID: 'openai', modelID: 'gpt-5.4' } })

interface Session { id: string; directory: string; messages: string[] }

// packages/core/src/session/sql.ts: session.model is not required.
function seedDb(dbPath: string, sessions: Session[]): void {
  const db = new Database(dbPath)
  db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT, slug TEXT NOT NULL, directory TEXT NOT NULL, title TEXT NOT NULL, version TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL)')
  db.exec('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)')
  const session = db.prepare("INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated) VALUES (?, 'proj', NULL, ?, ?, 'run', '1.14.46', ?, ?)")
  const message = db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)')
  sessions.forEach((s, si) => {
    session.run(s.id, s.id, s.directory, si, si)
    s.messages.forEach((data, mi) => message.run(`${s.id}-m${mi}`, s.id, mi, mi, data))
  })
  db.close()
}

/** `opencode run --format json` stdout: one JSON envelope per line with the native sessionID. */
function events(sessionID: string, ...extra: string[]): string {
  return [
    JSON.stringify({ type: 'step_start', timestamp: 1, sessionID, part: { type: 'step-start', sessionID } }),
    JSON.stringify({ type: 'text', timestamp: 2, sessionID, part: { type: 'text', sessionID, text: 'done' } }),
    JSON.stringify({ type: 'step_finish', timestamp: 3, sessionID, part: { type: 'step-finish', sessionID } }),
    ...extra,
  ].join('\n') + '\n'
}

function outcome(stdout: string) {
  return { exitCode: 0, durationSeconds: 1, stdout, stderr: '', timedOut: false }
}

const roots: string[] = []
const AMBIENT_ENV = ['OPENCODE_DB', 'OPENCODE_DISABLE_CHANNEL_DB', 'XDG_DATA_HOME']
const savedEnv: Record<string, string | undefined> = {}

beforeAll(() => {
  for (const key of AMBIENT_ENV) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
})

afterAll(() => {
  for (const key of AMBIENT_ENV) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function fresh(): { root: string; workdir: string } {
  const root = mkdtempSync(join(tmpdir(), 'harness-ts-opencode-'))
  roots.push(root)
  const workdir = join(root, 'repo')
  mkdirSync(workdir)
  return { root, workdir }
}

const NULLS = { costUsd: null, tokensIn: null, tokensOut: null, raw: null }

describe('opencode buildCommand', () => {
  test('requests the JSON event stream so the native session ID is observable', () => {
    const { workdir } = fresh()
    expect(buildCommand({ harness: 'opencode', prompt: 'x', workdir }).args.slice(0, 3)).toEqual(['run', '--format', 'json'])
  })
})

describe('opencode parseOutput correlates by native session ID', () => {
  test('selects exactly the reported session, never the newest row for the workdir', () => {
    const { root, workdir } = fresh()
    const dbPath = join(root, 'explicit.db')
    seedDb(dbPath, [
      { id: SESSION, directory: workdir, messages: [USER, assistant('gpt-5.4', 800, 23, 0.002)] },
      { id: OTHER, directory: join(root, 'right', 'repo'), messages: [USER, assistant('gpt-5.4', 99999, 1, 9)] },
    ])
    const parsed = parseOutput({ harness: 'opencode', prompt: 'x', workdir, env: { OPENCODE_DB: dbPath } }, outcome(events(SESSION)))
    expect(parsed).toEqual({ tokensIn: 800, tokensOut: 23, costUsd: 0.002, raw: { sessionID: SESSION, costSource: 'reported' } })
  })

  test('without a single unambiguous ID nothing is read, even when the DB exists', () => {
    const { root, workdir } = fresh()
    const dbPath = join(root, 'explicit.db')
    seedDb(dbPath, [{ id: SESSION, directory: workdir, messages: [assistant('gpt-5.4', 1, 1, 1)] }])
    const spec = { harness: 'opencode', prompt: 'x', workdir, env: { OPENCODE_DB: dbPath } }
    expect(parsed(spec, '')).toEqual(NULLS)
    expect(parsed(spec, `plain text mentioning ${SESSION}\n{not json\n`)).toEqual(NULLS)
    expect(parsed(spec, JSON.stringify({ type: 'banner', sessionID: SESSION }) + '\n')).toEqual(NULLS)
    expect(parsed(spec, events(SESSION) + events(OTHER))).toEqual(NULLS)
    expect(parsed(spec, JSON.stringify({ type: 'text', sessionID: SESSION, part: { sessionID: OTHER } }) + '\n')).toEqual(NULLS)
  })

  test('a missing or :memory: artifact keeps the identity with unavailable cost', () => {
    const { root, workdir } = fresh()
    const unavailable = { tokensIn: null, tokensOut: null, costUsd: null, raw: { sessionID: SESSION, costSource: 'unavailable' } }
    expect(parsed({ harness: 'opencode', prompt: 'x', workdir, env: { OPENCODE_DB: join(root, 'missing.db') } }, events(SESSION))).toEqual(unavailable)
    expect(parsed({ harness: 'opencode', prompt: 'x', workdir, env: { OPENCODE_DB: ':memory:' } }, events(SESSION))).toEqual(unavailable)
  })

  test('relative OPENCODE_DB resolves against the XDG data dir, not the workdir', () => {
    const { root, workdir } = fresh()
    const xdg = join(root, 'xdg')
    mkdirSync(join(xdg, 'opencode'), { recursive: true })
    seedDb(join(xdg, 'opencode', 'custom.db'), [{ id: SESSION, directory: workdir, messages: [assistant('gpt-5.4', 5, 6, 0)] }])
    const viaXdg = parsed({ harness: 'opencode', prompt: 'x', workdir, env: { XDG_DATA_HOME: xdg, OPENCODE_DB: 'custom.db' } }, events(SESSION))
    expect([viaXdg.tokensIn, viaXdg.tokensOut]).toEqual([5, 6])

    // xdg-basedir does not require an absolute XDG_DATA_HOME; a relative one lands under the child's cwd.
    mkdirSync(join(workdir, 'data', 'opencode'), { recursive: true })
    seedDb(join(workdir, 'data', 'opencode', 'opencode.db'), [{ id: SESSION, directory: workdir, messages: [assistant('gpt-5.4', 7, 8, 0)] }])
    const relativeXdg = parsed({ harness: 'opencode', prompt: 'x', workdir, env: { XDG_DATA_HOME: 'data' } }, events(SESSION))
    expect([relativeXdg.tokensIn, relativeXdg.tokensOut]).toEqual([7, 8])
  })

  test('without an override the unique data-dir database holding the session wins, regardless of name or age', () => {
    const { root, workdir } = fresh()
    const home = join(root, 'home')
    const dataDir = join(home, '.local', 'share', 'opencode')
    mkdirSync(dataDir, { recursive: true })
    seedDb(join(dataDir, 'opencode-dev.db'), [{ id: SESSION, directory: workdir, messages: [assistant('gpt-5.4', 42, 4, 0.5)] }])
    seedDb(join(dataDir, 'opencode.db'), [{ id: OTHER, directory: workdir, messages: [assistant('gpt-5.4', 99999, 1, 9)] }])
    writeFileSync(join(dataDir, 'opencode.db-wal'), '')
    const env = { HOME: home }
    expect(parsed({ harness: 'opencode', prompt: 'x', workdir, env }, events(SESSION))).toEqual({ tokensIn: 42, tokensOut: 4, costUsd: 0.5, raw: { sessionID: SESSION, costSource: 'reported' } })

    // OPENCODE_DISABLE_CHANNEL_DB restricts the search to opencode.db (upstream), which lacks the session.
    const disabled = parsed({ harness: 'opencode', prompt: 'x', workdir, env: { ...env, OPENCODE_DISABLE_CHANNEL_DB: '1' } }, events(SESSION))
    expect(disabled).toEqual({ tokensIn: null, tokensOut: null, costUsd: null, raw: { sessionID: SESSION, costSource: 'unavailable' } })
  })

  test('two databases claiming the same session attribute nothing', () => {
    const { root, workdir } = fresh()
    const xdg = join(root, 'xdg')
    mkdirSync(join(xdg, 'opencode'), { recursive: true })
    seedDb(join(xdg, 'opencode', 'opencode.db'), [{ id: SESSION, directory: workdir, messages: [assistant('gpt-5.4', 1, 1, 0)] }])
    seedDb(join(xdg, 'opencode', 'opencode-dev.db'), [{ id: SESSION, directory: workdir, messages: [assistant('gpt-5.4', 2, 2, 0)] }])
    expect(parsed({ harness: 'opencode', prompt: 'x', workdir, env: { XDG_DATA_HOME: xdg } }, events(SESSION)).tokensIn).toBeNull()
  })

  test('an unreadable candidate fails closed', () => {
    const { root, workdir } = fresh()
    const xdg = join(root, 'xdg')
    mkdirSync(join(xdg, 'opencode'), { recursive: true })
    seedDb(join(xdg, 'opencode', 'opencode.db'), [{ id: SESSION, directory: workdir, messages: [assistant('gpt-5.4', 1, 1, 0)] }])
    writeFileSync(join(xdg, 'opencode', 'opencode-beta.db'), 'not a sqlite file')
    expect(parsed({ harness: 'opencode', prompt: 'x', workdir, env: { XDG_DATA_HOME: xdg } }, events(SESSION)).tokensIn).toBeNull()
  })

  function parsed(spec: { harness: string; prompt: string; workdir: string; env: Record<string, string> }, stdout: string) {
    return parseOutput(spec, outcome(stdout))
  }
})

describe('opencode session log selector', () => {
  function telemetry(messages: string[], selector: (dbPath: string) => string = (dbPath) => `${dbPath}#session=${encodeURIComponent(SESSION)}`) {
    const { root, workdir } = fresh()
    const dbPath = join(root, 'opencode.db')
    seedDb(dbPath, [{ id: SESSION, directory: workdir, messages }])
    return getAdapter('opencode').parseSessionLog!(selector(dbPath))
  }

  test('sessionLogPath has no identity to name', () => {
    expect(getAdapter('opencode').sessionLogPath!(fresh().workdir)).toBeNull()
  })

  test('reports literal upstream totals, including a reported zero cost, for the exact session', () => {
    const result = telemetry([USER, assistant('gpt-5.4-mini', 1000, 100, 0)])
    expect(result).toMatchObject({ tokensIn: 1000, tokensOut: 100, costUsd: 0, model: 'gpt-5.4-mini', raw: { sessionID: SESSION, costSource: 'reported' } })
  })

  test('percent-encoded IDs round-trip; legacy and malformed selectors read nothing', () => {
    const encoded = telemetry([assistant('gpt-5.4', 3, 4, 0)], (dbPath) => `${dbPath}#session=${encodeURIComponent(SESSION)}`)
    expect(encoded.tokensIn).toBe(3)
    for (const legacy of [(p: string) => `${p}#session(repo)`, (p: string) => p, (p: string) => `${p}#session=`, (p: string) => `${p}#session=%E0%A4%A`]) {
      expect(telemetry([assistant('gpt-5.4', 3, 4, 0)], legacy)).toMatchObject({ tokensIn: null, tokensOut: null, costUsd: null, model: null, raw: null })
    }
  })

  test('an unknown session ID reads nothing but keeps its identity', () => {
    const result = telemetry([assistant('gpt-5.4', 3, 4, 0)], (dbPath) => `${dbPath}#session=${OTHER}`)
    expect(result).toMatchObject({ tokensIn: null, costUsd: null, model: null, raw: { sessionID: OTHER, costSource: 'unavailable' } })
  })

  test.each(['claude-sonnet-4-6', null])('mixed or missing model %s still sums totals and never prices them', (otherModel) => {
    const result = telemetry([assistant('gpt-5.4-mini', 1000, 100, 0), assistant(otherModel, 10, 1, 0)])
    expect([result.tokensIn, result.tokensOut, result.costUsd, result.model]).toEqual([1010, 101, 0, null])
  })

  test('a mixed provider hides the model even when the modelID agrees', () => {
    const result = telemetry([assistant('gpt-5.4', 1, 1, 0), assistant('gpt-5.4', 1, 1, 0, 'azure')])
    expect(result.model).toBeNull()
  })

  test('one invalid value makes only that field unavailable', () => {
    const result = telemetry([assistant('gpt-5.4', 10, 2.5, 0.1), assistant('gpt-5.4', 5, 1, null)])
    expect([result.tokensIn, result.tokensOut, result.costUsd]).toEqual([15, null, null])
    expect(result.raw).toEqual({ sessionID: SESSION, costSource: 'unavailable' })
  })

  test('a session without assistant rows reads nothing', () => {
    expect(telemetry([USER])).toMatchObject({ tokensIn: null, tokensOut: null, costUsd: null, model: null })
  })
})
