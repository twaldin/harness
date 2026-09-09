import { register } from '../registry.js'
import type { Adapter, AgentStatus, BuildCommand, ParsedOutput, ReadyState, RunSpec, SessionTelemetry, SubprocOutcome } from '../base.js'
import { finalizeCommand, validateRunSpec } from '../base.js'
import { stripAnsi, lastNonEmptyJoin } from '../util.js'
import { NO_TOTALS, field, identityRaw, openReadOnly, parseSelector, telemetryFor, unanimous, validCost, validTokens } from '../session-db.js'
import type { SessionTotals } from '../session-db.js'
import { existsSync } from 'fs'
import { join, resolve } from 'path'

/** `crush run --verbose` logs the new session on stderr; continuation records are deliberately not matched. */
const CREATED_SESSION_RE = /^INFO\s+Created session for non-interactive run session_id=([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\r?$/

/** The native session ID a fresh non-interactive run created; null when none or several distinct IDs were logged. */
function crushSessionID(stderr: string): string | null {
  let found: string | null = null
  for (const line of stripAnsi(stderr).split('\n')) {
    const id = CREATED_SESSION_RE.exec(line)?.[1]
    if (id === undefined) continue
    if (found !== null && found !== id) return null
    found = id
  }
  return found
}

/**
 * The data dir the child uses. A caller key in the spec env wins (an empty
 * value never resurrects an inherited path), then an inherited nonempty
 * value, relative to the child's workdir like `--data-dir`; otherwise the
 * harness default under the workdir, the only one created at prepare time.
 */
function crushDataDir(workdir: string, extraEnv: Record<string, string> | undefined): { dir: string; harnessOwned: boolean } {
  const explicit = extraEnv?.['CRUSH_DATA_DIR'] ?? process.env['CRUSH_DATA_DIR']
  if (explicit !== undefined && explicit !== '') return { dir: resolve(workdir, explicit), harnessOwned: false }
  return { dir: join(workdir, '.harness', 'crush-data'), harnessOwned: true }
}

/**
 * Upstream aggregates for exactly one session: `sessions.prompt_tokens`,
 * `completion_tokens` and `cost` are reported literally when valid. The
 * model comes from that session's assistant messages when they unanimously
 * name one nonempty model and provider; a missing messages table leaves the
 * session aggregates intact.
 */
function readCrushSession(dbPath: string, sessionID: string): SessionTotals {
  if (!existsSync(dbPath)) return NO_TOTALS
  const db = openReadOnly(dbPath)
  if (!db) return NO_TOTALS
  try {
    const row = db.get('SELECT prompt_tokens, completion_tokens, cost FROM sessions WHERE id = ?', sessionID)
    if (row === null) return NO_TOTALS
    const tokensIn = validTokens(field(row, 'prompt_tokens'))
    const tokensOut = validTokens(field(row, 'completion_tokens'))
    const costUsd = validCost(field(row, 'cost'))
    let model: string | null = null
    try {
      const messages = db.all("SELECT model, provider FROM messages WHERE session_id = ? AND role = 'assistant'", sessionID)
      const providers = messages.map((message) => field(message, 'provider'))
      model = unanimous(providers) === null ? null : unanimous(messages.map((message) => field(message, 'model')))
    } catch {
      // messages table absent: aggregates stand, model unknown
    }
    return { tokensIn, tokensOut, costUsd, model }
  } catch {
    return NO_TOTALS
  } finally {
    db.close()
  }
}

const crushAdapter: Adapter = {
  name: 'crush',
  instructionsFilename: 'AGENTS.md',
  defaultModel: 'gpt-5.4',

  buildCommand(spec: RunSpec): BuildCommand {
    const validated = validateRunSpec(this, spec)
    const { model, workdir } = validated
    const data = crushDataDir(workdir, spec.env)
    return finalizeCommand(this, spec, validated, {
      cmd: 'crush',
      args: ['run', '--verbose', '--data-dir', data.dir, '--model', model, '--small-model', model, spec.prompt],
      // Caller-selected data dirs are upstream state; only the harness default is created at prepare time.
      directories: data.harnessOwned ? [data.dir] : [],
    })
  },

  // Telemetry is correlated by the native session ID the verbose log reports;
  // the SQLite row for exactly that session is read afterwards.
  parseOutput(spec: RunSpec, outcome: SubprocOutcome): ParsedOutput {
    const sessionID = crushSessionID(outcome.stderr)
    if (sessionID === null) return { costUsd: null, tokensIn: null, tokensOut: null, raw: null }
    const dbPath = join(crushDataDir(resolve(spec.workdir), spec.env).dir, 'crush.db')
    const { tokensIn, tokensOut, costUsd } = readCrushSession(dbPath, sessionID)
    return { costUsd, tokensIn, tokensOut, raw: identityRaw(sessionID, costUsd) }
  },

  // The store is keyed by native session ID; without that identity there is no session log to name.
  sessionLogPath(_workdir: string, _since?: number): string | null {
    return null
  },

  /** Accepts only an explicit `<database path>#session=<percent-encoded native ID>` selector. */
  parseSessionLog(path: string): SessionTelemetry {
    const selector = parseSelector(path)
    if (selector === null) return telemetryFor(path, NO_TOTALS, null)
    return telemetryFor(path, readCrushSession(selector.dbPath, selector.sessionID), selector.sessionID)
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
