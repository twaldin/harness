import { register } from '../registry.js'
import { writeInstructions } from '../subproc.js'
import type { Adapter, BuildCommand, ParsedOutput, RunSpec, SubprocOutcome } from '../base.js'
import { normalizeModelForHarness } from '../model-normalization.js'

function parseLastJsonObject(stdout: string): Record<string, unknown> | null {
  const blob = stdout.trim()
  if (blob) {
    try {
      const parsed = JSON.parse(blob) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      // fall back to JSONL parse
    }
  }

  const lines = stdout.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim()
    if (!line.startsWith('{')) continue
    try {
      const parsed = JSON.parse(line) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      continue
    }
  }
  return null
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function asInt(value: unknown): number | null {
  const n = asNumber(value)
  return n === null ? null : Math.trunc(n)
}

const factoryDroidAdapter: Adapter = {
  name: 'factory-droid',
  instructionsFilename: 'AGENTS.md',
  defaultModel: 'gpt-5.4',

  buildCommand(spec: RunSpec): BuildCommand {
    const model = normalizeModelForHarness(this.name, spec.model ?? this.defaultModel) ?? this.defaultModel
    const instructionsFile = writeInstructions(spec.workdir, this.instructionsFilename, spec.instructions)

    return {
      cmd: 'droid',
      args: [
        'exec',
        '--output-format',
        'json',
        '--auto',
        '--skip-permissions-unsafe',
        '--model',
        model,
        '--spec-model',
        model,
        spec.prompt,
      ],
      cwd: spec.workdir,
      env: {},
      instructionsFile,
    }
  },

  parseOutput(_spec: RunSpec, outcome: SubprocOutcome): ParsedOutput {
    const raw = parseLastJsonObject(outcome.stdout)
    if (!raw) return { costUsd: null, tokensIn: null, tokensOut: null, raw: null }

    const usage = raw['usage']
    const usageObj = usage && typeof usage === 'object' && !Array.isArray(usage) ? usage as Record<string, unknown> : {}

    let costUsd = asNumber(raw['total_cost_usd'])
    if (costUsd === null) {
      const usageCost = usageObj['cost']
      if (typeof usageCost === 'number') {
        costUsd = usageCost
      } else if (usageCost && typeof usageCost === 'object' && !Array.isArray(usageCost)) {
        costUsd = asNumber((usageCost as Record<string, unknown>)['total'])
      }
    }

    return {
      costUsd,
      tokensIn: asInt(usageObj['input_tokens'] ?? usageObj['input']),
      tokensOut: asInt(usageObj['output_tokens'] ?? usageObj['output']),
      raw,
    }
  },
}

register('factory-droid', factoryDroidAdapter)
