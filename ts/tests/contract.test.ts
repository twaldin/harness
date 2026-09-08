import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { spawnSync } from 'node:child_process'
import { join } from 'path'
import { HarnessError, validateRunSpec } from '../src/base.js'
import type { Backend, ErrorCode, RunSpec } from '../src/base.js'
import { buildCommand, getAdapter, getCapabilities, parseOutput, register } from '../src/registry.js'
import '../src/adapters/index.js'

const TMP_ROOT = join('/tmp', `harness-ts-contract-${process.pid}-${Date.now()}`)
let counter = 0

/** A workdir path that does not exist yet: any adapter write would create it. */
function freshWorkdir(): string {
  return join(TMP_ROOT, `wd-${counter++}`)
}

afterAll(() => {
  try {
    rmSync(TMP_ROOT, { recursive: true, force: true })
  } catch {}
})

function specFor(harness: string, extra: Partial<RunSpec> = {}): RunSpec {
  return { harness, prompt: 'do the thing', workdir: freshWorkdir(), instructions: 'be careful\n', ...extra }
}

/** A spec as a JS/JSON caller would hand it over: the type system never saw it. */
function untyped(spec: object): RunSpec {
  return spec as RunSpec
}

function expectCode(fn: () => unknown, code: ErrorCode): HarnessError {
  let caught: unknown
  try {
    fn()
  } catch (err) {
    caught = err
  }
  expect(caught).toBeInstanceOf(HarnessError)
  const err = caught as HarnessError
  expect(err.code).toBe(code)
  return err
}

const BYPASS_FLAGS: Record<string, string[]> = {
  aider: ['--yes-always'],
  'claude-code': ['--dangerously-skip-permissions'],
  openclaude: ['--dangerously-skip-permissions'],
  codex: ['--dangerously-bypass-approvals-and-sandbox'],
  'factory-droid': ['--skip-permissions-unsafe'],
  gemini: ['-y'],
  qwen: ['-y'],
  kilo: ['--auto'],
}

const NO_BYPASS = ['opencode', 'pi', 'crush', 'continue-cli', 'swe-agent']

const ALL_BYPASS_FLAGS = Object.values(BYPASS_FLAGS).flat()
const SHIPPED = [...Object.keys(BYPASS_FLAGS), ...NO_BYPASS]

describe('permission policy', () => {
  for (const [name, flags] of Object.entries(BYPASS_FLAGS)) {
    test(`${name}: omitted policy injects no bypass flag; explicit bypass injects ${flags.join(' ')}`, () => {
      const workdir = freshWorkdir()
      const upstream = buildCommand(specFor(name, { workdir }))
      for (const flag of ALL_BYPASS_FLAGS) expect(upstream.args).not.toContain(flag)

      const bypass = buildCommand(specFor(name, { workdir, permissionPolicy: 'bypass' }))
      for (const flag of flags) expect(bypass.args).toContain(flag)
      // bypass adds exactly the mapped flags, nothing else moves
      expect(bypass.args.filter((a) => !flags.includes(a))).toEqual(upstream.args)
    })
  }

  for (const name of NO_BYPASS) {
    test(`${name}: explicit bypass is rejected before any write`, () => {
      const spec = specFor(name, { permissionPolicy: 'bypass' })
      expectCode(() => buildCommand(spec), 'unsupported-capability')
      expect(existsSync(spec.workdir)).toBe(false)
    })
  }

  test('explicit upstream equals omitted policy', () => {
    const omitted = buildCommand(specFor('gemini'))
    const explicit = buildCommand(specFor('gemini', { permissionPolicy: 'upstream' }))
    expect(explicit.args).toEqual(omitted.args)
  })

  test('unknown policy is invalid-options', () => {
    const spec = untyped({ ...specFor('claude-code'), permissionPolicy: 'yolo' })
    expectCode(() => buildCommand(spec), 'invalid-options')
    expect(existsSync(spec.workdir)).toBe(false)
  })
})

describe('backend selection', () => {
  test('omitted backend resolves to cli', () => {
    expect(validateRunSpec(getAdapter('codex'), specFor('codex')).backend).toBe('cli')
    expect(validateRunSpec(getAdapter('codex'), specFor('codex', { backend: 'cli' })).backend).toBe('cli')
  })

  for (const backend of ['rpc', 'sdk'] as const) {
    test(`${backend} is rejected before any filesystem side effect`, () => {
      for (const name of SHIPPED) {
        const spec = specFor(name, { backend })
        expectCode(() => buildCommand(spec), 'unsupported-backend')
        expect(existsSync(spec.workdir)).toBe(false)
      }
    })
  }

  test('unknown backend value is invalid-options', () => {
    const spec = untyped({ ...specFor('codex'), backend: 'grpc' })
    expectCode(() => buildCommand(spec), 'invalid-options')
    expect(existsSync(spec.workdir)).toBe(false)
  })

  test('direct adapter access validates too', () => {
    const spec = specFor('aider', { backend: 'sdk' })
    expectCode(() => getAdapter('aider').buildCommand(spec), 'unsupported-backend')
    expect(existsSync(spec.workdir)).toBe(false)
  })

  test('registry parseOutput validates the selector before parsing', () => {
    const outcome = { exitCode: 0, durationSeconds: 0, stdout: '', stderr: '', timedOut: false }
    expectCode(() => parseOutput(specFor('claude-code', { backend: 'rpc' }), outcome), 'unsupported-backend')
    expectCode(() => parseOutput(specFor('pi', { permissionPolicy: 'bypass' }), outcome), 'unsupported-capability')
  })

  test('public dispatch rejects unsupported selections before a custom builder runs', () => {
    const entry = new URL('../src/index.ts', import.meta.url).pathname
    const result = spawnSync(process.execPath, ['--eval', `
      import { register, buildCommand, run, runAsync, HarnessError } from ${JSON.stringify(entry)};
      register('custom', {
        name: 'custom', instructionsFilename: '', defaultModel: 'm',
        buildCommand() { throw new Error('builder must not be called'); },
        parseOutput() { throw new Error('parser must not be called'); },
      });
      for (const dispatch of [buildCommand, run, runAsync]) {
        try {
          await dispatch({ harness: 'custom', backend: 'sdk', prompt: 'x', workdir: '.' });
          throw new Error('unsupported backend accepted');
        } catch (error) {
          if (!(error instanceof HarnessError) || error.code !== 'unsupported-backend') throw error;
        }
      }
      console.log('rejected without invoking custom adapter');
    `], { encoding: 'utf8' })
    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe('rejected without invoking custom adapter')
  })
})

describe('native options', () => {
  test('claude-code effort is emitted after the model flag', () => {
    const built = buildCommand(specFor('claude-code', { model: 'opus', nativeOptions: { kind: 'claude-code', effort: 'high' } }))
    const at = built.args.indexOf('--effort')
    expect(at).toBeGreaterThan(built.args.indexOf('--model'))
    expect(built.args[at + 1]).toBe('high')
    expect(built.args.slice(at + 2)).toEqual(['--output-format', 'json', '--append-system-prompt', 'be careful\n'])
  })

  test('claude-code kind without effort emits nothing extra', () => {
    const plain = buildCommand(specFor('claude-code'))
    const withKind = buildCommand(specFor('claude-code', { nativeOptions: { kind: 'claude-code' } }))
    expect(withKind.args).toEqual(plain.args)
  })

  test('codex sandbox is emitted before the positional prompt', () => {
    const built = buildCommand(specFor('codex', { nativeOptions: { kind: 'codex', sandbox: 'workspace-write' } }))
    const at = built.args.indexOf('--sandbox')
    expect(built.args[at + 1]).toBe('workspace-write')
    expect(at).toBeLessThan(built.args.indexOf('do the thing'))
    expect(built.args).not.toContain('--dangerously-bypass-approvals-and-sandbox')
  })

  test('codex sandbox plus bypass is a conflict, not an override', () => {
    const spec = specFor('codex', { permissionPolicy: 'bypass', nativeOptions: { kind: 'codex', sandbox: 'read-only' } })
    expectCode(() => buildCommand(spec), 'invalid-options')
    expect(existsSync(spec.workdir)).toBe(false)
  })

  test('codex bypass without sandbox still works', () => {
    const built = buildCommand(specFor('codex', { permissionPolicy: 'bypass', nativeOptions: { kind: 'codex' } }))
    expect(built.args).toContain('--dangerously-bypass-approvals-and-sandbox')
    expect(built.args).not.toContain('--sandbox')
  })

  test('kind must match the harness', () => {
    expectCode(() => buildCommand(specFor('codex', { nativeOptions: { kind: 'claude-code', effort: 'low' } })), 'invalid-options')
    expectCode(() => buildCommand(specFor('claude-code', { nativeOptions: { kind: 'codex', sandbox: 'read-only' } })), 'invalid-options')
    const spec = specFor('gemini', { nativeOptions: { kind: 'claude-code' } })
    expectCode(() => buildCommand(spec), 'invalid-options')
    expect(existsSync(spec.workdir)).toBe(false)
  })

  test('bad kind, unknown field, and bad enum value are invalid-options', () => {
    const bad = (nativeOptions: unknown, harness = 'claude-code'): RunSpec => untyped({ ...specFor(harness), nativeOptions })
    expectCode(() => buildCommand(bad({ kind: 'gemini' })), 'invalid-options')
    expectCode(() => buildCommand(bad('claude-code')), 'invalid-options')
    expectCode(() => buildCommand(bad({ kind: 'claude-code', sandbox: 'read-only' })), 'invalid-options')
    expectCode(() => buildCommand(bad({ kind: 'claude-code', sandbox: undefined })), 'invalid-options')
    expectCode(() => buildCommand(bad(Object.assign(Object.create({ effort: 'invalid' }), { kind: 'claude-code' }))), 'invalid-options')
    expectCode(() => buildCommand(bad({ kind: 'claude-code', effort: 'extreme' })), 'invalid-options')
    expectCode(() => buildCommand(bad({ kind: 'codex', sandbox: 'none' }, 'codex')), 'invalid-options')
  })
})

describe('getCapabilities', () => {
  test('claude-code and codex report bypass plus their native kind', () => {
    expect(getCapabilities('claude-code')).toEqual({
      backend: 'cli',
      permissionPolicies: ['upstream', 'bypass'],
      nativeOptions: 'claude-code',
      streaming: false,
      cancellation: false,
      sessions: false,
    })
    expect(getCapabilities('codex', 'cli').nativeOptions).toBe('codex')
  })

  test('bypass appears exactly for the eight mapped adapters', () => {
    for (const name of SHIPPED) {
      const caps = getCapabilities(name)
      expect(caps.permissionPolicies[0]).toBe('upstream')
      expect(caps.permissionPolicies.includes('bypass')).toBe(name in BYPASS_FLAGS)
      if (name !== 'claude-code' && name !== 'codex') expect(caps.nativeOptions).toBeNull()
      expect(caps.streaming).toBe(false)
      expect(caps.cancellation).toBe(false)
      expect(caps.sessions).toBe(false)
    }
  })

  test('unsupported backend rejects instead of reporting fake capabilities', () => {
    expectCode(() => getCapabilities('codex', 'rpc'), 'unsupported-backend')
    expectCode(() => getCapabilities('codex', 'sdk'), 'unsupported-backend')
    const rawBackend: string = 'nope'
    expectCode(() => getCapabilities('codex', rawBackend as Backend), 'invalid-options')
  })

  test('unknown harness is unknown-harness', () => {
    expectCode(() => getCapabilities('nope'), 'unknown-harness')
  })
})

describe('registry', () => {

  test('getAdapter on unknown name is unknown-harness', () => {
    expectCode(() => getAdapter('nope'), 'unknown-harness')
  })

  test('re-registering the same object is a no-op; a different object is duplicate-adapter', () => {
    const adapter = getAdapter('claude-code')
    register('claude-code', adapter)
    register('claude-code', adapter)
    expect(getAdapter('claude-code')).toBe(adapter)
    expectCode(() => register('claude-code', { ...adapter }), 'duplicate-adapter')
  })

})

describe('model selection', () => {
  test('undefined and empty string both fall back to the default', () => {
    const codex = getAdapter('codex')
    const spec = specFor('codex')
    const fromUndefined = buildCommand(spec)
    const fromEmpty = buildCommand({ ...spec, model: '' })
    expect(fromUndefined.args).toContain(codex.defaultModel)
    expect(fromEmpty.args).toEqual(fromUndefined.args)
  })

  test('surrounding whitespace is trimmed after selection', () => {
    expect(validateRunSpec(getAdapter('codex'), specFor('codex', { model: '  gpt-5.4  ' })).model).toBe('gpt-5.4')
    expect(validateRunSpec(getAdapter('pi'), specFor('pi', { model: ' gpt-5.4 ', modelNoResolve: true })).model).toBe('gpt-5.4')
  })
})

test.each(['malformed', { input: {}, candidates: 7 }])('Gemini malformed usage is unknown (%j)', tokens => {
  const spec = specFor('gemini')
  const blob = JSON.stringify({ stats: { models: { 'gemini-2.5-pro': { tokens } } } })
  const parsed = parseOutput(spec, { stdout: blob, stderr: '', exitCode: 0, durationSeconds: 0, timedOut: false })
  expect([parsed.tokensIn, parsed.tokensOut, parsed.costUsd]).toEqual([null, null, null])
  mkdirSync(spec.workdir, { recursive: true })
  const log = join(spec.workdir, 'session.json')
  writeFileSync(log, blob)
  const telemetry = getAdapter('gemini').parseSessionLog!(log)
  expect([telemetry.tokensIn, telemetry.tokensOut, telemetry.costUsd]).toEqual([null, null, null])
})
