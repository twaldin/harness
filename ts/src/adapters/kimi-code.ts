import { register } from '../registry.js'
import { HarnessError, finalizeCommand, validateRunSpec } from '../base.js'
import type { Adapter, BuildCommand, ParsedOutput, RunSpec, SubprocOutcome } from '../base.js'
import { parseJsonObjectLines } from '../util.js'

// Kimi Code CLI 0.41.0 (`@moonshot-ai/kimi-code`, release commit 95478e8c)
// runs headless once `--prompt` is given and, with `--output-format
// stream-json`, writes one JSON object per stdout line: assistant messages
// (content/tool_calls), tool results (tool_call_id/content) and meta records.
// Print mode is inherently auto-approving, so there is no bypass mapping and
// the common validator rejects `permissionPolicy: 'bypass'`. No accounting
// schema is qualified, so metrics stay null and objects are preserved verbatim.

const kimiCodeAdapter: Adapter = {
  name: 'kimi-code',
  instructionsFilename: 'AGENTS.md',
  defaultModel: '', // Leave model selection to the caller's Kimi config.
  configHomeEnv: 'KIMI_CODE_HOME',

  buildCommand(spec: RunSpec): BuildCommand {
    const validated = validateRunSpec(this, spec)
    // Upstream rejects a blank prompt (`prompt.trim().length === 0`); without
    // `--prompt` the CLI opens its interactive session instead.
    if (!spec.prompt?.trim()) {
      throw new HarnessError('kimi-code requires a non-blank prompt for print mode', 'invalid-options')
    }
    const { model } = validated
    const args = ['--output-format', 'stream-json']
    // Equals form keeps values starting with '-' from being parsed as flags.
    if (model) args.push(`--model=${model}`)
    args.push(`--prompt=${spec.prompt}`)
    return finalizeCommand(this, spec, validated, { cmd: 'kimi', args, model: spec.model || null })
  },

  parseOutput(_spec: RunSpec, outcome: SubprocOutcome): ParsedOutput {
    const events = parseJsonObjectLines(outcome.stdout)
    return { costUsd: null, tokensIn: null, tokensOut: null, raw: events.length === 0 ? null : events }
  },
}

kimiCodeAdapter.installMeta = {
  packageManager: 'npm',
  installCommand: ['npm', 'install', '-g', '@moonshot-ai/kimi-code'],
  updateCommand: ['npm', 'install', '-g', '@moonshot-ai/kimi-code@latest'],
  versionCommand: ['kimi', '--version'],
}

register('kimi-code', kimiCodeAdapter)
