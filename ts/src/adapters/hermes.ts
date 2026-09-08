import { register } from '../registry.js'
import { HarnessError, finalizeCommand, validateRunSpec } from '../base.js'
import type { Adapter, BuildCommand, ParsedOutput, RunSpec, SubprocOutcome } from '../base.js'

/** Hermes Agent's local quiet chat CLI, not the messaging gateway. */
const hermesAdapter: Adapter = {
  name: 'hermes',
  instructionsFilename: 'AGENTS.md',
  defaultModel: '', // Leave model/provider selection to the caller's Hermes config.
  permissionBypassArgs: ['--yolo'],
  configHomeEnv: 'HERMES_HOME',

  buildCommand(spec: RunSpec): BuildCommand {
    const resolved = validateRunSpec(this, spec)
    if (!spec.prompt) {
      throw new HarnessError('hermes requires a non-empty prompt for headless chat', 'invalid-options')
    }
    // Top-level --oneshot implicitly bypasses approvals. Quiet chat does not.
    const args = ['chat', '--cli', '--quiet']
    if (spec.model || resolved.model) args.push('--model', resolved.model)
    args.push(...resolved.permissionArgs, `--query=${spec.prompt}`)
    return finalizeCommand(this, spec, resolved, { cmd: 'hermes', args, model: spec.model || null })
  },

  parseOutput(_spec: RunSpec, outcome: SubprocOutcome): ParsedOutput {
    let sessionId: string | null = null
    // Require a complete footer line; a capture-truncated session ID is not usable.
    for (const match of outcome.stderr.matchAll(/^session_id: ([A-Za-z0-9_-]+)\r?\n/gm)) {
      sessionId = match[1]!
    }
    // Quiet chat emits text, not JSON/usage events. Stdout remains on RunResult.
    return { costUsd: null, tokensIn: null, tokensOut: null, raw: sessionId === null ? null : { session_id: sessionId } }
  },
}

register('hermes', hermesAdapter)
