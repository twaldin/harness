import { register } from '../registry.js'
import { writeInstructions } from '../subproc.js'
import type { Adapter, AgentStatus, BuildCommand, ParsedOutput, ReadyState, RunSpec, SessionTelemetry, SubprocOutcome } from '../base.js'
import { normalizeModelForHarness } from '../model-normalization.js'
import { stripAnsi, lastNonEmptyJoin } from '../util.js'
import { deriveCost } from '../pricing.js'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

function parseGeminiStatsBlob(blob: string): { tokensIn: number | null; tokensOut: number | null; costUsd: number | null; model: string | null; raw: unknown | null } {
  let parsed: unknown
  try {
    parsed = JSON.parse(blob)
  } catch {
    return { tokensIn: null, tokensOut: null, costUsd: null, model: null, raw: null }
  }
  if (parsed === null || typeof parsed !== 'object') return { tokensIn: null, tokensOut: null, costUsd: null, model: null, raw: parsed }
  const obj = parsed as Record<string, unknown>
  const stats = obj['stats'] as Record<string, unknown> | undefined
  const models = stats?.['models']
  if (!models || typeof models !== 'object') return { tokensIn: null, tokensOut: null, costUsd: null, model: null, raw: parsed }
  let tokensIn = 0
  let tokensOut = 0
  let modelName: string | null = null
  for (const [name, modelStats] of Object.entries(models as Record<string, unknown>)) {
    if (!modelStats || typeof modelStats !== 'object') continue
    if (!modelName) modelName = name
    const t = (modelStats as Record<string, unknown>)['tokens'] as Record<string, unknown> | undefined
    tokensIn += Number(t?.['input'] ?? 0)
    tokensOut += Number(t?.['candidates'] ?? 0)
  }
  return {
    tokensIn,
    tokensOut,
    costUsd: deriveCost(modelName, tokensIn, tokensOut),
    model: modelName,
    raw: parsed,
  }
}

const geminiAdapter: Adapter = {
  name: 'gemini',
  instructionsFilename: 'GEMINI.md',
  defaultModel: 'gemini-2.5-pro',

  buildCommand(spec: RunSpec): BuildCommand {
    const model = normalizeModelForHarness(this.name, spec.model ?? this.defaultModel, { resolve: !spec.modelNoResolve }) ?? this.defaultModel
    const instructionsFile = writeInstructions(spec.workdir, this.instructionsFilename, spec.instructions)
    return {
      cmd: 'gemini',
      args: ['-p', spec.prompt, '-y', '-m', model, '--output-format', 'json'],
      cwd: spec.workdir,
      env: {},
      instructionsFile,
    }
  },

  parseOutput(_spec: RunSpec, outcome: SubprocOutcome): ParsedOutput {
    const candidates: string[] = [outcome.stdout.trim()]
    for (const ln of outcome.stdout.split('\n')) {
      if (ln.trim().startsWith('{')) candidates.push(ln.trim())
    }

    for (const blob of candidates) {
      if (!blob) continue
      const parsed = parseGeminiStatsBlob(blob)
      if (parsed.tokensIn == null || parsed.tokensOut == null) continue
      return { costUsd: parsed.costUsd, tokensIn: parsed.tokensIn, tokensOut: parsed.tokensOut, raw: parsed.raw }
    }

    return { costUsd: null, tokensIn: null, tokensOut: null, raw: null }
  },

  // -------- session-aware --------

  submitKeys: ['Enter'],

  detectReady(pane: string): ReadyState {
    const last20 = lastNonEmptyJoin(pane, 20)
    if (/Apply this change\?/i.test(last20) || /Allow execution of/i.test(last20)) return 'dialog'
    if (/Type your message/i.test(last20)) return 'ready'
    if (/[>❯]\s*$/.test(last20)) return 'ready'
    return 'loading'
  },

  detectStatus(pane: string): AgentStatus {
    const last20 = lastNonEmptyJoin(pane, 20)
    const last10 = lastNonEmptyJoin(pane, 10)

    // Mid-run dialogs (need auto-approve)
    if (/Apply this change\?/i.test(last20)) return 'dialog'
    if (/Allow execution of/i.test(last20)) return 'dialog'
    if (/Action Required/i.test(last20) && /Allow/i.test(last20)) return 'dialog'
    if (/Do you trust the files/i.test(last20)) return 'dialog'

    if (/rate.?limit|quota.?exceeded|resource.?exhausted/i.test(last10)) return 'rate-limited'
    if (/error/i.test(last10) && /fatal|crash/i.test(last10)) return 'error'

    // Spinners
    if (/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⊶⊷]/.test(last10)) return 'running'
    if (/Thinking\.\.\./i.test(last10)) return 'running'

    // Idle
    if (/Type your message/i.test(last10)) return 'idle'
    if (/Ready/i.test(last10) && !/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⊶⊷]/.test(last10)) return 'idle'
    if (/[✓✔]/.test(last10) && !/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⊶⊷]/.test(last10)) return 'idle'

    return 'unknown'
  },

  handleDialog(pane: string): string[] | null {
    const text = stripAnsi(pane)
    // "Apply this change?" / "Allow execution of X?" / "Action Required" — option 1 (Allow once) is selected by default; Enter accepts.
    if (/Apply this change\?/i.test(text)) return ['Enter']
    if (/Allow execution of/i.test(text)) return ['Enter']
    if (/Action Required/i.test(text) && /Allow/i.test(text)) return ['Enter']
    if (/Do you trust the files/i.test(text) || /Trust folder/i.test(text)) return ['Enter']
    return null
  },

  // gemini-cli writes interactive logs to ~/.gemini/tmp/<basename(workdir)>/logs.json
  // and headless --output-format=json stats to stdout/files with stats.models.
  // sessionLogPath still points at interactive logs; parseSessionLog can parse
  // either shape when given a file path.
  sessionLogPath(workdir: string, _since?: number): string | null {
    const home = process.env.HOME ?? ''
    const base = workdir.split('/').filter(Boolean).pop() ?? ''
    const path = join(home, '.gemini', 'tmp', base, 'logs.json')
    return existsSync(path) ? path : null
  },

  parseSessionLog(path: string): SessionTelemetry {
    if (!existsSync(path)) {
      return { sessionLogPath: path, tokensIn: null, tokensOut: null, costUsd: null, model: null, raw: null }
    }
    try {
      const rawText = readFileSync(path, 'utf-8')
      const parsedStats = parseGeminiStatsBlob(rawText)
      if (parsedStats.tokensIn != null && parsedStats.tokensOut != null) {
        return {
          sessionLogPath: path,
          tokensIn: parsedStats.tokensIn,
          tokensOut: parsedStats.tokensOut,
          costUsd: parsedStats.costUsd,
          model: parsedStats.model,
          raw: parsedStats.raw,
        }
      }
      const parsed = JSON.parse(rawText)
      return { sessionLogPath: path, tokensIn: null, tokensOut: null, costUsd: null, model: null, raw: parsed }
    } catch {
      return { sessionLogPath: path, tokensIn: null, tokensOut: null, costUsd: null, model: null, raw: null }
    }
  },

  installMeta: {
    packageManager: 'npm',
    installCommand: ['npm', 'install', '-g', '@google/gemini-cli'],
    updateCommand: ['npm', 'install', '-g', '@google/gemini-cli@latest'],
    versionCommand: ['gemini', '--version'],
    platforms: ['darwin', 'linux'],
  },
}

register('gemini', geminiAdapter)
