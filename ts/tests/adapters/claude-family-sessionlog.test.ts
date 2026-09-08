import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import '../../src/adapters/index.js'
import { getAdapter } from '../../src/registry.js'
import { PROJECT_DIR_NAME_LIMIT, canonicalProjectPath, encodeProjectPath } from '../../src/adapters/claude-code.js'
import type { SessionTelemetry } from '../../src/base.js'

// Consumes ../../../tests/fixtures/session-logs/{claude-code,openclaude}/discovery.json;
// tests/adapters/test_claude_family_session_logs.py runs the same cases in Python.

const FIXTURES = join(import.meta.dir, '..', '..', '..', 'tests', 'fixtures', 'session-logs')

interface EncodingCase { projectPath: string; encoded: string; note: string }
interface Telemetry { tokensIn: number; tokensOut: number; costUsd: number | null; model: string }
interface SourceQualification {
  configDirEnv: string
  configDirDefault: string
  projectsSubdir: string
  foreignConfigDirDefaults: string[]
  foreignConfigDirEnvs: string[]
}
interface Discovery {
  installedCapture?: { transcript: string; workdirName: string; projectDirName: string; telemetry: Telemetry; privatePathPlaceholder: string }
  sourceQualification: SourceQualification
  encoding: EncodingCase[]
  legacyLayout: { workdirName: string }
  transcript: string
  telemetry: Telemetry
  gatewayTranscript?: string
  gatewayTelemetry?: Telemetry
}

async function loadFixture(adapter: string): Promise<Discovery> {
  return await Bun.file(join(FIXTURES, adapter, 'discovery.json')).json() as Discovery
}

function place(projects: string, dirname: string, transcript: string, workdir: string, name = 'session.jsonl', mtimeMs?: number): string {
  const dir = join(projects, dirname)
  mkdirSync(dir, { recursive: true })
  const dst = join(dir, name)
  writeFileSync(dst, readFileSync(transcript, 'utf8').replaceAll('/Users/dev/repo.space_underé', canonicalProjectPath(workdir)))
  if (mtimeMs !== undefined) utimesSync(dst, mtimeMs / 1000, mtimeMs / 1000)
  return dst
}

function expectTelemetry(actual: SessionTelemetry | undefined, expected: Telemetry): void {
  expect(actual?.tokensIn).toBe(expected.tokensIn)
  expect(actual?.tokensOut).toBe(expected.tokensOut)
  expect(actual?.model).toBe(expected.model)
  if (expected.costUsd === null) expect(actual?.costUsd).toBeNull()
  else expect(actual?.costUsd).toBeCloseTo(expected.costUsd, 9)
}

const ENV_VARS = ['HOME', 'CLAUDE_CONFIG_DIR', 'OPENCLAUDE_CONFIG_DIR'] as const
let savedEnv: Record<string, string | undefined> = {}
let tmp = ''
let home = ''
const originalCwd = process.cwd()

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_VARS.map(k => [k, process.env[k]]))
  tmp = mkdtempSync(join(tmpdir(), 'harness-ts-claude-family-'))
  home = join(tmp, 'home')
  mkdirSync(home)
  process.env.HOME = home
  delete process.env.CLAUDE_CONFIG_DIR
  delete process.env.OPENCLAUDE_CONFIG_DIR
})

afterEach(() => {
  process.chdir(originalCwd)
  rmSync(tmp, { recursive: true, force: true })
  for (const k of ENV_VARS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
})

describe('claude-family project path encoding', () => {
  test('matches the upstream sanitizer table', async () => {
    for (const c of (await loadFixture('claude-code')).encoding) {
      expect(encodeProjectPath(c.projectPath), c.note).toBe(c.encoded)
    }
  })

  test('installed 2.1.220 capture: directory name and telemetry', async () => {
    const fx = await loadFixture('claude-code')
    const capture = fx.installedCapture!
    expect(encodeProjectPath(`${capture.privatePathPlaceholder}/${capture.workdirName}`)).toBe(capture.projectDirName)
    const telemetry = getAdapter('claude-code').parseSessionLog?.(join(FIXTURES, 'claude-code', capture.transcript))
    expectTelemetry(telemetry, capture.telemetry)
  })

  test('openclaude gateway model keeps cost null', async () => {
    const fx = await loadFixture('openclaude')
    const telemetry = getAdapter('openclaude').parseSessionLog?.(join(FIXTURES, 'openclaude', fx.gatewayTranscript!))
    expectTelemetry(telemetry, fx.gatewayTelemetry!)
  })
})

describe.each(['claude-code', 'openclaude'])('%s session log discovery', (adapterName) => {
  test('finds the current layout and ignores the legacy one', async () => {
    const fx = await loadFixture(adapterName)
    const source = fx.sourceQualification
    const projects = join(home, source.configDirDefault, source.projectsSubdir)
    const workdir = join(tmp, fx.legacyLayout.workdirName)
    mkdirSync(workdir)
    const real = canonicalProjectPath(workdir)
    const transcript = join(FIXTURES, adapterName, fx.transcript)
    const adapter = getAdapter(adapterName)

    const legacy = real.replace(/[\/_]/g, '-')
    expect(legacy).not.toBe(encodeProjectPath(real))
    place(projects, legacy, transcript, workdir)
    expect(adapter.sessionLogPath?.(workdir)).toBeNull()

    const expected = place(projects, encodeProjectPath(real), transcript, workdir)
    expect(adapter.sessionLogPath?.(workdir)).toBe(expected)
    expectTelemetry(adapter.parseSessionLog?.(expected), fx.telemetry)
  })

  test('config root env replaces the default and foreign roots are ignored', async () => {
    const fx = await loadFixture(adapterName)
    const source = fx.sourceQualification
    const workdir = join(tmp, 'repo')
    mkdirSync(workdir)
    const encoded = encodeProjectPath(canonicalProjectPath(workdir))
    const transcript = join(FIXTURES, adapterName, fx.transcript)
    const adapter = getAdapter(adapterName)

    for (const foreign of source.foreignConfigDirDefaults) place(join(home, foreign, source.projectsSubdir), encoded, transcript, workdir)
    const foreignRoot = join(tmp, 'foreign-config')
    place(join(foreignRoot, source.projectsSubdir), encoded, transcript, workdir)
    for (const v of source.foreignConfigDirEnvs) process.env[v] = foreignRoot
    expect(adapter.sessionLogPath?.(workdir)).toBeNull()

    const defaultPath = place(join(home, source.configDirDefault, source.projectsSubdir), encoded, transcript, workdir)
    expect(adapter.sessionLogPath?.(workdir)).toBe(defaultPath)

    const overrideRoot = join(tmp, 'override-config')
    const overridePath = place(join(overrideRoot, source.projectsSubdir), encoded, transcript, workdir)
    process.env[source.configDirEnv] = overrideRoot
    expect(adapter.sessionLogPath?.(workdir)).toBe(overridePath)

    process.chdir(overrideRoot)
    process.env[source.configDirEnv] = ''
    expect(adapter.sessionLogPath?.(workdir)).toBe(adapterName === 'claude-code' ? canonicalProjectPath(overridePath) : defaultPath)
  })

  test('millisecond cutoff filters stale logs instead of falling back', async () => {
    const fx = await loadFixture(adapterName)
    const source = fx.sourceQualification
    const projects = join(home, source.configDirDefault, source.projectsSubdir)
    const workdir = join(tmp, 'repo')
    mkdirSync(workdir)
    const encoded = encodeProjectPath(canonicalProjectPath(workdir))
    const transcript = join(FIXTURES, adapterName, fx.transcript)
    const adapter = getAdapter(adapterName)
    const now = Date.now()

    const stale = place(projects, encoded, transcript, workdir, 'stale.jsonl', now - 1_000_000)
    expect(adapter.sessionLogPath?.(workdir)).toBe(stale)
    expect(adapter.sessionLogPath?.(workdir, now - 100_000)).toBeNull()

    const fresh = place(projects, encoded, transcript, workdir, 'fresh.jsonl', now - 10_000)
    expect(adapter.sessionLogPath?.(workdir)).toBe(fresh)
    expect(adapter.sessionLogPath?.(workdir, now - 100_000)).toBe(fresh)
    expect(adapter.sessionLogPath?.(workdir, now - 10_000)).toBe(fresh)
    expect(adapter.sessionLogPath?.(workdir, now + 100_000)).toBeNull()
  })

  test('symlinked and NFD workdirs resolve to the canonical project', async () => {
    const fx = await loadFixture(adapterName)
    const source = fx.sourceQualification
    const projects = join(home, source.configDirDefault, source.projectsSubdir)
    const transcript = join(FIXTURES, adapterName, fx.transcript)
    const adapter = getAdapter(adapterName)

    const real = join(tmp, 'real cafe\u0301')
    const workdir = real
    mkdirSync(real)
    const link = join(tmp, 'link')
    symlinkSync(real, link, 'dir')
    const canonical = canonicalProjectPath(link)
    expect(canonical).toBe(canonicalProjectPath(real))
    expect(canonical.endsWith('caf\u00e9')).toBe(true)

    place(projects, encodeProjectPath(link), transcript, workdir)
    expect(adapter.sessionLogPath?.(link)).toBeNull()
    const expected = place(projects, encodeProjectPath(canonical), transcript, workdir)
    expect(adapter.sessionLogPath?.(link)).toBe(expected)
  })

  test('long paths use the hash suffix and accept prefix siblings', async () => {
    const fx = await loadFixture(adapterName)
    const source = fx.sourceQualification
    const projects = join(home, source.configDirDefault, source.projectsSubdir)
    const transcript = join(FIXTURES, adapterName, fx.transcript)
    const workdir = join(tmp, 'd'.repeat(PROJECT_DIR_NAME_LIMIT + 20))
    mkdirSync(workdir)
    const encoded = encodeProjectPath(canonicalProjectPath(workdir))
    expect(encoded.length).toBeGreaterThan(PROJECT_DIR_NAME_LIMIT + 1)
    const prefix = encoded.slice(0, PROJECT_DIR_NAME_LIMIT) + '-'
    const now = Date.now()
    const adapter = getAdapter(adapterName)

    const sibling = place(projects, prefix + 'otherhash', transcript, workdir, 'session.jsonl', now - 50_000)
    expect(adapter.sessionLogPath?.(workdir)).toBe(sibling)
    place(projects, encoded.slice(0, PROJECT_DIR_NAME_LIMIT) + 'x-unrelated', transcript, workdir, 'session.jsonl', now - 1_000)
    expect(adapter.sessionLogPath?.(workdir)).toBe(sibling)
    place(projects, prefix + 'foreignhash', transcript, join(tmp, 'unrelated'), 'session.jsonl', now - 1_000)
    expect(adapter.sessionLogPath?.(workdir)).toBe(sibling)
    const exact = place(projects, encoded, transcript, workdir, 'session.jsonl', now - 20_000)
    expect(adapter.sessionLogPath?.(workdir)).toBe(exact)
  })
})
