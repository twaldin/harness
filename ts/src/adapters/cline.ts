import { register } from '../registry.js'
import { HarnessError, finalizeCommand, validateRunSpec } from '../base.js'
import type { Adapter, BuildCommand, ParsedOutput, RunSpec, SubprocOutcome } from '../base.js'

// Cline standalone CLI, `cline --json` headless run. Qualified against
// cline 3.0.61 (pinned upstream tag cli-v3.0.61). Stdout is one JSON object
// per line: `hook_event`, `agent_event` (streaming partials, per-iteration
// `usage`, `done`) and finally one `run_result`:
//
//   { type: 'run_result', finishReason: 'completed' | 'error' | ...,
//     usage: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalCost },
//     aggregateUsage: {...}, durationMs, text, model: {...} }
//
// `run_result.usage` is the run's accumulated total, so only the last such
// record feeds the metrics; per-iteration `usage` / `done` records are never
// summed. A run cut before its terminal record reports null metrics while the
// partial records stay in `raw`. The process status is the real one: cline
// reports provider failures through `finishReason` inside the stream.
//
// Environment (upstream sources under apps/cli/src):
//   CLINE_SESSION_BACKEND_MODE=local  documented; keeps the session in-process
//                                     instead of the shared hub daemon (session/session.ts)
//   CLINE_NO_AUTO_UPDATE=1            disables the detached npm self-updater (commands/update.ts)
//   CLINE_RUN_AS_HUB_DAEMON=0         entry sentinel; never run as the daemon
//   CLINE_TOOL_APPROVAL_MODE=desktop  routes approvals to the desktop app's IPC
//                                     (utils/approval.ts); rejected as not headless
//   CLINE_DIR                         config root (`configHome`)
//
// `instructions` are projected to CLINE.md and referenced through cline's
// native file mention (`@./CLINE.md`, runtime/prompt.ts) rather than relying
// on git-root auto-discovery; the explicit relative mention also sidesteps
// whitespace/quote issues in absolute workdir paths.

type JsonObject = Record<string, unknown>

/** Per-run env the adapter requires; an explicit `spec.env` disagreement is rejected. */
const REQUIRED_ENV: Readonly<Record<string, string>> = {
  CLINE_SESSION_BACKEND_MODE: 'local',
  CLINE_NO_AUTO_UPDATE: '1',
  CLINE_RUN_AS_HUB_DAEMON: '0',
}
const APPROVAL_MODE_ENV = 'CLINE_TOOL_APPROVAL_MODE'
const INSTRUCTIONS_MENTION = 'Follow the instructions in @./CLINE.md\n\n'

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseRecords(stdout: string): JsonObject[] {
  const records: JsonObject[] = []
  for (const line of stdout.split('\n')) {
    const s = line.trim()
    if (!s) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(s)
    } catch {
      continue
    }
    if (isJsonObject(parsed)) records.push(parsed)
  }
  return records
}

const clineAdapter: Adapter = {
  name: 'cline',
  instructionsFilename: 'CLINE.md',
  defaultModel: '', // Leave provider/model selection to the caller's cline config.
  permissionBypassArgs: ['--auto-approve', 'true'],
  nativeOptionsKind: 'cline',
  configHomeEnv: 'CLINE_DIR',
  // First SIGINT stops a local-mode run and its shell tool child; SIGTERM
  // leaves that child alive in its own process group (see ticket probes).
  gracefulSignal: 'SIGINT',

  buildCommand(spec: RunSpec): BuildCommand {
    const validated = validateRunSpec(this, spec)
    if (!spec.prompt.trim()) {
      // A missing prompt makes cline fall back to its interactive session.
      throw new HarnessError('cline requires a non-empty prompt for a headless run', 'invalid-options')
    }
    const env = spec.env ?? {}
    for (const [key, value] of Object.entries(REQUIRED_ENV)) {
      const explicit = env[key]
      if (explicit !== undefined && explicit !== value) {
        throw new HarnessError(
          `env.${key}=${JSON.stringify(explicit)} conflicts with the ${JSON.stringify(value)} cline headless runs require; unset it`,
          'invalid-options',
        )
      }
    }
    const approvalMode = env[APPROVAL_MODE_ENV] ?? process.env[APPROVAL_MODE_ENV]
    if (approvalMode !== undefined && approvalMode.trim().toLowerCase() === 'desktop') {
      throw new HarnessError(
        `${APPROVAL_MODE_ENV}=desktop delegates tool approval to the Cline desktop app; unset it for headless runs`,
        'unsupported-capability',
      )
    }

    const args = ['--json', '--cwd', validated.workdir]
    if (validated.model) args.push('--model', validated.model)
    args.push(...validated.nativeArgs, ...validated.permissionArgs)
    const prompt = spec.instructions === undefined ? spec.prompt : INSTRUCTIONS_MENTION + spec.prompt
    args.push('--', prompt)
    return finalizeCommand(this, spec, validated, { cmd: 'cline', args, env: { ...REQUIRED_ENV }, model: spec.model || null })
  },

  parseOutput(_spec: RunSpec, outcome: SubprocOutcome): ParsedOutput {
    const records = parseRecords(outcome.stdout)
    let tokensIn: number | null = null
    let tokensOut: number | null = null
    let costUsd: number | null = null
    for (let i = records.length - 1; i >= 0; i--) {
      const record = records[i]!
      if (record['type'] !== 'run_result') continue
      const usage = record['usage']
      if (isJsonObject(usage)) {
        // Each metric validates independently: token counts as nonnegative
        // safe integers, cost as a finite nonnegative number; else null.
        const input = usage['inputTokens']
        const output = usage['outputTokens']
        const total = usage['totalCost']
        tokensIn = typeof input === 'number' && Number.isSafeInteger(input) && input >= 0 ? input : null
        tokensOut = typeof output === 'number' && Number.isSafeInteger(output) && output >= 0 ? output : null
        costUsd = typeof total === 'number' && Number.isFinite(total) && total >= 0 ? total : null
      }
      break
    }
    return { costUsd, tokensIn, tokensOut, raw: records.length === 0 ? null : records }
  },
}

clineAdapter.installMeta = {
  packageManager: 'npm',
  installCommand: ['npm', 'install', '-g', 'cline'],
  updateCommand: ['npm', 'install', '-g', 'cline@latest'],
  versionCommand: ['cline', '--version'],
}

register('cline', clineAdapter)
