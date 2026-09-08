import { register } from '../registry.js'
import { HarnessError, finalizeCommand, validateRunSpec } from '../base.js'
import type { Adapter, BuildCommand, ParsedOutput, RunSpec, SubprocOutcome } from '../base.js'

// Auggie `--print --output-format json` (verified against @augmentcode/auggie
// 0.36.0) writes a single compact JSON object per completed agent loop, not
// incremental events: `type: "result"` with `result`, `is_error`, `subtype`
// (success / error_during_execution / error_max_turns / empty_completion),
// `session_id`, `num_turns` and optional `request_id` / `billing` /
// `retry_stats`. `--show-cost` adds `billing` only when the account permits;
// its `usage_unit` is `usd` or `credits`, so `total_cost` is only lifted as a
// USD figure when the unit says so. Tokens are never reported. Every complete
// JSON object line is preserved verbatim, in order.

type JsonObject = Record<string, unknown>

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseRecords(stdout: string): JsonObject[] {
  const records: JsonObject[] = []
  // A complete final line needs no trailing newline; a truncated one fails to
  // parse and is dropped like any other malformed line. JSON.parse already
  // rejects the non-standard NaN/Infinity constants.
  for (const line of stdout.split('\n')) {
    const s = line.trim()
    if (!s) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(s)
    } catch {
      continue
    }
    if (isJsonObject(parsed)) records.push(parsed)
  }
  return records
}

/**
 * The last `result` record decides the cost on its own: a `billing` block
 * with `usage_unit` exactly `usd` and a finite nonnegative numeric
 * `total_cost` is reported; credits, missing or malformed billing yield null
 * with no fallback to earlier records.
 */
function extractCostUsd(records: readonly JsonObject[]): number | null {
  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i]!
    if (record['type'] !== 'result') continue
    const billing = record['billing']
    if (!isJsonObject(billing) || billing['usage_unit'] !== 'usd') return null
    const total = billing['total_cost']
    return typeof total === 'number' && Number.isFinite(total) && total >= 0 ? total : null
  }
  return null
}

const auggieAdapter: Adapter = {
  name: 'auggie',
  instructionsFilename: 'AGENTS.md',
  defaultModel: '', // Leave model selection to the caller's Augment config.

  buildCommand(spec: RunSpec): BuildCommand {
    const validated = validateRunSpec(this, spec)
    if (!spec.prompt) {
      throw new HarnessError('auggie requires a non-empty prompt for print mode', 'invalid-options')
    }
    const { model, workdir } = validated
    const args = ['--print', '--output-format', 'json', '--show-cost', '--workspace-root', workdir]
    if (model) args.push('--model', model)
    // Equals form keeps leading '-' prompts from being parsed as flags.
    args.push(`--instruction=${spec.prompt}`)
    return finalizeCommand(this, spec, validated, {
      cmd: 'auggie',
      args,
      // Caller `spec.env` layers over this in the finalizer, so an explicit value wins.
      env: { AUGMENT_DISABLE_AUTO_UPDATE: '1' },
      model: spec.model || null,
    })
  },

  parseOutput(_spec: RunSpec, outcome: SubprocOutcome): ParsedOutput {
    const records = parseRecords(outcome.stdout)
    return {
      costUsd: extractCostUsd(records),
      tokensIn: null,
      tokensOut: null,
      raw: records.length === 0 ? null : records,
    }
  },
}

auggieAdapter.installMeta = {
  packageManager: 'npm',
  installCommand: ['npm', 'install', '-g', '@augmentcode/auggie'],
  updateCommand: ['npm', 'install', '-g', '@augmentcode/auggie@latest'],
  versionCommand: ['auggie', '--version'],
  platforms: ['darwin', 'linux'],
}

register('auggie', auggieAdapter)
