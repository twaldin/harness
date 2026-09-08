import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, realpathSync, utimesSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import '../../src/adapters/index.js'
import { getAdapter } from '../../src/registry.js'

// Consumes ../../../tests/fixtures/session-logs/gemini/discovery.json;
// tests/adapters/test_gemini_session_logs.py runs the same cases in Python.

const FIXTURES = join(import.meta.dir, '..', '..', '..', 'tests', 'fixtures', 'session-logs', 'gemini')

interface Telemetry { tokensIn: number | null; tokensOut: number | null; costUsd: number | null; model: string | null }
interface Session { file: string; telemetry: Telemetry; messageIds?: string[]; lastUpdated?: string; sessionId?: string }
interface Fixture {
  sourceQualification: { homeEnv: string }
  registry: string
  registrySlug: string
  sessions: { main: Session; unrelated: Session; noUsage: Session }
  legacyLayout: { file: string }
}

const FX = JSON.parse(readFileSync(join(FIXTURES, 'discovery.json'), 'utf-8')) as Fixture
const BASE_MTIME_MS = 1_800_000_000_000
const MTIME_OFFSETS = { noUsage: 0, main: 60, unrelated: 120 } as const
type SessionKey = keyof typeof MTIME_OFFSETS

function materialize(source: string, target: string, root: string): string {
  const hash = createHash('sha256').update(root).digest('hex')
  const text = readFileSync(source, 'utf-8').replaceAll('__PROJECT_HASH__', hash).replaceAll('__WORKDIR__', root)
  mkdirSync(join(target, '..'), { recursive: true })
  writeFileSync(target, text)
  return target
}

/**
 * Lay the fixture out as gemini-cli would: registry, ownership marker and
 * chats. mtimes are pinned so the unrelated session is the newest file on
 * disk and the no-usage session is the oldest.
 */
function install(geminiDir: string, workdir: string, opts: { registry?: boolean; marker?: boolean; identifier?: string } = {}): Record<SessionKey, string> {
  const root = realpathSync(workdir)
  const identifier = opts.identifier ?? FX.registrySlug
  if (opts.registry !== false) materialize(join(FIXTURES, FX.registry), join(geminiDir, FX.registry), root)
  const project = join(geminiDir, 'tmp', identifier)
  if (opts.marker !== false) {
    mkdirSync(project, { recursive: true })
    writeFileSync(join(project, '.project_root'), root)
  }
  const files = {} as Record<SessionKey, string>
  for (const key of Object.keys(MTIME_OFFSETS) as SessionKey[]) {
    files[key] = materialize(join(FIXTURES, FX.sessions[key].file), join(project, FX.sessions[key].file), root)
    const seconds = BASE_MTIME_MS / 1000 + MTIME_OFFSETS[key]
    utimesSync(files[key], seconds, seconds)
  }
  return files
}

function expectTelemetry(actual: Telemetry, expected: Telemetry): void {
  expect([actual.tokensIn, actual.tokensOut, actual.model]).toEqual([expected.tokensIn, expected.tokensOut, expected.model])
  if (expected.costUsd === null) expect(actual.costUsd).toBeNull()
  else expect(actual.costUsd).toBeCloseTo(expected.costUsd, 10)
}

describe('gemini session log', () => {
  let home: string
  let workdir: string
  let base: string
  let originalEnv: Record<string, string | undefined>
  const adapter = getAdapter('gemini')

  beforeEach(() => {
    originalEnv = { HOME: process.env.HOME, [FX.sourceQualification.homeEnv]: process.env[FX.sourceQualification.homeEnv] }
    base = mkdtempSync(join(tmpdir(), 'harness-ts-gemini-'))
    home = join(base, 'home')
    workdir = join(base, 'repo')
    mkdirSync(home)
    mkdirSync(workdir)
    process.env.HOME = home
    delete process.env[FX.sourceQualification.homeEnv]
  })

  afterEach(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(base, { recursive: true, force: true })
  })

  test('old basename layout is not a session', () => {
    const legacy = join(home, '.gemini', 'tmp', 'repo', 'logs.json')
    mkdirSync(join(legacy, '..'), { recursive: true })
    copyFileSync(join(FIXTURES, FX.legacyLayout.file), legacy)
    expect(adapter.sessionLogPath!(workdir)).toBeNull()
  })

  test('registered session wins and unrelated project is rejected', () => {
    const files = install(join(home, '.gemini'), workdir)
    expect(adapter.sessionLogPath!(workdir)).toBe(files.main)

    const telemetry = adapter.parseSessionLog!(files.main)
    expectTelemetry(telemetry, FX.sessions.main.telemetry)
    expect(telemetry.raw).toMatchObject({
      lastUpdated: FX.sessions.main.lastUpdated!,
      messages: FX.sessions.main.messageIds!.map((id, index, ids) => (index === ids.length - 1 ? { id, toolCalls: [{ status: 'success' }] } : { id })),
    })

    expectTelemetry(adapter.parseSessionLog!(files.unrelated), FX.sessions.unrelated.telemetry)
  })

  test('cutoff is epoch milliseconds against mtimeMs', () => {
    const files = install(join(home, '.gemini'), workdir)
    expect(adapter.sessionLogPath!(workdir, BASE_MTIME_MS + 30_000)).toBe(files.main)
    expect(adapter.sessionLogPath!(workdir, BASE_MTIME_MS + 61_000)).toBeNull()
  })

  test('missing usage stays null', () => {
    const files = install(join(home, '.gemini'), workdir)
    const telemetry = adapter.parseSessionLog!(files.noUsage)
    expectTelemetry(telemetry, FX.sessions.noUsage.telemetry)
    expect(telemetry.raw).toMatchObject({ sessionId: FX.sessions.noUsage.sessionId! })
  })

  test('GEMINI_CLI_HOME selects the config root', () => {
    const files = install(join(home, '.gemini'), workdir)
    const alt = join(home, '..', 'alt-home')
    process.env['GEMINI_CLI_HOME'] = alt
    expect(adapter.sessionLogPath!(workdir)).toBeNull()

    const altFiles = install(join(alt, '.gemini'), workdir)
    expect(adapter.sessionLogPath!(workdir)).toBe(altFiles.main)
    delete process.env['GEMINI_CLI_HOME']
    expect(adapter.sessionLogPath!(workdir)).toBe(files.main)
  })

  test('marker and hash directories resolve without a registry', () => {
    const byMarker = install(join(home, '.gemini'), workdir, { registry: false, identifier: 'repo-1' })
    expect(adapter.sessionLogPath!(workdir)).toBe(byMarker.main)

    const hashed = createHash('sha256').update(realpathSync(workdir)).digest('hex')
    const otherHome = join(home, 'pre-registry')
    const byHash = install(join(otherHome, '.gemini'), workdir, { registry: false, marker: false, identifier: hashed })
    process.env['GEMINI_CLI_HOME'] = otherHome
    expect(adapter.sessionLogPath!(workdir)).toBe(byHash.main)
  })
})
