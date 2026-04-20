import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { buildCommand, parseOutput } from '../src/registry.js'
import '../src/adapters/index.js'
import type { RunSpec, SubprocOutcome } from '../src/base.js'

const FIXTURES_DIR = join(import.meta.dir, '../../tests/fixtures')

interface FixtureSpec {
  harness: string
  prompt: string
  workdir: string
  model?: string
  instructions?: string
  timeoutSeconds?: number
  env?: Record<string, string>
}

interface FixtureExpectedCommand {
  cmd: string
  args: string[]
  instructionsFile: string | null
  note?: string
}

interface FixtureExpectedParsed {
  costUsd: number | null
  tokensIn: number | null
  tokensOut: number | null
  note?: string
}

interface FixtureSampleOutput {
  exitCode: number
  durationSeconds: number
  timedOut: boolean
  stdout: string
  stderr: string
}

interface TrajectoryFile {
  path: string
  content: unknown
}

interface Fixture {
  spec: FixtureSpec
  expectedCommand: FixtureExpectedCommand
  sampleOutput: FixtureSampleOutput
  expectedParsed: FixtureExpectedParsed
  trajectoryFile?: TrajectoryFile
}

function loadFixture(name: string): Fixture {
  const path = join(FIXTURES_DIR, `${name}.json`)
  return JSON.parse(require('fs').readFileSync(path, 'utf-8')) as Fixture
}

function fixtureSpecToRunSpec(f: FixtureSpec): RunSpec {
  return {
    harness: f.harness,
    prompt: f.prompt,
    workdir: f.workdir,
    model: f.model,
    instructions: f.instructions,
    timeoutSeconds: f.timeoutSeconds,
    env: f.env,
  }
}

const ADAPTER_NAMES = ['claude-code', 'codex', 'gemini', 'opencode', 'aider', 'swe-agent']

const WORKDIRS: string[] = []

function setupWorkdir(workdir: string): void {
  mkdirSync(workdir, { recursive: true })
  WORKDIRS.push(workdir)
}

afterAll(() => {
  for (const dir of WORKDIRS) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {}
  }
})

for (const adapterName of ADAPTER_NAMES) {
  describe(adapterName, () => {
    const fixture = loadFixture(adapterName)
    const spec = fixtureSpecToRunSpec(fixture.spec)

    beforeAll(() => {
      setupWorkdir(spec.workdir)
      // swe-agent: create fake wrapper if needed
      if (spec.env?.['SWE_WRAPPER']) {
        const wrapper = spec.env['SWE_WRAPPER']!
        mkdirSync(require('path').dirname(wrapper), { recursive: true })
        if (!existsSync(wrapper)) writeFileSync(wrapper, '#!/usr/bin/env python3\n', 'utf-8')
      }
    })

    test('buildCommand matches fixture', () => {
      const result = buildCommand(spec)
      expect(result.cmd).toBe(fixture.expectedCommand.cmd)
      expect(result.args).toEqual(fixture.expectedCommand.args)
      expect(result.instructionsFile).toBe(fixture.expectedCommand.instructionsFile)
    })

    test('parseOutput matches fixture', () => {
      // swe-agent: write trajectory file before parsing
      if (fixture.trajectoryFile) {
        const tf = fixture.trajectoryFile
        mkdirSync(require('path').dirname(tf.path), { recursive: true })
        writeFileSync(tf.path, JSON.stringify(tf.content), 'utf-8')
      }

      const outcome: SubprocOutcome = {
        exitCode: fixture.sampleOutput.exitCode,
        durationSeconds: fixture.sampleOutput.durationSeconds,
        timedOut: fixture.sampleOutput.timedOut,
        stdout: fixture.sampleOutput.stdout,
        stderr: fixture.sampleOutput.stderr,
      }

      const parsed = parseOutput(spec, outcome)
      const ep = fixture.expectedParsed

      if (ep.costUsd !== undefined && ep.note === undefined) {
        expect(parsed.costUsd).toBe(ep.costUsd)
      }
      if (ep.tokensIn !== undefined && ep.note === undefined) {
        expect(parsed.tokensIn).toBe(ep.tokensIn)
      }
      if (ep.tokensOut !== undefined && ep.note === undefined) {
        expect(parsed.tokensOut).toBe(ep.tokensOut)
      }
      if (ep.note) {
        // opencode: no DB available in CI → all null
        expect(parsed.costUsd).toBeNull()
        expect(parsed.tokensIn).toBeNull()
        expect(parsed.tokensOut).toBeNull()
      }
    })
  })
}
