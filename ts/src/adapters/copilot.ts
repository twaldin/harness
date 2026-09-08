import { register } from '../registry.js'
import { HarnessError, finalizeCommand, validateRunSpec } from '../base.js'
import type { Adapter, BuildCommand, ParsedOutput, RunSpec, SubprocOutcome } from '../base.js'

// GitHub Copilot CLI `--output-format json --prompt=<text>` writes one JSON
// object per stdout line (verified against @github/copilot 1.0.83). The final
// `result` event carries sessionId, exitCode and usage as premium requests,
// durations and code changes; an intermediate session usage checkpoint carries
// cache state. Neither reports dollars or aggregate token totals, so every
// metric stays null and the events are preserved verbatim for the caller.

function parseCopilotEvents(stdout: string): ParsedOutput {
  const events: object[] = []
  // A complete final line needs no trailing newline; a truncated one fails to
  // parse and is dropped like any other malformed line.
  for (const line of stdout.split('\n')) {
    const s = line.trim()
    if (!s) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(s)
    } catch {
      continue
    }
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) events.push(parsed)
  }
  return { costUsd: null, tokensIn: null, tokensOut: null, raw: events.length === 0 ? null : events }
}

const copilotAdapter: Adapter = {
  name: 'copilot',
  instructionsFilename: 'AGENTS.md',
  defaultModel: '', // Leave model selection to the caller's Copilot config.
  permissionBypassArgs: ['--allow-all'],
  nativeOptionsKind: 'copilot',
  configHomeEnv: 'COPILOT_HOME',

  buildCommand(spec: RunSpec): BuildCommand {
    const validated = validateRunSpec(this, spec)
    if (!spec.prompt) {
      throw new HarnessError('copilot requires a non-empty prompt for non-interactive mode', 'invalid-options')
    }
    const { model, permissionArgs, nativeArgs } = validated
    const args = ['--no-auto-update', '--no-remote-export', '--no-ask-user', '--output-format', 'json']
    if (model) args.push('--model', model)
    // Equals form keeps leading '-' prompts from being parsed as flags.
    args.push(...permissionArgs, ...nativeArgs, `--prompt=${spec.prompt}`)
    return finalizeCommand(this, spec, validated, { cmd: 'copilot', args, model: spec.model || null })
  },

  parseOutput(_spec: RunSpec, outcome: SubprocOutcome): ParsedOutput {
    return parseCopilotEvents(outcome.stdout)
  },
}

copilotAdapter.installMeta = {
  packageManager: 'npm',
  installCommand: ['npm', 'install', '-g', '@github/copilot'],
  updateCommand: ['npm', 'install', '-g', '@github/copilot@latest'],
  versionCommand: ['copilot', '--version'],
}

register('copilot', copilotAdapter)
