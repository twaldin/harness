import { register } from '../registry.js'
import { HarnessError, finalizeCommand, validateRunSpec } from '../base.js'
import type { Adapter, BuildCommand, ParsedOutput, RunSpec, SubprocOutcome } from '../base.js'

// Kiro CLI 2.21.1 `chat --no-interactive --agent-engine v2 --output-format stream-json`
// writes native ACP events as JSON Lines. No aggregate accounting schema is
// qualified, so metrics stay null and objects are preserved for the caller.

function parseKiroEvents(stdout: string): ParsedOutput {
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

const kiroAdapter: Adapter = {
  name: 'kiro',
  instructionsFilename: 'AGENTS.md',
  defaultModel: '', // Leave model selection to the caller's Kiro config.
  permissionBypassArgs: ['--trust-all-tools'],
  nativeOptionsKind: 'kiro',

  buildCommand(spec: RunSpec): BuildCommand {
    const validated = validateRunSpec(this, spec)
    if (!spec.prompt) {
      // A missing prompt makes kiro-cli open its interactive chat.
      throw new HarnessError('kiro requires a non-empty prompt for non-interactive mode', 'invalid-options')
    }
    const { model, permissionArgs, nativeArgs } = validated
    const args = ['chat', '--no-interactive', '--agent-engine', 'v2', '--output-format', 'stream-json']
    // Equals form keeps model IDs starting with '-' from being parsed as flags.
    if (model) args.push(`--model=${model}`)
    // `--` keeps leading '-' prompts from being parsed as flags.
    args.push(...permissionArgs, ...nativeArgs, '--', spec.prompt)
    return finalizeCommand(this, spec, validated, { cmd: 'kiro-cli', args, model: spec.model || null })
  },

  parseOutput(_spec: RunSpec, outcome: SubprocOutcome): ParsedOutput {
    return parseKiroEvents(outcome.stdout)
  },
}

kiroAdapter.installMeta = {
  packageManager: 'binary',
  installCommand: ['bash', '-c', 'curl -fsSL https://cli.kiro.dev/install | bash'],
  updateCommand: ['kiro-cli', 'update'],
  versionCommand: ['kiro-cli', '--version'],
}

register('kiro', kiroAdapter)
