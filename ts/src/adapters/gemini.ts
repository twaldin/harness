import { register } from '../registry.js'
import { writeInstructions } from '../subproc.js'
import type { Adapter, AgentStatus, BuildCommand, ParsedOutput, ReadyState, RunSpec, SessionTelemetry, SubprocOutcome } from '../base.js'
import { normalizeModelForHarness } from '../model-normalization.js'
import { stripAnsi, lastNonEmptyJoin } from '../util.js'
import { deriveCost } from '../pricing.js'
import { existsSync, readFileSync, statSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

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
      let parsed: unknown
      try {
        parsed = JSON.parse(blob)
      } catch {
        continue
      }
      if (parsed === null || typeof parsed !== 'object') continue
      const obj = parsed as Record<string, unknown>
      const stats = obj['stats'] as Record<string, unknown> | undefined
      const models = stats?.['models']
      if (!models || typeof models !== 'object') continue
      let tokensIn = 0
      let tokensOut = 0
      let modelName: string | null = null
      for (const [name, stats] of Object.entries(models as Record<string, unknown>)) {
        if (!stats || typeof stats !== 'object') continue
        if (!modelName) modelName = name
        const t = (stats as Record<string, unknown>)['tokens'] as Record<string, unknown> | undefined
        tokensIn += Number(t?.['input'] ?? 0)
        tokensOut += Number(t?.['candidates'] ?? 0)
      }
      const costUsd = deriveCost(modelName, tokensIn, tokensOut)
      return { costUsd, tokensIn, tokensOut, raw: parsed }
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

  // gemini-cli writes session/stats to <workdir>/.gemini/ (per-project) and global
  // ~/.gemini/. The interactive run doesn't drop a single canonical file the way
  // claude-code/codex/pi do — so we look for the most recent JSON in either path.
  sessionLogPath(workdir: string, _since?: number): string | null {
    const candidates = [
      join(workdir, '.gemini', 'logs.json'),
      join(workdir, '.gemini', 'sessions'),
    ]
    for (const c of candidates) {
      if (!existsSync(c)) continue
      try {
        if (statSync(c).isDirectory()) {
          const items = readdirSync(c)
            .map(n => ({ n, t: statSync(join(c, n)).mtimeMs }))
            .sort((a, b) => b.t - a.t)
          if (items.length) return join(c, items[0].n)
        } else {
          return c
        }
      } catch {
        // fall through
      }
    }
    return null
  },

  parseSessionLog(path: string): SessionTelemetry {
    if (!existsSync(path)) {
      return { sessionLogPath: path, tokensIn: null, tokensOut: null, costUsd: null, model: null, raw: null }
    }
    try {
      const text = readFileSync(path, 'utf-8')
      let parsed: unknown
      try { parsed = JSON.parse(text) } catch { parsed = null }
      let tokensIn = 0, tokensOut = 0, modelName: string | null = null
      if (parsed && typeof parsed === 'object') {
        const stats = (parsed as Record<string, unknown>)['stats'] as Record<string, unknown> | undefined
        const models = stats?.['models'] as Record<string, unknown> | undefined
        if (models) {
          for (const [name, m] of Object.entries(models)) {
            if (!modelName) modelName = name
            const t = (m as Record<string, unknown>)?.['tokens'] as Record<string, unknown> | undefined
            tokensIn += Number(t?.['input'] ?? 0)
            tokensOut += Number(t?.['candidates'] ?? 0)
          }
        }
      }
      const costUsd = deriveCost(modelName, tokensIn, tokensOut)
      return { sessionLogPath: path, tokensIn, tokensOut, costUsd, model: modelName, raw: parsed }
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
