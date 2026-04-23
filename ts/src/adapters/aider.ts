import { register } from '../registry.js'
import { writeInstructions } from '../subproc.js'
import type { Adapter, BuildCommand, ParsedOutput, RunSpec, SubprocOutcome } from '../base.js'
import { writeFileSync } from 'fs'
import { normalizeModelForHarness } from '../model-normalization.js'

const TOKEN_RE = /Tokens:\s+([\d,.]+k?)\s+sent,\s+([\d,.]+k?)\s+received/i

function parseAiderNum(s: string): number | null {
  const cleaned = s.replace(/,/g, '').trim()
  if (!cleaned) return null
  try {
    if (cleaned.endsWith('k')) return Math.round(parseFloat(cleaned.slice(0, -1)) * 1000)
    return Math.round(parseFloat(cleaned))
  } catch {
    return null
  }
}

const aiderAdapter: Adapter = {
  name: 'aider',
  instructionsFilename: '.aider.conf.yml',
  defaultModel: 'openrouter/anthropic/claude-sonnet-4.6',

  buildCommand(spec: RunSpec): BuildCommand {
    const model = normalizeModelForHarness(this.name, spec.model ?? this.defaultModel) ?? this.defaultModel
    const instructionsFile = writeInstructions(spec.workdir, this.instructionsFilename, spec.instructions)

    const configPath = `${spec.workdir}/.agentelo-aider.yml`
    writeFileSync(configPath, '{}\n', 'utf-8')

    return {
      cmd: 'aider',
      args: [
        '--config', configPath,
        '--no-restore-chat-history',
        '--chat-history-file', `${spec.workdir}/.agentelo-aider-chat.history.md`,
        '--input-history-file', `${spec.workdir}/.agentelo-aider-input.history`,
        '--model', model,
        '--message', spec.prompt,
        '--yes-always',
        '--no-auto-commits',
        '--no-analytics',
        '--no-show-model-warnings',
      ],
      cwd: spec.workdir,
      env: {},
      instructionsFile,
    }
  },

  parseOutput(_spec: RunSpec, outcome: SubprocOutcome): ParsedOutput {
    const combined = outcome.stdout + '\n' + outcome.stderr
    const match = TOKEN_RE.exec(combined)
    if (!match) return { costUsd: null, tokensIn: null, tokensOut: null, raw: null }
    return {
      costUsd: null,
      tokensIn: parseAiderNum(match[1]!),
      tokensOut: parseAiderNum(match[2]!),
      raw: null,
    }
  },
}

register('aider', aiderAdapter)
