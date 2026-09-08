import { register } from '../registry.js'
import type { Adapter, AgentStatus, BuildCommand, ParsedOutput, ReadyState, RunSpec, SessionTelemetry, SubprocOutcome } from '../base.js'
import { HarnessError, finalizeCommand, validateRunSpec } from '../base.js'
import { stripAnsi, lastNonEmptyJoin } from '../util.js'
import { deriveCost } from '../pricing.js'
import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { basename, join } from 'path'
import { homedir } from 'os'

function continueSessionPath(workdir: string): string | null {
  const envDir = process.env['CONTINUE_SESSION_DIR']
  if (envDir) {
    try {
      const files = readdirSync(envDir)
        .filter((n) => n.endsWith('.json'))
        .map((n) => ({ path: join(envDir, n), mtimeMs: statSync(join(envDir, n)).mtimeMs }))
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
      const newest = files[0]
      if (newest) return newest.path
    } catch {
      return null
    }
  }

  const home = process.env.HOME ?? homedir()
  const base = basename(workdir)
  const candidates = [
    join(home, '.continue', 'sessions', base),
    join(home, '.continue', 'dev_data', base),
    join(home, '.continue', 'index', base),
  ]
  for (const dir of candidates) {
    if (!existsSync(dir)) continue
    try {
      const files = readdirSync(dir)
        .filter((n) => n.endsWith('.json'))
        .map((n) => ({ path: join(dir, n), mtimeMs: statSync(join(dir, n)).mtimeMs }))
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
      const newest = files[0]
      if (newest) return newest.path
      const indexPath = join(dir, 'session.json')
      if (existsSync(indexPath)) return indexPath
    } catch {
      continue
    }
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

  sessionLogPath(workdir: string, _since?: number): string | null {
    return continueSessionPath(workdir)
  },

  parseSessionLog(path: string): SessionTelemetry {
    if (!existsSync(path)) {
      return { sessionLogPath: path, tokensIn: null, tokensOut: null, costUsd: null, model: null, raw: null }
    }
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown
      const obj = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
      const usage = obj['usage'] && typeof obj['usage'] === 'object' ? obj['usage'] as Record<string, unknown> : {}
      const tokensIn = numberOrNull(usage['input_tokens'])
      const tokensOut = numberOrNull(usage['output_tokens'])
      const rawCost = numberOrNull(obj['total_cost_usd'])
      const model = typeof obj['model'] === 'string' ? obj['model'] : null
      const costUsd = rawCost ?? deriveCost(model, tokensIn, tokensOut)
      return { sessionLogPath: path, tokensIn, tokensOut, costUsd, model, raw: parsed }
    } catch {
      return { sessionLogPath: path, tokensIn: null, tokensOut: null, costUsd: null, model: null, raw: null }
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
