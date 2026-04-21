import { register } from '../registry.js'
import { writeInstructions } from '../subproc.js'
import type { Adapter, BuildCommand, ParsedOutput, RunSpec, SubprocOutcome } from '../base.js'

const qwenAdapter: Adapter = {
  name: 'qwen',
  instructionsFilename: 'QWEN.md',
  defaultModel: 'qwen3-coder',

  buildCommand(spec: RunSpec): BuildCommand {
    const model = spec.model ?? this.defaultModel
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
      if (ln.trim().startsWith('{')) candidates.push(ln.trim())
    }

    for (const blob of candidates) {
      if (!blob) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(blob)
      } catch {
        continue
      }
      if (parsed === null || typeof parsed !== 'object') continue
      const obj = parsed as Record<string, unknown>
      const stats = obj['stats'] as Record<string, unknown> | undefined
      const models = stats?.['models']
      if (!models || typeof models !== 'object') continue
      let tokensIn = 0
      let tokensOut = 0
      for (const stats of Object.values(models as Record<string, unknown>)) {
        if (!stats || typeof stats !== 'object') continue
        const t = (stats as Record<string, unknown>)['tokens'] as Record<string, unknown> | undefined
        tokensIn += Number(t?.['input'] ?? 0)
        tokensOut += Number(t?.['candidates'] ?? 0)
      }
      return { costUsd: null, tokensIn, tokensOut, raw: parsed }
    }

    return { costUsd: null, tokensIn: null, tokensOut: null, raw: null }
  },
}

register('qwen', qwenAdapter)
