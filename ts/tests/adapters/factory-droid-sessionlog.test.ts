import { afterEach, describe, expect, test } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import '../../src/adapters/index.js'
import { encodeProjectDir } from '../../src/adapters/factory-droid.js'
import { getAdapter } from '../../src/registry.js'

const SESSION_ID = '6f1c2e4a-8d3b-4c5e-9a7f-1b2c3d4e5f60'
const fixtures = fileURLToPath(new URL('../../../tests/fixtures/session-logs/factory/', import.meta.url))
const adapter = getAdapter('factory-droid')

const originalEnv = { HOME: process.env.HOME, FACTORY_HOME_OVERRIDE: process.env['FACTORY_HOME_OVERRIDE'] }
const roots: string[] = []
afterEach(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** Fresh HOME plus a `my_repo` workdir; returns the project directory droid would use for it. */
function setup(): { home: string; workdir: string; projectDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'harness-ts-factory-'))
  roots.push(root)
  const home = join(root, 'home')
  const workdir = join(root, 'my_repo')
  mkdirSync(workdir, { recursive: true })
  process.env.HOME = home
  delete process.env['FACTORY_HOME_OVERRIDE']
  const projectDir = join(home, '.factory', 'sessions', encodeProjectDir(realpathSync(workdir)))
  mkdirSync(projectDir, { recursive: true })
  return { home, workdir, projectDir }
}

function copySession(dir: string, cwd: string, id: string = SESSION_ID, settings = true): string {
  const log = join(dir, `${id}.jsonl`)
  writeFileSync(log, readFileSync(join(fixtures, `${SESSION_ID}.jsonl`), 'utf8').replaceAll('/workspace/repo', cwd))
  if (settings) copyFileSync(join(fixtures, `${SESSION_ID}.settings.json`), join(dir, `${id}.settings.json`))
  return log
}

describe('factory-droid session log', () => {
  test('encodes the realpath like droid: dash prefix, slashes to dashes, underscores kept', () => {
    expect(encodeProjectDir('/Users/me/code/my_app/')).toBe('-Users-me-code-my_app')
  })

  test('finds the project jsonl and reads usage/model from the sibling settings file', () => {
    const { workdir, projectDir } = setup()
    const log = copySession(projectDir, realpathSync(workdir))
    expect(adapter.sessionLogPath!(workdir)).toBe(log)
    const telemetry = adapter.parseSessionLog!(log)
    expect([telemetry.tokensIn, telemetry.tokensOut, telemetry.costUsd, telemetry.model]).toEqual([210, 44, null, 'claude-sonnet-4-5-20250929'])
    expect(telemetry.raw).toEqual(JSON.parse(readFileSync(join(fixtures, `${SESSION_ID}.settings.json`), 'utf8')))
  })

  test('ignores other projects and honors the epoch-milliseconds cutoff without a global fallback', () => {
    const { home, workdir, projectDir } = setup()
    const now = Date.now()
    const log = copySession(projectDir, realpathSync(workdir))
    utimesSync(log, (now - 60_000) / 1000, (now - 60_000) / 1000)
    const otherDir = join(home, '.factory', 'sessions', '-Users-someone-else')
    mkdirSync(otherDir, { recursive: true })
    const other = copySession(otherDir, '/unrelated', '00000000-0000-4000-8000-000000000000')
    utimesSync(other, now / 1000, now / 1000)
    const collision = copySession(projectDir, '/unrelated', '33333333-3333-4333-8333-333333333333')
    utimesSync(collision, now / 1000, now / 1000)

    expect(adapter.sessionLogPath!(workdir)).toBe(log)
    expect(adapter.sessionLogPath!(workdir, now - 3_600_000)).toBe(log)
    expect(adapter.sessionLogPath!(workdir, now - 1_000)).toBeNull()
  })

  test('FACTORY_HOME_OVERRIDE replaces ~ rather than ~/.factory', () => {
    const { home, workdir } = setup()
    copySession(join(home, '.factory', 'sessions', encodeProjectDir(realpathSync(workdir))), realpathSync(workdir))
    const override = join(home, 'override')
    process.env['FACTORY_HOME_OVERRIDE'] = override
    expect(adapter.sessionLogPath!(workdir)).toBeNull()
    const overrideDir = join(override, '.factory', 'sessions', encodeProjectDir(realpathSync(workdir)))
    mkdirSync(overrideDir, { recursive: true })
    const expected = copySession(overrideDir, realpathSync(workdir))
    expect(adapter.sessionLogPath!(workdir)).toBe(expected)
  })

  test('legacy flat sessions match only through session_start.cwd', () => {
    const { home, workdir } = setup()
    const sessions = join(home, '.factory', 'sessions')
    const mine = join(sessions, '11111111-1111-4111-8111-111111111111.jsonl')
    writeFileSync(mine, JSON.stringify({ type: 'session_start', id: '1', title: 't', cwd: realpathSync(workdir) }) + '\n')
    const theirs = join(sessions, '22222222-2222-4222-8222-222222222222.jsonl')
    writeFileSync(theirs, JSON.stringify({ type: 'session_start', id: '2', title: 't', cwd: '/somewhere/else' }) + '\n')
    const later = (Date.now() + 5_000) / 1000
    utimesSync(theirs, later, later)
    expect(adapter.sessionLogPath!(workdir)).toBe(mine)
  })

  test('project sessions accept symlink cwd with a trailing slash', () => {
    const { home, workdir, projectDir } = setup()
    const alias = join(home, 'repo-alias')
    symlinkSync(workdir, alias, 'dir')
    const log = copySession(projectDir, `${alias}/`)
    expect(adapter.sessionLogPath!(workdir)).toBe(log)
  })

  test('missing settings falls back to the assistant modelId; missing files stay null', () => {
    const { projectDir } = setup()
    const log = copySession(projectDir, '/workspace/repo', SESSION_ID, false)
    const telemetry = adapter.parseSessionLog!(log)
    expect([telemetry.tokensIn, telemetry.tokensOut, telemetry.costUsd, telemetry.model, telemetry.raw]).toEqual([null, null, null, 'claude-sonnet-4-5-20250929', null])
    const missing = adapter.parseSessionLog!(join(projectDir, 'nope.jsonl'))
    expect([missing.tokensIn, missing.model, missing.raw]).toEqual([null, null, null])
  })
})
