import { register } from '../registry.js'
import { writeInstructions } from '../subproc.js'
import type { Adapter, AgentStatus, BuildCommand, ParsedOutput, ReadyState, RunSpec, SessionTelemetry, SubprocOutcome } from '../base.js'
import { normalizeModelForHarness } from '../model-normalization.js'
import { stripAnsi, lastNonEmptyJoin } from '../util.js'
import { deriveCost } from '../pricing.js'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs'
import { basename, join } from 'path'
import { homedir } from 'os'

/**
 * continue-cli adapter — invokes the `cn` CLI (Continue) in print mode.
 *
 * When OPENAI-style env vars are present, this adapter writes a minimal
 * Continue config YAML and runs `cn -p --config <file> --format json ...` so
 * bare model IDs like `gpt-5.4` work against an OpenAI-compatible endpoint.
 */
function writeContinueConfig(
  workdir: string,
  model: string,
  apiKey: string,
  apiBase: string | undefined,
  instructions: string | undefined,
): string {
  const continueDir = join(workdir, '.harness', 'continue')
  mkdirSync(continueDir, { recursive: true })
  const configPath = join(continueDir, 'config.yaml')
  const lines: string[] = [
    'name: Harness Continue',
    'version: 1.0.0',
    'schema: v1',
    'models:',
    '  - name: harness-model',
    `    model: ${model}`,
    '    provider: openai',
    `    apiKey: ${apiKey}`,
  ]
  if (apiBase) {
    lines.push(`    apiBase: ${apiBase}`)
  }
  lines.push('    roles:', '      - chat', '      - edit', '      - apply')
  if (instructions) {
    const escaped = instructions.replace(/\s+$/, '').replace(/\n/g, '\\n')
    lines.push('rules:', `  - '${escaped}'`)
  }
  writeFileSync(configPath, lines.join('\n') + '\n', 'utf-8')
  return configPath
}

function continueSessionPath(workdir: string): string | null {
  const envDir = process.env['CONTINUE_SESSION_DIR']
  if (envDir) {
    try {
      const files = readdirSync(envDir)
        .filter((n) => n.endsWith('.json'))
        .map((n) => ({ path: join(envDir, n), mtimeMs: statSync(join(envDir, n)).mtimeMs }))
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
      const newest = files[0]
      if (newest) return newest.path
    } catch {
      return null
    }
  }

  const home = process.env.HOME ?? homedir()
  const base = basename(workdir)
  const candidates = [
    join(home, '.continue', 'sessions', base),
    join(home, '.continue', 'dev_data', base),
    join(home, '.continue', 'index', base),
  ]
  for (const dir of candidates) {
    if (!existsSync(dir)) continue
    try {
      const files = readdirSync(dir)
        .filter((n) => n.endsWith('.json'))
        .map((n) => ({ path: join(dir, n), mtimeMs: statSync(join(dir, n)).mtimeMs }))
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
      const newest = files[0]
      if (newest) return newest.path
      const indexPath = join(dir, 'session.json')
      if (existsSync(indexPath)) return indexPath
    } catch {
      continue
    }
  }
  return null
}

function numberOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

const continueCliAdapter: Adapter = {
  name: 'continue-cli',
  instructionsFilename: 'CONTINUE.md',
  defaultModel: 'claude-sonnet-4-6',

  buildCommand(spec: RunSpec): BuildCommand {
    const model = normalizeModelForHarness(this.name, spec.model ?? this.defaultModel, { resolve: !spec.modelNoResolve }) ?? this.defaultModel
    const instructionsFile = writeInstructions(spec.workdir, this.instructionsFilename, spec.instructions)

    const openaiKey = (spec.env ?? {})['OPENAI_API_KEY']
    const openaiBase = (spec.env ?? {})['OPENAI_BASE_URL']
    if (openaiKey || openaiBase) {
      const configPath = writeContinueConfig(spec.workdir, model, openaiKey ?? 'dummy', openaiBase, spec.instructions)
      return {
        cmd: 'cn',
        args: ['-p', '--config', configPath, '--format', 'json', spec.prompt],
        cwd: spec.workdir,
        env: {},
        instructionsFile,
      }
    }

    return {
      cmd: 'cn',
      args: ['-p', spec.prompt, '--model', model, '--json'],
      cwd: spec.workdir,
      env: {},
      instructionsFile,
    }
  },

  parseOutput(_spec: RunSpec, outcome: SubprocOutcome): ParsedOutput {
    let raw: unknown = null
    if (outcome.stdout.trim()) {
      try {
        raw = JSON.parse(outcome.stdout)
      } catch {
        raw = null
      }
    }
    if (raw !== null && typeof raw === 'object') {
      const obj = raw as Record<string, unknown>
      const usage = (obj['usage'] as Record<string, unknown> | undefined) ?? {}
      return {
        costUsd: (obj['total_cost_usd'] as number | undefined) ?? null,
        tokensIn: (usage['input_tokens'] as number | undefined) ?? null,
        tokensOut: (usage['output_tokens'] as number | undefined) ?? null,
        raw,
      }
    }
    return { costUsd: null, tokensIn: null, tokensOut: null, raw }
  },

  sessionLogPath(workdir: string, _since?: number): string | null {
    return continueSessionPath(workdir)
  },

  parseSessionLog(path: string): SessionTelemetry {
    if (!existsSync(path)) {
      return { sessionLogPath: path, tokensIn: null, tokensOut: null, costUsd: null, model: null, raw: null }
    }
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown
      const obj = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
      const usage = obj['usage'] && typeof obj['usage'] === 'object' ? obj['usage'] as Record<string, unknown> : {}
      const tokensIn = numberOrNull(usage['input_tokens'])
      const tokensOut = numberOrNull(usage['output_tokens'])
      const rawCost = numberOrNull(obj['total_cost_usd'])
      const model = typeof obj['model'] === 'string' ? obj['model'] : null
      const costUsd = rawCost ?? deriveCost(model, tokensIn, tokensOut)
      return { sessionLogPath: path, tokensIn, tokensOut, costUsd, model, raw: parsed }
    } catch {
      return { sessionLogPath: path, tokensIn: null, tokensOut: null, costUsd: null, model: null, raw: null }
    }
  },
}

continueCliAdapter.submitKeys = ['Enter']
continueCliAdapter.detectReady = function (pane: string): ReadyState {
  const last20 = lastNonEmptyJoin(pane, 20)
  // cn shows "Ask anything" placeholder while model is still loading.
  // Real ready = input visible AND model loaded (no "Model: Loading..." line).
  if (/Model:\s*Loading/i.test(last20)) return 'loading'
  if (/Ask anything/i.test(last20)) return 'ready'
  if (/Update available/i.test(last20)) return 'dialog'
  return 'loading'
}
continueCliAdapter.handleDialog = function (pane: string): string[] | null {
  if (/Update available/i.test(stripAnsi(pane))) return ['Escape']
  return null
}
continueCliAdapter.detectStatus = function (pane: string): AgentStatus {
  const last10 = lastNonEmptyJoin(pane, 10)
  if (/rate.?limit/i.test(last10)) return 'rate-limited'
  if (/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(last10)) return 'running'
  if (/thinking|working/i.test(last10)) return 'running'
  if (/Ask anything/i.test(last10)) return 'idle'
  return 'unknown'
}
continueCliAdapter.installMeta = {
  packageManager: 'npm',
  installCommand: ['npm', 'install', '-g', '@continuedev/cli'],
  updateCommand: ['npm', 'install', '-g', '@continuedev/cli@latest'],
  versionCommand: ['cn', '--version'],
}

register('continue-cli', continueCliAdapter)
