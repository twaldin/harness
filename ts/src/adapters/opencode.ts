import { register } from '../registry.js'
import { writeInstructions } from '../subproc.js'
import type { Adapter, BuildCommand, ParsedOutput, RunSpec, SubprocOutcome, SessionTelemetry } from '../base.js'
import { homedir } from 'os'
import { existsSync } from 'fs'
import { resolve, basename } from 'path'
import { createRequire } from 'module'
import { normalizeModelForHarness } from '../model-normalization.js'
import { stripAnsi, lastNonEmptyJoin } from '../util.js'
import { deriveCost } from '../pricing.js'

function openCodeDbPath(): string {
  const envPath = process.env['OPENCODE_DB']
  if (envPath) return envPath.replace(/^~/, homedir())
  return `${homedir()}/.local/share/opencode/opencode.db`
}

// Opencode writes token/cost totals to a sqlite DB post-exit. Runtime detection:
// bun doesn't support better-sqlite3's native bindings (oven-sh/bun#4290), so we
// use bun:sqlite when running under bun and better-sqlite3 on node. Same query,
// different driver. If neither is available we return null — correctness-safe.

interface SqliteDriver {
  get(sql: string, ...params: unknown[]): unknown
  close(): void
}

function openDb(dbPath: string): SqliteDriver | null {
  const isBun = typeof (globalThis as unknown as { Bun?: unknown }).Bun !== 'undefined'
  const requireFn = createRequire(import.meta.url)
  if (isBun) {
    try {
      // bun:sqlite is a built-in, accessible via require in bun
      const mod = requireFn('bun:sqlite') as { Database: new (p: string, o?: unknown) => {
        prepare(s: string): { get(...p: unknown[]): unknown }
        close(): void
      } }
      const db = new mod.Database(dbPath, { readonly: true })
      return {
        get: (sql, ...params) => db.prepare(sql).get(...params),
        close: () => db.close(),
      }
    } catch {
      return null
    }
  }
  try {
    const Database = requireFn('better-sqlite3') as new (p: string, o?: unknown) => {
      prepare(s: string): { get(...p: unknown[]): unknown }
      close(): void
    }
    const db = new Database(dbPath, { readonly: true, timeout: 5000 })
    return {
      get: (sql, ...params) => db.prepare(sql).get(...params),
      close: () => db.close(),
    }
  } catch {
    return null
  }
}

function readOpenCodeSessionTotals(
  workdir: string,
  dbPath = openCodeDbPath(),
): { tokensIn: number | null; tokensOut: number | null; costUsd: number | null; model: string | null } {
  if (!existsSync(dbPath)) return { tokensIn: null, tokensOut: null, costUsd: null, model: null }

  let resolvedWorkdir = workdir
  try {
    resolvedWorkdir = resolve(workdir)
  } catch {
    // keep raw
  }
  const wdBasename = basename(resolvedWorkdir)

  const db = openDb(dbPath)
  if (!db) return { tokensIn: null, tokensOut: null, costUsd: null, model: null }

  try {
    const row = db.get(
      `
      SELECT
        COALESCE(SUM(json_extract(data, '$.tokens.input')), 0)  AS tokens_in,
        COALESCE(SUM(json_extract(data, '$.tokens.output')), 0) AS tokens_out,
        COALESCE(SUM(json_extract(data, '$.cost')), 0)          AS cost,
        MAX(s.model)                                             AS model,
        COUNT(*)                                                 AS row_count
      FROM message m
      JOIN session s ON s.id = m.session_id
      WHERE m.session_id IN (
        SELECT id FROM session WHERE directory LIKE ? ORDER BY time_updated DESC LIMIT 1
      )
    `,
      `%${wdBasename}%`,
    ) as { tokens_in: number; tokens_out: number; cost: number; model: unknown; row_count: number } | undefined

    if (!row || row.row_count === 0) {
      return { tokensIn: null, tokensOut: null, costUsd: null, model: null }
    }
    return {
      tokensIn: Math.round(row.tokens_in),
      tokensOut: Math.round(row.tokens_out),
      costUsd: row.cost,
      model: typeof row.model === 'string' ? row.model : null,
    }
  } catch {
    return { tokensIn: null, tokensOut: null, costUsd: null, model: null }
  } finally {
    db.close()
  }
}

const openCodeAdapter: Adapter = {
  name: 'opencode',
  instructionsFilename: 'AGENTS.md',
  defaultModel: 'gpt-5.4',
  scrollOwnership: 'app',

  buildCommand(spec: RunSpec): BuildCommand {
    const model = normalizeModelForHarness(this.name, spec.model ?? this.defaultModel, { resolve: !spec.modelNoResolve }) ?? this.defaultModel
    const instructionsFile = writeInstructions(spec.workdir, this.instructionsFilename, spec.instructions)
    return {
      cmd: 'opencode',
      args: ['run', '--dir', spec.workdir, '--model', model, spec.prompt],
      cwd: spec.workdir,
      env: {},
      instructionsFile,
    }
  },

  parseOutput(spec: RunSpec, _outcome: SubprocOutcome): ParsedOutput {
    const { tokensIn, tokensOut, costUsd } = readOpenCodeSessionTotals(spec.workdir)
    return { costUsd, tokensIn, tokensOut, raw: null }
  },
}

// ===== session-aware additions =====

openCodeAdapter.submitKeys = ['Enter']
openCodeAdapter.flattenOnPaste = true

// opencode always renders into its own virtualized scrollback — return the
// fixed chord map regardless of any external mode.
openCodeAdapter.getCurrentScrollKeys = function () {
  return { lineDown: 'C-M-e', lineUp: 'C-M-y', pageDown: 'NPage', pageUp: 'PPage' }
}

openCodeAdapter.detectReady = function (pane: string) {
  const full = stripAnsi(pane)
  const last5 = lastNonEmptyJoin(pane, 5)
  if (/update available|a new version of opencode|upgrade now/i.test(full)) return 'dialog'
  if (/Ask anything/i.test(full) && /\d+\.\d+\.\d+/.test(last5)) return 'ready'
  return 'loading'
}

openCodeAdapter.handleDialog = function (pane: string) {
  const text = stripAnsi(pane)
  if (/update available|a new version of opencode|upgrade now/i.test(text)) return ['Escape']
  return null
}

openCodeAdapter.detectStatus = function (pane: string) {
  const last10 = lastNonEmptyJoin(pane, 10)
  const full = stripAnsi(pane)
  if (/update available|a new version of opencode|upgrade now/i.test(full)) return 'dialog'
  if (/rate.?limit|try again later/i.test(last10)) return 'rate-limited'
  if (/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(last10)) return 'running'
  if (/thinking|running/i.test(last10)) return 'running'
  if (/Ask anything/i.test(full)) return 'idle'
  return 'unknown'
}

// opencode telemetry already lives in SQLite; re-use the existing reader.
openCodeAdapter.sessionLogPath = function (workdir: string, _since?: number): string | null {
  // Path is shared SQLite — return DB path so consumer knows where to look.
  const dbPath = process.env['OPENCODE_DB']?.replace(/^~/, homedir()) ?? `${homedir()}/.local/share/opencode/opencode.db`
  return existsSync(dbPath) ? `${dbPath}#session(${basename(resolve(workdir))})` : null
}

openCodeAdapter.parseSessionLog = function (path: string): SessionTelemetry {
  const dbPath = path.split('#')[0] ?? path
  const wdHint = path.split('session(')[1]?.replace(/\)$/, '') ?? ''
  if (!existsSync(dbPath)) {
    return { sessionLogPath: path, tokensIn: null, tokensOut: null, costUsd: null, model: null, raw: null }
  }
  const result = readOpenCodeSessionTotals(wdHint || '/', dbPath)
  // SQLite cost can be 0 when opencode used a custom provider (no upstream
  // pricing): fall back to deriveCost from tokens if we have any.
  let cost = result.costUsd
  if ((cost == null || cost === 0) && result.tokensIn != null && (result.tokensIn > 0 || (result.tokensOut ?? 0) > 0)) {
    cost = deriveCost('gpt-5.4', result.tokensIn, result.tokensOut) ?? cost
  }
  return { sessionLogPath: path, tokensIn: result.tokensIn, tokensOut: result.tokensOut, costUsd: cost, model: result.model, raw: null }
}

openCodeAdapter.installMeta = {
  packageManager: 'npm',
  installCommand: ['npm', 'install', '-g', 'opencode-ai'],
  updateCommand: ['npm', 'install', '-g', 'opencode-ai@latest'],
  versionCommand: ['opencode', '--version'],
}

register('opencode', openCodeAdapter)
