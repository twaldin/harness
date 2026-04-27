import { register } from '../registry.js'
import { writeInstructions } from '../subproc.js'
import type { Adapter, AgentStatus, BuildCommand, ParsedOutput, ReadyState, RunSpec, SessionTelemetry, SubprocOutcome } from '../base.js'
import { normalizeModelForHarness } from '../model-normalization.js'
import { stripAnsi, lastNonEmptyJoin } from '../util.js'
import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { deriveCost } from '../pricing.js'

function parseQwenStatsBlob(blob: string): { tokensIn: number | null; tokensOut: number | null; costUsd: number | null; model: string | null; raw: unknown | null } {
  let parsed: unknown
  try {
    parsed = JSON.parse(blob)
  } catch {
    return { tokensIn: null, tokensOut: null, costUsd: null, model: null, raw: null }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { tokensIn: null, tokensOut: null, costUsd: null, model: null, raw: parsed }
  }
  const obj = parsed as Record<string, unknown>
  const stats = obj['stats'] as Record<string, unknown> | undefined
  const models = stats?.['models']
  if (!models || typeof models !== 'object') {
    return { tokensIn: null, tokensOut: null, costUsd: null, model: null, raw: parsed }
  }

  let tokensIn = 0
  let tokensOut = 0
  let model: string | null = null
  for (const [name, modelStats] of Object.entries(models as Record<string, unknown>)) {
    if (!modelStats || typeof modelStats !== 'object') continue
    if (!model) model = name
    const tokens = (modelStats as Record<string, unknown>)['tokens'] as Record<string, unknown> | undefined
    tokensIn += Number(tokens?.['input'] ?? 0)
    tokensOut += Number(tokens?.['candidates'] ?? 0)
  }

  return {
    tokensIn,
    tokensOut,
    costUsd: deriveCost(model, tokensIn, tokensOut),
    model,
    raw: parsed,
  }
}

const qwenAdapter: Adapter = {
  name: 'qwen',
  instructionsFilename: 'QWEN.md',
  defaultModel: 'qwen3-coder',

  buildCommand(spec: RunSpec): BuildCommand {
    const model = normalizeModelForHarness(this.name, spec.model ?? this.defaultModel, { resolve: !spec.modelNoResolve }) ?? this.defaultModel
    const instructionsFile = writeInstructions(spec.workdir, this.instructionsFilename, spec.instructions)
    return {
      cmd: 'qwen',
      args: ['-p', spec.prompt, '-y', '-m', model, '--output-format', 'json'],
      cwd: spec.workdir,
      env: {},
      instructionsFile,
    }
  },

  parseOutput(_spec: RunSpec, outcome: SubprocOutcome): ParsedOutput {
    const candidates: string[] = [outcome.stdout.trim()]
    for (const ln of outcome.stdout.split('\n')) {
      if (ln.trim().startsWith('[')) candidates.push(ln.trim())
    }

    for (const blob of candidates) {
      if (!blob) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(blob)
      } catch {
        continue
      }
      if (!Array.isArray(parsed)) continue
      for (let i = parsed.length - 1; i >= 0; i--) {
        const item = parsed[i]
        if (!item || typeof item !== 'object') continue
        const obj = item as Record<string, unknown>
        if (obj['type'] !== 'result') continue
        const usage = obj['usage'] as Record<string, unknown> | undefined
        const tokensIn = Number(usage?.['input_tokens'] ?? 0)
        const tokensOut = Number(usage?.['output_tokens'] ?? 0)
        return { costUsd: null, tokensIn, tokensOut, raw: parsed }
      }
    }

    return { costUsd: null, tokensIn: null, tokensOut: null, raw: null }
  },

  sessionLogPath(workdir: string, _since?: number): string | null {
    const home = process.env.HOME ?? ''
    const base = basename(workdir)
    const primary = join(home, '.qwen', 'tmp', base, 'logs.json')
    if (existsSync(primary)) return primary
    const compat = join(home, '.gemini', 'tmp', base, 'logs.json')
    return existsSync(compat) ? compat : null
  },

  parseSessionLog(path: string): SessionTelemetry {
    if (!existsSync(path)) {
      return { sessionLogPath: path, tokensIn: null, tokensOut: null, costUsd: null, model: null, raw: null }
    }
    try {
      const rawText = readFileSync(path, 'utf-8')
      const statsParsed = parseQwenStatsBlob(rawText)
      if (statsParsed.tokensIn != null && statsParsed.tokensOut != null) {
        return {
          sessionLogPath: path,
          tokensIn: statsParsed.tokensIn,
          tokensOut: statsParsed.tokensOut,
          costUsd: statsParsed.costUsd,
          model: statsParsed.model,
          raw: statsParsed.raw,
        }
      }
      const parsed = JSON.parse(rawText) as unknown
      return { sessionLogPath: path, tokensIn: null, tokensOut: null, costUsd: null, model: null, raw: parsed }
    } catch {
      return { sessionLogPath: path, tokensIn: null, tokensOut: null, costUsd: null, model: null, raw: null }
    }
  },
}

qwenAdapter.submitKeys = ['Enter']
qwenAdapter.detectReady = function (pane: string): ReadyState {
  const last30 = lastNonEmptyJoin(pane, 30)
  // Auth dialog (OAuth discontinued / API key prompt)
  if (/Qwen OAuth|API Key/i.test(last30) && /Discontinued|switch/i.test(last30)) return 'dialog'
  if (/Type your message|>\s*$|❯\s*$/m.test(last30)) return 'ready'
  return 'loading'
}
qwenAdapter.handleDialog = function (pane: string): string[] | null {
  // Auth dialog needs user — return null so flt surfaces it.
  return null
}
qwenAdapter.detectStatus = function (pane: string): AgentStatus {
  const last10 = lastNonEmptyJoin(pane, 10)
  if (/rate.?limit|quota/i.test(last10)) return 'rate-limited'
  if (/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(last10) || /thinking|working/i.test(last10)) return 'running'
  if (/Type your message|>\s*$|❯\s*$/m.test(last10)) return 'idle'
  return 'unknown'
}
qwenAdapter.installMeta = {
  packageManager: 'npm',
  installCommand: ['npm', 'install', '-g', '@qwen-code/qwen-code'],
  updateCommand: ['npm', 'install', '-g', '@qwen-code/qwen-code@latest'],
  versionCommand: ['qwen', '--version'],
}

register('qwen', qwenAdapter)
