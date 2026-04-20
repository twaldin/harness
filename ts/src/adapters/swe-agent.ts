import { register } from '../registry.js'
import type { Adapter, BuildCommand, ParsedOutput, RunSpec, SubprocOutcome } from '../base.js'
import { HarnessError } from '../base.js'
import { homedir } from 'os'
import { existsSync, mkdirSync, readFileSync } from 'fs'
import { resolve } from 'path'

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

function readSweTrajectory(trajFile: string): { tokensIn: number | null; tokensOut: number | null; costUsd: number | null; raw: unknown | null } {
  if (!existsSync(trajFile)) return { tokensIn: null, tokensOut: null, costUsd: null, raw: null }
  let traj: unknown
  try {
    traj = JSON.parse(readFileSync(trajFile, 'utf-8'))
  } catch {
    return { tokensIn: null, tokensOut: null, costUsd: null, raw: null }
  }
  if (!traj || typeof traj !== 'object') return { tokensIn: null, tokensOut: null, costUsd: null, raw: null }
  const obj = traj as Record<string, unknown>

  const info = obj['info'] as Record<string, unknown> | undefined
  const modelStats = info?.['model_stats'] as Record<string, unknown> | undefined
  const costRaw = modelStats?.['instance_cost']
  const costUsd = typeof costRaw === 'number' ? costRaw : null

  let tokensIn = 0
  let tokensOut = 0
  let sawUsage = false
  const messages = obj['messages']
  if (Array.isArray(messages)) {
    for (const msg of messages) {
      if (!msg || typeof msg !== 'object') continue
      const extra = (msg as Record<string, unknown>)['extra'] as Record<string, unknown> | undefined
      const response = extra?.['response'] as Record<string, unknown> | undefined
      const usage = response?.['usage'] as Record<string, unknown> | undefined
      if (!usage) continue
      sawUsage = true
      tokensIn += Number(usage['prompt_tokens'] ?? usage['input_tokens'] ?? 0)
      tokensOut += Number(usage['completion_tokens'] ?? usage['output_tokens'] ?? 0)
    }
  }

  return {
    tokensIn: sawUsage ? tokensIn : null,
    tokensOut: sawUsage ? tokensOut : null,
    costUsd,
    raw: traj,
  }
}

const sweAgentAdapter: Adapter = {
  name: 'swe-agent',
  instructionsFilename: '',
  defaultModel: 'openai/gpt-5.4',

  buildCommand(spec: RunSpec): BuildCommand {
    const model = spec.model ?? this.defaultModel
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

register('swe-agent', sweAgentAdapter)
