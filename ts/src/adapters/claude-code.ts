import { register } from '../registry.js'
import { writeInstructions } from '../subproc.js'
import type { Adapter, BuildCommand, ParsedOutput, RunSpec, SubprocOutcome } from '../base.js'
import { normalizeModelForHarness } from '../model-normalization.js'

function stripMarkdownFences(s: string): string {
  const m = /^```(?:[a-z]+)?\n([\s\S]*?)\n```\s*$/.exec(s)
  return m ? m[1]! : s
}

const claudeCodeAdapter: Adapter = {
  name: 'claude-code',
  instructionsFilename: 'CLAUDE.md',
  defaultModel: 'sonnet',

  buildCommand(spec: RunSpec): BuildCommand {
    const model = normalizeModelForHarness(this.name, spec.model ?? this.defaultModel) ?? this.defaultModel
    const instructionsFile = writeInstructions(spec.workdir, this.instructionsFilename, spec.instructions)
    const args = ['-p', spec.prompt, '--model', model, '--output-format', 'json', '--dangerously-skip-permissions']
    // -p mode does not auto-walk workdir for CLAUDE.md; inject explicitly so
    // the instructions are always visible to the model.
    if (spec.instructions) {
      args.push('--append-system-prompt', spec.instructions)
    }
    return {
      cmd: 'claude',
      args,
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
      // Strip markdown fences that claude-code occasionally wraps output in.
      if (typeof obj['result'] === 'string') {
        obj['result'] = stripMarkdownFences(obj['result'] as string)
      }
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
