import type { Adapter, Backend, BuildCommand, Capabilities, ParsedOutput, RunResult, RunSpec, SubprocOutcome } from './base.js'
import { HarnessError, finalizeCommand, resolveBackend, validateRunSpec } from './base.js'
import { cleanupCommand, prepareCommand } from './instructions.js'
import { describeError, prepareLaunch, runLifecycle } from './lifecycle.js'

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
    configHomeEnv: adapter.configHomeEnv ?? null,
    configFileFlag: adapter.configFileFlag ?? null,
    streaming: true,
    cancellation: true,
    sessions: false,
  }
}

/**
 * Validate, dispatch, and pass the adapter's command back through the shared
 * finalizer. Idempotent for built-in adapters; it gives minimal third-party
 * adapters the same executable/config-home/env layering and absolute cwd.
 */
export function buildCommand(spec: RunSpec): BuildCommand {
  const adapter = getAdapter(spec.harness)
  const validated = validateRunSpec(adapter, spec)
  return finalizeCommand(adapter, spec, validated, adapter.buildCommand(spec))
}

export function parseOutput(spec: RunSpec, outcome: SubprocOutcome): ParsedOutput {
  const adapter = getAdapter(spec.harness)
  validateRunSpec(adapter, spec)
  return adapter.parseOutput(spec, outcome)
}

/**
 * Caller-owned spec and env are copied before command planning and execution.
 * Run I/O options are validated before the workdir is touched, so a bad
 * option never leaves a lease behind. A parser exception becomes
 * `parseError` with null metrics; the process outcome is kept.
 */
async function execute(spec: RunSpec): Promise<RunResult> {
  const frozen = spec.env === undefined ? { ...spec } : { ...spec, env: { ...spec.env } }
  const adapter = getAdapter(frozen.harness)
  const built = buildCommand(frozen)
  const request = prepareLaunch([built.cmd, ...built.args], {
    cwd: built.cwd,
    timeoutSeconds: frozen.timeoutSeconds,
    inactivityTimeoutSeconds: frozen.inactivityTimeoutSeconds,
    maxOutputBytes: frozen.maxOutputBytes,
    stdin: frozen.stdin,
    onOutput: frozen.onOutput,
    extraEnv: built.env,
    cancel: frozen.cancel,
    gracefulSignal: built.gracefulSignal,
  })
  const prepared = prepareCommand(built)
  let cleanupSafe = false
  try {
    // Only a resolved outcome proves the group is stopped; a rejection here is a teardown failure.
    const outcome = await runLifecycle(request, frozen.cancel, undefined, frozen.onOutput)
    cleanupSafe = true
    let parsed: ParsedOutput = { costUsd: null, tokensIn: null, tokensOut: null, raw: null }
    let parseError: string | null = null
    try {
      parsed = adapter.parseOutput(frozen, outcome)
    } catch (error) {
      parseError = describeError(error)
    }
    return {
      harness: frozen.harness,
      model: built.model === undefined ? frozen.model || adapter.defaultModel : built.model,
      exitCode: outcome.exitCode,
      durationSeconds: outcome.durationSeconds,
      stdout: outcome.stdout,
      stderr: outcome.stderr,
      timedOut: outcome.timedOut,
      termination: outcome.termination,
      signal: outcome.signal,
      launchError: outcome.launchError,
      stdoutBytes: outcome.stdoutBytes,
      stderrBytes: outcome.stderrBytes,
      stdoutTruncated: outcome.stdoutTruncated,
      stderrTruncated: outcome.stderrTruncated,
      callbackError: outcome.callbackError,
      timeoutKind: outcome.timeoutKind,
      parseError,
      costUsd: parsed.costUsd,
      tokensIn: parsed.tokensIn,
      tokensOut: parsed.tokensOut,
      raw: parsed.raw,
    }
  } finally {
    if (cleanupSafe) cleanupCommand(prepared)
  }
}

/**
 * Full headless invocation. Both entry points execute in-process on the
 * async engine (no event-loop blocking), so `spec.cancel` can abort either.
 */
export function run(spec: RunSpec): Promise<RunResult> {
  return execute(spec)
}

export function runAsync(spec: RunSpec): Promise<RunResult> {
  return execute(spec)
}
