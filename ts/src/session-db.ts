// Native-correlated SQLite telemetry shared by the opencode, kilo and crush
// adapters: a read-only sqlite driver that works under Bun (bun:sqlite) and
// Node (better-sqlite3), the `<db>#session=<id>` log selector, and the
// opencode-family (opencode / kilo fork) identity, path and accounting rules.
import { createRequire } from 'node:module'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import type { SessionTelemetry } from './base.js'

export interface SessionTotals {
  tokensIn: number | null
  tokensOut: number | null
  costUsd: number | null
  model: string | null
}

export const NO_TOTALS: SessionTotals = { tokensIn: null, tokensOut: null, costUsd: null, model: null }

/** Effective child environment: inherited, overridden by the spec's explicit values (including empty ones). */
export type Env = Record<string, string | undefined>

// ----- sqlite driver ---------------------------------------------------------

export interface SqliteReader {
  /** First row, or null when the statement yields none (both drivers normalised). */
  get(sql: string, ...params: unknown[]): unknown
  all(sql: string, ...params: unknown[]): unknown[]
  close(): void
}

interface Statement {
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
}
interface Connection {
  prepare(sql: string): Statement
  close(): void
}
type Constructor = new (path: string, options: { readonly: true; timeout?: number }) => Connection

export const BUSY_TIMEOUT_MS = 5000

/**
 * Open a database read-only with a bounded busy timeout. Bun cannot load
 * better-sqlite3's native bindings (oven-sh/bun#4290), so bun:sqlite is used
 * there and better-sqlite3 on Node. Null when no driver can open the file.
 */
export function openReadOnly(dbPath: string, timeoutMs: number = BUSY_TIMEOUT_MS): SqliteReader | null {
  const requireFn = createRequire(import.meta.url)
  let connection: Connection | undefined
  try {
    if ('Bun' in globalThis) {
      const mod: { Database: Constructor } = requireFn('bun:sqlite')
      connection = new mod.Database(dbPath, { readonly: true })
      connection.prepare(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(timeoutMs))}`).get()
    } else {
      const Database: Constructor = requireFn('better-sqlite3')
      connection = new Database(dbPath, { readonly: true, timeout: Math.max(0, Math.trunc(timeoutMs)) })
    }
  } catch {
    try { connection?.close() } catch { /* Preserve an unavailable reader. */ }
    return null
  }
  const db = connection
  return {
    get: (sql, ...params) => db.prepare(sql).get(...params) ?? null,
    all: (sql, ...params) => db.prepare(sql).all(...params),
    close: () => db.close(),
  }
}

/** Property of an arbitrary decoded value, undefined when absent or not an object. */
export function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null && key in value ? Reflect.get(value, key) : undefined
}

// ----- explicit log selector -------------------------------------------------

const SELECTOR = '#session='

/** `<database path>#session=<percent-encoded native ID>`; the split is on the last marker so DB paths may contain `#`. */
export function parseSelector(path: string): { dbPath: string; sessionID: string } | null {
  const at = path.lastIndexOf(SELECTOR)
  if (at < 0) return null
  let sessionID: string
  try {
    sessionID = decodeURIComponent(path.slice(at + SELECTOR.length))
  } catch {
    return null
  }
  if (sessionID === '') return null
  return { dbPath: path.slice(0, at), sessionID }
}

/** Provenance of the reported cost: literal upstream value (a reported 0 stays 0) or nothing to report. */
export function identityRaw(sessionID: string, costUsd: number | null): { sessionID: string; costSource: 'reported' | 'unavailable' } {
  return { sessionID, costSource: costUsd === null ? 'unavailable' : 'reported' }
}

export function telemetryFor(path: string, totals: SessionTotals, sessionID: string | null): SessionTelemetry {
  return {
    sessionLogPath: path,
    tokensIn: totals.tokensIn,
    tokensOut: totals.tokensOut,
    costUsd: totals.costUsd,
    model: totals.model,
    raw: sessionID === null ? null : identityRaw(sessionID, totals.costUsd),
  }
}

// ----- value validity --------------------------------------------------------

export function validTokens(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null
}

export function validCost(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

/** Unique nonempty string shared by every row, or null when any row lacks it or they differ. */
export function unanimous(values: unknown[]): string | null {
  const first = values[0]
  if (typeof first !== 'string' || first === '') return null
  return values.every((value) => value === first) ? first : null
}

// ----- opencode family (opencode, kilo) --------------------------------------

/** Event types `<cli> run --format json` emits; every envelope carries the native sessionID. */
const RUN_EVENT_TYPES: Record<string, true> = { step_start: true, step_finish: true, text: true, reasoning: true, tool_use: true, error: true }

/**
 * Native session ID from `--format json` stdout envelopes. Exactly one
 * top-level ID must be observed; a part ID can confirm it, never supply it.
 * Ordinary text, malformed JSON and unknown event types are ignored.
 */
export function runSessionID(stdout: string): string | null {
  let found: string | null = null
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    let event: unknown
    try {
      event = JSON.parse(trimmed)
    } catch {
      continue
    }
    const type = field(event, 'type')
    if (typeof type !== 'string' || RUN_EVENT_TYPES[type] !== true) continue
    const id = field(event, 'sessionID')
    if (typeof id !== 'string' || id === '') continue
    const partID = field(field(event, 'part'), 'sessionID')
    if (partID !== undefined && partID !== id) return null
    if (found !== null && found !== id) return null
    found = id
  }
  return found
}

export type OpenCodeApp = 'opencode' | 'kilo'

/**
 * Upstream `Global.Path.data`: xdg-basedir's `XDG_DATA_HOME || ~/.local/share`
 * (no absoluteness check, so a relative value lands under the child's cwd,
 * i.e. the workdir) joined with the app name.
 */
export function globalDataDir(env: Env, app: OpenCodeApp, workdir: string): string {
  const xdg = env['XDG_DATA_HOME']
  let base = xdg !== undefined && xdg !== '' ? xdg : join(env['HOME'] ?? homedir(), '.local', 'share')
  // Kilo defensively strips newlines from the resolved XDG path (kilocode_change in global.ts).
  if (app === 'kilo') base = base.replace(/[\r\n]+/g, '')
  return resolve(workdir, base, app)
}

const DISABLE_CHANNEL_ENV: Record<OpenCodeApp, string> = { opencode: 'OPENCODE_DISABLE_CHANNEL_DB', kilo: 'KILO_DISABLE_CHANNEL_DB' }

/**
 * Where the CLI persisted the run, mirroring upstream `Database.path()`
 * without its import-time side effects. An explicit nonempty `<APP>_DB` is
 * authoritative: `:memory:` has no readable artifact, absolute paths are
 * verbatim and relative ones join `Global.Path.data` (no `~` expansion).
 * Without an override the build channel is unobservable, so the candidates
 * are every direct `*.db` file under `Global.Path.data`, unless the channel
 * DB is disabled (only `<app>.db`, upstream).
 */
export function candidateDbPaths(env: Env, app: OpenCodeApp, override: string | undefined, workdir: string): string[] {
  const dataDir = globalDataDir(env, app, workdir)
  if (override !== undefined && override !== '') {
    if (override === ':memory:') return []
    return [isAbsolute(override) ? override : join(dataDir, override)]
  }
  const disable = env[DISABLE_CHANNEL_ENV[app]]
  if (disable === '1' || disable === 'true') return [join(dataDir, `${app}.db`)]
  let names: string[]
  try {
    names = readdirSync(dataDir)
  } catch {
    return []
  }
  const candidates: string[] = []
  try {
    for (const name of names) {
      if (!name.endsWith('.db')) continue
      const path = join(dataDir, name)
      if (statSync(path).isFile()) candidates.push(path)
    }
  } catch {
    return []
  }
  return candidates
}

/**
 * Totals for the exact native session when its row exists, null otherwise;
 * throws when the database cannot answer. Only that session's assistant rows
 * are read. A field sums only when every row reports a valid value (a literal
 * upstream 0 is preserved); the model is reported only when every row names
 * the same nonempty modelID and providerID.
 */
function openCodeTotals(db: SqliteReader, sessionID: string): SessionTotals | null {
  if (db.get('SELECT 1 FROM session WHERE id = ?', sessionID) === null) return null
  const rows = db.all("SELECT data FROM message WHERE session_id = ? AND json_extract(data, '$.role') = 'assistant'", sessionID)
  if (rows.length === 0) return NO_TOTALS
  let tokensIn: number | null = 0
  let tokensOut: number | null = 0
  let costUsd: number | null = 0
  const models: unknown[] = []
  const providers: unknown[] = []
  for (const row of rows) {
    const data = field(row, 'data')
    let message: unknown = null
    if (typeof data === 'string') {
      try {
        message = JSON.parse(data)
      } catch {
        message = null
      }
    }
    const tokens = field(message, 'tokens')
    const input = validTokens(field(tokens, 'input'))
    const output = validTokens(field(tokens, 'output'))
    const cost = validCost(field(message, 'cost'))
    tokensIn = tokensIn === null || input === null ? null : tokensIn + input
    tokensOut = tokensOut === null || output === null ? null : tokensOut + output
    costUsd = costUsd === null || cost === null ? null : costUsd + cost
    models.push(field(message, 'modelID'))
    providers.push(field(message, 'providerID'))
  }
  const model = unanimous(providers) === null ? null : unanimous(models)
  return { tokensIn, tokensOut, costUsd, model }
}

/**
 * Correlate the native session with exactly one of the candidate databases.
 * Two or more matches, or any candidate that cannot be read within the shared
 * budget, attribute nothing rather than risk the wrong transcript.
 */
export function readOpenCodeRun(candidates: string[], sessionID: string): SessionTotals {
  const deadline = Date.now() + BUSY_TIMEOUT_MS
  let match: SessionTotals | null = null
  for (const path of candidates) {
    if (!existsSync(path)) continue
    const remaining = deadline - Date.now()
    if (remaining <= 0) return NO_TOTALS
    const db = openReadOnly(path, remaining)
    if (!db) return NO_TOTALS
    let totals: SessionTotals | null
    try {
      totals = openCodeTotals(db, sessionID)
    } catch {
      return NO_TOTALS
    } finally {
      db.close()
    }
    if (totals === null) continue
    if (match !== null) return NO_TOTALS
    match = totals
  }
  return match ?? NO_TOTALS
}
