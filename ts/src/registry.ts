import type { Adapter, Backend, BuildCommand, Capabilities, ParsedOutput, RunResult, RunSpec, SubprocOutcome } from './base.js'
import { HarnessError, resolveBackend, validateRunSpec } from './base.js'
import { runSubprocess, runSubprocessAsync } from './subproc.js'

const registry = new Map<string, Adapter>()

/** Re-registering the same adapter object under the same name is a no-op; any other collision fails. */
export function register(name: string, adapter: Adapter): void {
  const existing = registry.get(name)
  if (existing === adapter) return
  if (existing) {
    throw new HarnessError(`Duplicate adapter registration: "${name}"`, 'duplicate-adapter')
  }
  registry.set(name, adapter)
}

export function listAdapters(): string[] {
  // Default sort is locale-independent UTF-16 code-unit order.
  return Array.from(registry.keys()).sort()
}

export function getAdapter(name: string): Adapter {
  const adapter = registry.get(name)
  if (!adapter) {
    throw new HarnessError(`Unknown harness: "${name}". Available: ${listAdapters().join(', ')}`, 'unknown-harness')
  }
  return adapter
}

/**
 * Static support report for a harness on a backend. Reports what the adapter
 * implements, not whether the CLI is installed or authenticated. Unsupported
 * backends reject rather than returning a fabricated capability set.
 */
export function getCapabilities(name: string, backend: Backend = 'cli'): Capabilities {
  const adapter = getAdapter(name)
  return {
    backend: resolveBackend(backend),
    permissionPolicies: adapter.permissionBypassArgs ? ['upstream', 'bypass'] : ['upstream'],
    nativeOptions: adapter.nativeOptionsKind ?? null,
    streaming: false,
    cancellation: false,
    sessions: false,
  }
}

export function buildCommand(spec: RunSpec): BuildCommand {
  const adapter = getAdapter(spec.harness)
  // Public dispatch also protects callers of minimal third-party adapters.
  validateRunSpec(adapter, spec)
  return adapter.buildCommand(spec)
}

export function parseOutput(spec: RunSpec, outcome: SubprocOutcome): ParsedOutput {
  const adapter = getAdapter(spec.harness)
  validateRunSpec(adapter, spec)
  return adapter.parseOutput(spec, outcome)
}

export async function run(spec: RunSpec): Promise<RunResult> {
  const adapter = getAdapter(spec.harness)
  validateRunSpec(adapter, spec)
  const built = adapter.buildCommand(spec)
  const outcome = runSubprocess([built.cmd, ...built.args], {
    cwd: built.cwd,
    timeoutSeconds: spec.timeoutSeconds,
    extraEnv: { ...built.env, ...(spec.env ?? {}) },
  })
  const parsed = adapter.parseOutput(spec, outcome)
  return {
    harness: spec.harness,
    model: spec.model || adapter.defaultModel,
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
  validateRunSpec(adapter, spec)
  const built = adapter.buildCommand(spec)
  const outcome = await runSubprocessAsync([built.cmd, ...built.args], {
    cwd: built.cwd,
    timeoutSeconds: spec.timeoutSeconds,
    extraEnv: { ...built.env, ...(spec.env ?? {}) },
  })
  const parsed = adapter.parseOutput(spec, outcome)
  return {
    harness: spec.harness,
    model: spec.model || adapter.defaultModel,
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
