// OpenClaude (github.com/Gitlawb/openclaude) is a Claude Code fork. It keeps the
// <config>/projects/<encoded cwd>/<session-id>.jsonl transcript layout but
// resolves its config root independently: NFC(OPENCLAUDE_CONFIG_DIR or
// ~/.openclaude) (src/utils/envUtils.ts). It deliberately never reads
// CLAUDE_CONFIG_DIR or ~/.claude, so discovery here never falls back to Claude
// Code transcripts either.
import { register } from '../registry.js'
import type { Adapter, AgentStatus, BuildCommand, ParsedOutput, ReadyState, RunSpec, SubprocOutcome } from '../base.js'
import { finalizeCommand, validateRunSpec } from '../base.js'
import { stripAnsi, lastNonEmptyJoin } from '../util.js'
import { canonicalProjectPath, configHome, newestSessionLog, parseClaudeTranscript, projectDirs } from './claude-code.js'
import { join } from 'node:path'

export const OPENCLAUDE_CONFIG_DIR_ENV = 'OPENCLAUDE_CONFIG_DIR'

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
  permissionBypassArgs: ['--dangerously-skip-permissions'],

  buildCommand(spec: RunSpec): BuildCommand {
    const validated = validateRunSpec(this, spec)
    const { model, permissionArgs } = validated

    const args = [
      '-p',
      spec.prompt,
      '--output-format',
      'json',
      ...permissionArgs,
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

    return finalizeCommand(this, spec, validated, { cmd: 'openclaude', args, env })
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

  sessionLogPath(workdir: string, since?: number): string | null {
    const projects = join(configHome(OPENCLAUDE_CONFIG_DIR_ENV, '.openclaude', true), 'projects')
    const projectPath = canonicalProjectPath(workdir)
    return newestSessionLog(projectDirs(projects, projectPath), projectPath, since)
  },

  parseSessionLog: parseClaudeTranscript,
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
  installCommand: ['npm', 'install', '-g', '@gitlawb/openclaude'],
  updateCommand: ['npm', 'install', '-g', '@gitlawb/openclaude@latest'],
  versionCommand: ['openclaude', '--version'],
}

register('openclaude', openClaudeAdapter)
