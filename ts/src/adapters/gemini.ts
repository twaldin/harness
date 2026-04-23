import { register } from '../registry.js'
import { writeInstructions } from '../subproc.js'
import type { Adapter, BuildCommand, ParsedOutput, RunSpec, SubprocOutcome } from '../base.js'
import { normalizeModelForHarness } from '../model-normalization.js'

const geminiAdapter: Adapter = {
  name: 'gemini',
  instructionsFilename: 'GEMINI.md',
  defaultModel: 'gemini-2.5-pro',

  buildCommand(spec: RunSpec): BuildCommand {
    const model = normalizeModelForHarness(this.name, spec.model ?? this.defaultModel) ?? this.defaultModel
    const instructionsFile = writeInstructions(spec.workdir, this.instructionsFilename, spec.instructions)
    return {
      cmd: 'gemini',
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
      // A stats block was present and we iterated model entries — report the sum
      // even if 0 (truthful "upstream reported 0", not "we couldn't parse").
      return { costUsd: null, tokensIn, tokensOut, raw: parsed }
    }

    return { costUsd: null, tokensIn: null, tokensOut: null, raw: null }
  },
}

register('gemini', geminiAdapter)
