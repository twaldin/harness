import { register } from '../registry.js'
import type { Adapter, AgentStatus, BuildCommand, ParsedOutput, ReadyState, RunSpec, SessionTelemetry, SubprocOutcome } from '../base.js'
import { finalizeCommand, validateRunSpec } from '../base.js'
import { stripAnsi, lastNonEmptyJoin } from '../util.js'
import { deriveCost } from '../pricing.js'
import { existsSync, openSync, readSync, closeSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'

function geminiTokenCount(value: unknown): number | null {
  if (value == null) return 0
  if (typeof value === 'string') {
    if (!/^\s*\+?[0-9]+\s*$/.test(value)) return null
    value = Number(value)
  }
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

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
  if (!models || typeof models !== 'object' || Array.isArray(models)) return { tokensIn: null, tokensOut: null, costUsd: null, model: null, raw: parsed }
  let tokensIn = 0
  let tokensOut = 0
  let modelName: string | null = null
  for (const [name, modelStats] of Object.entries(models as Record<string, unknown>)) {
    if (!modelStats || typeof modelStats !== 'object' || Array.isArray(modelStats)) continue
    if (!modelName) modelName = name
    const tokens = (modelStats as Record<string, unknown>)['tokens'] ?? {}
    if (typeof tokens !== 'object' || Array.isArray(tokens)) return { tokensIn: null, tokensOut: null, costUsd: null, model: null, raw: parsed }
    const t = tokens as Record<string, unknown>
    const countIn = geminiTokenCount(t['input'])
    const countOut = geminiTokenCount(t['candidates'])
    if (countIn === null || countOut === null) return { tokensIn: null, tokensOut: null, costUsd: null, model: null, raw: parsed }
    tokensIn += countIn
    tokensOut += countOut
    if (!Number.isSafeInteger(tokensIn) || !Number.isSafeInteger(tokensOut)) return { tokensIn: null, tokensOut: null, costUsd: null, model: null, raw: parsed }
  }
  return {
    tokensIn,
    tokensOut,
    costUsd: deriveCost(modelName, tokensIn, tokensOut),
    model: modelName,
    raw: parsed,
  }
}

const SESSION_FILE_RE = /^session-.*\.jsonl?$/

type GeminiConversation = Record<string, unknown> & { messages: Record<string, unknown>[] }

/** Parsed JSON as an object record, or null for scalars/arrays. */
function jsonObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

/**
 * Spellings gemini-cli may have used as the project root for `workdir`. The CLI
 * keys everything on `path.resolve(process.cwd())`; `process.cwd()` is the
 * physical path, so the realpath comes first with the literal absolute path as
 * a fallback.
 */
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

/**
 * Candidate `tmp/<id>` directory names for a project, most authoritative first:
 * the projects.json slug, `tmp/*\/.project_root` ownership markers, then the
 * pre-registry sha256 hash directory.
 */
function projectIdentifiers(geminiDir: string, roots: string[]): string[] {
  const identifiers: string[] = []
  const push = (id: string): void => {
    if (!identifiers.includes(id)) identifiers.push(id)
  }
  let registry: unknown = null
  try {
    registry = JSON.parse(readFileSync(join(geminiDir, 'projects.json'), 'utf-8'))
  } catch {
    /* no registry */
  }
  const projects = jsonObject(jsonObject(registry)?.['projects'])
  if (projects) {
    for (const root of roots) {
      const slug = projects[root]
      if (typeof slug === 'string' && /^[a-z0-9-]+$/.test(slug)) push(slug)
    }
  }
  let entries: string[] = []
  try {
    entries = readdirSync(join(geminiDir, 'tmp'))
  } catch {
    /* no tmp dir */
  }
  for (const entry of entries) {
    let owner: string
    try {
      owner = readFileSync(join(geminiDir, 'tmp', entry, '.project_root'), 'utf-8').trim()
    } catch {
      continue
    }
    if (roots.includes(owner)) push(entry)
  }
  for (const root of roots) push(createHash('sha256').update(root).digest('hex'))
  return identifiers
}

/** `projectHash` from the leading metadata record (JSONL) or the legacy whole-file record. */
function sessionProjectHash(path: string): string | null {
  let head: string
  try {
    head = readHead(path)
  } catch {
    return null
  }
  const first = head.split('\n').find(line => line.trim())
  if (first === undefined) return null
  let record: unknown
  try {
    record = JSON.parse(first)
  } catch {
    try {
      record = JSON.parse(readFileSync(path, 'utf-8'))
    } catch {
      return null
    }
  }
  const projectHash = jsonObject(record)?.['projectHash']
  return typeof projectHash === 'string' ? projectHash : null
}

/** First 64 KiB of a file: enough for the one-line metadata record. */
function readHead(path: string): string {
  const fd = openSync(path, 'r')
  try {
    const buffer = Buffer.alloc(64 * 1024)
    const read = readSync(fd, buffer, 0, buffer.length, 0)
    return buffer.toString('utf-8', 0, read)
  } finally {
    closeSync(fd)
  }
}

/**
 * Replay a chats/ record into its final state, mirroring `loadConversationRecord`:
 * messages are keyed by `id` (a re-appended message replaces its earlier
 * snapshot in place), `$rewindTo` drops that message and everything after it,
 * and a `$set.messages` checkpoint rebuilds the list. Null when no record shape
 * is recognised.
 */
function geminiConversation(text: string): GeminiConversation | null {
  let records: unknown[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      records.push(JSON.parse(line))
    } catch {
      continue
    }
  }
  if (records.length === 0) {
    try {
      records = [JSON.parse(text)]
    } catch {
      return null
    }
  }
  const metadata: Record<string, unknown> = {}
  const messages = new Map<string, Record<string, unknown>>()
  let recognised = false
  const put = (message: unknown): void => {
    const record = jsonObject(message)
    if (record && typeof record['id'] === 'string') messages.set(record['id'], record)
  }
  for (const parsed of records) {
    const record = jsonObject(parsed)
    if (!record) continue
    if (typeof record['$rewindTo'] === 'string') {
      recognised = true
      const ids = [...messages.keys()]
      const cut = messages.has(record['$rewindTo']) ? ids.indexOf(record['$rewindTo']) : 0
      for (const id of ids.slice(cut)) messages.delete(id)
    } else if (typeof record['id'] === 'string') {
      recognised = true
      put(record)
    } else if (jsonObject(record['$set'])) {
      recognised = true
      const updates = record['$set'] as Record<string, unknown>
      if (Array.isArray(updates['messages'])) {
        messages.clear()
        for (const message of updates['messages']) put(message)
      }
      for (const [key, value] of Object.entries(updates)) if (key !== 'messages') metadata[key] = value
    } else if (typeof record['sessionId'] === 'string' && typeof record['projectHash'] === 'string') {
      recognised = true
      for (const [key, value] of Object.entries(record)) if (key !== 'messages') metadata[key] = value
      if (Array.isArray(record['messages'])) for (const message of record['messages']) put(message)
    }
  }
  if (!recognised) return null
  return { ...metadata, messages: [...messages.values()] }
}

/** Sum `tokens.{input,output}` over gemini messages; null until any message reports usage. */
function conversationUsage(messages: Record<string, unknown>[]): { tokensIn: number | null; tokensOut: number | null; model: string | null } {
  let tokensIn: number | null = null
  let tokensOut: number | null = null
  let model: string | null = null
  const usageModels = new Set<string | null>()
  for (const message of messages) {
    if (message['type'] !== 'gemini') continue
    if (typeof message['model'] === 'string' && message['model']) model = message['model']
    if (message['tokens'] == null) continue
    const tokens = jsonObject(message['tokens'])
    if (!tokens) return { tokensIn: null, tokensOut: null, model }
    const countIn = geminiTokenCount(tokens['input'])
    const countOut = geminiTokenCount(tokens['output'])
    if (countIn === null || countOut === null) return { tokensIn: null, tokensOut: null, model }
    usageModels.add(typeof message['model'] === 'string' && message['model'] ? message['model'] : null)
    tokensIn = (tokensIn ?? 0) + countIn
    tokensOut = (tokensOut ?? 0) + countOut
    if (!Number.isSafeInteger(tokensIn) || !Number.isSafeInteger(tokensOut)) return { tokensIn: null, tokensOut: null, model }
  }
  if (usageModels.size) model = usageModels.size === 1 ? usageModels.values().next().value ?? null : null
  return { tokensIn, tokensOut, model }
}

const geminiAdapter: Adapter = {
  name: 'gemini',
  instructionsFilename: 'GEMINI.md',
  defaultModel: 'gemini-2.5-pro',
  permissionBypassArgs: ['-y'],

  buildCommand(spec: RunSpec): BuildCommand {
    const validated = validateRunSpec(this, spec)
    const { model, permissionArgs } = validated
    return finalizeCommand(this, spec, validated, {
      cmd: 'gemini',
      args: ['-p', spec.prompt, ...permissionArgs, '-m', model, '--output-format', 'json'],
    })
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

  // gemini-cli records interactive sessions under
  // <GEMINI_CLI_HOME|home>/.gemini/tmp/<project-id>/chats/session-<stamp>-<id8>.jsonl
  // (legacy .json), where <project-id> is the projects.json slug or, before the
  // registry existed, sha256(projectRoot). Records carry projectHash =
  // sha256(projectRoot), which rejects sessions of other projects.
  sessionLogPath(workdir: string, since?: number): string | null {
    // Storage.getGlobalGeminiDir(): GEMINI_CLI_HOME (verbatim) or the home dir, plus .gemini
    const override = process.env['GEMINI_CLI_HOME']
    const geminiDir = join(override ? override : (process.env.HOME ?? homedir()), '.gemini')
    const roots = projectRoots(workdir)
    const hashes = new Set(roots.map(root => createHash('sha256').update(root).digest('hex')))
    let best: { mtime: number; name: string; path: string } | null = null
    for (const identifier of projectIdentifiers(geminiDir, roots)) {
      const chats = join(geminiDir, 'tmp', identifier, 'chats')
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
        const projectHash = sessionProjectHash(path)
        if (projectHash === null || !hashes.has(projectHash)) continue
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
    const conversation = geminiConversation(rawText)
    if (conversation !== null) {
      const { tokensIn, tokensOut, model } = conversationUsage(conversation.messages)
      const costUsd = tokensIn === null ? null : deriveCost(model, tokensIn, tokensOut)
      return { sessionLogPath: path, tokensIn, tokensOut, costUsd, model, raw: conversation }
    }
    // Not a chats/ record: accept a headless stats envelope written to a file,
    // otherwise surface whatever JSON is there without inventing usage.
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
    try {
      return { sessionLogPath: path, tokensIn: null, tokensOut: null, costUsd: null, model: null, raw: JSON.parse(rawText) }
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
