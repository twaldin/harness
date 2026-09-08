import { register } from '../registry.js'
import type { Adapter, AgentStatus, BuildCommand, ParsedOutput, ReadyState, RunSpec, SessionTelemetry, SubprocOutcome } from '../base.js'
import { finalizeCommand, validateRunSpec } from '../base.js'
import { stripAnsi, lastNonEmptyJoin } from '../util.js'
import { existsSync, openSync, readSync, closeSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { deriveCost } from '../pricing.js'

type QwenStats = { tokensIn: number | null; tokensOut: number | null; costUsd: number | null; model: string | null; raw: unknown | null }

function parseQwenStatsBlob(blob: string): QwenStats {
  let parsed: unknown
  try {
    parsed = JSON.parse(blob)
  } catch {
    return { tokensIn: null, tokensOut: null, costUsd: null, model: null, raw: null }
  }
  return statsFromParsed(parsed)
}

function statsFromParsed(parsed: unknown): QwenStats {
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

// SessionService.SESSION_FILE_PATTERN: sidecars (.runtime.json, .ledger.jsonl, .pr.json) never match.
const SESSION_FILE_RE = /^[0-9a-fA-F-]{32,36}\.jsonl$/
const RUNTIME_SNAPSHOT_PREFIX = '$runtime|'

/** Parsed JSON as an object record, or null for scalars/arrays. */
function jsonObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

/** `Storage.resolvePath`: leading `~` expands to the home dir; relative paths resolve against the CLI cwd. */
function resolveQwenPath(value: string, cwd: string): string {
  if (value === '~' || value.startsWith('~/') || value.startsWith('~\\')) {
    return join(process.env.HOME ?? homedir(), ...value.slice(2).split(/[/\\]+/).filter(Boolean))
  }
  return isAbsolute(value) ? value : resolve(cwd, value)
}

/**
 * `Storage.getRuntimeBaseDir()`: `QWEN_RUNTIME_DIR`, else `QWEN_HOME`, else
 * `~/.qwen`. The settings-file `runtimeOutputDir` override is not consulted.
 */
function qwenRuntimeDir(workdir: string): string {
  const runtime = process.env['QWEN_RUNTIME_DIR']
  if (runtime) return resolveQwenPath(runtime, workdir)
  const home = process.env['QWEN_HOME']
  if (home) return resolveQwenPath(home, workdir)
  return join(process.env.HOME ?? homedir(), '.qwen')
}

/** Spellings qwen-code may have used as the project root (`path.resolve(process.cwd())`, physical path first). */
function projectRoots(workdir: string): string[] {
  const absolute = resolve(workdir)
  let real = absolute
  try {
    real = realpathSync(workdir)
  } catch {
    /* keep the literal path */
  }
  return real === absolute ? [real] : [real, absolute]
}

/** `cwd` of the first record; qwen-code's own project-membership check reads the same field. */
function sessionCwd(path: string): string | null {
  let first: string | undefined
  try {
    const fd = openSync(path, 'r')
    try {
      const buffer = Buffer.alloc(64 * 1024)
      const read = readSync(fd, buffer, 0, buffer.length, 0)
      first = buffer.toString('utf-8', 0, read).split('\n').find(line => line.trim())
    } finally {
      closeSync(fd)
    }
  } catch {
    return null
  }
  if (first === undefined) return null
  let record: unknown
  try {
    record = JSON.parse(first)
  } catch {
    return null
  }
  const cwd = jsonObject(record)?.['cwd']
  return typeof cwd === 'string' ? cwd : null
}

/**
 * Parse a chats/ JSONL transcript; null when no line is a ChatRecord. Records
 * are keyed by `uuid` (last write wins) so a re-emitted record is never counted twice.
 */
function qwenRecords(text: string): Record<string, unknown>[] | null {
  const records = new Map<string, Record<string, unknown>>()
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!
    if (!line.trim()) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    const record = jsonObject(parsed)
    if (!record || typeof record['type'] !== 'string' || typeof record['sessionId'] !== 'string') continue
    const uuid = record['uuid']
    records.set(typeof uuid === 'string' ? uuid : `line:${index}`, record)
  }
  return records.size > 0 ? [...records.values()] : null
}

/** Nonnegative safe integer; an absent field counts as 0 (upstream `?? 0`). */
function usageCount(value: unknown): number | null {
  if (value == null) return 0
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

/**
 * Sum `usageMetadata.{promptTokenCount,candidatesTokenCount}` over assistant
 * records. Only per-turn usageMetadata is counted; `ui_telemetry` and other
 * system snapshots are cumulative views of the same usage and are ignored.
 * Null until any assistant record reports usage.
 */
function recordsUsage(records: Record<string, unknown>[]): { tokensIn: number | null; tokensOut: number | null; model: string | null } {
  let tokensIn: number | null = null
  let tokensOut: number | null = null
  let model: string | null = null
  const usageModels = new Set<string | null>()
  for (const record of records) {
    if (record['type'] !== 'assistant') continue
    let recordModel: string | null = null
    if (typeof record['model'] === 'string' && record['model']) {
      let name: string = record['model']
      while (name.startsWith(RUNTIME_SNAPSHOT_PREFIX)) {
        const stripped = name.split('|').slice(2).join('|')
        if (!stripped) break
        name = stripped
      }
      model = name
      recordModel = name
    }
    if (record['usageMetadata'] == null) continue
    const usage = jsonObject(record['usageMetadata'])
    if (!usage) return { tokensIn: null, tokensOut: null, model }
    const countIn = usageCount(usage['promptTokenCount'])
    const countOut = usageCount(usage['candidatesTokenCount'])
    if (countIn === null || countOut === null) return { tokensIn: null, tokensOut: null, model }
    usageModels.add(recordModel)
    tokensIn = (tokensIn ?? 0) + countIn
    tokensOut = (tokensOut ?? 0) + countOut
    if (!Number.isSafeInteger(tokensIn) || !Number.isSafeInteger(tokensOut)) return { tokensIn: null, tokensOut: null, model }
  }
  if (usageModels.size) model = usageModels.size === 1 ? usageModels.values().next().value ?? null : null
  return { tokensIn, tokensOut, model }
}

const qwenAdapter: Adapter = {
  name: 'qwen',
  instructionsFilename: 'QWEN.md',
  defaultModel: 'qwen3-coder',
  permissionBypassArgs: ['-y'],

  buildCommand(spec: RunSpec): BuildCommand {
    const validated = validateRunSpec(this, spec)
    const { model, permissionArgs } = validated
    return finalizeCommand(this, spec, validated, {
      cmd: 'qwen',
      args: ['-p', spec.prompt, ...permissionArgs, '-m', model, '--output-format', 'json'],
    })
  },

  parseOutput(_spec: RunSpec, outcome: SubprocOutcome): ParsedOutput {
    // Current qwen emits a JSON array whose last `type: "result"` item carries
    // usage. Older versions emit a `stats.models[*]` envelope object; keep that
    // fallback so headless parsing matches the Python adapter.
    const candidates: string[] = [outcome.stdout.trim()]
    for (const ln of outcome.stdout.split('\n')) {
      const s = ln.trim()
      if (s.startsWith('[') || s.startsWith('{')) candidates.push(s)
    }

    for (const blob of candidates) {
      if (!blob) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(blob)
      } catch {
        continue
      }
      if (!Array.isArray(parsed)) {
        const stats = statsFromParsed(parsed)
        if (stats.tokensIn === null) continue
        if (!Number.isFinite(stats.tokensIn) || !Number.isFinite(stats.tokensOut)) {
          throw new Error('Invalid Qwen token totals')
        }
        return { costUsd: null, tokensIn: stats.tokensIn, tokensOut: stats.tokensOut, raw: parsed }
      }
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

  // qwen-code records interactive sessions as
  // <QWEN_RUNTIME_DIR|QWEN_HOME|~/.qwen>/projects/<sanitizeCwd(projectRoot)>/chats/<sessionId>.jsonl.
  // Sanitised paths can collide, so the first record's literal cwd decides membership.
  sessionLogPath(workdir: string, since?: number): string | null {
    const roots = projectRoots(workdir)
    const projects = join(qwenRuntimeDir(workdir), 'projects')
    let best: { mtime: number; name: string; path: string } | null = null
    for (const chats of new Set(roots.map(root => join(projects, root.replace(/[^a-zA-Z0-9]/g, '-'), 'chats')))) {
      let entries: string[]
      try {
        entries = readdirSync(chats)
      } catch {
        continue
      }
      for (const name of entries) {
        if (!SESSION_FILE_RE.test(name)) continue
        const path = join(chats, name)
        let mtime: number
        try {
          const stat = statSync(path)
          if (!stat.isFile()) continue
          mtime = stat.mtimeMs
        } catch {
          continue
        }
        if (since !== undefined && mtime < since) continue
        if (best && (mtime < best.mtime || (mtime === best.mtime && name <= best.name))) continue
        const cwd = sessionCwd(path)
        if (cwd === null || !roots.includes(cwd)) continue
        best = { mtime, name, path }
      }
    }
    return best?.path ?? null
  },

  parseSessionLog(path: string): SessionTelemetry {
    if (!existsSync(path)) {
      return { sessionLogPath: path, tokensIn: null, tokensOut: null, costUsd: null, model: null, raw: null }
    }
    let rawText: string
    try {
      rawText = readFileSync(path, 'utf-8')
    } catch {
      return { sessionLogPath: path, tokensIn: null, tokensOut: null, costUsd: null, model: null, raw: null }
    }
    const records = qwenRecords(rawText)
    if (records !== null) {
      const { tokensIn, tokensOut, model } = recordsUsage(records)
      const costUsd = tokensIn === null ? null : deriveCost(model, tokensIn, tokensOut)
      return { sessionLogPath: path, tokensIn, tokensOut, costUsd, model, raw: records }
    }
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
    try {
      return { sessionLogPath: path, tokensIn: null, tokensOut: null, costUsd: null, model: null, raw: JSON.parse(rawText) as unknown }
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
