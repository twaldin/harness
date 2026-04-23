import { register } from '../registry.js'
import { writeInstructions } from '../subproc.js'
import type { Adapter, BuildCommand, ParsedOutput, RunSpec, SubprocOutcome } from '../base.js'
import { normalizeModelForHarness } from '../model-normalization.js'

const codexAdapter: Adapter = {
  name: 'codex',
  instructionsFilename: 'AGENTS.md',
  defaultModel: 'gpt-5.3-codex',

  buildCommand(spec: RunSpec): BuildCommand {
    const model = normalizeModelForHarness(this.name, spec.model ?? this.defaultModel) ?? this.defaultModel
    const instructionsFile = writeInstructions(spec.workdir, this.instructionsFilename, spec.instructions)
    return {
      cmd: 'codex',
      args: ['exec', '-m', model, '--dangerously-bypass-approvals-and-sandbox', '--json', '-C', spec.workdir, spec.prompt],
      cwd: spec.workdir,
      env: {},
      instructionsFile,
    }
  },

  parseOutput(_spec: RunSpec, outcome: SubprocOutcome): ParsedOutput {
    let tokensIn = 0
    let tokensOut = 0
    let sawTurn = false
    for (const line of outcome.stdout.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('{')) continue
      let event: unknown
      try {
        event = JSON.parse(trimmed)
      } catch {
        continue
      }
      if (event !== null && typeof event === 'object') {
        const obj = event as Record<string, unknown>
        if (obj['type'] === 'turn.completed') {
          sawTurn = true
          const usage = (obj['usage'] as Record<string, unknown> | undefined) ?? {}
          tokensIn += Number(usage['input_tokens'] ?? 0)
          tokensOut += Number(usage['output_tokens'] ?? 0)
        }
      }
    }
    return {
      costUsd: null,
      tokensIn: sawTurn ? tokensIn : null,
      tokensOut: sawTurn ? tokensOut : null,
      raw: null,
    }
  },
}

register('codex', codexAdapter)
