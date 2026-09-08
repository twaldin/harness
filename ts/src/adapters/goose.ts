import { register } from '../registry.js'
import { HarnessError, finalizeCommand, validateRunSpec } from '../base.js'
import type { Adapter, BuildCommand, ParsedOutput, RunSpec, SubprocOutcome } from '../base.js'

/** Child env that makes goose auto-approve tool calls; `approve` prompts and rejects headlessly. */
const BYPASS_MODE = 'auto'

type StreamEvent = Record<string, unknown> & { type: string }

function isStreamEvent(value: unknown): value is StreamEvent {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && typeof (value as Record<string, unknown>)['type'] === 'string'
}


/** Goose's local non-interactive run command, not its ACP/HTTP server. */
const gooseAdapter: Adapter = {
  name: 'goose',
  // Use --system rather than projecting a file that CONTEXT_FILE_NAMES could exclude.
  instructionsFilename: '',
  defaultModel: '', // Provider and model come from the caller's goose config / GOOSE_* env.
  // Bypass is env, not argv: GOOSE_MODE=auto on the child.
  permissionBypassArgs: [],
  configHomeEnv: 'GOOSE_PATH_ROOT',

  buildCommand(spec: RunSpec): BuildCommand {
    const validated = validateRunSpec(this, spec)
    const env: Record<string, string> = {}
    if (validated.permissionPolicy === 'bypass') {
      const explicit = spec.env?.['GOOSE_MODE']
      if (explicit !== undefined && explicit !== BYPASS_MODE) {
        throw new HarnessError(
          `permissionPolicy "bypass" conflicts with env.GOOSE_MODE=${JSON.stringify(explicit)}; set one`,
          'invalid-options',
        )
      }
      env['GOOSE_MODE'] = BYPASS_MODE
    }
    const args = ['run', '--quiet', '--output-format', 'stream-json']
    if (validated.model) args.push('--model', validated.model)
    if (spec.instructions != null) args.push(`--system=${spec.instructions}`)
    args.push(`--text=${spec.prompt}`)
    return finalizeCommand(this, spec, validated, { cmd: 'goose', args, env, model: spec.model || null })
  },

  parseOutput(_spec: RunSpec, outcome: SubprocOutcome): ParsedOutput {
    const events: StreamEvent[] = []
    let complete: StreamEvent | null = null
    for (const line of outcome.stdout.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('{')) continue
      let event: unknown
      try {
        event = JSON.parse(trimmed)
      } catch {
        continue
      }
      if (!isStreamEvent(event)) continue
      events.push(event)
      if (event.type === 'complete') complete = event
    }
    // The last `complete` carries cumulative session usage; never sum events.
    // Each metric stands alone: typeof number excludes booleans, the range check excludes NaN/Infinity.
    const cost = complete?.['cost_usd']
    const tokensIn = complete?.['input_tokens']
    const tokensOut = complete?.['output_tokens']
    return {
      costUsd: typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : null,
      tokensIn: typeof tokensIn === 'number' && Number.isInteger(tokensIn) && tokensIn >= 0 ? tokensIn : null,
      tokensOut: typeof tokensOut === 'number' && Number.isInteger(tokensOut) && tokensOut >= 0 ? tokensOut : null,
      raw: events.length === 0 ? null : events,
    }
  },
}

register('goose', gooseAdapter)
