import { register } from '../registry.js'
import type { Adapter, BuildCommand, ParsedOutput, RunSpec, SubprocOutcome } from '../base.js'
import { finalizeCommand, validateRunSpec } from '../base.js'
import { devNull } from 'node:os'
import { join } from 'node:path'

const TOKEN_RE = /Tokens:\s+([\d,.]+k?)\s+sent,\s+([\d,.]+k?)\s+received/i

function parseAiderNum(s: string): number | null {
  const cleaned = s.replace(/,/g, '').trim().toLowerCase()
  const scaled = cleaned.endsWith('k')
  const digits = scaled ? cleaned.slice(0, -1) : cleaned
  if (digits === '') return null
  const value = Number(digits) * (scaled ? 1000 : 1)
  if (!Number.isFinite(value)) return null
  if (!scaled) return Math.trunc(value)
  // Match Python round(): nearest whole token, ties to even, for abbreviated counts.
  const lower = Math.floor(value)
  return value - lower === 0.5 ? lower + lower % 2 : Math.round(value)
}

const aiderAdapter: Adapter = {
  name: 'aider',
  instructionsFilename: '.harness-aider-instructions.md',
  defaultModel: 'openrouter/anthropic/claude-sonnet-4.6',
  permissionBypassArgs: ['--yes-always'],
  configFileFlag: '--config',

  buildCommand(spec: RunSpec): BuildCommand {
    const validated = validateRunSpec(this, spec)
    const { model, permissionArgs, configArgs, workdir } = validated
    const args = [...configArgs]
    // Instructions are plain text the model reads, not aider's YAML config.
    if (spec.instructions !== undefined) {
      args.push('--read', join(workdir, this.instructionsFilename))
    }
    args.push(
      '--no-restore-chat-history',
      // Upstream defaults to writing histories into the workdir; the null device keeps runs from sharing them.
      '--chat-history-file', devNull,
      '--input-history-file', devNull,
      '--model', model,
      '--message', spec.prompt,
      ...permissionArgs,
      '--no-auto-commits',
      '--no-analytics',
      '--no-show-model-warnings',
    )
    return finalizeCommand(this, spec, validated, { cmd: 'aider', args })
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
