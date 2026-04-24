import { register } from '../registry.js'
import { writeInstructions } from '../subproc.js'
import type { Adapter, BuildCommand, ParsedOutput, RunSpec, SubprocOutcome } from '../base.js'
import { normalizeModelForHarness } from '../model-normalization.js'

// pi's --mode json writes one JSON object per stdout line. AssistantMessage.usage
// has { input, output, cacheRead, cacheWrite, totalTokens, cost: { total, ... } }.
// Prefer agent_end.messages (authoritative); fall back to summing turn_end events
// if the stream was cut off.
// Docs: https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/json.md

interface PiUsage {
  input?: number
  output?: number
  cost?: { total?: number }
}

interface PiAssistantMessage {
  role?: string
  usage?: PiUsage
}

interface PiEvent {
  type?: string
  message?: PiAssistantMessage
  messages?: PiAssistantMessage[]
}

function sumAssistantUsage(messages: PiAssistantMessage[]): { tokensIn: number; tokensOut: number; cost: number } {
  let tokensIn = 0
  let tokensOut = 0
  let cost = 0
  for (const msg of messages) {
    if (!msg || msg.role !== 'assistant') continue
    const usage = msg.usage ?? {}
    tokensIn += Number(usage.input ?? 0)
    tokensOut += Number(usage.output ?? 0)
    cost += Number(usage.cost?.total ?? 0)
  }
  return { tokensIn, tokensOut, cost }
}

function parsePiEvents(stdout: string): {
  tokensIn: number | null
  tokensOut: number | null
  costUsd: number | null
  raw: PiEvent[] | null
} {
  const events: PiEvent[] = []
  for (const line of stdout.split('\n')) {
    const s = line.trim()
    if (!s) continue
    try {
      const ev = JSON.parse(s) as PiEvent
      if (ev && typeof ev === 'object') events.push(ev)
    } catch {
      // skip non-JSON lines
    }
  }

  if (events.length === 0) {
    return { tokensIn: null, tokensOut: null, costUsd: null, raw: null }
  }

  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]!
    if (ev.type === 'agent_end' && Array.isArray(ev.messages)) {
      const { tokensIn, tokensOut, cost } = sumAssistantUsage(ev.messages)
      return { tokensIn, tokensOut, costUsd: cost, raw: events }
    }
  }

  let tokensIn = 0
  let tokensOut = 0
  let cost = 0
  let anyAssistant = false
  for (const ev of events) {
    if (ev.type !== 'turn_end') continue
    const msg = ev.message
    if (!msg || msg.role !== 'assistant') continue
    const usage = msg.usage ?? {}
    tokensIn += Number(usage.input ?? 0)
    tokensOut += Number(usage.output ?? 0)
    cost += Number(usage.cost?.total ?? 0)
    anyAssistant = true
  }

  if (!anyAssistant) {
    return { tokensIn: null, tokensOut: null, costUsd: null, raw: events }
  }
  return { tokensIn, tokensOut, costUsd: cost, raw: events }
}

const piAdapter: Adapter = {
  name: 'pi',
  instructionsFilename: 'AGENTS.md',
  defaultModel: 'sonnet',

  buildCommand(spec: RunSpec): BuildCommand {
    const model = normalizeModelForHarness(this.name, spec.model ?? this.defaultModel, { resolve: !spec.modelNoResolve }) ?? this.defaultModel
    const instructionsFile = writeInstructions(spec.workdir, this.instructionsFilename, spec.instructions)
    return {
      cmd: 'pi',
      args: ['--mode', 'json', '--no-session', '--model', model, spec.prompt],
      cwd: spec.workdir,
      env: {},
      instructionsFile,
    }
  },

  parseOutput(_spec: RunSpec, outcome: SubprocOutcome): ParsedOutput {
    const { tokensIn, tokensOut, costUsd, raw } = parsePiEvents(outcome.stdout)
    return { costUsd, tokensIn, tokensOut, raw }
  },
}

register('pi', piAdapter)
