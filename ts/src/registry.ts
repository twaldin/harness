import type { Adapter, BuildCommand, ParsedOutput, RunResult, RunSpec, SubprocOutcome } from './base.js'
import { HarnessError } from './base.js'
import { runSubprocess, runSubprocessAsync } from './subproc.js'

const registry = new Map<string, Adapter>()

export function register(name: string, adapter: Adapter): void {
  if (registry.has(name)) {
    throw new HarnessError(`Duplicate adapter registration: "${name}"`)
  }
  registry.set(name, adapter)
}

export function listAdapters(): string[] {
  return Array.from(registry.keys()).sort((a, b) => a.localeCompare(b, 'en'))
}

export function getAdapter(name: string): Adapter {
  const adapter = registry.get(name)
  if (!adapter) {
    throw new HarnessError(`Unknown harness: "${name}". Available: ${listAdapters().join(', ')}`)
  }
  return adapter
}

export function buildCommand(spec: RunSpec): BuildCommand {
  return getAdapter(spec.harness).buildCommand(spec)
}

export function parseOutput(spec: RunSpec, outcome: SubprocOutcome): ParsedOutput {
  return getAdapter(spec.harness).parseOutput(spec, outcome)
}

export async function run(spec: RunSpec): Promise<RunResult> {
  const adapter = getAdapter(spec.harness)
  const built = adapter.buildCommand(spec)
  const outcome = runSubprocess([built.cmd, ...built.args], {
    cwd: built.cwd,
    timeoutSeconds: spec.timeoutSeconds,
    extraEnv: { ...built.env, ...(spec.env ?? {}) },
  })
  const parsed = adapter.parseOutput(spec, outcome)
  return {
    harness: spec.harness,
    model: spec.model ?? adapter.defaultModel,
    exitCode: outcome.exitCode,
    durationSeconds: outcome.durationSeconds,
    stdout: outcome.stdout,
    stderr: outcome.stderr,
    timedOut: outcome.timedOut,
    costUsd: parsed.costUsd,
    tokensIn: parsed.tokensIn,
    tokensOut: parsed.tokensOut,
    raw: parsed.raw,
  }
}

export async function runAsync(spec: RunSpec): Promise<RunResult> {
  const adapter = getAdapter(spec.harness)
  const built = adapter.buildCommand(spec)
  const outcome = await runSubprocessAsync([built.cmd, ...built.args], {
    cwd: built.cwd,
    timeoutSeconds: spec.timeoutSeconds,
    extraEnv: { ...built.env, ...(spec.env ?? {}) },
  })
  const parsed = adapter.parseOutput(spec, outcome)
  return {
    harness: spec.harness,
    model: spec.model ?? adapter.defaultModel,
    exitCode: outcome.exitCode,
    durationSeconds: outcome.durationSeconds,
    stdout: outcome.stdout,
    stderr: outcome.stderr,
    timedOut: outcome.timedOut,
    costUsd: parsed.costUsd,
    tokensIn: parsed.tokensIn,
    tokensOut: parsed.tokensOut,
    raw: parsed.raw,
  }
}
