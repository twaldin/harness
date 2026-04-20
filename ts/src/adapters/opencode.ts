import { register } from '../registry.js'
import { writeInstructions } from '../subproc.js'
import type { Adapter, BuildCommand, ParsedOutput, RunSpec, SubprocOutcome } from '../base.js'
import { homedir } from 'os'
import { existsSync } from 'fs'
import { resolve, basename } from 'path'
import Database from 'better-sqlite3'

function openCodeDbPath(): string {
  const envPath = process.env['OPENCODE_DB']
  if (envPath) return envPath.replace(/^~/, homedir())
  return `${homedir()}/.local/share/opencode/opencode.db`
}

function readOpenCodeSessionTotals(workdir: string): { tokensIn: number | null; tokensOut: number | null; costUsd: number | null } {
  const dbPath = openCodeDbPath()
  if (!existsSync(dbPath)) return { tokensIn: null, tokensOut: null, costUsd: null }

  let resolvedWorkdir = workdir
  try {
    resolvedWorkdir = resolve(workdir)
  } catch {
    // keep raw
  }
  const wdBasename = basename(resolvedWorkdir)

  let db: InstanceType<typeof Database> | undefined
  try {
    db = new Database(dbPath, { readonly: true, timeout: 5000 })
  } catch {
    return { tokensIn: null, tokensOut: null, costUsd: null }
  }

  try {
    const row = db.prepare(`
      SELECT
        COALESCE(SUM(json_extract(data, '$.tokens.input')), 0)  AS tokens_in,
        COALESCE(SUM(json_extract(data, '$.tokens.output')), 0) AS tokens_out,
        COALESCE(SUM(json_extract(data, '$.cost')), 0)          AS cost
      FROM message
      WHERE session_id IN (
        SELECT id FROM session WHERE directory LIKE ? ORDER BY time_updated DESC LIMIT 1
      )
    `).get(`%${wdBasename}%`) as { tokens_in: number; tokens_out: number; cost: number } | undefined

    if (!row) return { tokensIn: null, tokensOut: null, costUsd: null }
    return {
      tokensIn: row.tokens_in ? Math.round(row.tokens_in) : null,
      tokensOut: row.tokens_out ? Math.round(row.tokens_out) : null,
      costUsd: row.cost ? row.cost : null,
    }
  } catch {
    return { tokensIn: null, tokensOut: null, costUsd: null }
  } finally {
    db?.close()
  }
}

const openCodeAdapter: Adapter = {
  name: 'opencode',
  instructionsFilename: 'AGENTS.md',
  defaultModel: 'openai/gpt-5.4',

  buildCommand(spec: RunSpec): BuildCommand {
    const model = spec.model ?? this.defaultModel
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
