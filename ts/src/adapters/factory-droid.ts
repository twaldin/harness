import { register } from '../registry.js'
import { writeInstructions } from '../subproc.js'
import type { Adapter, AgentStatus, BuildCommand, ParsedOutput, ReadyState, RunSpec, SubprocOutcome } from '../base.js'
import { normalizeModelForHarness } from '../model-normalization.js'
import { stripAnsi, lastNonEmptyJoin } from '../util.js'

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
    const model = normalizeModelForHarness(this.name, spec.model ?? this.defaultModel, { resolve: !spec.modelNoResolve }) ?? this.defaultModel
    const instructionsFile = writeInstructions(spec.workdir, this.instructionsFilename, spec.instructions)

    return {
      cmd: 'droid',
      args: [
        'exec',
        '--output-format',
        'json',
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

factoryDroidAdapter.submitKeys = ['Enter']
factoryDroidAdapter.detectReady = function (pane: string): ReadyState {
  const last30 = lastNonEmptyJoin(pane, 30)
  if (/Try\s+"/i.test(last30) || /Auto.*\(Off\)|Auto.*\(On\)/i.test(last30)) return 'ready'
  if (/Update available/i.test(last30)) return 'dialog'
  return 'loading'
}
factoryDroidAdapter.handleDialog = function (pane: string): string[] | null {
  if (/Update available/i.test(stripAnsi(pane))) return ['Escape']
  return null
}
factoryDroidAdapter.detectStatus = function (pane: string): AgentStatus {
  const last10 = lastNonEmptyJoin(pane, 10)
  if (/rate.?limit/i.test(last10)) return 'rate-limited'
  if (/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(last10) || /Thinking|Working/i.test(last10)) return 'running'
  if (/Try\s+"|Auto.*\(/i.test(last10)) return 'idle'
  return 'unknown'
}
factoryDroidAdapter.installMeta = {
  packageManager: 'npm',
  installCommand: ['npm', 'install', '-g', '@factory-ai/droid'],
  updateCommand: ['npm', 'install', '-g', '@factory-ai/droid@latest'],
  versionCommand: ['droid', '--version'],
}

register('factory-droid', factoryDroidAdapter)
