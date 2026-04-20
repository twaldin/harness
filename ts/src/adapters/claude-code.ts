import { register } from '../registry.js'
import { writeInstructions } from '../subproc.js'
import type { Adapter, BuildCommand, ParsedOutput, RunSpec, SubprocOutcome } from '../base.js'

const claudeCodeAdapter: Adapter = {
  name: 'claude-code',
  instructionsFilename: 'CLAUDE.md',
  defaultModel: 'sonnet',

  buildCommand(spec: RunSpec): BuildCommand {
    const model = spec.model ?? this.defaultModel
    const instructionsFile = writeInstructions(spec.workdir, this.instructionsFilename, spec.instructions)
    return {
      cmd: 'claude',
      args: ['-p', spec.prompt, '--model', model, '--output-format', 'json', '--dangerously-skip-permissions'],
      cwd: spec.workdir,
      env: {},
      instructionsFile,
    }
  },

  parseOutput(_spec: RunSpec, outcome: SubprocOutcome): ParsedOutput {
    let raw: unknown = null
    if (outcome.stdout.trim()) {
      try {
        raw = JSON.parse(outcome.stdout)
      } catch {
        raw = null
      }
    }
    if (raw !== null && typeof raw === 'object' && raw !== null) {
      const obj = raw as Record<string, unknown>
      const usage = (obj['usage'] as Record<string, unknown> | undefined) ?? {}
      return {
        costUsd: (obj['total_cost_usd'] as number | undefined) ?? null,
        tokensIn: (usage['input_tokens'] as number | undefined) ?? null,
        tokensOut: (usage['output_tokens'] as number | undefined) ?? null,
        raw,
      }
    }
    return { costUsd: null, tokensIn: null, tokensOut: null, raw }
  },
}

register('claude-code', claudeCodeAdapter)
