import { register } from '../registry.js'
import { writeInstructions } from '../subproc.js'
import type { Adapter, BuildCommand, ParsedOutput, RunSpec, SubprocOutcome, SessionTelemetry } from '../base.js'
import { normalizeModelForHarness } from '../model-normalization.js'
import { stripAnsi, lastNonEmptyJoin } from '../util.js'
import { deriveCost } from '../pricing.js'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const codexAdapter: Adapter = {
  name: 'codex',
  instructionsFilename: 'AGENTS.md',
  defaultModel: 'gpt-5.3-codex',

  buildCommand(spec: RunSpec): BuildCommand {
    const model = normalizeModelForHarness(this.name, spec.model ?? this.defaultModel, { resolve: !spec.modelNoResolve }) ?? this.defaultModel
    const instructionsFile = writeInstructions(spec.workdir, this.instructionsFilename, spec.instructions)
    return {
      cmd: 'codex',
      args: ['exec', '-m', model, '--dangerously-bypass-approvals-and-sandbox', '--json', '-C', spec.workdir, spec.prompt],
      cwd: spec.workdir,
      env: {},
      instructionsFile,
    }
  },

  parseOutput(_spec: RunSpec, outcome: SubprocOutcome): ParsedOutput {
    let tokensIn = 0
    let tokensOut = 0
    let sawTurn = false
    for (const line of outcome.stdout.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('{')) continue
      let event: unknown
      try {
        event = JSON.parse(trimmed)
      } catch {
        continue
      }
      if (event !== null && typeof event === 'object') {
        const obj = event as Record<string, unknown>
        if (obj['type'] === 'turn.completed') {
          sawTurn = true
          const usage = (obj['usage'] as Record<string, unknown> | undefined) ?? {}
          tokensIn += Number(usage['input_tokens'] ?? 0)
          tokensOut += Number(usage['output_tokens'] ?? 0)
        }
      }
    }
    return {
      costUsd: null,
      tokensIn: sawTurn ? tokensIn : null,
      tokensOut: sawTurn ? tokensOut : null,
      raw: null,
    }
  },
}

// ===== session-aware additions =====

codexAdapter.submitKeys = ['Enter']

codexAdapter.detectReady = function (pane: string) {
  const last20 = lastNonEmptyJoin(pane, 20)
  const lines = stripAnsi(pane).split('\n')
  const hasPrompt = lines.some(l => /^\s*[❯›]\s+\S/.test(l) || /^\s*[❯›]\s*$/.test(l))
  const hasStatusBar = /\d+%\s+left/i.test(last20) || /model:/i.test(last20)
  if (hasPrompt && hasStatusBar) return 'ready'
  if (/Press enter to continue/i.test(last20)) return 'dialog'
  if (/›\s+\d+\./m.test(last20) && !hasPrompt) return 'dialog'
  if (/Update available/i.test(last20)) return 'dialog'
  return 'loading'
}

codexAdapter.handleDialog = function (pane: string) {
  const text = stripAnsi(pane)
  if (/Update available/i.test(text)) return ['Down', 'Enter'] // skip update
  if (/Press enter/i.test(text)) return ['Enter']
  if (/›\s+\d+\./m.test(text)) return ['Enter']
  return null
}

codexAdapter.detectStatus = function (pane: string) {
  const last15 = lastNonEmptyJoin(pane, 15)
  const last5 = lastNonEmptyJoin(pane, 5)
  if (/Update available/i.test(last15)) return 'dialog'
  if (/esc to interrupt/i.test(last15)) return 'running'
  if (/Working\s*\(/i.test(last15)) return 'running'
  if (/background terminal running/i.test(last15)) return 'running'
  const hasPrompt = last5.split('\n').some(l => /^\s*[❯›]\s*$/.test(l))
  if (hasPrompt) return 'idle'
  if (/\d+%\s+left/i.test(last5) && !/working/i.test(last5)) return 'idle'
  return 'unknown'
}

// ~/.codex/sessions/<year>/<month>/<day>/...jsonl — most recent jsonl
codexAdapter.sessionLogPath = function (_workdir: string, since?: number): string | null {
  const dir = join(process.env.HOME ?? '', '.codex', 'sessions')
  if (!existsSync(dir)) return null
  // walk yyyy/mm/dd
  const cutoff = since ?? 0
  let best: { path: string; mtime: number } | null = null
  function scan(d: string): void {
    try {
      for (const name of readdirSync(d)) {
        const p = join(d, name)
        const st = statSync(p)
        if (st.isDirectory()) scan(p)
        else if (name.endsWith('.jsonl') && st.mtimeMs >= cutoff) {
          if (!best || st.mtimeMs > best.mtime) best = { path: p, mtime: st.mtimeMs }
        }
      }
    } catch { /* ignore */ }
  }
  scan(dir)
  return best ? best.path : null
}

codexAdapter.parseSessionLog = function (path: string): SessionTelemetry {
  if (!existsSync(path)) {
    return { sessionLogPath: path, tokensIn: null, tokensOut: null, costUsd: null, model: null, raw: null }
  }
  let tokensIn = 0, tokensOut = 0, modelName: string | null = null, sawUsage = false
  try {
    for (const line of readFileSync(path, 'utf-8').split('\n')) {
      const t = line.trim()
      if (!t.startsWith('{')) continue
      let ev: unknown
      try { ev = JSON.parse(t) } catch { continue }
      if (!ev || typeof ev !== 'object') continue
      const obj = ev as Record<string, unknown>
      if (obj['type'] === 'turn.completed' || obj['type'] === 'session.created') {
        const usage = obj['usage'] as Record<string, unknown> | undefined
        if (usage) {
          sawUsage = true
          tokensIn += Number(usage['input_tokens'] ?? 0)
          tokensOut += Number(usage['output_tokens'] ?? 0)
        }
        const m = obj['model']
        if (typeof m === 'string' && !modelName) modelName = m
      }
    }
  } catch {
    return { sessionLogPath: path, tokensIn: null, tokensOut: null, costUsd: null, model: null, raw: null }
  }
  const ti = sawUsage ? tokensIn : null
  const to = sawUsage ? tokensOut : null
  return { sessionLogPath: path, tokensIn: ti, tokensOut: to, costUsd: deriveCost(modelName, ti, to), model: modelName, raw: null }
}

codexAdapter.installMeta = {
  packageManager: 'npm',
  installCommand: ['npm', 'install', '-g', '@openai/codex'],
  updateCommand: ['npm', 'install', '-g', '@openai/codex@latest'],
  versionCommand: ['codex', '--version'],
}

register('codex', codexAdapter)
