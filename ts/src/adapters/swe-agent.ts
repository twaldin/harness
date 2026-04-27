import { register } from '../registry.js'
import type { Adapter, BuildCommand, ParsedOutput, RunSpec, SubprocOutcome, SessionTelemetry } from '../base.js'
import { HarnessError } from '../base.js'
import { homedir } from 'os'
import { existsSync, mkdirSync, readFileSync } from 'fs'
import { resolve, join } from 'path'
import { normalizeModelForHarness } from '../model-normalization.js'
import { stripAnsi, lastNonEmptyJoin } from '../util.js'
import { deriveCost } from '../pricing.js'

const DEFAULT_COST_LIMIT_USD = 10.0

function resolveWrapper(env: Record<string, string> | undefined): string {
  const explicit = (env ?? {})['SWE_WRAPPER'] ?? process.env['SWE_WRAPPER']
  if (explicit) {
    const p = explicit.replace(/^~/, homedir())
    if (!existsSync(p)) throw new HarnessError(`SWE_WRAPPER does not exist: ${p}`)
    return p
  }
  const fallback = `${homedir()}/agentelo/bin/run-mini-swe.py`
  if (existsSync(fallback)) return fallback
  throw new HarnessError(
    'swe-agent wrapper not found. Set SWE_WRAPPER env var to your headless mini-swe-agent runner script, or install agentelo at ~/agentelo.',
  )
}

function readSweTrajectory(trajFile: string): { tokensIn: number | null; tokensOut: number | null; costUsd: number | null; model: string | null; raw: unknown | null } {
  if (!existsSync(trajFile)) return { tokensIn: null, tokensOut: null, costUsd: null, model: null, raw: null }
  let traj: unknown
  try {
    traj = JSON.parse(readFileSync(trajFile, 'utf-8'))
  } catch {
    return { tokensIn: null, tokensOut: null, costUsd: null, model: null, raw: null }
  }
  if (!traj || typeof traj !== 'object') return { tokensIn: null, tokensOut: null, costUsd: null, model: null, raw: null }
  const obj = traj as Record<string, unknown>

  const info = obj['info'] as Record<string, unknown> | undefined
  const modelStats = info?.['model_stats'] as Record<string, unknown> | undefined
  const costRaw = modelStats?.['instance_cost']
  const costUsd = typeof costRaw === 'number' ? costRaw : null

  let tokensIn = 0
  let tokensOut = 0
  let sawUsage = false
  let model: string | null = null
  const messages = obj['messages']
  if (Array.isArray(messages)) {
    for (const msg of messages) {
      if (!msg || typeof msg !== 'object') continue
      const extra = (msg as Record<string, unknown>)['extra'] as Record<string, unknown> | undefined
      const response = extra?.['response'] as Record<string, unknown> | undefined
      if (!model && typeof response?.['model'] === 'string') model = response['model'] as string
      const usage = response?.['usage'] as Record<string, unknown> | undefined
      if (!usage) continue
      sawUsage = true
      tokensIn += Number(usage['prompt_tokens'] ?? usage['input_tokens'] ?? 0)
      tokensOut += Number(usage['completion_tokens'] ?? usage['output_tokens'] ?? 0)
    }
  }

  if (!model && modelStats) {
    const modelKeys = Object.keys(modelStats).filter((k) => k !== 'instance_cost')
    model = modelKeys.length > 0 ? modelKeys[0]! : null
  }

  return {
    tokensIn: sawUsage ? tokensIn : null,
    tokensOut: sawUsage ? tokensOut : null,
    costUsd,
    model,
    raw: traj,
  }
}

const sweAgentAdapter: Adapter = {
  name: 'swe-agent',
  instructionsFilename: '',
  defaultModel: 'gpt-5.4',

  buildCommand(spec: RunSpec): BuildCommand {
    const model = normalizeModelForHarness(this.name, spec.model ?? this.defaultModel, { resolve: !spec.modelNoResolve }) ?? this.defaultModel
    const wrapper = resolveWrapper(spec.env)

    const trajDir = `${spec.workdir}/.harness`
    mkdirSync(trajDir, { recursive: true })
    const trajFile = `${trajDir}/swe-traj.json`

    let prompt = spec.prompt
    if (spec.instructions) {
      prompt = `${spec.instructions.trimEnd()}\n\n---\n\n${prompt}`
    }

    return {
      cmd: 'python3',
      args: [wrapper, '--model', model, '--task', prompt, '--cwd', spec.workdir, '--cost-limit', DEFAULT_COST_LIMIT_USD.toFixed(1), '--output', trajFile],
      cwd: spec.workdir,
      env: {},
      instructionsFile: null,
    }
  },

  parseOutput(spec: RunSpec, _outcome: SubprocOutcome): ParsedOutput {
    const trajFile = `${spec.workdir}/.harness/swe-traj.json`
    const { tokensIn, tokensOut, costUsd, raw } = readSweTrajectory(trajFile)
    return { costUsd, tokensIn, tokensOut, raw }
  },
}

// ===== session-aware additions (mini-swe-agent interactive) =====

sweAgentAdapter.submitKeys = ['Escape', 'Enter']

sweAgentAdapter.detectReady = function (pane: string) {
  const last20 = lastNonEmptyJoin(pane, 20)
  if (/Submit message/i.test(last20)) return 'ready'
  if (/What do you want to do/i.test(last20)) return 'ready'
  return 'loading'
}

sweAgentAdapter.handleDialog = function (_pane: string) {
  return null
}

sweAgentAdapter.detectStatus = function (pane: string) {
  const last10 = lastNonEmptyJoin(pane, 10)
  if (/rate.?limit|quota/i.test(last10)) return 'rate-limited'
  if (/error/i.test(last10) && /fatal|crash/i.test(last10)) return 'error'
  if (/What do you want to do|Submit message/i.test(last10)) return 'idle'
  // mini shows a Rich spinner / "thinking" while working
  if (/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(last10) || /thinking/i.test(last10)) return 'running'
  return 'unknown'
}

// mini-swe-agent interactive writes the most recent run's trajectory to
//   ~/Library/Application Support/mini-swe-agent/last_mini_run.traj.json (macOS)
//   ~/.local/share/mini-swe-agent/last_mini_run.traj.json (linux, XDG)
// Headless flt runs (with --output) drop the per-task trajectory at
// <workdir>/.harness/swe-traj.json — prefer that when present.
sweAgentAdapter.sessionLogPath = function (workdir: string, _since?: number): string | null {
  const home = process.env.HOME ?? ''
  const platform = process.platform
  const appSupport = platform === 'darwin'
    ? join(home, 'Library', 'Application Support', 'mini-swe-agent')
    : join(home, '.local', 'share', 'mini-swe-agent')
  const candidates = [
    join(workdir, '.harness', 'swe-traj.json'),
    join(workdir, 'mini-traj.json'),
    join(appSupport, 'last_mini_run.traj.json'),
  ]
  for (const c of candidates) if (existsSync(c)) return c
  return null
}

sweAgentAdapter.parseSessionLog = function (path: string): SessionTelemetry {
  const r = readSweTrajectory(path)
  const cost = r.costUsd ?? deriveCost(r.model, r.tokensIn, r.tokensOut)
  return { sessionLogPath: path, tokensIn: r.tokensIn, tokensOut: r.tokensOut, costUsd: cost, model: r.model, raw: r.raw }
}

sweAgentAdapter.installMeta = {
  packageManager: 'pip',
  installCommand: ['pip', 'install', '--user', 'mini-swe-agent'],
  updateCommand: ['pip', 'install', '--user', '--upgrade', 'mini-swe-agent'],
  versionCommand: ['mini', '--version'],
}

register('swe-agent', sweAgentAdapter)
