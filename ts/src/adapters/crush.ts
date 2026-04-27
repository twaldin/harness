import { register } from '../registry.js'
import { writeInstructions } from '../subproc.js'
import type { Adapter, AgentStatus, BuildCommand, ParsedOutput, ReadyState, RunSpec, SessionTelemetry, SubprocOutcome } from '../base.js'
import { normalizeModelForHarness } from '../model-normalization.js'
import { stripAnsi, lastNonEmptyJoin } from '../util.js'
import { deriveCost } from '../pricing.js'
import { createRequire } from 'module'
import { existsSync, mkdirSync } from 'fs'
import { basename, join, resolve } from 'path'
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

function readCrushSessionTotalsByDbPath(
  dbPath: string,
): { tokensIn: number | null; tokensOut: number | null; costUsd: number | null; model: string | null } {
  if (!existsSync(dbPath)) return { tokensIn: null, tokensOut: null, costUsd: null, model: null }

  const db = openDb(dbPath)
  if (!db) return { tokensIn: null, tokensOut: null, costUsd: null, model: null }

  try {
    const row = db.get(
      `
      SELECT prompt_tokens, completion_tokens, cost, model
      FROM sessions
      WHERE parent_session_id IS NULL
      ORDER BY updated_at DESC
      LIMIT 1
      `,
    ) as { prompt_tokens: unknown; completion_tokens: unknown; cost: unknown; model: unknown } | undefined

    const tokensIn = typeof row?.prompt_tokens === 'number' ? Math.trunc(row.prompt_tokens) : null
    const tokensOut = typeof row?.completion_tokens === 'number' ? Math.trunc(row.completion_tokens) : null
    const costUsd = typeof row?.cost === 'number' ? row.cost : null
    const model = typeof row?.model === 'string' ? row.model : null
    return { tokensIn, tokensOut, costUsd, model }
  } catch {
    return { tokensIn: null, tokensOut: null, costUsd: null, model: null }
  } finally {
    db.close()
  }
}

function readCrushSessionTotals(
  workdir: string,
  extraEnv: Record<string, string> | undefined,
): { tokensIn: number | null; tokensOut: number | null; costUsd: number | null; model: string | null } {
  return readCrushSessionTotalsByDbPath(join(crushDataDir(workdir, extraEnv), 'crush.db'))
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

  sessionLogPath(workdir: string, _since?: number): string | null {
    const dbPath = join(crushDataDir(workdir, undefined), 'crush.db')
    if (!existsSync(dbPath)) return null
    let wd = workdir
    try { wd = basename(resolve(workdir)) } catch { wd = basename(workdir) }
    return `${dbPath}#session(${wd})`
  },

  parseSessionLog(path: string): SessionTelemetry {
    const dbPath = path.split('#')[0] ?? path
    const { tokensIn, tokensOut, costUsd, model } = readCrushSessionTotalsByDbPath(dbPath)
    let finalCost = costUsd
    if ((finalCost == null || finalCost === 0) && (tokensIn != null || tokensOut != null)) {
      finalCost = deriveCost(model ?? 'gpt-5.4', tokensIn, tokensOut) ?? finalCost
    }
    return { sessionLogPath: path, tokensIn, tokensOut, costUsd: finalCost, model, raw: null }
  },
}

crushAdapter.submitKeys = ['Enter']
crushAdapter.detectReady = function (pane: string): ReadyState {
  const last30 = lastNonEmptyJoin(pane, 30)
  // First-time setup: model picker shown
  if (/choose.*confirm/i.test(last30) && /↑\/↓/.test(last30)) return 'dialog'
  // Ready: prompt visible (crush uses ▎ or > marker) + model status bar
  if (/Ready|Charm|Crush/i.test(last30) && /\$|>|▎|❯/.test(last30)) return 'ready'
  return 'loading'
}
crushAdapter.handleDialog = function (pane: string): string[] | null {
  const text = stripAnsi(pane)
  if (/choose.*confirm/i.test(text)) return ['Enter'] // accept the highlighted (default) model
  return null
}
crushAdapter.detectStatus = function (pane: string): AgentStatus {
  const last10 = lastNonEmptyJoin(pane, 10)
  if (/rate.?limit/i.test(last10)) return 'rate-limited'
  if (/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(last10) || /thinking|working/i.test(last10)) return 'running'
  if (/Ready|>\s*$|❯\s*$/.test(last10)) return 'idle'
  return 'unknown'
}
crushAdapter.installMeta = {
  packageManager: 'brew',
  installCommand: ['brew', 'install', 'charmbracelet/tap/crush'],
  updateCommand: ['brew', 'upgrade', 'crush'],
  versionCommand: ['crush', '--version'],
  platforms: ['darwin', 'linux'],
}

register('crush', crushAdapter)
