import { register } from '../registry.js'
import { writeInstructions } from '../subproc.js'
import type { Adapter, BuildCommand, ParsedOutput, RunSpec, SubprocOutcome } from '../base.js'
import { normalizeModelForHarness } from '../model-normalization.js'

const qwenAdapter: Adapter = {
  name: 'qwen',
  instructionsFilename: 'QWEN.md',
  defaultModel: 'qwen3-coder',

  buildCommand(spec: RunSpec): BuildCommand {
    const model = normalizeModelForHarness(this.name, spec.model ?? this.defaultModel) ?? this.defaultModel
    const instructionsFile = writeInstructions(spec.workdir, this.instructionsFilename, spec.instructions)
    return {
      cmd: 'qwen',
      args: ['-p', spec.prompt, '-y', '-m', model, '--output-format', 'json'],
      cwd: spec.workdir,
      env: {},
      instructionsFile,
    }
  },

  parseOutput(_spec: RunSpec, outcome: SubprocOutcome): ParsedOutput {
    const candidates: string[] = [outcome.stdout.trim()]
    for (const ln of outcome.stdout.split('\n')) {
      if (ln.trim().startsWith('[')) candidates.push(ln.trim())
    }

    for (const blob of candidates) {
      if (!blob) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(blob)
      } catch {
        continue
      }
      if (!Array.isArray(parsed)) continue
      for (let i = parsed.length - 1; i >= 0; i--) {
        const item = parsed[i]
        if (!item || typeof item !== 'object') continue
        const obj = item as Record<string, unknown>
        if (obj['type'] !== 'result') continue
        const usage = obj['usage'] as Record<string, unknown> | undefined
        const tokensIn = Number(usage?.['input_tokens'] ?? 0)
        const tokensOut = Number(usage?.['output_tokens'] ?? 0)
        return { costUsd: null, tokensIn, tokensOut, raw: parsed }
      }
    }

    return { costUsd: null, tokensIn: null, tokensOut: null, raw: null }
  },
}

register('qwen', qwenAdapter)
