/**
 * Shared adapter fixtures — one generic loop over ../../tests/fixtures/<name>.json.
 *
 * Every registered adapter needs a fixture and every fixture an adapter. Each
 * fixture pins, for both language implementations:
 *
 * - `expectedCommand`  — the exact normalized command plan (`buildCommand`),
 * - `capabilities`     — what `getCapabilities` declares, and therefore which
 *                        spec fields the adapter must reject,
 * - `expectedParsed`   — what `parseOutput` yields for `sampleOutput` once the
 *                        declared `artifacts` (sqlite DBs, trajectory files) exist,
 * - `expectedParsedWithoutArtifacts` — the explicit all-null result when they don't,
 * - a real `run` through `fixtures/fixture_cli.py`, a deterministic substitute
 *   for the CLI that records what it observed and replays `sampleOutput`.
 *
 * `<workdir>` / `<root>` placeholders resolve to the fresh temporary
 * directories each test creates. The Python suite (tests/test_fixtures.py)
 * makes the same assertions.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { basename, dirname, join, relative } from 'path'
import { Database } from 'bun:sqlite'
import { HarnessError } from '../src/base.js'
import type { Backend, BuildCommand, Capabilities, ErrorCode, GracefulSignal, NativeOptions, ParsedOutput, RunSpec, SubprocOutcome } from '../src/base.js'
import { buildCommand, getCapabilities, listAdapters, parseOutput, run, runAsync } from '../src/registry.js'
import '../src/adapters/index.js'

const FIXTURES_DIR = join(import.meta.dir, '../../tests/fixtures')
const FIXTURE_CLI = join(FIXTURES_DIR, 'fixture_cli.py')
const FIXTURE_NAMES = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -'.json'.length)).sort()
const FIXTURE_KEYS = ['spec', 'expectedCommand', 'capabilities', 'sampleOutput', 'expectedParsed']
const ARTIFACT_KEYS = [...FIXTURE_KEYS, 'artifacts', 'expectedParsedWithoutArtifacts']
const LOCK = '.harness-run.lock'
/** Ambient state that would change a command plan or a parser result. */
const AMBIENT_ENV = ['HOME', 'OPENCODE_DB', 'KILO_DB', 'KILO_CONFIG_CONTENT', 'CRUSH_DATA_DIR', 'SWE_WRAPPER', 'XDG_DATA_HOME', 'CLINE_TOOL_APPROVAL_MODE']
/** Spec fields where JSON `null` is a real value rather than "not provided". */
const NULLABLE_SPEC_FIELDS = ['timeoutSeconds', 'inactivityTimeoutSeconds', 'stdin']

type FixtureSpec = Omit<RunSpec, 'workdir' | 'cancel' | 'onOutput'>

interface FixtureExpectedCommand {
  cmd: string
  args: string[]
  cwd: string
  env: Record<string, string>
  instructionsFile: string | null
  directories: string[]
  model: string | null
  gracefulSignal?: GracefulSignal
}

interface FixtureCapabilities {
  backend: Backend
  permissionPolicies: Capabilities['permissionPolicies']
  nativeOptions: NativeOptions['kind'] | null
  configHomeEnv: string | null
  configFileFlag: string | null
  streaming: boolean
  cancellation: boolean
  sessions: boolean
}

type SqliteArtifact = { kind: 'sqlite'; path: string; sql: string[] }
type JsonArtifact = { kind: 'json'; path: string; content: unknown }
type Artifact = SqliteArtifact | JsonArtifact

interface FixtureVariant {
  name: string
  spec?: Partial<FixtureSpec>
  sampleOutput?: SubprocOutcome
  expectedParsed?: ParsedOutput
  artifacts?: Artifact[]
  expectedCommand?: FixtureExpectedCommand
  expectedError?: ErrorCode
  expectedParseError?: boolean
}

interface Fixture {
  spec: FixtureSpec
  expectedCommand: FixtureExpectedCommand
  capabilities: FixtureCapabilities
  /** The `SubprocOutcome` fields a caller-constructed outcome carries. */
  sampleOutput: SubprocOutcome
  expectedParsed: ParsedOutput
  artifacts?: Artifact[]
  expectedParsedWithoutArtifacts?: ParsedOutput
  cases?: FixtureVariant[]
  expectedError?: ErrorCode
  expectedParseError?: boolean
}

interface Case extends Fixture {
  name: string
  root: string
  workdir: string
}

interface Record_ {
  cwd: string
  argv: string[]
  env: Record<string, string>
  entries: string[]
  files: Record<string, string>
}

function substitute<T>(value: T, mapping: Record<string, string>): T {
  if (typeof value === 'string') {
    let out: string = value
    for (const [placeholder, path] of Object.entries(mapping)) out = out.split(placeholder).join(path)
    return out as T
  }
  if (Array.isArray(value)) return value.map((item) => substitute(item, mapping)) as T
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as object).map(([k, v]) => [k, substitute(v, mapping)])) as T
  }
  return value
}

function variants(name: string): FixtureVariant[] {
  return (JSON.parse(readFileSync(join(FIXTURES_DIR, `${name}.json`), 'utf-8')) as Fixture).cases ?? []
}

function runnableCases(name: string): string[] {
  return [name, ...variants(name).filter((variant) => !variant.expectedError).map((variant) => `${name}/${variant.name}`)]
}

function loadFixture(caseId: string, root: string, workdir: string): Fixture {
  const [name, variantName] = caseId.split('/')
  const { cases = [], ...base } = JSON.parse(readFileSync(join(FIXTURES_DIR, `${name}.json`), 'utf-8')) as Fixture
  expect(new Set(cases.map((variant) => variant.name)).size).toBe(cases.length)
  const expectedKeys = 'artifacts' in base ? ARTIFACT_KEYS : FIXTURE_KEYS
  expect(Object.keys(base).sort()).toEqual([...expectedKeys].sort())
  let fixture: Fixture = base
  if (variantName !== undefined) {
    const variant = cases.find((item) => item.name === variantName)
    if (!variant) throw new Error(`Missing fixture case: ${caseId}`)
    const allowed: Record<string, true> = {
      name: true, spec: true, sampleOutput: true, expectedParsed: true,
      artifacts: true, expectedCommand: true, expectedError: true, expectedParseError: true,
    }
    expect(Object.keys(variant).every((key) => Object.hasOwn(allowed, key))).toBe(true)
    const { name: _name, spec = {}, ...overrides } = variant
    // A variant can only override base keys, so `null` stands in for "not
    // provided" except where the contract gives null a meaning of its own.
    const merged = Object.fromEntries(
      Object.entries({ ...base.spec, ...spec }).filter(([key, value]) => value !== null || NULLABLE_SPEC_FIELDS.includes(key)),
    ) as FixtureSpec
    fixture = { ...base, ...overrides, spec: merged }
  }
  return substitute(fixture, { '<workdir>': workdir, '<root>': root })
}

const ROOTS: string[] = []

/** A fixture resolved against a fresh root/workdir pair. */
function freshCase(caseId: string): Case {
  const name = caseId.split('/')[0]!
  const root = mkdtempSync(join(tmpdir(), `harness-fixture-${name}-`))
  ROOTS.push(root)
  const workdir = join(root, 'repo')
  mkdirSync(workdir)
  const fixture = loadFixture(caseId, root, workdir)
  // Files the builder itself requires to exist (swe-agent checks its wrapper).
  const wrapper = fixture.spec.env?.['SWE_WRAPPER']
  if (wrapper !== undefined) writeFileSync(wrapper, '# stub wrapper; never executed\n', 'utf-8')
  return { name, root, workdir, ...fixture }
}

function makeSpec(raw: FixtureSpec, workdir: string, overrides: Partial<RunSpec> = {}): RunSpec {
  return {
    ...raw,
    workdir,
    env: { ...(raw.env ?? {}) },
    ...overrides,
  }
}

function expectedCommand(raw: FixtureExpectedCommand, instructions: string | undefined): BuildCommand {
  const built: BuildCommand = {
    cmd: raw.cmd,
    args: [...raw.args],
    cwd: raw.cwd,
    env: { ...raw.env },
    instructionsFile: raw.instructionsFile,
    directories: [...raw.directories],
    model: raw.model,
  }
  if (raw.instructionsFile !== null) built.instructionContent = instructions
  if (raw.gracefulSignal !== undefined) built.gracefulSignal = raw.gracefulSignal
  return built
}

function expectedCapabilities(raw: FixtureCapabilities): Capabilities {
  return {
    backend: raw.backend,
    permissionPolicies: [...raw.permissionPolicies],
    nativeOptions: raw.nativeOptions,
    configHomeEnv: raw.configHomeEnv,
    configFileFlag: raw.configFileFlag,
    streaming: raw.streaming,
    cancellation: raw.cancellation,
    sessions: raw.sessions,
  }
}

function writeArtifacts(artifacts: Artifact[]): void {
  for (const artifact of artifacts) {
    mkdirSync(dirname(artifact.path), { recursive: true })
    if (artifact.kind === 'sqlite') {
      const db = new Database(artifact.path)
      for (const statement of artifact.sql) db.run(statement)
      db.close()
    } else {
      writeFileSync(artifact.path, JSON.stringify(artifact.content), 'utf-8')
    }
  }
}

function expectCode(fn: () => unknown, code: ErrorCode): void {
  let caught: unknown
  try {
    fn()
  } catch (err) {
    caught = err
  }
  expect(caught).toBeInstanceOf(HarnessError)
  expect((caught as HarnessError).code).toBe(code)
}

/** Shell wrapper that execs the shared fixture CLI; usable as `RunSpec.executable`. */
function substituteCli(root: string): string {
  const exe = join(root, 'bin', 'fixture-cli')
  mkdirSync(dirname(exe))
  const quotedChild = "'" + FIXTURE_CLI.replaceAll("'", "'\\''") + "'"
  writeFileSync(exe, `#!/bin/sh\nexec python3 ${quotedChild} "$@"\n`, { mode: 0o755 })
  return exe
}

const savedEnv: Record<string, string | undefined> = {}

beforeAll(() => {
  for (const key of AMBIENT_ENV) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
  const home = mkdtempSync(join(tmpdir(), 'harness-fixture-home-'))
  ROOTS.push(home)
  process.env.HOME = home
})

afterAll(() => {
  for (const key of AMBIENT_ENV) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  for (const root of ROOTS) {
    rmSync(root, { recursive: true, force: true })
  }
})

test('registry matches the shared fixtures', () => {
  expect(listAdapters()).toEqual(FIXTURE_NAMES)
})

for (const name of FIXTURE_NAMES) {
  for (const variant of variants(name).filter((item) => item.expectedError)) {
    test(`${name}/${variant.name} rejects before preparation`, () => {
      const c = freshCase(`${name}/${variant.name}`)
      expectCode(() => buildCommand(makeSpec(c.spec, c.workdir)), variant.expectedError!)
      expect(readdirSync(c.workdir)).toEqual([])
    })
  }
}

for (const name of FIXTURE_NAMES) {
  describe(name, () => {
    test.each(runnableCases(name))('%s buildCommand matches the fixture without touching the workdir', (caseId) => {
      const c = freshCase(caseId)
      const spec = makeSpec(c.spec, c.workdir)
      const before = readdirSync(c.workdir).sort()

      const built = buildCommand(spec)

      expect(built).toEqual(expectedCommand(c.expectedCommand, spec.instructions))
      expect(readdirSync(c.workdir).sort()).toEqual(before)
      expect(spec.env).toEqual(c.spec.env ?? {}) // never mutated
    })

    test('capabilities match the fixture; undeclared options are rejected', () => {
      const c = freshCase(name)
      const caps = c.capabilities
      expect(getCapabilities(name)).toEqual(expectedCapabilities(caps))

      const build = (overrides: Partial<RunSpec>): BuildCommand => buildCommand(makeSpec(c.spec, c.workdir, overrides))
      const rejects = (code: ErrorCode, overrides: Partial<RunSpec>): void => {
        expectCode(() => build(overrides), code)
        expect(readdirSync(c.workdir)).toEqual([])
      }

      if (!caps.permissionPolicies.includes('bypass')) {
        rejects('unsupported-capability', { permissionPolicy: 'bypass' })
      }

      const home = join(c.root, 'config-home')
      if (caps.configHomeEnv !== null) {
        expect(build({ configHome: home }).env[caps.configHomeEnv]).toBe(home)
      } else {
        rejects('unsupported-capability', { configHome: home })
      }

      const configFile = join(c.root, 'config-file')
      if (caps.configFileFlag !== null) {
        const args = build({ configFile, model: undefined }).args
        expect(args[args.indexOf(caps.configFileFlag) + 1]).toBe(configFile)
      } else {
        rejects('unsupported-capability', { configFile })
      }

      const kinds: NativeOptions[] = [{ kind: 'claude-code' }, { kind: 'codex' }, { kind: 'cline' }, { kind: 'copilot' }]
      for (const nativeOptions of kinds) {
        if (nativeOptions.kind !== caps.nativeOptions) {
          rejects('invalid-options', { nativeOptions })
        }
      }

      for (const backend of ['rpc', 'sdk'] as const) rejects('unsupported-backend', { backend })
    })

    test.each(runnableCases(name))('%s parseOutput matches the fixture once the artifacts exist', (caseId) => {
      const c = freshCase(caseId)
      writeArtifacts(c.artifacts ?? [])
      if (c.expectedParseError) {
        expect(() => parseOutput(makeSpec(c.spec, c.workdir), c.sampleOutput)).toThrow()
        return
      }
      const parsed = parseOutput(makeSpec(c.spec, c.workdir), c.sampleOutput)
      expect(parsed).toEqual(c.expectedParsed)
    })

    if ('artifacts' in (JSON.parse(readFileSync(join(FIXTURES_DIR, `${name}.json`), 'utf-8')) as object)) {
      test('parseOutput without the artifacts is explicitly null', () => {
        const c = freshCase(name)
        const parsed = parseOutput(makeSpec(c.spec, c.workdir), c.sampleOutput)
        expect(parsed).toEqual(c.expectedParsedWithoutArtifacts!)
        expect(parsed).toEqual({ costUsd: null, tokensIn: null, tokensOut: null, raw: null })
      })
    }

    for (const [entrypoint, execute] of [['run', run], ['runAsync', runAsync]] as const) {
      test.each(runnableCases(name))(`%s ${entrypoint} executes the substitute CLI through the shared lifecycle`, async (caseId) => {
        const c = freshCase(caseId)
        const spec0 = makeSpec(c.spec, c.workdir)
        const expected = expectedCommand(c.expectedCommand, spec0.instructions)
        const sample = c.sampleOutput
        const artifacts = c.artifacts ?? []
        const recordPath = join(c.root, 'record.json')
        const manifest = join(c.root, 'run.json')
        writeFileSync(manifest, JSON.stringify({
          record: recordPath,
          envKeys: Object.keys(expected.env).sort(),
          artifacts,
          stdout: sample.stdout,
          stderr: sample.stderr,
          exitCode: sample.exitCode,
        }), 'utf-8')
        const spec = makeSpec(c.spec, c.workdir, {
          executable: substituteCli(c.root),
          env: { ...(c.spec.env ?? {}), HARNESS_FIXTURE_RUN: manifest },
        })

        const result = await execute(spec)

        // Lifecycle metadata shared by every adapter.
        expect(result.harness).toBe(name)
        expect(result.model).toBe(expected.model!)
        expect([result.exitCode, result.timedOut, result.termination]).toEqual([sample.exitCode, false, 'exited'])
        expect([result.signal, result.launchError, result.callbackError]).toEqual([null, null, null])
        if (c.expectedParseError) {
          expect(typeof result.parseError).toBe('string')
        } else {
          expect(result.parseError).toBeNull()
        }
        expect([result.stdout, result.stderr]).toEqual([sample.stdout, sample.stderr])
        expect([result.stdoutTruncated, result.stderrTruncated]).toEqual([false, false])

        // What the substitute CLI observed at launch.
        const seen = JSON.parse(readFileSync(recordPath, 'utf-8')) as Record_
        expect(seen.cwd).toBe(realpathSync(c.workdir))
        expect(seen.argv).toEqual(expected.args)
        expect(seen.env).toEqual(expected.env)
        expect(seen.entries).toContain(LOCK)
        for (const directory of expected.directories ?? []) expect(seen.entries).toContain(relative(c.workdir, directory).split('/')[0]!)
        if (expected.instructionsFile === null) {
          expect(seen.files).toEqual({})
        } else {
          expect(seen.files).toEqual({ [basename(expected.instructionsFile)]: spec.instructions! })
        }

        // The parser saw the artifacts the CLI wrote.
        expect([result.costUsd, result.tokensIn, result.tokensOut, result.raw]).toEqual([
          c.expectedParsed.costUsd, c.expectedParsed.tokensIn, c.expectedParsed.tokensOut, c.expectedParsed.raw,
        ])

        // Owned projection and lease are gone; CLI-written artifacts survive; empty planned dirs are pruned.
        expect(existsSync(join(c.workdir, LOCK))).toBe(false)
        if (expected.instructionsFile !== null) expect(existsSync(expected.instructionsFile)).toBe(false)
        for (const directory of expected.directories ?? []) {
          const written = artifacts.some((a) => !relative(directory, a.path).startsWith('..'))
          expect(existsSync(directory)).toBe(written)
        }
        for (const artifact of artifacts) expect(existsSync(artifact.path)).toBe(true)
      })
    }
  })
}
