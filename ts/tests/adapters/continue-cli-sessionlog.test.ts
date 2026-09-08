import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import '../../src/adapters/index.js'
import { getAdapter } from '../../src/registry.js'

const SESSION_ID = '3b9e7d2c-5a1f-4e8b-9c6d-0f1a2b3c4d5e'
const fixture = JSON.parse(readFileSync(new URL(`../../../tests/fixtures/session-logs/continue/${SESSION_ID}.json`, import.meta.url), 'utf8')) as Record<string, unknown>
const legacyLayouts = JSON.parse(readFileSync(new URL('../../../tests/fixtures/session-logs/continue/legacy-layouts.json', import.meta.url), 'utf8')) as { cases: { name: string; directory: string; override: boolean }[] }
const adapter = getAdapter('continue-cli')

const originalEnv = { HOME: process.env.HOME, CONTINUE_GLOBAL_DIR: process.env['CONTINUE_GLOBAL_DIR'], CONTINUE_SESSION_DIR: process.env['CONTINUE_SESSION_DIR'] }
const roots: string[] = []
afterEach(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function setup(): { home: string; workdir: string; sessions: string } {
  const root = mkdtempSync(join(tmpdir(), 'harness-ts-continue-'))
  roots.push(root)
  const home = join(root, 'home')
  const workdir = join(root, 'repo')
  mkdirSync(workdir, { recursive: true })
  process.env.HOME = home
  delete process.env['CONTINUE_GLOBAL_DIR']
  delete process.env['CONTINUE_SESSION_DIR']
  const sessions = join(home, '.continue', 'sessions')
  mkdirSync(sessions, { recursive: true })
  return { home, workdir, sessions }
}

/** Upstream keys sessions by `workspaceDirectory` (the cn process cwd), so the fixture is rewritten per test. */
function writeSession(dir: string, workspaceDirectory: string, id: string = SESSION_ID, overrides: Record<string, unknown> = {}): string {
  const path = join(dir, `${id}.json`)
  writeFileSync(path, JSON.stringify({ ...fixture, sessionId: id, workspaceDirectory, ...overrides }))
  return path
}

describe('continue-cli session log', () => {
  test('selects the newest session for this workspace and reads native usage; model stays null', () => {
    const { workdir, sessions } = setup()
    const now = Date.now()
    const log = writeSession(sessions, realpathSync(workdir))
    utimesSync(log, (now - 60_000) / 1000, (now - 60_000) / 1000)
    const foreign = writeSession(sessions, '/somewhere/else', '00000000-0000-4000-8000-000000000000')
    utimesSync(foreign, now / 1000, now / 1000)
    writeFileSync(join(sessions, 'sessions.json'), JSON.stringify([{ sessionId: SESSION_ID, title: 't', dateCreated: String(now), workspaceDirectory: realpathSync(workdir) }]))

    expect(adapter.sessionLogPath!(workdir)).toBe(log)
    const telemetry = adapter.parseSessionLog!(log)
    expect([telemetry.tokensIn, telemetry.tokensOut, telemetry.costUsd, telemetry.model]).toEqual([33, 9, 0.005, null])
    expect(telemetry.raw).toEqual(fixture['usage'])
  })

  test('epoch-milliseconds cutoff filters stale sessions instead of returning them', () => {
    const { workdir, sessions } = setup()
    const now = Date.now()
    const log = writeSession(sessions, realpathSync(workdir))
    utimesSync(log, (now - 60_000) / 1000, (now - 60_000) / 1000)
    expect(adapter.sessionLogPath!(workdir, now - 3_600_000)).toBe(log)
    expect(adapter.sessionLogPath!(workdir, now - 1_000)).toBeNull()
  })

  test('does not guess workspace identity by case folding', () => {
    const { workdir, sessions } = setup()
    writeSession(sessions, realpathSync(workdir).toUpperCase())
    expect(adapter.sessionLogPath!(workdir)).toBeNull()
  })

  test('CONTINUE_GLOBAL_DIR relocates the sessions directory', () => {
    const { home, workdir, sessions } = setup()
    writeSession(sessions, realpathSync(workdir))
    const globalDir = join(home, 'continue-global')
    process.env['CONTINUE_GLOBAL_DIR'] = globalDir
    expect(adapter.sessionLogPath!(workdir)).toBeNull()
    mkdirSync(join(globalDir, 'sessions'), { recursive: true })
    const expected = writeSession(join(globalDir, 'sessions'), realpathSync(workdir))
    expect(adapter.sessionLogPath!(workdir)).toBe(expected)
  })

  test('sessions without usage and missing files report null telemetry', () => {
    const { workdir, sessions } = setup()
    const { usage: _usage, ...withoutUsage } = fixture
    const log = join(sessions, `${SESSION_ID}.json`)
    writeFileSync(log, JSON.stringify({ ...withoutUsage, workspaceDirectory: realpathSync(workdir) }))
    const telemetry = adapter.parseSessionLog!(log)
    expect([telemetry.tokensIn, telemetry.tokensOut, telemetry.costUsd, telemetry.model, telemetry.raw]).toEqual([null, null, null, null, null])
    expect(adapter.parseSessionLog!(join(sessions, 'missing.json')).raw).toBeNull()
  })
  test.each(legacyLayouts.cases)('obsolete layout is not a workspace session: $name', (layout) => {
    const { home, workdir } = setup()
    const directory = join(home, layout.directory.replace('__BASENAME__', basename(workdir)))
    mkdirSync(directory, { recursive: true })
    writeSession(directory, '/unrelated/workspace')
    if (layout.override) process.env['CONTINUE_SESSION_DIR'] = directory
    expect(adapter.sessionLogPath!(workdir)).toBeNull()
  })
})
