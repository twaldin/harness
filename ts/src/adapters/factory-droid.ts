/**
 * Factory Droid adapter — invokes `droid exec` in headless JSON mode.
 *
 * Session artifacts (droid 0.213.0 binary, `@factory/droid-sdk` 0.9.1
 * `src/session-discovery.ts`): `<FACTORY_HOME_OVERRIDE or ~>/.factory/sessions/`
 * holds one project directory per working directory, named `-` + realpath with
 * `/` runs replaced by `-` (`/Users/me/app` -> `-Users-me-app`). Each session is
 * `<uuid>.jsonl` (first line `{"type":"session_start","cwd":...}`) plus
 * `<uuid>.settings.json` (`model`, `tokenUsage.{inputTokens,outputTokens,...}`).
 * Older builds wrote `<uuid>.jsonl` flat in `sessions/`; those are matched by
 * their `session_start.cwd`. Usage never appears in the `--output-format json`
 * envelope and Factory bills credits, not USD, so cost stays null.
 */
import { register } from '../registry.js'
import type { Adapter, AgentStatus, BuildCommand, ParsedOutput, ReadyState, RunSpec, SessionTelemetry, SubprocOutcome } from '../base.js'
import { finalizeCommand, validateRunSpec } from '../base.js'
import { stripAnsi, lastNonEmptyJoin } from '../util.js'
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { homedir } from 'node:os'

const SETTINGS_SUFFIX = '.settings.json'
const SESSION_START_BYTES = 65536 // upstream reads the first 64 KiB for the session_start line

function parseLastJsonObject(stdout: string): Record<string, unknown> | null {
  const blob = stdout.trim()
  if (blob) {
    try {
      const parsed = JSON.parse(blob) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      // fall back to JSONL parse
    }
  }

  const lines = stdout.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim()
    if (!line.startsWith('{')) continue
    try {
      const parsed = JSON.parse(line) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      continue
    }
  }
  return null
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function asInt(value: unknown): number | null {
  const n = asNumber(value)
  return n === null ? null : Math.trunc(n)
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

/** `<FACTORY_HOME_OVERRIDE or ~>/.factory/sessions`; the override replaces `~`, not `~/.factory`. */
export function factorySessionsDir(): string {
  return join(process.env['FACTORY_HOME_OVERRIDE'] || process.env['HOME'] || homedir(), '.factory', 'sessions')
}

/** `-` + cwd without leading/trailing slashes and every `/` run replaced by `-` (POSIX rule). */
export function encodeProjectDir(cwd: string): string {
  return `-${cwd.replace(/^\/+|\/+$/g, '').replace(/\/+/g, '-')}`
}

function canonicalCwd(workdir: string): string {
  const absolute = resolve(workdir)
  try { return realpathSync(absolute) } catch { return absolute }
}

function jsonlFiles(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
      .map((e) => join(dir, e.name))
  } catch {
    return []
  }
}

/** `cwd` from a session file's first `session_start` line, or null. */
function sessionStartCwd(path: string): string | null {
  let head: string
  try {
    const fd = openSync(path, 'r')
    try {
      const buf = Buffer.allocUnsafe(SESSION_START_BYTES)
      head = buf.toString('utf8', 0, readSync(fd, buf, 0, SESSION_START_BYTES, 0))
    } finally {
      closeSync(fd)
    }
  } catch {
    return null
  }
  const newline = head.indexOf('\n')
  let event: unknown
  try { event = JSON.parse(newline === -1 ? head : head.slice(0, newline)) } catch { return null }
  const record = asRecord(event)
  if (!record || record['type'] !== 'session_start') return null
  return typeof record['cwd'] === 'string' ? record['cwd'] : null
}

function readJsonObject(path: string): Record<string, unknown> | null {
  try { return asRecord(JSON.parse(readFileSync(path, 'utf8'))) } catch { return null }
}

/** `message.modelId` of the last assistant line (recent droid builds stamp it; older ones do not). */
function lastAssistantModelId(path: string): string | null {
  let text: string
  try { text = readFileSync(path, 'utf8') } catch { return null }
  let model: string | null = null
  for (const line of text.split('\n')) {
    if (!line.includes('"modelId"')) continue
    let event: unknown
    try { event = JSON.parse(line) } catch { continue }
    const message = asRecord(asRecord(event)?.['message'])
    if (message && message['role'] === 'assistant' && typeof message['modelId'] === 'string') model = message['modelId']
  }
  return model
}

function findFactorySession(workdir: string, since?: number): string | null {
  const cwd = canonicalCwd(workdir)
  const sessions = factorySessionsDir()
  const candidates = jsonlFiles(join(sessions, encodeProjectDir(cwd)))
  // Older builds use a flat directory; both layouts require matching cwd.
  candidates.push(...jsonlFiles(sessions))

  let newest: { mtimeMs: number; path: string } | null = null
  for (const path of candidates) {
    let mtimeMs: number
    try { mtimeMs = statSync(path).mtimeMs } catch { continue }
    if (since !== undefined && mtimeMs < since) continue
    if (newest !== null && (mtimeMs < newest.mtimeMs || (mtimeMs === newest.mtimeMs && path <= newest.path))) continue
    if (sessionStartCwd(path) === cwd) newest = { mtimeMs, path }
  }
  return newest === null ? null : newest.path
}

const factoryDroidAdapter: Adapter = {
  name: 'factory-droid',
  instructionsFilename: 'AGENTS.md',
  defaultModel: 'gpt-5.4',
  permissionBypassArgs: ['--skip-permissions-unsafe'],

  buildCommand(spec: RunSpec): BuildCommand {
    const validated = validateRunSpec(this, spec)
    const { model, permissionArgs } = validated
    return finalizeCommand(this, spec, validated, {
      cmd: 'droid',
      args: [
        'exec',
        '--output-format',
        'json',
        ...permissionArgs,
        '--model',
        model,
        '--spec-model',
        model,
        spec.prompt,
      ],
    })
  },

  parseOutput(_spec: RunSpec, outcome: SubprocOutcome): ParsedOutput {
    const raw = parseLastJsonObject(outcome.stdout)
    if (!raw) return { costUsd: null, tokensIn: null, tokensOut: null, raw: null }

    const usage = raw['usage']
    const usageObj = usage && typeof usage === 'object' && !Array.isArray(usage) ? usage as Record<string, unknown> : {}

    let costUsd = asNumber(raw['total_cost_usd'])
    if (costUsd === null) {
      const usageCost = usageObj['cost']
      if (typeof usageCost === 'number') {
        costUsd = usageCost
      } else if (usageCost && typeof usageCost === 'object' && !Array.isArray(usageCost)) {
        costUsd = asNumber((usageCost as Record<string, unknown>)['total'])
      }
    }

    return {
      costUsd,
      tokensIn: asInt(usageObj['input_tokens'] ?? usageObj['input']),
      tokensOut: asInt(usageObj['output_tokens'] ?? usageObj['output']),
      raw,
    }
  },

  sessionLogPath(workdir: string, since?: number): string | null {
    return findFactorySession(workdir, since)
  },

  parseSessionLog(path: string): SessionTelemetry {
    const settingsPath = path.endsWith(SETTINGS_SUFFIX) ? path : join(dirname(path), basename(path, extname(path)) + SETTINGS_SUFFIX)
    const settings = readJsonObject(settingsPath)
    if (settings === null && !existsSync(path)) {
      return { sessionLogPath: path, tokensIn: null, tokensOut: null, costUsd: null, model: null, raw: null }
    }
    const usage = asRecord(settings?.['tokenUsage']) ?? {}
    const modelField = settings?.['model']
    let model = typeof modelField === 'string' ? modelField : null
    if (model === null && settingsPath !== path) model = lastAssistantModelId(path)
    return {
      sessionLogPath: path,
      tokensIn: asInt(usage['inputTokens']),
      tokensOut: asInt(usage['outputTokens']),
      costUsd: null,
      model,
      raw: settings,
    }
  },
}

factoryDroidAdapter.submitKeys = ['Enter']
factoryDroidAdapter.detectReady = function (pane: string): ReadyState {
  const last30 = lastNonEmptyJoin(pane, 30)
  if (/Try\s+"/i.test(last30) || /Auto.*\(Off\)|Auto.*\(On\)/i.test(last30)) return 'ready'
  if (/Update available/i.test(last30)) return 'dialog'
  return 'loading'
}
factoryDroidAdapter.handleDialog = function (pane: string): string[] | null {
  if (/Update available/i.test(stripAnsi(pane))) return ['Escape']
  return null
}
factoryDroidAdapter.detectStatus = function (pane: string): AgentStatus {
  const last10 = lastNonEmptyJoin(pane, 10)
  if (/rate.?limit/i.test(last10)) return 'rate-limited'
  if (/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(last10) || /Thinking|Working/i.test(last10)) return 'running'
  if (/Try\s+"|Auto.*\(/i.test(last10)) return 'idle'
  return 'unknown'
}
factoryDroidAdapter.installMeta = {
  packageManager: 'npm',
  installCommand: ['npm', 'install', '-g', 'droid'],
  updateCommand: ['npm', 'install', '-g', 'droid@latest'],
  versionCommand: ['droid', '--version'],
}

register('factory-droid', factoryDroidAdapter)
