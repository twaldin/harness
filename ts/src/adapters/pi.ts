import { register } from '../registry.js'
import type { Adapter, BuildCommand, ParsedOutput, RunSpec, SubprocOutcome, SessionTelemetry } from '../base.js'
import { finalizeCommand, validateRunSpec } from '../base.js'
import { stripAnsi, lastNonEmptyJoin } from '../util.js'
import { deriveCost } from '../pricing.js'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

// pi's --mode json writes one JSON object per stdout line. AssistantMessage.usage
// has { input, output, cacheRead, cacheWrite, totalTokens, cost: { total, ... } }.
// Each agent_end snapshot replaces that cycle's incremental messages, not
// earlier cycles. Retain completed messages when the last cycle is cut off.
// Docs: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/json.md

interface PiUsage {
  input?: number
  output?: number
  cost?: { total?: number }
}

interface PiAssistantMessage {
  role?: string
  usage?: PiUsage
}

interface PiEvent {
  type?: string
  message?: PiAssistantMessage
  messages?: PiAssistantMessage[]
}

function sumAssistantUsage(messages: PiAssistantMessage[]): { tokensIn: number; tokensOut: number; cost: number } {
  let tokensIn = 0
  let tokensOut = 0
  let cost = 0
  for (const msg of messages) {
    if (!msg || msg.role !== 'assistant') continue
    const usage = msg.usage ?? {}
    tokensIn += Number(usage.input ?? 0)
    tokensOut += Number(usage.output ?? 0)
    cost += Number(usage.cost?.total ?? 0)
  }
  return { tokensIn, tokensOut, cost }
}

function parsePiEvents(stdout: string): {
  tokensIn: number | null
  tokensOut: number | null
  costUsd: number | null
  raw: PiEvent[] | null
} {
  const events: PiEvent[] = []
  for (const line of stdout.split('\n')) {
    const s = line.trim()
    if (!s) continue
    try {
      const ev = JSON.parse(s) as PiEvent
      if (ev && typeof ev === 'object') events.push(ev)
    } catch {
      // skip non-JSON lines
    }
  }

  if (events.length === 0) {
    return { tokensIn: null, tokensOut: null, costUsd: null, raw: null }
  }

  let messages: PiAssistantMessage[] = []
  let currentMessage: PiAssistantMessage | undefined
  let tokensIn = 0
  let tokensOut = 0
  let cost = 0
  let hasUsage = false
  for (const ev of events) {
    if (ev.type === 'message_end') {
      if (ev.message?.role === 'assistant') currentMessage = ev.message
    } else if (ev.type === 'turn_end') {
      if (ev.message?.role === 'assistant') messages.push(ev.message)
      else if (currentMessage) messages.push(currentMessage)
      currentMessage = undefined
    } else if (ev.type === 'agent_end') {
      if (Array.isArray(ev.messages)) {
        messages = ev.messages
        hasUsage = true
      } else if (currentMessage) messages.push(currentMessage)
      const usage = sumAssistantUsage(messages)
      hasUsage ||= messages.some(msg => msg?.role === 'assistant')
      tokensIn += usage.tokensIn
      tokensOut += usage.tokensOut
      cost += usage.cost
      messages = []
      currentMessage = undefined
    }
  }

  if (currentMessage) messages.push(currentMessage)
  const usage = sumAssistantUsage(messages)
  if (!hasUsage && messages.length === 0) {
    return { tokensIn: null, tokensOut: null, costUsd: null, raw: events }
  }
  return {
    tokensIn: tokensIn + usage.tokensIn, tokensOut: tokensOut + usage.tokensOut,
    costUsd: cost + usage.cost, raw: events,
  }
}

const piAdapter: Adapter = {
  name: 'pi',
  instructionsFilename: 'AGENTS.md',
  defaultModel: 'sonnet',

  buildCommand(spec: RunSpec): BuildCommand {
    const validated = validateRunSpec(this, spec)
    return finalizeCommand(this, spec, validated, {
      cmd: 'pi',
      args: ['--mode', 'json', '--no-session', '--model', validated.model, spec.prompt],
    })
  },

  parseOutput(_spec: RunSpec, outcome: SubprocOutcome): ParsedOutput {
    const { tokensIn, tokensOut, costUsd, raw } = parsePiEvents(outcome.stdout)
    return { costUsd, tokensIn, tokensOut, raw }
  },
}

// ===== session-aware additions =====

piAdapter.submitKeys = ['Enter']

// pi's idle prompt has a footer line with cost/token stats:
// "↑39k ↓6.4k R84k $0.428 (sub) 14.7%/272k (auto)". The "(sub)" + cost
// pattern is reliable and only renders when pi is at a usable prompt.
const PI_IDLE_FOOTER_RE = /\$\d+\.\d+\s+\(sub\)/

piAdapter.detectReady = function (pane: string) {
  const stripped = stripAnsi(pane)
  const last20 = lastNonEmptyJoin(pane, 20)
  const lines = stripped.split('\n')
  // Idle-prompt footer is authoritative — present means pi is ready, regardless
  // of whether an "Update Available" banner is also showing above it.
  if (PI_IDLE_FOOTER_RE.test(stripped)) return 'ready'
  if (/\/[a-z][a-z0-9_-]*/i.test(last20) && /pi|model|provider/i.test(last20)) return 'ready'
  if (lines.some(l => /^\s*[>❯]\s*$/.test(l.trim()))) return 'ready'
  if (/chatgpt plus|login|oauth|select a provider/i.test(last20)) return 'ready'
  // Banner check is a last-resort fallback — only fires if no prompt is visible
  // yet. handleDialog returns null since the banner isn't dismissable.
  if (/Update Available/i.test(last20)) return 'dialog'
  return 'loading'
}

piAdapter.handleDialog = function (pane: string) {
  // pi's "Update Available" is a banner, not a blocking modal — no key dismisses it.
  // Return null so the controller doesn't repeatedly send keys; the prompt is still
  // usable below the banner.
  if (/Update Available/i.test(stripAnsi(pane))) return null
  return null
}

piAdapter.detectStatus = function (pane: string) {
  // pi's UI is binary: when a model turn is in flight, the working banner
  // contains a braille spinner glyph followed by 'Working...'. When the turn
  // ends, the spinner disappears and the prompt is restored. Pi prints model
  // OUTPUT (test failures, error messages, stack traces) into the pane during
  // and after a turn — those words MUST NOT influence status detection. Only
  // the spinner is authoritative.
  const last10 = lastNonEmptyJoin(pane, 10)
  // Rate-limit overlay is a specific status-bar message (not free-form text).
  if (/^.*rate.?limit/im.test(last10) && /retry|wait|seconds/i.test(last10)) return 'rate-limited'
  if (/[⠁-⣿]\s*Working\.\.\./i.test(last10)) return 'running'
  return 'idle'
}

// ~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<sid>.jsonl
// Encoding: '--' + realpath(workdir).replaceAll('/', '-') + '--'
// (TWO leading dashes, TWO trailing dashes; underscores preserved).
//   /private/var/folders/cf/sgp0bvks6t7br_0q2kj_5jpm0000gn/T/flt-wt-probe-pi
//   → --private-var-folders-cf-sgp0bvks6t7br_0q2kj_5jpm0000gn-T-flt-wt-probe-pi--
piAdapter.sessionLogPath = function (workdir: string, _since?: number): string | null {
  const home = process.env.HOME ?? ''
  let real = workdir
  try { real = require('node:fs').realpathSync(workdir) } catch { /* fall back */ }
  const encoded = '-' + real.replace(/\//g, '-') + '--'
  const dir = join(home, '.pi', 'agent', 'sessions', encoded)
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

piAdapter.parseSessionLog = function (path: string): SessionTelemetry {
  if (!existsSync(path)) {
    return { sessionLogPath: path, tokensIn: null, tokensOut: null, costUsd: null, model: null, raw: null }
  }
  let tokensIn = 0, tokensOut = 0, costUsd = 0
  let modelName: string | null = null
  let sawUsage = false, sawCost = false
  try {
    for (const line of readFileSync(path, 'utf-8').split('\n')) {
      const t = line.trim()
      if (!t.startsWith('{')) continue
      let ev: unknown
      try { ev = JSON.parse(t) } catch { continue }
      if (!ev || typeof ev !== 'object') continue
      const obj = ev as Record<string, unknown>
      if (obj['type'] === 'model_change') {
        const m = obj['modelId']
        if (typeof m === 'string' && !modelName) modelName = m
      }
      const message = obj['message'] as Record<string, unknown> | undefined
      const usage = message?.['usage'] as Record<string, unknown> | undefined
      if (usage) {
        sawUsage = true
        tokensIn += Number(usage['input'] ?? 0)
        tokensOut += Number(usage['output'] ?? 0)
        const c = (usage['cost'] as Record<string, unknown> | undefined)?.['total']
        if (typeof c === 'number') { sawCost = true; costUsd += c }
      }
    }
  } catch {
    return { sessionLogPath: path, tokensIn: null, tokensOut: null, costUsd: null, model: null, raw: null }
  }
  const ti = sawUsage ? tokensIn : null
  const to = sawUsage ? tokensOut : null
  const cost = sawCost ? costUsd : deriveCost(modelName, ti, to)
  return { sessionLogPath: path, tokensIn: ti, tokensOut: to, costUsd: cost, model: modelName, raw: null }
}

piAdapter.installMeta = {
  packageManager: 'npm',
  installCommand: ['npm', 'install', '-g', '--ignore-scripts', '@earendil-works/pi-coding-agent'],
  updateCommand: ['npm', 'install', '-g', '--ignore-scripts', '@earendil-works/pi-coding-agent@latest'],
  versionCommand: ['pi', '--version'],
}

register('pi', piAdapter)
