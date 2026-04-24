import { register } from '../registry.js'
import { writeInstructions } from '../subproc.js'
import type { Adapter, BuildCommand, ParsedOutput, RunSpec, SubprocOutcome } from '../base.js'
import { normalizeModelForHarness } from '../model-normalization.js'
import { createRequire } from 'module'
import { existsSync, mkdirSync } from 'fs'
import { join } from 'path'
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

function crushDataDir(workdir: string, extraEnv: Record<string, string> | undefined): string {
  const envPath = (extraEnv ?? {})['CRUSH_DATA_DIR'] ?? process.env['CRUSH_DATA_DIR']
  return envPath ? envPath.replace(/^~/, homedir()) : join(workdir, '.harness', 'crush-data')
}

function readCrushSessionTotals(
  workdir: string,
  extraEnv: Record<string, string> | undefined,
): { tokensIn: number | null; tokensOut: number | null; costUsd: number | null } {
  const dbPath = join(crushDataDir(workdir, extraEnv), 'crush.db')
  if (!existsSync(dbPath)) return { tokensIn: null, tokensOut: null, costUsd: null }

  const db = openDb(dbPath)
  if (!db) return { tokensIn: null, tokensOut: null, costUsd: null }

  try {
    const row = db.get(
      `
      SELECT prompt_tokens, completion_tokens, cost
      FROM sessions
      WHERE parent_session_id IS NULL
      ORDER BY updated_at DESC
      LIMIT 1
      `,
    ) as { prompt_tokens: unknown; completion_tokens: unknown; cost: unknown } | undefined

    const tokensIn = typeof row?.prompt_tokens === 'number' ? Math.trunc(row.prompt_tokens) : null
    const tokensOut = typeof row?.completion_tokens === 'number' ? Math.trunc(row.completion_tokens) : null
    const costUsd = typeof row?.cost === 'number' ? row.cost : null
    return { tokensIn, tokensOut, costUsd }
  } catch {
    return { tokensIn: null, tokensOut: null, costUsd: null }
  } finally {
    db.close()
  }
}

const crushAdapter: Adapter = {
  name: 'crush',
  instructionsFilename: 'AGENTS.md',
  defaultModel: 'gpt-5.4',

  buildCommand(spec: RunSpec): BuildCommand {
    const model = normalizeModelForHarness(this.name, spec.model ?? this.defaultModel, { resolve: !spec.modelNoResolve }) ?? this.defaultModel
    const instructionsFile = writeInstructions(spec.workdir, this.instructionsFilename, spec.instructions)
    const dataDir = crushDataDir(spec.workdir, spec.env)
    mkdirSync(dataDir, { recursive: true })

    return {
      cmd: 'crush',
      args: ['run', '--data-dir', dataDir, '--model', model, '--small-model', model, spec.prompt],
      cwd: spec.workdir,
      env: {},
      instructionsFile,
    }
  },

  parseOutput(spec: RunSpec, _outcome: SubprocOutcome): ParsedOutput {
    const { tokensIn, tokensOut, costUsd } = readCrushSessionTotals(spec.workdir, spec.env)
    return { costUsd, tokensIn, tokensOut, raw: null }
  },
}

register('crush', crushAdapter)
