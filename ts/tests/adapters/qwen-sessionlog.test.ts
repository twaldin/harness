import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, realpathSync, utimesSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import '../../src/adapters/index.js'
import { getAdapter } from '../../src/registry.js'

// Consumes ../../../tests/fixtures/session-logs/qwen/discovery.json;
// tests/adapters/test_qwen_session_logs.py runs the same cases in Python.

const FIXTURES = join(import.meta.dir, '..', '..', '..', 'tests', 'fixtures', 'session-logs', 'qwen')

interface Telemetry { tokensIn: number | null; tokensOut: number | null; costUsd: number | null; model: string | null }
interface Session { file: string; telemetry: Telemetry; recordUuids?: string[]; sessionId?: string }
interface Fixture {
  sourceQualification: { homeEnv: string; runtimeDirEnv: string }
  sessions: { main: Session; unrelated: Session; noUsage: Session }
  sidecar: { file: string }
  legacyLayout: { file: string }
}

const FX = JSON.parse(readFileSync(join(FIXTURES, 'discovery.json'), 'utf-8')) as Fixture
const BASE_MTIME_MS = 1_800_000_000_000
const MTIME_OFFSETS = { noUsage: 0, main: 60, unrelated: 120, sidecar: 180 } as const
type FileKey = keyof typeof MTIME_OFFSETS

/**
 * Lay the fixture out under <runtime>/projects/<sanitizeCwd(root)>/chats.
 * mtimes are pinned so the unrelated session is the newest transcript, the
 * sidecar newer still, and the no-usage session the oldest.
 */
function install(runtimeDir: string, workdir: string): Record<FileKey, string> {
  const root = realpathSync(workdir)
  const project = join(runtimeDir, 'projects', root.replace(/[^a-zA-Z0-9]/g, '-'))
  const files = {} as Record<FileKey, string>
  for (const key of Object.keys(MTIME_OFFSETS) as FileKey[]) {
    const relative = key === 'sidecar' ? FX.sidecar.file : FX.sessions[key].file
    files[key] = join(project, relative)
    mkdirSync(join(files[key], '..'), { recursive: true })
    writeFileSync(files[key], readFileSync(join(FIXTURES, relative), 'utf-8').replaceAll('__WORKDIR__', root))
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

describe('qwen session log', () => {
  let home: string
  let workdir: string
  let base: string
  let originalEnv: Record<string, string | undefined>
  const adapter = getAdapter('qwen')

  beforeEach(() => {
    originalEnv = {
      HOME: process.env.HOME,
      [FX.sourceQualification.homeEnv]: process.env[FX.sourceQualification.homeEnv],
      [FX.sourceQualification.runtimeDirEnv]: process.env[FX.sourceQualification.runtimeDirEnv],
    }
    base = mkdtempSync(join(tmpdir(), 'harness-ts-qwen-'))
    home = join(base, 'home')
    workdir = join(base, 'repo')
    mkdirSync(home)
    mkdirSync(workdir)
    process.env.HOME = home
    delete process.env[FX.sourceQualification.homeEnv]
    delete process.env[FX.sourceQualification.runtimeDirEnv]
  })

  afterEach(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(base, { recursive: true, force: true })
  })

  test('old basename layouts are not sessions', () => {
    for (const cliDir of ['.qwen', '.gemini']) {
      const legacy = join(home, cliDir, 'tmp', 'repo', 'logs.json')
      mkdirSync(join(legacy, '..'), { recursive: true })
      copyFileSync(join(FIXTURES, FX.legacyLayout.file), legacy)
    }
    expect(adapter.sessionLogPath!(workdir)).toBeNull()
  })

  test('project session wins and colliding project is rejected', () => {
    const files = install(join(home, '.qwen'), workdir)
    expect(adapter.sessionLogPath!(workdir)).toBe(files.main)

    const telemetry = adapter.parseSessionLog!(files.main)
    expectTelemetry(telemetry, FX.sessions.main.telemetry)
    expect(telemetry.raw).toMatchObject(FX.sessions.main.recordUuids!.map(uuid => ({ uuid })))

    expectTelemetry(adapter.parseSessionLog!(files.unrelated), FX.sessions.unrelated.telemetry)
  })

  test('cutoff is epoch milliseconds against mtimeMs', () => {
    const files = install(join(home, '.qwen'), workdir)
    expect(adapter.sessionLogPath!(workdir, BASE_MTIME_MS + 30_000)).toBe(files.main)
    expect(adapter.sessionLogPath!(workdir, BASE_MTIME_MS + 61_000)).toBeNull()
  })

  test('missing usage stays null', () => {
    const files = install(join(home, '.qwen'), workdir)
    const telemetry = adapter.parseSessionLog!(files.noUsage)
    expectTelemetry(telemetry, FX.sessions.noUsage.telemetry)
    expect(telemetry.raw).toMatchObject([{ sessionId: FX.sessions.noUsage.sessionId! }, {}])
  })

  test('QWEN_HOME and QWEN_RUNTIME_DIR select the config root', () => {
    const files = install(join(home, '.qwen'), workdir)
    const qwenHome = join(home, '..', 'qwen-home')

    process.env['QWEN_HOME'] = qwenHome
    expect(adapter.sessionLogPath!(workdir)).toBeNull()
    const byHome = install(qwenHome, workdir)
    expect(adapter.sessionLogPath!(workdir)).toBe(byHome.main)

    // A relative QWEN_RUNTIME_DIR resolves against the CLI cwd, i.e. the workdir.
    process.env['QWEN_RUNTIME_DIR'] = '.qwen-runtime'
    expect(adapter.sessionLogPath!(workdir)).toBeNull()
    const byRuntime = install(join(workdir, '.qwen-runtime'), workdir)
    expect(adapter.sessionLogPath!(workdir)).toBe(byRuntime.main)

    delete process.env['QWEN_RUNTIME_DIR']
    delete process.env['QWEN_HOME']
    expect(adapter.sessionLogPath!(workdir)).toBe(files.main)
  })
})
