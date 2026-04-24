import { register } from '../registry.js'
import { writeInstructions } from '../subproc.js'
import type { Adapter, BuildCommand, ParsedOutput, RunSpec, SubprocOutcome } from '../base.js'
import { homedir } from 'os'
import { existsSync } from 'fs'
import { resolve, basename } from 'path'
import { createRequire } from 'module'
import { normalizeModelForHarness } from '../model-normalization.js'

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
): { tokensIn: number | null; tokensOut: number | null; costUsd: number | null } {
  const dbPath = openCodeDbPath()
  if (!existsSync(dbPath)) return { tokensIn: null, tokensOut: null, costUsd: null }

  let resolvedWorkdir = workdir
  try {
    resolvedWorkdir = resolve(workdir)
  } catch {
    // keep raw
  }
  const wdBasename = basename(resolvedWorkdir)

  const db = openDb(dbPath)
  if (!db) return { tokensIn: null, tokensOut: null, costUsd: null }

  try {
    const row = db.get(
      `
      SELECT
        COALESCE(SUM(json_extract(data, '$.tokens.input')), 0)  AS tokens_in,
        COALESCE(SUM(json_extract(data, '$.tokens.output')), 0) AS tokens_out,
        COALESCE(SUM(json_extract(data, '$.cost')), 0)          AS cost,
        COUNT(*)                                                 AS row_count
      FROM message
      WHERE session_id IN (
        SELECT id FROM session WHERE directory LIKE ? ORDER BY time_updated DESC LIMIT 1
      )
    `,
      `%${wdBasename}%`,
    ) as { tokens_in: number; tokens_out: number; cost: number; row_count: number } | undefined

    if (!row || row.row_count === 0) {
      return { tokensIn: null, tokensOut: null, costUsd: null }
    }
    return {
      tokensIn: Math.round(row.tokens_in),
      tokensOut: Math.round(row.tokens_out),
      costUsd: row.cost,
    }
  } catch {
    return { tokensIn: null, tokensOut: null, costUsd: null }
  } finally {
    db.close()
  }
}

const openCodeAdapter: Adapter = {
  name: 'opencode',
  instructionsFilename: 'AGENTS.md',
  defaultModel: 'gpt-5.4',

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

register('opencode', openCodeAdapter)
