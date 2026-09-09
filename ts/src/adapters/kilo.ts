import { register } from '../registry.js'
import type { Adapter, AgentStatus, BuildCommand, ParsedOutput, ReadyState, RunSpec, SessionTelemetry, SubprocOutcome } from '../base.js'
import { finalizeCommand, validateRunSpec } from '../base.js'
import { stripAnsi, lastNonEmptyJoin } from '../util.js'
import { NO_TOTALS, candidateDbPaths, identityRaw, parseSelector, readOpenCodeRun, runSessionID, telemetryFor } from '../session-db.js'
import { dirname, join, resolve } from 'path'

/**
 * The KILO_DB value the child sees. A caller key in the spec env wins verbatim
 * (even empty, which selects upstream channel storage), then an inherited
 * nonempty value; otherwise the harness default under the workdir. Only that
 * default is harness-owned and created at prepare time.
 */
function kiloDbOverride(workdir: string, extraEnv: Record<string, string> | undefined): { value: string; harnessOwned: boolean } {
  const explicit = extraEnv?.['KILO_DB'] ?? process.env['KILO_DB']
  if (explicit !== undefined && (explicit !== '' || extraEnv?.['KILO_DB'] !== undefined)) return { value: explicit, harnessOwned: false }
  return { value: join(workdir, '.harness', 'kilo', 'kilo.db'), harnessOwned: true }
}

const kiloAdapter: Adapter = {
  name: 'kilo',
  instructionsFilename: 'AGENTS.md',
  defaultModel: 'gpt-5.4',
  permissionBypassArgs: ['--auto'],

  buildCommand(spec: RunSpec): BuildCommand {
    const validated = validateRunSpec(this, spec)
    const { model, permissionArgs, workdir } = validated
    const db = kiloDbOverride(workdir, spec.env)
    const env: Record<string, string> = { KILO_DB: db.value }
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
      directories: db.harnessOwned ? [dirname(db.value)] : [],
    })
  },

  // Telemetry is correlated by the native session ID the JSON event stream
  // reports; the SQLite row for exactly that session is read afterwards.
  parseOutput(spec: RunSpec, outcome: SubprocOutcome): ParsedOutput {
    const sessionID = runSessionID(outcome.stdout)
    if (sessionID === null) return { costUsd: null, tokensIn: null, tokensOut: null, raw: null }
    const env = { ...process.env, ...(spec.env ?? {}) }
    const workdir = resolve(spec.workdir)
    const override = kiloDbOverride(workdir, spec.env).value
    const { tokensIn, tokensOut, costUsd } = readOpenCodeRun(candidateDbPaths(env, 'kilo', override, workdir), sessionID)
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
    return telemetryFor(path, readOpenCodeRun([selector.dbPath], selector.sessionID), selector.sessionID)
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
