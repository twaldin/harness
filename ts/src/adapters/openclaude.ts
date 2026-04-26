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

const openClaudeAdapter: Adapter = {
  name: 'openclaude',
  instructionsFilename: 'CLAUDE.md',
  defaultModel: 'gpt-5.4',

  buildCommand(spec: RunSpec): BuildCommand {
    const model = normalizeModelForHarness(this.name, spec.model ?? this.defaultModel, { resolve: !spec.modelNoResolve }) ?? this.defaultModel
    const instructionsFile = writeInstructions(spec.workdir, this.instructionsFilename, spec.instructions)

    const args = [
      '-p',
      spec.prompt,
      '--output-format',
      'json',
      '--dangerously-skip-permissions',
    ]
    if (spec.instructions) {
      args.push('--append-system-prompt', spec.instructions)
    }

    const env: Record<string, string> = {}
    // OpenAI-compatible provider path: prefer env-based setup. openclaude's
    // README documents OPENAI_MODEL + CLAUDE_CODE_USE_OPENAI rather than an
    // explicit --model flag for custom OpenAI-compatible endpoints.
    if ((spec.env ?? {})['OPENAI_API_KEY'] || (spec.env ?? {})['OPENAI_BASE_URL']) {
      env['CLAUDE_CODE_USE_OPENAI'] = '1'
      if (!(spec.env ?? {})['OPENAI_MODEL']) {
        env['OPENAI_MODEL'] = model
      }
    } else {
      args.push('--model', model)
    }

    return {
      cmd: 'openclaude',
      args,
      cwd: spec.workdir,
      env,
      instructionsFile,
    }
  },

  parseOutput(_spec: RunSpec, outcome: SubprocOutcome): ParsedOutput {
    const raw = parseLastJsonObject(outcome.stdout)
    if (!raw) return { costUsd: null, tokensIn: null, tokensOut: null, raw: null }

    const usage = raw['usage']
    const usageObj = usage && typeof usage === 'object' && !Array.isArray(usage) ? usage as Record<string, unknown> : {}
    return {
      costUsd: asNumber(raw['total_cost_usd']),
      tokensIn: asInt(usageObj['input_tokens']),
      tokensOut: asInt(usageObj['output_tokens']),
      raw,
    }
  },
}

openClaudeAdapter.submitKeys = ['Enter']
openClaudeAdapter.detectReady = function (pane: string): ReadyState {
  const last20 = lastNonEmptyJoin(pane, 20)
  // openclaude shows "Ready — type /help to begin" + ❯ prompt
  if (/Ready\s*[-—]/i.test(last20) || stripAnsi(pane).split('\n').some(l => /^\s*❯\s*$/.test(l.trim()))) return 'ready'
  if (/Update available/i.test(last20)) return 'dialog'
  return 'loading'
}
openClaudeAdapter.handleDialog = function (pane: string): string[] | null {
  if (/Update available/i.test(stripAnsi(pane))) return ['Escape']
  return null
}
openClaudeAdapter.detectStatus = function (pane: string): AgentStatus {
  const last10 = lastNonEmptyJoin(pane, 10)
  if (/rate.?limit/i.test(last10)) return 'rate-limited'
  if (/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(last10) || /Thinking|Working/i.test(last10)) return 'running'
  if (/Ready\s*[-—]/i.test(last10) || /❯\s*$/.test(last10)) return 'idle'
  return 'unknown'
}
openClaudeAdapter.installMeta = {
  packageManager: 'npm',
  installCommand: ['npm', 'install', '-g', 'openclaude'],
  updateCommand: ['npm', 'install', '-g', 'openclaude@latest'],
  versionCommand: ['openclaude', '--version'],
}

register('openclaude', openClaudeAdapter)
