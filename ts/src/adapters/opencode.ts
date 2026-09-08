import { register } from '../registry.js'
import type { Adapter, BuildCommand, ParsedOutput, RunSpec, SubprocOutcome, SessionTelemetry } from '../base.js'
import { finalizeCommand, validateRunSpec } from '../base.js'
import { stripAnsi, lastNonEmptyJoin } from '../util.js'
import { resolve } from 'path'
import { NO_TOTALS, candidateDbPaths, identityRaw, parseSelector, readOpenCodeRun, runSessionID, telemetryFor } from '../session-db.js'

const openCodeAdapter: Adapter = {
  name: 'opencode',
  instructionsFilename: 'AGENTS.md',
  defaultModel: 'gpt-5.4',
  scrollOwnership: 'app',

  buildCommand(spec: RunSpec): BuildCommand {
    const validated = validateRunSpec(this, spec)
    const { model, workdir } = validated
    return finalizeCommand(this, spec, validated, {
      cmd: 'opencode',
      args: ['run', '--format', 'json', '--dir', workdir, '--model', model, spec.prompt],
    })
  },

  // Telemetry is correlated by the native session ID the JSON event stream
  // reports; the SQLite row for exactly that session is read afterwards.
  parseOutput(spec: RunSpec, outcome: SubprocOutcome): ParsedOutput {
    const sessionID = runSessionID(outcome.stdout)
    if (sessionID === null) return { costUsd: null, tokensIn: null, tokensOut: null, raw: null }
    const env = { ...process.env, ...(spec.env ?? {}) }
    const { tokensIn, tokensOut, costUsd } = readOpenCodeRun(candidateDbPaths(env, 'opencode', env['OPENCODE_DB'], resolve(spec.workdir)), sessionID)
    return { costUsd, tokensIn, tokensOut, raw: identityRaw(sessionID, costUsd) }
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

// opencode telemetry lives in the shared SQLite store keyed by native session
// ID; without that identity there is no session log to name.
openCodeAdapter.sessionLogPath = function (_workdir: string, _since?: number): string | null {
  return null
}

/** Accepts only an explicit `<database path>#session=<percent-encoded native ID>` selector. */
openCodeAdapter.parseSessionLog = function (path: string): SessionTelemetry {
  const selector = parseSelector(path)
  if (selector === null) return telemetryFor(path, NO_TOTALS, null)
  return telemetryFor(path, readOpenCodeRun([selector.dbPath], selector.sessionID), selector.sessionID)
}

openCodeAdapter.installMeta = {
  packageManager: 'npm',
  installCommand: ['npm', 'install', '-g', 'opencode-ai'],
  updateCommand: ['npm', 'install', '-g', 'opencode-ai@latest'],
  versionCommand: ['opencode', '--version'],
}

register('opencode', openCodeAdapter)
