import { register } from '../registry.js'
import { writeInstructions } from '../subproc.js'
import type { Adapter, AgentStatus, BuildCommand, ParsedOutput, ReadyState, RunSpec, ScrollKeys, SessionTelemetry, SubprocOutcome } from '../base.js'
import { normalizeModelForHarness } from '../model-normalization.js'
import { stripAnsi, lastNonEmptyJoin } from '../util.js'
import { deriveCost } from '../pricing.js'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

function stripMarkdownFences(s: string): string {
  const m = /^```(?:[a-z]+)?\n([\s\S]*?)\n```\s*$/.exec(s)
  return m ? m[1]! : s
}

const claudeCodeAdapter: Adapter = {
  name: 'claude-code',
  instructionsFilename: 'CLAUDE.md',
  defaultModel: 'sonnet',
  scrollOwnership: 'fullscreen-aware',

  buildCommand(spec: RunSpec): BuildCommand {
    const model = normalizeModelForHarness(this.name, spec.model ?? this.defaultModel, { resolve: !spec.modelNoResolve }) ?? this.defaultModel
    const instructionsFile = writeInstructions(spec.workdir, this.instructionsFilename, spec.instructions)
    const args = ['-p', spec.prompt, '--model', model, '--output-format', 'json', '--dangerously-skip-permissions']
    // -p mode does not auto-walk workdir for CLAUDE.md; inject explicitly so
    // the instructions are always visible to the model.
    if (spec.instructions) {
      args.push('--append-system-prompt', spec.instructions)
    }
    return {
      cmd: 'claude',
      args,
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
    if (raw !== null && typeof raw === 'object' && raw !== null) {
      const obj = raw as Record<string, unknown>
      // Strip markdown fences that claude-code occasionally wraps output in.
      if (typeof obj['result'] === 'string') {
        obj['result'] = stripMarkdownFences(obj['result'] as string)
      }
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
}

// ===== session-aware additions =====

claudeCodeAdapter.submitKeys = ['Enter']

// claude-code's `/tui` slash command toggles between the classic main-screen
// renderer ("default") and the alt-screen virtualized renderer ("fullscreen").
// Persisted under the `tui` key in ~/.claude/settings.json. When fullscreen,
// we forward C-M-e/y + NPage/PPage into the app; when default (or absent),
// real terminal scrollback works and we fall through to tmux.
//
// v1: user-scope only. The full claude-code precedence ladder
// (managed → local → project → user) is intentionally deferred — user-scope
// is where /tui-style global preferences land and is sufficient in practice.
const CLAUDE_CODE_FULLSCREEN_SCROLL_KEYS: ScrollKeys = {
  lineDown: 'C-M-e',
  lineUp: 'C-M-y',
  pageDown: 'NPage',
  pageUp: 'PPage',
}

function readClaudeCodeTuiMode(): string | null {
  const home = process.env['HOME'] ?? homedir()
  const path = join(home, '.claude', 'settings.json')
  if (!existsSync(path)) return null
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as unknown
    if (raw && typeof raw === 'object') {
      const v = (raw as Record<string, unknown>)['tui']
      return typeof v === 'string' ? v : null
    }
  } catch {
    // unreadable / malformed settings → treat as "default"
  }
  return null
}

claudeCodeAdapter.getCurrentScrollKeys = function (): ScrollKeys | null {
  return readClaudeCodeTuiMode() === 'fullscreen' ? CLAUDE_CODE_FULLSCREEN_SCROLL_KEYS : null
}

claudeCodeAdapter.detectReady = function (pane: string) {
  const last20 = lastNonEmptyJoin(pane, 20)
  const all = stripAnsi(pane)
  const hasPrompt = stripAnsi(pane).split('\n').some(l => /^\s*[>❯]\s*$/.test(l.trim()))
  const hasStatusBar = /bypass permissions/i.test(all) || /Claude Code/i.test(all)
  if (hasPrompt && hasStatusBar) return 'ready'
  if (/bypass.?permissions/i.test(last20) && /Yes, I accept/i.test(last20)) return 'dialog'
  if (/trust this folder/i.test(last20) || /Do you trust the files/i.test(last20)) return 'dialog'
  if (/Update available/i.test(last20) && /\?/.test(last20)) return 'dialog'
  return 'loading'
}

claudeCodeAdapter.handleDialog = function (pane: string) {
  const text = stripAnsi(pane)
  if (/bypass.?permissions/i.test(text) && /Yes, I accept/i.test(text)) return ['2', 'Enter']
  if (/trust this folder/i.test(text) || /Do you trust the files/i.test(text)) return ['Enter']
  // Decline updates mid-run; explicit `flt clis update` is the install path.
  if (/Update available/i.test(text)) return ['Escape']
  return null
}

claudeCodeAdapter.detectStatus = function (pane: string) {
  const last10 = lastNonEmptyJoin(pane, 10)
  if (/rate.?limit|hit your limit/i.test(last10)) return 'rate-limited'
  if (/Update available/i.test(last10) && /\?/.test(last10)) return 'dialog'
  // claude-code shows "(Xs · ↑M ↓N)" or "·X tokens·" while running
  if (/\((?:\d+m\s+)?\d+s[\s·)]/.test(last10)) return 'running'
  // Idle: prompt visible without timer
  if (stripAnsi(pane).split('\n').some(l => /^\s*[>❯]\s*$/.test(l.trim()))) return 'idle'
  return 'unknown'
}

// ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl
// Encoding: realpath(workdir) → replace both '/' and '_' with '-'.
//   /private/var/folders/cf/sgp0bvks6t7br_0q2kj_5jpm0000gn/T/flt-wt-probe-claude-code
//   → -private-var-folders-cf-sgp0bvks6t7br-0q2kj-5jpm0000gn-T-flt-wt-probe-claude-code
claudeCodeAdapter.sessionLogPath = function (workdir: string, _since?: number): string | null {
  const home = process.env.HOME ?? ''
  let real = workdir
  try { real = require('node:fs').realpathSync(workdir) } catch { /* fall back */ }
  const encoded = real.replace(/[\/_]/g, '-')
  const dir = join(home, '.claude', 'projects', encoded)
  if (!existsSync(dir)) return null
  try {
    const items = readdirSync(dir)
      .filter(n => n.endsWith('.jsonl'))
      .map(n => ({ n, t: statSync(join(dir, n)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
    const newest = items[0]
    return newest ? join(dir, newest.n) : null
  } catch {
    return null
  }
}

claudeCodeAdapter.parseSessionLog = function (path: string): SessionTelemetry {
  if (!existsSync(path)) {
    return { sessionLogPath: path, tokensIn: null, tokensOut: null, costUsd: null, model: null, raw: null }
  }
  let tokensIn = 0, tokensOut = 0, costUsd = 0, modelName: string | null = null
  let sawUsage = false, sawCost = false
  try {
    for (const line of readFileSync(path, 'utf-8').split('\n')) {
      const t = line.trim()
      if (!t) continue
      let ev: unknown
      try { ev = JSON.parse(t) } catch { continue }
      if (!ev || typeof ev !== 'object') continue
      const obj = ev as Record<string, unknown>
      const msg = obj['message'] as Record<string, unknown> | undefined
      const usage = msg?.['usage'] as Record<string, unknown> | undefined
      if (usage) {
        sawUsage = true
        tokensIn += Number(usage['input_tokens'] ?? 0)
        tokensOut += Number(usage['output_tokens'] ?? 0)
      }
      const cost = obj['costUSD'] ?? obj['total_cost_usd']
      if (typeof cost === 'number') { sawCost = true; costUsd += cost }
      const model = msg?.['model']
      // Skip claude-code's "<synthetic>" placeholder — that's an
      // autoresponder/interrupt turn, not a real model invocation. Pick the
      // first NON-synthetic string instead.
      if (typeof model === 'string' && model !== '<synthetic>' && !modelName) modelName = model
    }
  } catch {
    return { sessionLogPath: path, tokensIn: null, tokensOut: null, costUsd: null, model: null, raw: null }
  }
  const finalTokensIn = sawUsage ? tokensIn : null
  const finalTokensOut = sawUsage ? tokensOut : null
  const finalCost = sawCost ? costUsd : deriveCost(modelName, finalTokensIn, finalTokensOut)
  return { sessionLogPath: path, tokensIn: finalTokensIn, tokensOut: finalTokensOut, costUsd: finalCost, model: modelName, raw: null }
}

claudeCodeAdapter.installMeta = {
  packageManager: 'npm',
  installCommand: ['npm', 'install', '-g', '@anthropic-ai/claude-code'],
  updateCommand: ['npm', 'install', '-g', '@anthropic-ai/claude-code@latest'],
  versionCommand: ['claude', '--version'],
}

register('claude-code', claudeCodeAdapter)
