import { register } from '../registry.js'
import { writeInstructions } from '../subproc.js'
import type { Adapter, AgentStatus, BuildCommand, ParsedOutput, ReadyState, RunSpec, SubprocOutcome } from '../base.js'
import { normalizeModelForHarness } from '../model-normalization.js'
import { stripAnsi, lastNonEmptyJoin } from '../util.js'
import { createRequire } from 'module'
import { existsSync, mkdirSync } from 'fs'
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

function kiloDbPath(workdir: string, extraEnv: Record<string, string> | undefined): string {
  const envPath = (extraEnv ?? {})['KILO_DB'] ?? process.env['KILO_DB']
  if (envPath) return envPath.replace(/^~/, homedir())
  return join(workdir, '.harness', 'kilo', 'kilo.db')
}

function readKiloSessionTotals(
  workdir: string,
  extraEnv: Record<string, string> | undefined,
): { tokensIn: number | null; tokensOut: number | null; costUsd: number | null } {
  const dbPath = kiloDbPath(workdir, extraEnv)
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
        SELECT id FROM session
        WHERE directory LIKE ?
        ORDER BY time_updated DESC
        LIMIT 1
      )
      AND json_extract(data, '$.role') = 'assistant'
      `,
      `%${wdBasename}%`,
    ) as { tokens_in: unknown; tokens_out: unknown; cost: unknown; row_count: unknown } | undefined

    if (!row || typeof row.row_count !== 'number' || row.row_count === 0) {
      return { tokensIn: null, tokensOut: null, costUsd: null }
    }
    return {
      tokensIn: typeof row.tokens_in === 'number' ? Math.trunc(row.tokens_in) : null,
      tokensOut: typeof row.tokens_out === 'number' ? Math.trunc(row.tokens_out) : null,
      costUsd: typeof row.cost === 'number' ? row.cost : null,
    }
  } catch {
    return { tokensIn: null, tokensOut: null, costUsd: null }
  } finally {
    db.close()
  }
}

const kiloAdapter: Adapter = {
  name: 'kilo',
  instructionsFilename: 'AGENTS.md',
  defaultModel: 'gpt-5.4',

  buildCommand(spec: RunSpec): BuildCommand {
    const model = normalizeModelForHarness(this.name, spec.model ?? this.defaultModel, { resolve: !spec.modelNoResolve }) ?? this.defaultModel
    const instructionsFile = writeInstructions(spec.workdir, this.instructionsFilename, spec.instructions)

    const dbPath = kiloDbPath(spec.workdir, spec.env)
    // Only attempt mkdir if the parent path sits under a writable prefix on
    // the host. When KILO_DB points at a container-only path (e.g. /app/...),
    // leave dir creation to the runtime inside the container.
    try {
      mkdirSync(dirname(dbPath), { recursive: true })
    } catch {
      // intentionally ignore: container-only paths
    }

    const configJson = JSON.stringify({
      model,
      small_model: model,
      default_agent: 'build',
    })

    return {
      cmd: 'kilo',
      args: ['run', '--auto', '--format', 'json', '--dir', spec.workdir, '--model', model, spec.prompt],
      cwd: spec.workdir,
      env: {
        KILO_DB: dbPath,
        KILO_CONFIG_CONTENT: configJson,
      },
      instructionsFile,
    }
  },

  parseOutput(spec: RunSpec, _outcome: SubprocOutcome): ParsedOutput {
    const { tokensIn, tokensOut, costUsd } = readKiloSessionTotals(spec.workdir, spec.env)
    return { costUsd, tokensIn, tokensOut, raw: null }
  },
}

kiloAdapter.submitKeys = ['Enter']
kiloAdapter.detectReady = function (pane: string): ReadyState {
  const last30 = lastNonEmptyJoin(pane, 30)
  if (/Ask anything\.\.\./i.test(last30)) return 'ready'
  if (/Update available/i.test(last30)) return 'dialog'
  return 'loading'
}
kiloAdapter.handleDialog = function (pane: string): string[] | null {
  if (/Update available/i.test(stripAnsi(pane))) return ['Escape']
  return null
}
kiloAdapter.detectStatus = function (pane: string): AgentStatus {
  const last10 = lastNonEmptyJoin(pane, 10)
  if (/rate.?limit/i.test(last10)) return 'rate-limited'
  if (/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(last10) || /thinking|working/i.test(last10)) return 'running'
  if (/Ask anything\.\.\./i.test(last10)) return 'idle'
  return 'unknown'
}
kiloAdapter.installMeta = {
  packageManager: 'npm',
  installCommand: ['npm', 'install', '-g', 'kilo'],
  updateCommand: ['npm', 'install', '-g', 'kilo@latest'],
  versionCommand: ['kilo', '--version'],
}

register('kilo', kiloAdapter)
