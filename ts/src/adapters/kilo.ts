import { register } from '../registry.js'
import type { Adapter, AgentStatus, BuildCommand, ParsedOutput, ReadyState, RunSpec, SessionTelemetry, SubprocOutcome } from '../base.js'
import { finalizeCommand, validateRunSpec } from '../base.js'
import { stripAnsi, lastNonEmptyJoin } from '../util.js'
import { deriveCost } from '../pricing.js'
import { createRequire } from 'module'
import { existsSync } from 'fs'
import { basename, dirname, join, resolve } from 'path'
import { homedir } from 'os'

interface SqliteDriver {
  get(sql: string, ...params: unknown[]): unknown
  close(): void
}

function openDb(dbPath: string): SqliteDriver | null {
  const isBun = typeof (globalThis as unknown as { Bun?: unknown }).Bun !== 'undefined'
  const requireFn = createRequire(import.meta.url)
  if (isBun) {
    try {
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

/** Caller-selected KILO_DB (spec env, then inherited env) is upstream state; otherwise the harness default under the workdir. */
function kiloDbPath(workdir: string, extraEnv: Record<string, string> | undefined): { path: string; harnessOwned: boolean } {
  const envPath = (extraEnv ?? {})['KILO_DB'] ?? process.env['KILO_DB']
  if (envPath) return { path: envPath.replace(/^~/, homedir()), harnessOwned: false }
  return { path: join(workdir, '.harness', 'kilo', 'kilo.db'), harnessOwned: true }
}

function readKiloSessionTotalsByDbPath(
  dbPath: string,
  wdBasename: string,
): { tokensIn: number | null; tokensOut: number | null; costUsd: number | null; model: string | null } {
  if (!existsSync(dbPath)) return { tokensIn: null, tokensOut: null, costUsd: null, model: null }

  const db = openDb(dbPath)
  if (!db) return { tokensIn: null, tokensOut: null, costUsd: null, model: null }

  try {
    const row = db.get(
      `
      SELECT
        COALESCE(SUM(json_extract(data, '$.tokens.input')), 0)  AS tokens_in,
        COALESCE(SUM(json_extract(data, '$.tokens.output')), 0) AS tokens_out,
        COALESCE(SUM(json_extract(data, '$.cost')), 0)          AS cost,
        MAX(json_extract(data, '$.model'))                      AS model,
        COUNT(*)                                                 AS row_count
      FROM message
      WHERE session_id IN (
        SELECT id FROM session
        WHERE directory LIKE ?
        ORDER BY time_updated DESC
        LIMIT 1
      )
      AND json_extract(data, '$.role') = 'assistant'
      `,
      `%${wdBasename}%`,
    ) as { tokens_in: unknown; tokens_out: unknown; cost: unknown; model: unknown; row_count: unknown } | undefined

    if (!row || typeof row.row_count !== 'number' || row.row_count === 0) {
      return { tokensIn: null, tokensOut: null, costUsd: null, model: null }
    }
    return {
      tokensIn: typeof row.tokens_in === 'number' ? Math.trunc(row.tokens_in) : null,
      tokensOut: typeof row.tokens_out === 'number' ? Math.trunc(row.tokens_out) : null,
      costUsd: typeof row.cost === 'number' ? row.cost : null,
      model: typeof row.model === 'string' ? row.model : null,
    }
  } catch {
    return { tokensIn: null, tokensOut: null, costUsd: null, model: null }
  } finally {
    db.close()
  }
}

function readKiloSessionTotals(
  workdir: string,
  extraEnv: Record<string, string> | undefined,
): { tokensIn: number | null; tokensOut: number | null; costUsd: number | null; model: string | null } {
  const resolvedWorkdir = resolve(workdir)
  return readKiloSessionTotalsByDbPath(kiloDbPath(resolvedWorkdir, extraEnv).path, basename(resolvedWorkdir))
}

const kiloAdapter: Adapter = {
  name: 'kilo',
  instructionsFilename: 'AGENTS.md',
  defaultModel: 'gpt-5.4',
  permissionBypassArgs: ['--auto'],

  buildCommand(spec: RunSpec): BuildCommand {
    const validated = validateRunSpec(this, spec)
    const { model, permissionArgs, workdir } = validated
    const db = kiloDbPath(workdir, spec.env)
    const env: Record<string, string> = { KILO_DB: db.path }
    // A caller-selected KILO_CONFIG_CONTENT (spec env or inherited) is passed through untouched;
    // the single-model JSON is only generated when neither environment provides one.
    if (spec.env?.['KILO_CONFIG_CONTENT'] === undefined && process.env['KILO_CONFIG_CONTENT'] === undefined) {
      env['KILO_CONFIG_CONTENT'] = JSON.stringify({ model, small_model: model, default_agent: 'build' })
    }
    return finalizeCommand(this, spec, validated, {
      cmd: 'kilo',
      args: ['run', ...permissionArgs, '--format', 'json', '--dir', workdir, '--model', model, spec.prompt],
      env,
      // Caller-selected DB paths (possibly container-only) are upstream state; only the harness default parent is created.
      directories: db.harnessOwned ? [dirname(db.path)] : [],
    })
  },

  parseOutput(spec: RunSpec, _outcome: SubprocOutcome): ParsedOutput {
    const { tokensIn, tokensOut, costUsd } = readKiloSessionTotals(spec.workdir, spec.env)
    return { costUsd, tokensIn, tokensOut, raw: null }
  },

  sessionLogPath(workdir: string, _since?: number): string | null {
    const dbPath = kiloDbPath(workdir, undefined).path
    if (!existsSync(dbPath)) return null
    let wd = workdir
    try { wd = basename(resolve(workdir)) } catch { wd = basename(workdir) }
    return `${dbPath}#session(${wd})`
  },

  parseSessionLog(path: string): SessionTelemetry {
    const dbPath = path.split('#')[0] ?? path
    const wdHint = path.split('session(')[1]?.replace(/\)$/, '') ?? ''
    const result = readKiloSessionTotalsByDbPath(dbPath, wdHint || '/')
    let costUsd = result.costUsd
    if ((costUsd == null || costUsd === 0) && (result.tokensIn != null || result.tokensOut != null)) {
      costUsd = deriveCost(result.model ?? 'gpt-5.4', result.tokensIn, result.tokensOut) ?? costUsd
    }
    return { sessionLogPath: path, tokensIn: result.tokensIn, tokensOut: result.tokensOut, costUsd, model: result.model, raw: null }
  },
}

kiloAdapter.submitKeys = ['Enter']
kiloAdapter.detectReady = function (pane: string): ReadyState {
  // Discriminate dialog by visible button row at the bottom (not title).
  const tail = lastNonEmptyJoin(pane, 12)
  if (/Confirm\s+Cancel/i.test(tail)) return 'dialog'
  if (/Allow once\s+Allow always\s+Reject/i.test(tail)) return 'dialog'
  if (/Update available/i.test(tail)) return 'dialog'
  if (/Ask anything\.\.\./i.test(tail)) return 'ready'
  return 'loading'
}
kiloAdapter.handleDialog = function (pane: string): string[] | null {
  // kilo permission flow has two dialogs back-to-back. Discriminate by the
  // BUTTON ROW (always at the bottom of the visible pane), not by the title
  // (which lingers in scrollback after the dialog closes):
  //   1. "Allow once   Allow always   Reject" → Right + Enter picks "Allow always".
  //   2. "Confirm   Cancel" → Enter (Confirm is default).
  // Look for the button row in the LAST few non-empty lines.
  const tail = lastNonEmptyJoin(pane, 12)
  if (/Confirm\s+Cancel/i.test(tail)) return ['Enter']
  if (/Allow once\s+Allow always\s+Reject/i.test(tail)) return ['Right', 'Enter']
  if (/Update available/i.test(tail)) return ['Escape']
  return null
}
kiloAdapter.detectStatus = function (pane: string): AgentStatus {
  const tail = lastNonEmptyJoin(pane, 12)
  const last10 = lastNonEmptyJoin(pane, 10)
  if (/Confirm\s+Cancel/i.test(tail)) return 'dialog'
  if (/Allow once\s+Allow always\s+Reject/i.test(tail)) return 'dialog'
  if (/rate.?limit/i.test(last10)) return 'rate-limited'
  if (/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(last10) || /thinking|working/i.test(last10)) return 'running'
  if (/Ask anything\.\.\./i.test(last10)) return 'idle'
  return 'unknown'
}
kiloAdapter.installMeta = {
  packageManager: 'npm',
  installCommand: ['npm', 'install', '-g', '@kilocode/cli'],
  updateCommand: ['npm', 'install', '-g', '@kilocode/cli@latest'],
  versionCommand: ['kilo', '--version'],
}

register('kilo', kiloAdapter)
