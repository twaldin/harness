import { register } from '../registry.js'
import { HarnessError, finalizeCommand, validateRunSpec } from '../base.js'
import type { Adapter, BuildCommand, ParsedOutput, RunSpec, SubprocOutcome } from '../base.js'

/** Env var vibe reads its active model from; there is no `--model` flag (verified against mistral-vibe 2.25.0). */
const MODEL_ENV = 'VIBE_ACTIVE_MODEL'

// Mistral Vibe `--output streaming --prompt=<text>` writes one JSON object per
// stdout line: the conversation history as it grows (assistant messages, tool
// calls and results). No event carries aggregate token or cost totals, so every
// metric stays null and the objects are preserved verbatim for the caller.

function parseVibeEvents(stdout: string): ParsedOutput {
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

const vibeAdapter: Adapter = {
  name: 'mistral-vibe',
  instructionsFilename: 'AGENTS.md',
  defaultModel: '', // Leave model selection to the caller's vibe config.
  permissionBypassArgs: ['--auto-approve'],
  nativeOptionsKind: 'mistral-vibe',
  configHomeEnv: 'VIBE_HOME',

  buildCommand(spec: RunSpec): BuildCommand {
    const validated = validateRunSpec(this, spec)
    if (!spec.prompt) {
      // A missing prompt makes vibe open its interactive TUI.
      throw new HarnessError('mistral-vibe requires a non-empty prompt for non-interactive mode', 'invalid-options')
    }
    // Vibe reads a workspace AGENTS.md only once the workspace is trusted, and
    // the harness never trusts on the caller's behalf: an untrusted projection
    // would be silently ignored, so require the explicit native knob.
    const trusted = validated.nativeOptions?.kind === 'mistral-vibe' && validated.nativeOptions.trust === true
    if (spec.instructions && !trusted) {
      throw new HarnessError(
        'mistral-vibe only reads a projected AGENTS.md from a trusted workspace; set nativeOptions.trust=true (kind "mistral-vibe") or omit instructions',
        'unsupported-capability',
      )
    }
    const { model, permissionArgs, nativeArgs } = validated
    const env: Record<string, string> = {}
    if (model) {
      const explicit = spec.env?.[MODEL_ENV]
      if (explicit !== undefined && explicit !== model) {
        throw new HarnessError(`model conflicts with env.${MODEL_ENV}=${JSON.stringify(explicit)}; set one`, 'invalid-options')
      }
      env[MODEL_ENV] = model
    }
    // Equals form keeps leading '-' prompts from being parsed as flags.
    const args = ['--output', 'streaming', ...permissionArgs, ...nativeArgs, `--prompt=${spec.prompt}`]
    return finalizeCommand(this, spec, validated, { cmd: 'vibe', args, env, model: spec.model || null })
  },

  parseOutput(_spec: RunSpec, outcome: SubprocOutcome): ParsedOutput {
    return parseVibeEvents(outcome.stdout)
  },
}

vibeAdapter.installMeta = {
  packageManager: 'pip', // PyPI distribution `mistral-vibe`, installed through uv's tool manager.
  installCommand: ['uv', 'tool', 'install', 'mistral-vibe'],
  updateCommand: ['uv', 'tool', 'upgrade', 'mistral-vibe'],
  versionCommand: ['vibe', '--version'],
}

register('mistral-vibe', vibeAdapter)
