export interface RunSpec {
  harness: string
  prompt: string
  workdir: string
  model?: string
  instructions?: string
  timeoutSeconds?: number
  env?: Record<string, string>
  /**
   * Pass `model` through exactly as provided, without harness-specific
   * normalization. Escape hatch for odd provider/model combinations.
   */
  modelNoResolve?: boolean
}

export interface BuildCommand {
  cmd: string
  args: string[]
  cwd: string
  env: Record<string, string>
  instructionsFile: string | null
}

export interface SubprocOutcome {
  exitCode: number
  durationSeconds: number
  stdout: string
  stderr: string
  timedOut: boolean
}

export interface RunResult {
  harness: string
  model: string | null
  exitCode: number
  durationSeconds: number
  stdout: string
  stderr: string
  timedOut: boolean
  costUsd: number | null
  tokensIn: number | null
  tokensOut: number | null
  raw: unknown | null
}

export interface ParsedOutput {
  costUsd: number | null
  tokensIn: number | null
  tokensOut: number | null
  raw: unknown | null
}

export interface Adapter {
  name: string
  instructionsFilename: string
  defaultModel: string
  buildCommand(spec: RunSpec): BuildCommand
  parseOutput(spec: RunSpec, outcome: SubprocOutcome): ParsedOutput
}

export class HarnessError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HarnessError'
  }
}
