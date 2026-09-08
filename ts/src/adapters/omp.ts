import { register } from '../registry.js'
import type { Adapter, BuildCommand, ParsedOutput, RunSpec, SubprocOutcome } from '../base.js'
import { finalizeCommand, validateRunSpec } from '../base.js'

// Oh My Pi (omp) `--print --mode json` writes one JSON object per stdout line.
// An assistant message carries usage { input, output, cacheRead, cacheWrite,
// totalTokens, cost: { total, ... } }. Qualified with 18.1.10, a cycle looks like:
//
//   message_end (assistant, final usage) → turn_end (same usage again)
//   → agent_end { messages: [...] }
//
// `agent_end.messages` is authoritative for its completed cycle. A stream cut
// before it leaves `message_end` records; `turn_end` is only a fallback for a
// turn that never produced an assistant `message_end`. `message_update`
// partials never carry usage worth counting.
//
// Exit status is the real process status: a provider error surfaces in the
// records (`error` / `stopReason`), and omp may still exit 0.

type JsonObject = Record<string, unknown>

interface Usage {
  tokensIn: number | null
  tokensOut: number | null
  costUsd: number | null
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function add(total: number | null, value: number | null): number | null {
  return value === null ? total : (total ?? 0) + value
}

function merge(into: Usage, from: Usage): void {
  into.tokensIn = add(into.tokensIn, from.tokensIn)
  into.tokensOut = add(into.tokensOut, from.tokensOut)
  into.costUsd = add(into.costUsd, from.costUsd)
}

/**
 * Adds one assistant message's usage. Each metric counts independently and
 * only when well-typed: token counts as nonnegative integers, cost.total as a
 * finite nonnegative number; anything else leaves that metric untouched.
 * Returns whether `message` was an assistant message at all.
 */
function addAssistantUsage(into: Usage, message: unknown): boolean {
  if (!isJsonObject(message) || message['role'] !== 'assistant') return false
  const usage = message['usage']
  if (!isJsonObject(usage)) return true
  const input = usage['input']
  const output = usage['output']
  const cost = usage['cost']
  const total = isJsonObject(cost) ? cost['total'] : undefined
  if (typeof input === 'number' && Number.isInteger(input) && input >= 0) {
    into.tokensIn = add(into.tokensIn, input)
  }
  if (typeof output === 'number' && Number.isInteger(output) && output >= 0) {
    into.tokensOut = add(into.tokensOut, output)
  }
  if (typeof total === 'number' && Number.isFinite(total) && total >= 0) {
    into.costUsd = add(into.costUsd, total)
  }
  return true
}

function parseOmpEvents(stdout: string): ParsedOutput {
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
  if (records.length === 0) return { costUsd: null, tokensIn: null, tokensOut: null, raw: null }

  const totals: Usage = { tokensIn: null, tokensOut: null, costUsd: null }
  let pending: Usage = { tokensIn: null, tokensOut: null, costUsd: null }
  // The current turn already contributed an assistant `message_end`; its
  // `turn_end` repeats that usage and must not be counted again.
  let turnCounted = false

  for (const record of records) {
    switch (record['type']) {
      case 'message_end':
        if (addAssistantUsage(pending, record['message'])) turnCounted = true
        break
      case 'turn_end':
        if (!turnCounted) addAssistantUsage(pending, record['message'])
        turnCounted = false
        break
      case 'agent_end': {
        const messages = record['messages']
        if (Array.isArray(messages)) {
          for (const message of messages) addAssistantUsage(totals, message)
        } else {
          merge(totals, pending)
        }
        pending = { tokensIn: null, tokensOut: null, costUsd: null }
        turnCounted = false
        break
      }
    }
  }
  // Incomplete final cycle: keep what its message_end / turn_end records reported.
  merge(totals, pending)

  return { costUsd: totals.costUsd, tokensIn: totals.tokensIn, tokensOut: totals.tokensOut, raw: records }
}

const ompAdapter: Adapter = {
  name: 'omp',
  instructionsFilename: 'AGENTS.md',
  defaultModel: 'sonnet',
  permissionBypassArgs: ['--auto-approve'],
  configHomeEnv: 'PI_CODING_AGENT_DIR',
  configFileFlag: '--config',

  buildCommand(spec: RunSpec): BuildCommand {
    const validated = validateRunSpec(this, spec)
    const { model, permissionArgs, configHome, configArgs } = validated
    const args = ['--print', '--mode', 'json', '--no-session', '--model', model]
    // An explicit agent dir must win over an inherited OMP_PROFILE, which would
    // otherwise ignore that dir and select state under the config root.
    if (configHome !== null) args.push('--profile', 'default')
    args.push(...permissionArgs, ...configArgs, '--', spec.prompt)
    return finalizeCommand(this, spec, validated, { cmd: 'omp', args })
  },

  parseOutput(_spec: RunSpec, outcome: SubprocOutcome): ParsedOutput {
    return parseOmpEvents(outcome.stdout)
  },
}

ompAdapter.installMeta = {
  packageManager: 'brew',
  installCommand: ['brew', 'install', 'can1357/tap/omp'],
  updateCommand: ['brew', 'upgrade', 'omp'],
  versionCommand: ['omp', '--version'],
}

register('omp', ompAdapter)
