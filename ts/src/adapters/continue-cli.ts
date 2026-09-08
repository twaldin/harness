import { register } from '../registry.js'
import type { Adapter, AgentStatus, BuildCommand, ParsedOutput, ReadyState, RunSpec, SessionTelemetry, SubprocOutcome } from '../base.js'
import { HarnessError, finalizeCommand, validateRunSpec } from '../base.js'
import { stripAnsi, lastNonEmptyJoin } from '../util.js'
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'

/**
 * Session artifacts (continuedev/continue@5522c6f, `extensions/cli/src/session.ts`
 * and `core/util/{history,paths}.ts`): `<CONTINUE_GLOBAL_DIR or ~/.continue>/sessions/
 * <uuid>.json` holding `{sessionId, title, workspaceDirectory, history, usage?}`
 * where `workspaceDirectory` is the `cn` process cwd and `usage` is the CLI's own
 * cumulative `{totalCost, promptTokens, completionTokens, ...}`. `sessions.json`
 * in the same directory is the upstream index, not a session. The CLI never
 * persists a model id (`chatModelTitle` is unset), so `model` stays null.
 */

/** `<CONTINUE_GLOBAL_DIR or ~/.continue>/sessions`; a relative override resolves against the process cwd. */
export function continueSessionsDir(): string {
  const override = process.env['CONTINUE_GLOBAL_DIR']
  return join(override ? resolve(override) : join(process.env['HOME'] || homedir(), '.continue'), 'sessions')
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function readJsonObject(path: string): Record<string, unknown> | null {
  try { return asRecord(JSON.parse(readFileSync(path, 'utf8'))) } catch { return null }
}

function continueSessionPath(workdir: string, since?: number): string | null {
  const absolute = resolve(workdir)
  let resolved = absolute
  try { resolved = realpathSync(absolute) } catch { /* keep the unresolved path */ }
  // Distinct case-sensitive POSIX paths must not share telemetry.

  const dir = continueSessionsDir()
  let entries: Dirent[]
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return null }
  const candidates: { mtimeMs: number; path: string }[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json') || entry.name === 'sessions.json') continue
    const path = join(dir, entry.name)
    let mtimeMs: number
    try { mtimeMs = statSync(path).mtimeMs } catch { continue }
    if (since !== undefined && mtimeMs < since) continue
    candidates.push({ mtimeMs, path })
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.path < b.path ? 1 : a.path > b.path ? -1 : 0))
  for (const { path } of candidates) {
    const workspace = readJsonObject(path)?.['workspaceDirectory']
    if (workspace === absolute || workspace === resolved) return path
  }
  return null
}

function numberOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** `cn --model` takes a Continue Hub slug: exactly `owner/package`. */
function isHubSlug(model: string): boolean {
  const slash = model.indexOf('/')
  return slash > 0 && slash < model.length - 1 && !model.includes('/', slash + 1)
}

/**
 * A standalone `{status, message, ...}` line `cn` prints to stdout while
 * (auto-)compacting before the final response (commands/chat.ts).
 */
function isCompactionStatusLine(line: string): boolean {
  if (!line.startsWith('{')) return false
  try {
    const obj: unknown = JSON.parse(line)
    return typeof obj === 'object' && obj !== null && !Array.isArray(obj) && typeof (obj as Record<string, unknown>)['status'] === 'string'
  } catch {
    return false
  }
}

/**
 * The final JSON `cn --format json` prints: the model text verbatim when it
 * parsed as JSON upstream, else the `{response, status, note}` wrapper.
 * Leading compaction status lines are skipped; anything else is null.
 */
function parseHeadlessJson(stdout: string): unknown | null {
  const text = stdout.trim()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    // fall through to compaction-prefix handling
  }
  const lines = text.split('\n')
  let start = 0
  while (start < lines.length - 1 && isCompactionStatusLine(lines[start]!.trim())) start++
  if (start === 0) return null
  try {
    return JSON.parse(lines.slice(start).join('\n'))
  } catch {
    return null
  }
}

/**
 * Continue headless adapter; see SPEC.md and ADAPTER-MATRIX.md.
 * --model selects a Hub slug; an empty default delegates to upstream config.
 * Projected instructions require --rule. JSON is model output, not telemetry.
 */
const continueCliAdapter: Adapter = {
  name: 'continue-cli',
  instructionsFilename: 'CONTINUE.md',
  /** Empty means "upstream selection": no `--model`, reported model null. */
  defaultModel: '',
  permissionBypassArgs: ['--auto'],
  configFileFlag: '--config',

  buildCommand(spec: RunSpec): BuildCommand {
    const validated = validateRunSpec(this, spec)
    const { model, configArgs, configFile, permissionArgs } = validated
    // Same path finalizeCommand plans for the projection; passed as a rule
    // because cn never reads a root CONTINUE.md.
    const ruleArgs = spec.instructions === undefined ? [] : ['--rule', join(validated.workdir, this.instructionsFilename)]

    if (configFile !== null) {
      // Any explicit model (even whitespace) is rejected; empty/omitted defers to the file like Python.
      if (spec.model) {
        throw new HarnessError(
          'continue-cli configFile selects the model itself (cn --model is a Hub slug); omit spec.model or drop configFile',
          'unsupported-capability',
        )
      }
      return finalizeCommand(this, spec, validated, {
        cmd: 'cn',
        args: ['-p', ...configArgs, ...permissionArgs, ...ruleArgs, '--format', 'json', spec.prompt],
        model: null,
      })
    }

    const env = spec.env ?? {}
    if (env['OPENAI_API_KEY'] !== undefined || env['OPENAI_BASE_URL'] !== undefined) {
      throw new HarnessError(
        'continue-cli OpenAI-compatible endpoints need a caller-selected configFile; the harness no longer generates Continue configs from OPENAI_API_KEY/OPENAI_BASE_URL',
        'unsupported-capability',
      )
    }

    let modelArgs: string[] = []
    if (model) {
      if (!isHubSlug(model)) {
        throw new HarnessError(
          `continue-cli --model takes a Continue Hub slug (owner/package), not the native model id ${JSON.stringify(model)}; pass a Hub slug, or leave model unset and select the model in a Continue config (configFile -> --config)`,
          'unsupported-capability',
        )
      }
      modelArgs = ['--model', model]
    }

    return finalizeCommand(this, spec, validated, {
      cmd: 'cn',
      args: ['-p', spec.prompt, ...permissionArgs, ...modelArgs, ...ruleArgs, '--format', 'json'],
      // Explicit Hub slug keeps its spelling; otherwise the upstream config picks.
      model: model ? spec.model! : null,
    })
  },

  parseOutput(_spec: RunSpec, outcome: SubprocOutcome): ParsedOutput {
    // Headless JSON is model-generated text; any usage/cost-looking fields in
    // it are not CLI telemetry.
    return { costUsd: null, tokensIn: null, tokensOut: null, raw: parseHeadlessJson(outcome.stdout) }
  },

  sessionLogPath(workdir: string, since?: number): string | null {
    return continueSessionPath(workdir, since)
  },

  parseSessionLog(path: string): SessionTelemetry {
    const usage = asRecord(readJsonObject(path)?.['usage'])
    if (usage === null) {
      return { sessionLogPath: path, tokensIn: null, tokensOut: null, costUsd: null, model: null, raw: null }
    }
    const tokensIn = numberOrNull(usage['promptTokens'])
    const tokensOut = numberOrNull(usage['completionTokens'])
    return {
      sessionLogPath: path,
      tokensIn: tokensIn === null ? null : Math.trunc(tokensIn),
      tokensOut: tokensOut === null ? null : Math.trunc(tokensOut),
      costUsd: numberOrNull(usage['totalCost']),
      model: null,
      raw: usage,
    }
  },
}

continueCliAdapter.submitKeys = ['Enter']
continueCliAdapter.detectReady = function (pane: string): ReadyState {
  const last20 = lastNonEmptyJoin(pane, 20)
  // cn shows "Ask anything" placeholder while model is still loading.
  // Real ready = input visible AND model loaded (no "Model: Loading..." line).
  if (/Model:\s*Loading/i.test(last20)) return 'loading'
  if (/Ask anything/i.test(last20)) return 'ready'
  if (/Update available/i.test(last20)) return 'dialog'
  return 'loading'
}
continueCliAdapter.handleDialog = function (pane: string): string[] | null {
  if (/Update available/i.test(stripAnsi(pane))) return ['Escape']
  return null
}
continueCliAdapter.detectStatus = function (pane: string): AgentStatus {
  const last10 = lastNonEmptyJoin(pane, 10)
  if (/rate.?limit/i.test(last10)) return 'rate-limited'
  if (/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(last10)) return 'running'
  if (/thinking|working/i.test(last10)) return 'running'
  if (/Ask anything/i.test(last10)) return 'idle'
  return 'unknown'
}
continueCliAdapter.installMeta = {
  packageManager: 'npm',
  installCommand: ['npm', 'install', '-g', '@continuedev/cli'],
  updateCommand: ['npm', 'install', '-g', '@continuedev/cli@latest'],
  versionCommand: ['cn', '--version'],
}

register('continue-cli', continueCliAdapter)
