import { register } from '../registry.js'
import { HarnessError, finalizeCommand, validateRunSpec } from '../base.js'
import type { Adapter, BuildCommand, ParsedOutput, RunSpec, SubprocOutcome } from '../base.js'

// Qualified against @qoder-ai/qodercli 1.1.47; see ADAPTER-MATRIX.md.
// Native positional prompts beginning '--' reject even after '--', so use
// the supported deprecated --prompt= form without suppressing its warning.
// Native USD is hardcoded zero and usage is unqualified; preserve it only in raw.

type JsonObject = Record<string, unknown>

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** `undefined` for anything JSON.parse rejects (which already includes NaN/Infinity). */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** Preserve a whole JSON object, or complete object lines after invalid JSON.
 * Valid arrays/scalars are not event streams. */
function parseRecords(stdout: string): JsonObject | JsonObject[] | null {
  const whole = parseJson(stdout.trim())
  if (whole !== undefined) return isJsonObject(whole) ? whole : null
  const records: JsonObject[] = []
  for (const line of stdout.split('\n')) {
    const s = line.trim()
    if (!s) continue
    const parsed = parseJson(s)
    if (isJsonObject(parsed)) records.push(parsed)
  }
  return records.length === 0 ? null : records
}

const qoderAdapter: Adapter = {
  name: 'qoder',
  instructionsFilename: 'AGENTS.md',
  defaultModel: '', // Leave model selection to the caller's Qoder config.
  nativeOptionsKind: 'qoder',
  configHomeEnv: 'QODER_CONFIG_DIR',

  buildCommand(spec: RunSpec): BuildCommand {
    const validated = validateRunSpec(this, spec)
    if (!spec.prompt) {
      // Without a prompt, print mode reads the query from stdin instead.
      throw new HarnessError('qoder requires a non-empty prompt for print mode', 'invalid-options')
    }
    const { model, nativeArgs } = validated
    const args = ['--print', '--output-format', 'json', '--input-format', 'text', '--max-turns', '20']
    if (model) args.push('--model', model)
    // No bypass or config-file slot: neither is mapped, so the validator rejects both before this point.
    args.push(...nativeArgs, `--prompt=${spec.prompt}`)
    return finalizeCommand(this, spec, validated, { cmd: 'qoder', args, model: spec.model || null })
  },

  parseOutput(_spec: RunSpec, outcome: SubprocOutcome): ParsedOutput {
    return { costUsd: null, tokensIn: null, tokensOut: null, raw: parseRecords(outcome.stdout) }
  },
}

qoderAdapter.installMeta = {
  packageManager: 'npm',
  installCommand: ['npm', 'install', '-g', '@qoder-ai/qodercli'],
  updateCommand: ['npm', 'install', '-g', '@qoder-ai/qodercli@latest'],
  versionCommand: ['qoder', '--version'],
  platforms: ['darwin', 'linux'],
}

register('qoder', qoderAdapter)
