import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, relative } from 'path'
import { setTimeout as delay } from 'node:timers/promises'
import { spawnSync } from 'node:child_process'
import { HarnessError } from '../src/base.js'
import type { Adapter, BuildCommand, ErrorCode, RunSpec } from '../src/base.js'
import { cleanupCommand, prepareCommand } from '../src/instructions.js'
import { buildCommand, getAdapter, register, run, runAsync } from '../src/registry.js'
import '../src/adapters/index.js'

const LOCK = '.harness-run.lock'
const ROOT = mkdtempSync(join(tmpdir(), 'harness-ts-launch-'))
const FAKE = join(ROOT, 'fake-cli')
let counter = 0

/**
 * The fake CLI records what a real CLI would observe: its cwd, argv, the
 * synthetic env we care about, whether the lease is visible and the
 * instructions files present in the cwd. It prints `{}` so JSON parsers
 * see an empty payload.
 */
beforeAll(() => {
  writeFileSync(FAKE, `#!/bin/sh
{
  printf 'CWD=%s\\n' "$(pwd -P)"
  for a in "$@"; do printf 'ARG=%s\\n' "$a"; done
  printf 'CLAUDE_CONFIG_DIR=%s\\n' "\${CLAUDE_CONFIG_DIR-<unset>}"
  printf 'HARNESS_PROBE=%s\\n' "\${HARNESS_PROBE-<unset>}"
  printf 'KILO_CONFIG_CONTENT=%s\\n' "\${KILO_CONFIG_CONTENT-<unset>}"
  if [ -d ${LOCK} ]; then printf 'LOCK=present\\n'; else printf 'LOCK=absent\\n'; fi
  for f in CLAUDE.md AGENTS.md CONTINUE.md .harness-aider-instructions.md; do
    if [ -f "$f" ]; then printf 'FILE %s=%s\\n' "$f" "$(cat "$f")"; fi
  done
} > "$HARNESS_RECORD"
printf '{}'
`, { mode: 0o755 })
})

afterAll(() => {
  try {
    rmSync(ROOT, { recursive: true, force: true })
  } catch {}
})

function tmpDir(): string {
  const dir = join(ROOT, `wd-${counter++}`)
  mkdirSync(dir)
  return dir
}

/** Spec wired to the recording fake; `record` is where the fake wrote what it saw. */
function recorded(harness: string, workdir: string, extra: Partial<RunSpec> = {}): { spec: RunSpec; record: () => Record<string, string[]> } {
  const recordPath = join(ROOT, `record-${counter++}.txt`)
  const spec: RunSpec = {
    harness,
    prompt: 'do the thing',
    workdir,
    executable: FAKE,
    ...extra,
    env: { HARNESS_RECORD: recordPath, ...(extra.env ?? {}) },
  }
  return {
    spec,
    record: () => {
      const seen: Record<string, string[]> = {}
      for (const line of readFileSync(recordPath, 'utf-8').split('\n')) {
        const at = line.indexOf('=')
        if (at === -1) continue
        const key = line.slice(0, at)
        ;(seen[key] ??= []).push(line.slice(at + 1))
      }
      return seen
    },
  }
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

async function expectRejectCode(promise: Promise<unknown>, code: ErrorCode): Promise<HarnessError> {
  let caught: unknown
  try {
    await promise
  } catch (err) {
    caught = err
  }
  expect(caught).toBeInstanceOf(HarnessError)
  const err = caught as HarnessError
  expect(err.code).toBe(code)
  return err
}

describe('run configuration', () => {
  test('a relative workdir is resolved once, without changing the process cwd', async () => {
    const absolute = tmpDir()
    const rel = relative(process.cwd(), absolute)
    const cwdBefore = process.cwd()
    const { spec, record } = recorded('codex', rel, { instructions: 'be careful' })

    const built = buildCommand(spec)
    expect(built.cwd).toBe(absolute)
    expect(built.args[built.args.indexOf('-C') + 1]).toBe(absolute)
    expect(built.instructionsFile).toBe(join(absolute, 'AGENTS.md'))
    expect(getAdapter('codex').buildCommand(spec)).toEqual(built)

    const result = await runAsync(spec)
    expect(result.exitCode).toBe(0)
    expect(process.cwd()).toBe(cwdBefore)
    const seen = record()
    expect(seen['CWD']).toEqual([realpathSync(absolute)])
    expect(seen['ARG']).toContain(absolute)
    expect(seen['FILE AGENTS.md']).toEqual(['be careful'])
    expect(seen['LOCK']).toEqual(['present'])
    expect(existsSync(join(absolute, 'AGENTS.md'))).toBe(false)
    expect(existsSync(join(absolute, LOCK))).toBe(false)
  })

  test('configHome and configFile reach the CLI through the declared mapping; caller env wins over adapter env', async () => {
    const workdir = tmpDir()
    const home = join(ROOT, 'claude-home')
    const settings = join(ROOT, 'settings.json')
    const { spec, record } = recorded('claude-code', workdir, {
      configHome: home,
      configFile: settings,
      env: { HARNESS_PROBE: 'from-caller' },
    })
    const built = buildCommand(spec)
    expect(built.env['CLAUDE_CONFIG_DIR']).toBe(home)
    expect(built.env['HARNESS_PROBE']).toBe('from-caller')
    expect(built.args.slice(built.args.indexOf('--settings'))).toEqual(['--settings', settings])
    expect(spec.env).toEqual({ HARNESS_RECORD: spec.env!['HARNESS_RECORD']!, HARNESS_PROBE: 'from-caller' })

    const result = await run(spec)
    expect(result.model).toBe('sonnet')
    const seen = record()
    expect(seen['CLAUDE_CONFIG_DIR']).toEqual([home])
    expect(seen['HARNESS_PROBE']).toEqual(['from-caller'])
    expect(seen['ARG']).toContain(settings)
    // Never opened, copied or created.
    expect(existsSync(home)).toBe(false)
    expect(existsSync(settings)).toBe(false)
  })

  test('configHome conflicting with the same variable in spec.env is invalid-options; an equal value is fine', () => {
    const workdir = tmpDir()
    const home = join(ROOT, 'codex-home')
    expectCode(() => buildCommand({ harness: 'codex', prompt: 'x', workdir, configHome: home, env: { CODEX_HOME: '/elsewhere' } }), 'invalid-options')
    const built = buildCommand({ harness: 'codex', prompt: 'x', workdir, configHome: home, env: { CODEX_HOME: home } })
    expect(built.env['CODEX_HOME']).toBe(home)
    expect(readdirSync(workdir)).toEqual([])
  })

  test('undeclared overrides and malformed values reject before any work', () => {
    const workdir = tmpDir()
    expectCode(() => buildCommand({ harness: 'gemini', prompt: 'x', workdir, configHome: '/h' }), 'unsupported-capability')
    expectCode(() => buildCommand({ harness: 'gemini', prompt: 'x', workdir, configFile: '/f' }), 'unsupported-capability')
    expectCode(() => buildCommand({ harness: 'codex', prompt: 'x', workdir, configFile: '/f' }), 'unsupported-capability')
    expectCode(() => buildCommand({ harness: 'claude-code', prompt: 'x', workdir, configHome: 'relative/home' }), 'invalid-options')
    expectCode(() => buildCommand({ harness: 'claude-code', prompt: 'x', workdir, configFile: '' }), 'invalid-options')
    expectCode(() => buildCommand({ harness: 'claude-code', prompt: 'x', workdir, executable: 'bin/claude' }), 'invalid-options')
    expectCode(() => buildCommand({ harness: 'claude-code', prompt: 'x', workdir, executable: '' }), 'invalid-options')
    expectCode(() => buildCommand({ harness: 'claude-code', prompt: 'x', workdir, executable: 'cl\0aude' }), 'invalid-options')
    expectCode(() => buildCommand({ harness: 'claude-code', prompt: 'x', workdir: '' }), 'invalid-options')
    expect(buildCommand({ harness: 'claude-code', prompt: 'x', workdir, executable: 'claude-nightly' }).cmd).toBe('claude-nightly')
    expect(readdirSync(workdir)).toEqual([])
  })

  test('continue-cli delegates the model to a caller config file and refuses to drop an explicit one', async () => {
    const workdir = tmpDir()
    const config = join(ROOT, 'continue.yaml')
    const { spec, record } = recorded('continue-cli', workdir, { configFile: config, instructions: 'brief' })
    const built = buildCommand(spec)
    expect(built.args).toEqual(['-p', '--config', config, '--format', 'json', 'do the thing'])
    expect(built.model).toBeNull()

    const result = await runAsync(spec)
    expect(result.model).toBeNull()
    expect(record()['FILE CONTINUE.md']).toEqual(['brief'])

    expectCode(() => buildCommand({ ...spec, model: 'gpt-5.4' }), 'unsupported-capability')
    expect(buildCommand({ ...spec, model: '' }).model).toBeNull()

    const plain = buildCommand({ harness: 'continue-cli', prompt: 'x', workdir, model: 'gpt-5.4' })
    expect(plain.args).toEqual(['-p', 'x', '--model', 'gpt-5.4', '--json'])
    expect(plain.model).toBe('gpt-5.4')
  })

  test('continue-cli OpenAI-compatible env without a config file is unsupported and leaks no secret', () => {
    const workdir = tmpDir()
    const err = expectCode(
      () => buildCommand({ harness: 'continue-cli', prompt: 'x', workdir, env: { OPENAI_API_KEY: 'sk-secret-value' } }),
      'unsupported-capability',
    )
    expect(err.message).not.toContain('sk-secret-value')
    expect(err.message).toContain('configFile')
    expect(readdirSync(workdir)).toEqual([])
  })

  test('aider reads projected text instructions and keeps histories off the workdir', async () => {
    const workdir = tmpDir()
    const { spec, record } = recorded('aider', workdir, { instructions: 'aider rules', configFile: join(ROOT, 'aider.yml') })
    const built = buildCommand(spec)
    const instructions = join(workdir, '.harness-aider-instructions.md')
    expect(built.args.slice(0, 4)).toEqual(['--config', join(ROOT, 'aider.yml'), '--read', instructions])
    expect(built.args).not.toContain(join(workdir, '.agentelo-aider.yml'))
    await runAsync(spec)
    expect(record()['FILE .harness-aider-instructions.md']).toEqual(['aider rules'])
    expect(readdirSync(workdir)).toEqual([])
  })

  test('kilo passes a caller-selected KILO_CONFIG_CONTENT through untouched', async () => {
    const workdir = tmpDir()
    const generated = buildCommand({ harness: 'kilo', prompt: 'x', workdir })
    expect(JSON.parse(generated.env['KILO_CONFIG_CONTENT']!)).toEqual({ model: 'openai/gpt-5.4', small_model: 'openai/gpt-5.4', default_agent: 'build' })
    expect(generated.directories).toEqual([join(workdir, '.harness', 'kilo')])

    const { spec, record } = recorded('kilo', workdir, { env: { KILO_CONFIG_CONTENT: '{"custom":true}' } })
    expect(buildCommand(spec).env['KILO_CONFIG_CONTENT']).toBe('{"custom":true}')
    await runAsync(spec)
    expect(record()['KILO_CONFIG_CONTENT']).toEqual(['{"custom":true}'])

    const external = buildCommand({ harness: 'kilo', prompt: 'x', workdir, env: { KILO_DB: '/app/kilo.db' } })
    expect(external.env['KILO_DB']).toBe('/app/kilo.db')
    expect(external.directories).toEqual([])
    expect(existsSync(join(workdir, '.harness'))).toBe(false)
  })

  test('the spec and its env are snapshotted before the run awaits', async () => {
    const workdir = tmpDir()
    const { spec, record } = recorded('claude-code', workdir, { env: { HARNESS_PROBE: 'before' }, instructions: 'before' })
    const pending = runAsync(spec)
    spec.env!['HARNESS_PROBE'] = 'after'
    spec.prompt = 'after'
    await pending
    const seen = record()
    expect(seen['HARNESS_PROBE']).toEqual(['before'])
    expect(seen['ARG']).toContain('do the thing')
    expect(seen['FILE CLAUDE.md']).toEqual(['before'])
  })
})

describe('run lifecycle', () => {
  test('an existing instructions file is handed back with its bytes, mode and inode after the run', async () => {
    const workdir = tmpDir()
    const file = join(workdir, 'CLAUDE.md')
    writeFileSync(file, 'user CLAUDE.md\n', 'utf-8')
    chmodSync(file, 0o640)
    const before = statSync(file)
    const { spec, record } = recorded('claude-code', workdir, { instructions: 'run-scoped' })
    await runAsync(spec)
    expect(record()['FILE CLAUDE.md']).toEqual(['run-scoped'])
    const after = statSync(file)
    expect(readFileSync(file, 'utf-8')).toBe('user CLAUDE.md\n')
    expect(after.ino).toBe(before.ino)
    expect(after.mode).toBe(before.mode)
    expect(readdirSync(workdir)).toEqual(['CLAUDE.md'])
  })

  test('overlapping runs on one workdir reject; distinct workdirs run concurrently', async () => {
    const workdir = tmpDir()
    writeFileSync(join(workdir, 'AGENTS.md'), 'theirs\n', 'utf-8')
    const held = prepareCommand(buildCommand({ harness: 'codex', prompt: 'x', workdir }))
    const { spec } = recorded('codex', workdir, { instructions: 'mine' })
    await expectRejectCode(runAsync(spec), 'instruction-conflict')
    await expectRejectCode(run(spec), 'instruction-conflict')
    expect(readFileSync(join(workdir, 'AGENTS.md'), 'utf-8')).toBe('theirs\n')
    cleanupCommand(held)

    const a = recorded('codex', tmpDir(), { instructions: 'a' })
    const b = recorded('codex', tmpDir(), { instructions: 'b' })
    const [ra, rb] = await Promise.all([runAsync(a.spec), runAsync(b.spec)])
    expect(ra.exitCode).toBe(0)
    expect(rb.exitCode).toBe(0)
    expect(a.record()['FILE AGENTS.md']).toEqual(['a'])
    expect(b.record()['FILE AGENTS.md']).toEqual(['b'])
  })

  test('a parser exception is reported on the result; the workdir is restored and the lease released', async () => {
    const throwing: Adapter = {
      name: 'throwing-parser',
      instructionsFilename: 'AGENTS.md',
      defaultModel: 'm',
      buildCommand(spec: RunSpec): BuildCommand {
        return { cmd: 'never-used', args: [], cwd: spec.workdir, env: {}, instructionsFile: null }
      },
      parseOutput(): never {
        throw new Error('parser exploded')
      },
    }
    register('throwing-parser', throwing)
    const workdir = tmpDir()
    writeFileSync(join(workdir, 'AGENTS.md'), 'original\n', 'utf-8')
    const { spec, record } = recorded('throwing-parser', workdir, { instructions: 'projected' })

    for (const entrypoint of [runAsync, run]) {
      const result = await entrypoint(spec)
      expect(result.parseError).toBe('Error: parser exploded')
      expect([result.termination, result.exitCode, result.callbackError]).toEqual(['exited', 0, null])
      expect(result.stdout).toBe('{}')
      expect([result.costUsd, result.tokensIn, result.tokensOut, result.raw]).toEqual([null, null, null, null])
      expect(record()['FILE AGENTS.md']).toEqual(['projected'])
      expect(readFileSync(join(workdir, 'AGENTS.md'), 'utf-8')).toBe('original\n')
      expect(existsSync(join(workdir, LOCK))).toBe(false)
    }
  })

  test('public dispatch gives a minimal third-party adapter executable, cwd, env layering and projection', async () => {
    const minimal: Adapter = {
      name: 'minimal',
      instructionsFilename: 'AGENTS.md',
      defaultModel: 'm',
      buildCommand(spec: RunSpec): BuildCommand {
        return { cmd: 'minimal-cli', args: ['--flag'], cwd: spec.workdir, env: { HARNESS_PROBE: 'adapter' }, instructionsFile: null, directories: ['nested/artifacts'] }
      },
      parseOutput() {
        return { costUsd: null, tokensIn: null, tokensOut: null, raw: null }
      },
    }
    register('minimal', minimal)
    const absolute = tmpDir()
    const { spec, record } = recorded('minimal', relative(process.cwd(), absolute), { instructions: 'third party' })
    const built = buildCommand(spec)
    expect(built.cmd).toBe(FAKE)
    expect(built.cwd).toBe(absolute)
    expect(built.env['HARNESS_PROBE']).toBe('adapter')
    expect(built.model).toBe('m')
    expect(built.instructionsFile).toBe(join(absolute, 'AGENTS.md'))
    expect(built.instructionContent).toBe('third party')
    const prepared = prepareCommand(built)
    expect(existsSync(join(absolute, 'nested/artifacts'))).toBe(true)
    cleanupCommand(prepared)
    expect(existsSync(join(absolute, 'nested'))).toBe(false)

    await runAsync(spec)
    const seen = record()
    expect(seen['CWD']).toEqual([realpathSync(absolute)])
    expect(seen['ARG']).toEqual(['--flag'])
    expect(seen['FILE AGENTS.md']).toEqual(['third party'])
    expect(readdirSync(absolute)).toEqual([])
  })

  for (const entrypoint of [run, runAsync]) {
    test(`${entrypoint.name} restores original instructions after launch failure`, async () => {
      const workdir = tmpDir()
      const file = join(workdir, 'AGENTS.md')
      writeFileSync(file, 'original')
      const identity = statSync(file).ino
      const result = await entrypoint({
        harness: 'codex', prompt: 'x', workdir, instructions: 'projected',
        executable: join(workdir, 'nonexistent-agent'),
      })
      expect(result.termination).toBe('launch-failed')
      expect(readFileSync(file, 'utf-8')).toBe('original')
      expect(statSync(file).ino).toBe(identity)
      expect(existsSync(join(workdir, LOCK))).toBe(false)
    })

    test.skipIf(process.platform === 'win32')(`${entrypoint.name} retains instructions through cancelled child teardown`, async () => {
      // This real child handles an OS signal; fake timers cannot control its readiness or teardown.
      const workdir = tmpDir()
      const executable = join(ROOT, `cancellable-${counter++}`)
      writeFileSync(executable, `#!${process.execPath}
const fs = require('node:fs');
process.on('SIGTERM', () => {
  setTimeout(() => {
    fs.writeFileSync('teardown-observed', fs.readFileSync('AGENTS.md'));
    process.exit(0);
  }, 80);
});
fs.writeFileSync('ready', '');
setInterval(() => {}, 1000);
`, { mode: 0o700 })
      const file = join(workdir, 'AGENTS.md')
      writeFileSync(file, 'original')
      const identity = statSync(file).ino
      const cancellation = new AbortController()
      const invocation = entrypoint({
        harness: 'codex', prompt: 'x', workdir, instructions: 'projected',
        executable, cancel: cancellation.signal, timeoutSeconds: 5,
      })
      try {
        const deadline = Date.now() + 3000
        while (!existsSync(join(workdir, 'ready')) && Date.now() < deadline) {
          await delay(10)
        }
        expect(existsSync(join(workdir, 'ready'))).toBe(true)
        cancellation.abort()
        const result = await invocation
        expect(result.termination).toBe('cancelled')
        expect(readFileSync(join(workdir, 'teardown-observed'), 'utf-8')).toBe('projected')
        expect(readFileSync(file, 'utf-8')).toBe('original')
        expect(statSync(file).ino).toBe(identity)
        expect(existsSync(join(workdir, LOCK))).toBe(false)
      } finally {
        cancellation.abort()
        await invocation
      }
    })
  }
})

test('failed process teardown retains instructions and recovery backup', () => {
  for (const entrypoint of ['run', 'runAsync']) {
    const workdir = tmpDir()
    const result = spawnSync(process.execPath, ['-e', `
      import assert from 'node:assert/strict';
      import { mock } from 'bun:test';
      import { readFileSync, writeFileSync, existsSync } from 'node:fs';
      const workdir = ${JSON.stringify(workdir)};
      writeFileSync(workdir + '/AGENTS.md', 'original');
      const failure = Object.assign(new Error('synthetic process-group denial'), { code: 'EPERM' });
      const lifecyclePath = ${JSON.stringify(join(import.meta.dir, '../src/lifecycle.ts'))};
      const lifecycle = await import(lifecyclePath);
      mock.module(lifecyclePath, () => ({
        ...lifecycle,
        runLifecycle: async () => { throw failure; },
        runLifecycleSync: () => { throw failure; },
      }));
      // Import after fault injection; static imports would bind before the mock.
      const harness = await import(${JSON.stringify(join(import.meta.dir, '../src/index.ts'))});
      await assert.rejects(harness[${JSON.stringify(entrypoint)}]({
        harness: 'codex', prompt: 'x', workdir, instructions: 'projected',
        executable: '/nonexistent/synthetic-agent',
      }), error => error === failure);
      assert.equal(readFileSync(workdir + '/AGENTS.md', 'utf8'), 'projected');
      assert.equal(readFileSync(workdir + '/.harness-run.lock/original-AGENTS.md', 'utf8'), 'original');
      assert.equal(existsSync(workdir + '/.harness-run.lock'), true);
    `], { encoding: 'utf-8' })
    expect(result.status, result.stderr).toBe(0)
  }
})

test('prelaunch validation of run I/O options happens before the workdir is touched', async () => {
  const cases: Partial<RunSpec>[] = [
    { timeoutSeconds: -1 },
    { inactivityTimeoutSeconds: 0 },
    { maxOutputBytes: 1.5 },
    { stdin: untypedValue(42) },
    { onOutput: untypedValue('not a function') },
  ]
  for (const entrypoint of [run, runAsync]) {
    for (const invalidIO of cases) {
      const workdir = tmpDir()
      const file = join(workdir, 'AGENTS.md')
      writeFileSync(file, 'original')
      const identity = statSync(file).ino
      await expectRejectCode(entrypoint({
        harness: 'codex', prompt: 'x', workdir, instructions: 'projected', ...invalidIO,
      }), 'invalid-options')
      expect(readFileSync(file, 'utf-8')).toBe('original')
      expect(statSync(file).ino).toBe(identity)
      expect(existsSync(join(workdir, LOCK))).toBe(false)
    }
  }
})

/** A value as a JS caller would hand it over: the type system never saw it. */
function untypedValue<T>(value: unknown): T {
  return value as T
}
