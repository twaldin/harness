import { register } from '../registry.js'
import { HarnessError, finalizeCommand, validateRunSpec } from '../base.js'
import type { Adapter, BuildCommand, ParsedOutput, RunSpec, SubprocOutcome } from '../base.js'

// Amp `--executor local --stream-json --execute=<prompt>` writes one JSON
// object per stdout line (verified against amp 0.0.1788868861-g921679):
// `system` init, `assistant`/`user` messages and a final `result` whose
// `usage` may carry run totals. Amp owns mode-to-model routing and has no CLI
// model flag or documented approval bypass. Events are preserved verbatim;
// only the token totals are lifted.

type JsonObject = Record<string, unknown>

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseRecords(stdout: string): JsonObject[] {
  const records: JsonObject[] = []
  // A complete final line needs no trailing newline; a truncated one fails to
  // parse and is dropped like any other malformed line.
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
 * Per field: the last top-level `result` event's usage wins when it carries a
 * valid count (a nonnegative safe integer); otherwise the valid top-level
 * assistant message usages are summed. Sub-agent events carry a non-null
 * `parent_tool_use_id` and are skipped. The two sources are never combined.
 * Cache fields stay raw, matching claude-code.
 */
function aggregateTokens(records: readonly JsonObject[], field: 'input_tokens' | 'output_tokens'): number | null {
  let fromResult: number | null = null
  let assistantSum: number | null = null
  for (const record of records) {
    if ((record['parent_tool_use_id'] ?? null) !== null) continue
    if (record['type'] === 'result') {
      const usage = record['usage']
      const count = isJsonObject(usage) ? usage[field] : undefined
      fromResult = typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 ? count : null
    } else if (record['type'] === 'assistant') {
      const message = record['message']
      const usage = isJsonObject(message) ? message['usage'] : undefined
      const count = isJsonObject(usage) ? usage[field] : undefined
      if (typeof count === 'number' && Number.isSafeInteger(count) && count >= 0) assistantSum = (assistantSum ?? 0) + count
    }
  }
  return fromResult ?? (Number.isSafeInteger(assistantSum) ? assistantSum : null)
}

const ampAdapter: Adapter = {
  name: 'amp',
  instructionsFilename: 'AGENTS.md',
  defaultModel: '', // Amp owns mode-to-model routing; no CLI model flag.
  nativeOptionsKind: 'amp',
  configFileFlag: '--settings-file',

  buildCommand(spec: RunSpec): BuildCommand {
    const validated = validateRunSpec(this, spec)
    if (validated.model) {
      throw new HarnessError(
        'amp has no model flag; leave model unset and select a mode with AmpOptions',
        'unsupported-capability',
      )
    }
    if (!spec.prompt) {
      throw new HarnessError('amp requires a non-empty prompt for execute mode; stdin only supplements it', 'invalid-options')
    }
    const { nativeArgs, configArgs } = validated
    // Equals form keeps leading '-' prompts from being parsed as flags.
    const args = ['--executor', 'local', '--stream-json', ...nativeArgs, `--execute=${spec.prompt}`, ...configArgs]
    return finalizeCommand(this, spec, validated, { cmd: 'amp', args, model: null })
  },

  parseOutput(_spec: RunSpec, outcome: SubprocOutcome): ParsedOutput {
    const records = parseRecords(outcome.stdout)
    return {
      costUsd: null,
      tokensIn: aggregateTokens(records, 'input_tokens'),
      tokensOut: aggregateTokens(records, 'output_tokens'),
      raw: records.length === 0 ? null : records,
    }
  },
}

ampAdapter.installMeta = {
  packageManager: 'binary',
  // The official installer is a shell pipeline (curl | bash), not an argv;
  // empty means "not installable via this metadata".
  installCommand: [],
  updateCommand: ['amp', 'update'],
  versionCommand: ['amp', 'version'],
  platforms: ['darwin', 'linux'],
}

register('amp', ampAdapter)
