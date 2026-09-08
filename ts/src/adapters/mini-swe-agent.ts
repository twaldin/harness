import { register } from '../registry.js'
import { HarnessError, finalizeCommand, validateRunSpec } from '../base.js'
import type { Adapter, BuildCommand, ParsedOutput, RunSpec, SubprocOutcome } from '../base.js'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { stripAnsi } from '../util.js'

// Native mini-swe-agent (`mini`, verified against 2.4.6), distinct from the
// `swe-agent` adapter that drives the agentelo wrapper script.
//
// `mini --task=<text> --exit-immediately --output <file>` runs one task to
// completion and writes the trajectory JSON to a fixed artifact under the
// workdir; Typer's readable-path validation rejects /dev/stdout, so the
// artifact is the only channel for metrics. Stdout/stderr are Rich console
// text (streamed as plain chunks, not structured events).
//
// Permissions are left to upstream: with the default closed stdin, every
// confirmation prompt fails with EOF and nothing is approved implicitly.
// Unattended runs need `permissionPolicy: 'bypass'` (`--yolo`) or a caller
// config that whitelists commands. `--config` replaces the whole upstream
// config, so environment selection there is the caller's responsibility; only
// the default local environment is qualified. That environment starts each
// shell command with `start_new_session=True`, so an in-flight shell command
// escapes the harness's process-group cancellation; the harness owns only its
// own group and adds no global cleanup.

const TRAJECTORY_DIR = '.harness'
const TRAJECTORY_FILE = 'mini-swe-agent.traj.json'
const TRAJECTORY_FORMAT = 'mini-swe-agent-1.1'
/** Set by upstream's first-run wizard; `true` skips the wizard and nothing else. */
const CONFIGURED_ENV = 'MSWEA_CONFIGURED'

type JsonObject = Record<string, unknown>

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Whether stdout carries upstream's completion line `Saved trajectory to
 * '<path>'`, printed only after the trajectory file is completely written.
 * Rich wraps long lines, so ANSI is stripped and every CR/LF removed before
 * the substring test. Without the marker the artifact may be stale or
 * partial (interrupted run, provider exception) and is never read.
 */
function hasSavedMarker(stdout: string, trajFile: string): boolean {
  return stripAnsi(stdout).replace(/[\r\n]/g, '').includes(`Saved trajectory to '${trajFile}'`)
}

/** Strict UTF-8 JSON read: missing, undecodable or malformed content is not an artifact. */
function readTrajectory(trajFile: string): JsonObject | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(trajFile)))
  } catch {
    return null
  }
  if (!isJsonObject(parsed) || parsed['trajectory_format'] !== TRAJECTORY_FORMAT) return null
  return parsed
}

/** Sum one usage dimension over assistant turns; `null` unless at least one message carried a valid count. */
function sumTokens(messages: unknown, primary: string, fallback: string): number | null {
  if (!Array.isArray(messages)) return null
  let total: number | null = null
  for (const message of messages) {
    // Only assistant turns carry a priced provider response; user/tool/exit
    // messages never contribute usage.
    if (!isJsonObject(message) || message['role'] !== 'assistant') continue
    const extra = message['extra']
    const response = isJsonObject(extra) ? extra['response'] : undefined
    const usage = isJsonObject(response) ? response['usage'] : undefined
    if (!isJsonObject(usage)) continue
    // The fallback key applies only when the primary is absent or null; a
    // present-but-invalid primary is dropped, never substituted.
    const value = usage[primary] ?? usage[fallback]
    // Booleans are never counts; sums must stay exact in both language APIs.
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) continue
    total = (total ?? 0) + value
  }
  return total !== null && Number.isSafeInteger(total) ? total : null
}

const miniSweAgentAdapter: Adapter = {
  name: 'mini-swe-agent',
  instructionsFilename: '', // No instructions file: `instructions` is prepended to the task text.
  defaultModel: '', // Leave model selection to the caller's mini-swe-agent config.
  permissionBypassArgs: ['--yolo'],
  configHomeEnv: 'MSWEA_GLOBAL_CONFIG_DIR',
  configFileFlag: '--config',

  buildCommand(spec: RunSpec): BuildCommand {
    const validated = validateRunSpec(this, spec)
    if (!spec.prompt) {
      throw new HarnessError('mini-swe-agent requires a non-empty prompt for non-interactive mode', 'invalid-options')
    }
    // Caller env layers over the adapter's in the finalizer, so an empty value
    // would silently re-enable the interactive config wizard.
    if (spec.env?.[CONFIGURED_ENV] === '') {
      throw new HarnessError(`env.${CONFIGURED_ENV} must be non-empty; mini-swe-agent opens its config wizard otherwise`, 'invalid-options')
    }
    const { model, workdir, permissionArgs, configArgs } = validated
    const prompt = spec.instructions ? `${spec.instructions.trimEnd()}\n\n---\n\n${spec.prompt}` : spec.prompt
    // Equals form keeps leading '-' prompts from being parsed as flags.
    const args = [`--task=${prompt}`, '--exit-immediately', '--output', join(workdir, TRAJECTORY_DIR, TRAJECTORY_FILE), ...permissionArgs, ...configArgs]
    if (model) args.push('--model', model)
    return finalizeCommand(this, spec, validated, {
      cmd: 'mini',
      args,
      env: { [CONFIGURED_ENV]: 'true' },
      directories: [TRAJECTORY_DIR],
      model: spec.model || null,
    })
  },

  parseOutput(spec: RunSpec, outcome: SubprocOutcome): ParsedOutput {
    const trajFile = join(resolve(spec.workdir), TRAJECTORY_DIR, TRAJECTORY_FILE)
    const trajectory = hasSavedMarker(outcome.stdout, trajFile) ? readTrajectory(trajFile) : null
    if (trajectory === null) return { costUsd: null, tokensIn: null, tokensOut: null, raw: null }
    // `info.exit_status` in `raw` is the semantic outcome (Submitted,
    // LimitsExceeded, ...); a zero process exit does not imply Submitted.
    const info = trajectory['info']
    const modelStats = isJsonObject(info) ? info['model_stats'] : undefined
    const cost = isJsonObject(modelStats) ? modelStats['instance_cost'] : undefined
    const messages = trajectory['messages']
    return {
      costUsd: typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : null,
      tokensIn: sumTokens(messages, 'prompt_tokens', 'input_tokens'),
      tokensOut: sumTokens(messages, 'completion_tokens', 'output_tokens'),
      raw: trajectory,
    }
  },
}

miniSweAgentAdapter.installMeta = {
  packageManager: 'pip', // PyPI distribution `mini-swe-agent`, installed through uv's tool manager.
  installCommand: ['uv', 'tool', 'install', 'mini-swe-agent'],
  updateCommand: ['uv', 'tool', 'upgrade', 'mini-swe-agent'],
  // `mini --version` does not exist; read the installed distribution metadata.
  versionCommand: ['python3', '-c', "from importlib.metadata import version; print(version('mini-swe-agent'))"],
}

register('mini-swe-agent', miniSweAgentAdapter)
