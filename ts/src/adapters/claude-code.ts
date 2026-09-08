import { register } from '../registry.js'
import type { Adapter, AgentStatus, BuildCommand, ParsedOutput, ReadyState, RunSpec, ScrollKeys, SessionTelemetry, SubprocOutcome } from '../base.js'
import { finalizeCommand, validateRunSpec } from '../base.js'
import { stripAnsi, lastNonEmptyJoin } from '../util.js'
import { deriveCost } from '../pricing.js'
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

// Session transcripts live at <config>/projects/<encoded cwd>/<session-id>.jsonl.
// Read from the Claude Code 2.1.220 native binary's embedded bundle (OpenClaude,
// a fork, ships the same algorithm in src/utils/sessionStoragePortable.ts):
//   config root:    NFC(CLAUDE_CONFIG_DIR ?? ~/.claude)
//   project key:    NFC(realpath(cwd)), or NFC(cwd) when realpath fails
//   directory name: /[^a-zA-Z0-9]/g -> '-'; names over 200 chars are cut to 200
//                   and suffixed '-' + base36(abs(djb2(project key)))
//   lookups also accept sibling directories sharing that 200-char prefix

export const PROJECT_DIR_NAME_LIMIT = 200

function djb2(text: string): number {
  let hash = 0
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0
  return hash
}

/** Directory name Claude-family CLIs use for `projectPath` under `projects/`. */
export function encodeProjectPath(projectPath: string): string {
  const sanitized = projectPath.replace(/[^a-zA-Z0-9]/g, '-')
  if (sanitized.length <= PROJECT_DIR_NAME_LIMIT) return sanitized
  return `${sanitized.slice(0, PROJECT_DIR_NAME_LIMIT)}-${Math.abs(djb2(projectPath)).toString(36)}`
}

/** NFC(realpath(workdir)); upstream keeps the unresolved path when realpath fails. */
export function canonicalProjectPath(workdir: string): string {
  const absolute = resolve(workdir)
  let resolved = absolute
  try { resolved = realpathSync(absolute) } catch { /* keep the unresolved path, like upstream */ }
  return resolved.normalize('NFC')
}

/**
 * NFC config root; Claude preserves an explicit empty path, OpenClaude does not.
 * Node's os.homedir() reads $HOME per call but Bun caches it at startup, so
 * $HOME is consulted directly first.
 */
export function configHome(envVar: string, defaultDirname: string, emptyIsUnset = false): string {
  const explicit = process.env[envVar]
  return resolve((explicit !== undefined && (explicit || !emptyIsUnset)
    ? explicit : join(process.env['HOME'] || homedir(), defaultDirname)).normalize('NFC'))
}

/**
 * Existing transcript directories for `projectPath`, exact match first. Mirrors
 * upstream resume lookups: a truncated name also matches sibling directories
 * sharing its 200-char prefix (hash suffixes differ across runtimes/versions).
 */
export function projectDirs(projectsRoot: string, projectPath: string): string[] {
  const encoded = encodeProjectPath(projectPath)
  const exact = join(projectsRoot, encoded)
  const dirs: string[] = []
  try { if (statSync(exact).isDirectory()) dirs.push(exact) } catch { /* no exact directory */ }
  if (encoded.length <= PROJECT_DIR_NAME_LIMIT) return dirs
  const prefix = encoded.slice(0, PROJECT_DIR_NAME_LIMIT) + '-'
  try {
    const siblings = readdirSync(projectsRoot, { withFileTypes: true })
      .filter(d => d.isDirectory() && d.name.startsWith(prefix))
      .map(d => join(projectsRoot, d.name))
      .sort()
    for (const candidate of siblings) if (candidate !== exact) dirs.push(candidate)
  } catch { /* projects root unreadable: exact match only */ }
  return dirs
}

function transcriptMatchesProject(path: string, projectPath: string): boolean {
  const fd = openSync(path, 'r')
  let header: string
  try {
    const buffer = Buffer.allocUnsafe(65536)
    header = buffer.toString('utf8', 0, readSync(fd, buffer, 0, buffer.length, 0))
  } finally { closeSync(fd) }
  for (const line of header.split('\n')) {
    let event: unknown
    try { event = JSON.parse(line) } catch { continue }
    const record = asRecord(event)
    if (!record || record['isSidechain']) continue
    const cwd = record['cwd']
    if (typeof cwd === 'string' && cwd.startsWith('/')) return canonicalProjectPath(cwd) === projectPath
  }
  return false
}

/** Newest matching-project JSONL at/after the epoch-milliseconds mtime cutoff. */
export function newestSessionLog(dirs: string[], projectPath: string, since?: number): string | null {
  let newest: { mtimeMs: number; path: string } | null = null
  for (const dir of dirs) {
    let names: string[]
    try { names = readdirSync(dir) } catch { continue }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue
      const path = join(dir, name)
      let stat
      try { stat = statSync(path) } catch { continue }
      if (!stat.isFile()) continue
      if (since !== undefined && stat.mtimeMs < since) continue
      if (newest !== null && (stat.mtimeMs < newest.mtimeMs || (stat.mtimeMs === newest.mtimeMs && path <= newest.path))) continue
      try {
        if (transcriptMatchesProject(path, projectPath)) newest = { mtimeMs: stat.mtimeMs, path }
      } catch { /* Unreadable artifact or missing identity. */ }
    }
  }
  return newest?.path ?? null
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/**
 * Sum assistant usage once per API message id; derive cost when no cost field
 * exists. Claude Code writes one transcript line per assistant content block,
 * each repeating the same `message.id` and `message.usage`; upstream groups
 * those lines by id, so usage is counted once per id here.
 */
export function parseClaudeTranscript(path: string): SessionTelemetry {
  if (!existsSync(path)) {
    return { sessionLogPath: path, tokensIn: null, tokensOut: null, costUsd: null, model: null, raw: null }
  }
  let tokensIn = 0, tokensOut = 0, costUsd = 0, modelName: string | null = null
  let sawUsage = false, sawCost = false
  const seenMessageIds = new Set<string>()
  const previousUsage = new Map<string, { input: number; output: number }>()
  try {
    for (const line of readFileSync(path, 'utf-8').split('\n')) {
      const t = line.trim()
      if (!t) continue
      let ev: unknown
      try { ev = JSON.parse(t) } catch { continue }
      const obj = asRecord(ev)
      if (!obj) continue
      const msg = asRecord(obj['message'])
      const usage = asRecord(msg?.['usage'])
      const messageId = msg?.['id']
      const duplicate = typeof messageId === 'string' && seenMessageIds.has(messageId)
      if (typeof messageId === 'string') seenMessageIds.add(messageId)
      if (usage) {
        const input = Number(usage['input_tokens'] ?? 0)
        const output = Number(usage['output_tokens'] ?? 0)
        const prior = typeof messageId === 'string' ? previousUsage.get(messageId) : undefined
        tokensIn += input - (prior?.input ?? 0)
        tokensOut += output - (prior?.output ?? 0)
        if (typeof messageId === 'string') previousUsage.set(messageId, { input, output })
        sawUsage = true
      }
      const cost = typeof obj['costUSD'] === 'number' ? obj['costUSD'] : obj['total_cost_usd']
      if (typeof cost === 'number' && !duplicate) { sawCost = true; costUsd += cost }
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

const claudeCodeAdapter: Adapter = {
  name: 'claude-code',
  instructionsFilename: 'CLAUDE.md',
  defaultModel: 'sonnet',
  scrollOwnership: 'fullscreen-aware',
  permissionBypassArgs: ['--dangerously-skip-permissions'],
  nativeOptionsKind: 'claude-code',
  configHomeEnv: 'CLAUDE_CONFIG_DIR',
  configFileFlag: '--settings',

  buildCommand(spec: RunSpec): BuildCommand {
    const validated = validateRunSpec(this, spec)
    const { model, permissionArgs, nativeArgs, configArgs } = validated
    const args = ['-p', spec.prompt, '--model', model, ...nativeArgs, '--output-format', 'json', ...permissionArgs, ...configArgs]
    // -p mode does not auto-walk workdir for CLAUDE.md; inject explicitly so
    // the instructions are always visible to the model.
    if (spec.instructions) {
      args.push('--append-system-prompt', spec.instructions)
    }
    return finalizeCommand(this, spec, validated, { cmd: 'claude', args })
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
// Persisted under the `tui` key in the user-scope settings.json inside the
// config root. When fullscreen, we forward C-M-e/y + NPage/PPage into the app;
// when default (or absent), real terminal scrollback works and we fall through
// to tmux.
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
  const path = join(configHome('CLAUDE_CONFIG_DIR', '.claude'), 'settings.json')
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

claudeCodeAdapter.sessionLogPath = function (workdir: string, since?: number): string | null {
  const projects = join(configHome('CLAUDE_CONFIG_DIR', '.claude'), 'projects')
  const projectPath = canonicalProjectPath(workdir)
  return newestSessionLog(projectDirs(projects, projectPath), projectPath, since)
}

claudeCodeAdapter.parseSessionLog = parseClaudeTranscript

claudeCodeAdapter.installMeta = {
  packageManager: 'npm',
  installCommand: ['npm', 'install', '-g', '@anthropic-ai/claude-code'],
  updateCommand: ['npm', 'install', '-g', '@anthropic-ai/claude-code@latest'],
  versionCommand: ['claude', '--version'],
}

register('claude-code', claudeCodeAdapter)
