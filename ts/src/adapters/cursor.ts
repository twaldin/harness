import { register } from '../registry.js'
import { HarnessError, finalizeCommand, validateRunSpec } from '../base.js'
import type { Adapter, BuildCommand, ParsedOutput, RunSpec, SubprocOutcome } from '../base.js'

// Cursor CLI `agent --print --output-format stream-json` writes one JSON
// object per stdout line (verified against 2026.09.02-c22c1a3). The stream
// carries system/user/assistant/tool_call events and a final `result` event
// with duration, result text, session_id and an optional usage block whose
// inputTokens already excludes cache reads/writes. Only that last result's
// input/output counts are reported; cache metrics are not folded in, no USD
// total is reported, and the events are preserved verbatim, in order.

type JsonObject = Record<string, unknown>

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const cursorAdapter: Adapter = {
  name: 'cursor',
  instructionsFilename: 'AGENTS.md',
  defaultModel: '', // Leave model selection to the caller's Cursor config.
  permissionBypassArgs: ['--force'],
  configHomeEnv: 'CURSOR_CONFIG_DIR',
  // Native headless mode registers a SIGINT AbortController that aborts all
  // work; SIGTERM only triggers the global exit path.
  gracefulSignal: 'SIGINT',

  buildCommand(spec: RunSpec): BuildCommand {
    const validated = validateRunSpec(this, spec)
    if (!spec.prompt) {
      throw new HarnessError('cursor requires a non-empty prompt for non-interactive mode', 'invalid-options')
    }
    const { model, permissionArgs } = validated
    const args = ['--print', '--output-format', 'stream-json', '--stream-partial-output']
    if (model) args.push('--model', model)
    // `--` keeps leading '-' prompts from being parsed as flags.
    args.push(...permissionArgs, '--', spec.prompt)
    return finalizeCommand(this, spec, validated, { cmd: 'agent', args, model: spec.model || null })
  },

  parseOutput(_spec: RunSpec, outcome: SubprocOutcome): ParsedOutput {
    const events: JsonObject[] = []
    // A complete final line needs no trailing newline; a truncated one fails to
    // parse and is dropped like any other malformed line. JSON.parse already
    // rejects the non-standard NaN/Infinity constants.
    for (const line of outcome.stdout.split('\n')) {
      const s = line.trim()
      if (!s) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(s)
      } catch {
        continue
      }
      if (isJsonObject(parsed)) events.push(parsed)
    }
    let tokensIn: number | null = null
    let tokensOut: number | null = null
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i]!
      if (event['type'] !== 'result') continue
      const usage = event['usage']
      if (isJsonObject(usage)) {
        // Counts must be exact in both language APIs; reject unsafe integers
        // rather than silently report a rounded token total.
        const input = usage['inputTokens']
        const output = usage['outputTokens']
        tokensIn = typeof input === 'number' && Number.isSafeInteger(input) && input >= 0 ? input : null
        tokensOut = typeof output === 'number' && Number.isSafeInteger(output) && output >= 0 ? output : null
      }
      break
    }
    return { costUsd: null, tokensIn, tokensOut, raw: events.length === 0 ? null : events }
  },
}

cursorAdapter.installMeta = {
  packageManager: 'binary',
  installCommand: ['bash', '-c', 'curl https://cursor.com/install -fsS | bash'],
  updateCommand: ['agent', 'update'],
  versionCommand: ['agent', '--version'],
  platforms: ['darwin', 'linux'],
}

register('cursor', cursorAdapter)
