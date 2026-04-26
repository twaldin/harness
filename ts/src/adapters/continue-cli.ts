import { register } from '../registry.js'
import { writeInstructions } from '../subproc.js'
import type { Adapter, AgentStatus, BuildCommand, ParsedOutput, ReadyState, RunSpec, SubprocOutcome } from '../base.js'
import { normalizeModelForHarness } from '../model-normalization.js'
import { stripAnsi, lastNonEmptyJoin } from '../util.js'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'

/**
 * continue-cli adapter — invokes the `cn` CLI (Continue) in print mode.
 *
 * When OPENAI-style env vars are present, this adapter writes a minimal
 * Continue config YAML and runs `cn -p --config <file> --format json ...` so
 * bare model IDs like `gpt-5.4` work against an OpenAI-compatible endpoint.
 */
function writeContinueConfig(
  workdir: string,
  model: string,
  apiKey: string,
  apiBase: string | undefined,
  instructions: string | undefined,
): string {
  const continueDir = join(workdir, '.harness', 'continue')
  mkdirSync(continueDir, { recursive: true })
  const configPath = join(continueDir, 'config.yaml')
  const lines: string[] = [
    'name: Harness Continue',
    'version: 1.0.0',
    'schema: v1',
    'models:',
    '  - name: harness-model',
    `    model: ${model}`,
    '    provider: openai',
    `    apiKey: ${apiKey}`,
  ]
  if (apiBase) {
    lines.push(`    apiBase: ${apiBase}`)
  }
  lines.push('    roles:', '      - chat', '      - edit', '      - apply')
  if (instructions) {
    const escaped = instructions.replace(/\s+$/, '').replace(/\n/g, '\\n')
    lines.push('rules:', `  - '${escaped}'`)
  }
  writeFileSync(configPath, lines.join('\n') + '\n', 'utf-8')
  return configPath
}

const continueCliAdapter: Adapter = {
  name: 'continue-cli',
  instructionsFilename: 'CONTINUE.md',
  defaultModel: 'claude-sonnet-4-6',

  buildCommand(spec: RunSpec): BuildCommand {
    const model = normalizeModelForHarness(this.name, spec.model ?? this.defaultModel, { resolve: !spec.modelNoResolve }) ?? this.defaultModel
    const instructionsFile = writeInstructions(spec.workdir, this.instructionsFilename, spec.instructions)

    const openaiKey = (spec.env ?? {})['OPENAI_API_KEY']
    const openaiBase = (spec.env ?? {})['OPENAI_BASE_URL']
    if (openaiKey || openaiBase) {
      const configPath = writeContinueConfig(spec.workdir, model, openaiKey ?? 'dummy', openaiBase, spec.instructions)
      return {
        cmd: 'cn',
        args: ['-p', '--config', configPath, '--format', 'json', spec.prompt],
        cwd: spec.workdir,
        env: {},
        instructionsFile,
      }
    }

    return {
      cmd: 'cn',
      args: ['-p', spec.prompt, '--model', model, '--json'],
      cwd: spec.workdir,
      env: {},
      instructionsFile,
    }
  },

  parseOutput(_spec: RunSpec, outcome: SubprocOutcome): ParsedOutput {
    let raw: unknown = null
    if (outcome.stdout.trim()) {
      try {
        raw = JSON.parse(outcome.stdout)
      } catch {
        raw = null
      }
    }
    if (raw !== null && typeof raw === 'object') {
      const obj = raw as Record<string, unknown>
      const usage = (obj['usage'] as Record<string, unknown> | undefined) ?? {}
      return {
        costUsd: (obj['total_cost_usd'] as number | undefined) ?? null,
        tokensIn: (usage['input_tokens'] as number | undefined) ?? null,
        tokensOut: (usage['output_tokens'] as number | undefined) ?? null,
        raw,
      }
    }
    return { costUsd: null, tokensIn: null, tokensOut: null, raw }
  },
}

continueCliAdapter.submitKeys = ['Enter']
continueCliAdapter.detectReady = function (pane: string): ReadyState {
  const last20 = lastNonEmptyJoin(pane, 20)
  if (/Ask anything/i.test(last20)) return 'ready'
  if (/Update available/i.test(last20)) return 'dialog'
  return 'loading'
}
continueCliAdapter.handleDialog = function (pane: string): string[] | null {
  if (/Update available/i.test(stripAnsi(pane))) return ['Escape']
  return null
}
continueCliAdapter.detectStatus = function (pane: string): AgentStatus {
  const last10 = lastNonEmptyJoin(pane, 10)
  if (/rate.?limit/i.test(last10)) return 'rate-limited'
  if (/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(last10)) return 'running'
  if (/thinking|working/i.test(last10)) return 'running'
  if (/Ask anything/i.test(last10)) return 'idle'
  return 'unknown'
}
continueCliAdapter.installMeta = {
  packageManager: 'npm',
  installCommand: ['npm', 'install', '-g', '@continuedev/cli'],
  updateCommand: ['npm', 'install', '-g', '@continuedev/cli@latest'],
  versionCommand: ['cn', '--version'],
}

register('continue-cli', continueCliAdapter)
