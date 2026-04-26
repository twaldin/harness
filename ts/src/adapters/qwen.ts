import { register } from '../registry.js'
import { writeInstructions } from '../subproc.js'
import type { Adapter, AgentStatus, BuildCommand, ParsedOutput, ReadyState, RunSpec, SubprocOutcome } from '../base.js'
import { normalizeModelForHarness } from '../model-normalization.js'
import { stripAnsi, lastNonEmptyJoin } from '../util.js'

const qwenAdapter: Adapter = {
  name: 'qwen',
  instructionsFilename: 'QWEN.md',
  defaultModel: 'qwen3-coder',

  buildCommand(spec: RunSpec): BuildCommand {
    const model = normalizeModelForHarness(this.name, spec.model ?? this.defaultModel, { resolve: !spec.modelNoResolve }) ?? this.defaultModel
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

qwenAdapter.submitKeys = ['Enter']
qwenAdapter.detectReady = function (pane: string): ReadyState {
  const last30 = lastNonEmptyJoin(pane, 30)
  // Auth dialog (OAuth discontinued / API key prompt)
  if (/Qwen OAuth|API Key/i.test(last30) && /Discontinued|switch/i.test(last30)) return 'dialog'
  if (/Type your message|>\s*$|❯\s*$/m.test(last30)) return 'ready'
  return 'loading'
}
qwenAdapter.handleDialog = function (pane: string): string[] | null {
  // Auth dialog needs user — return null so flt surfaces it.
  return null
}
qwenAdapter.detectStatus = function (pane: string): AgentStatus {
  const last10 = lastNonEmptyJoin(pane, 10)
  if (/rate.?limit|quota/i.test(last10)) return 'rate-limited'
  if (/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(last10) || /thinking|working/i.test(last10)) return 'running'
  if (/Type your message|>\s*$|❯\s*$/m.test(last10)) return 'idle'
  return 'unknown'
}
qwenAdapter.installMeta = {
  packageManager: 'npm',
  installCommand: ['npm', 'install', '-g', '@qwen-code/qwen-code'],
  updateCommand: ['npm', 'install', '-g', '@qwen-code/qwen-code@latest'],
  versionCommand: ['qwen', '--version'],
}

register('qwen', qwenAdapter)
