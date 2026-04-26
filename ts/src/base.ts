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

// Session-aware additions for live tmux/PTY consumers (e.g. flt).
// These are pure functions on already-captured pane content — harness-ts
// stays headless, the consumer drives pane capture and timing.

export type ReadyState = 'loading' | 'dialog' | 'ready'
export type AgentStatus = 'running' | 'idle' | 'error' | 'rate-limited' | 'unknown' | 'exited' | 'dialog'

export interface SessionTelemetry {
  /** Path to the conversation log file flt/etc. can tail or replay. */
  sessionLogPath: string | null
  tokensIn: number | null
  tokensOut: number | null
  costUsd: number | null
  model: string | null
  raw: unknown | null
}

export interface InstallMeta {
  /** What package manager owns this CLI's install. */
  packageManager: 'npm' | 'pip' | 'brew' | 'cargo' | 'binary' | 'unknown'
  /** argv to install fresh. Empty array = not installable via this metadata. */
  installCommand: string[]
  /** argv to update to latest. */
  updateCommand: string[]
  /** argv to print version (parsed by consumer to compare against npm view latest etc.) */
  versionCommand: string[]
  /** Platforms supported. Defaults to ['darwin', 'linux']. */
  platforms?: ('darwin' | 'linux' | 'win32')[]
}

export interface Adapter {
  name: string
  instructionsFilename: string
  defaultModel: string
  buildCommand(spec: RunSpec): BuildCommand
  parseOutput(spec: RunSpec, outcome: SubprocOutcome): ParsedOutput

  // ---- session-aware (optional; fall back to flt's local impl when missing) ----

  /** Keystrokes to submit a message in this CLI's TUI. e.g. ['Enter'] or ['Escape','Enter']. */
  submitKeys?: string[]

  /** When `flatten=true`, paste-buffer writes will collapse \n → ' ' before send. */
  flattenOnPaste?: boolean

  /** Pure pane → ready/loading/dialog. flt drives the polling loop. */
  detectReady?(pane: string): ReadyState

  /** Pure pane → live agent status. Returns 'dialog' to opt into auto-handle. */
  detectStatus?(pane: string): AgentStatus

  /** When detectReady/detectStatus = 'dialog', return keystrokes to dismiss; null otherwise. */
  handleDialog?(pane: string): string[] | null

  /** Where this CLI persists session data on disk (rich event log). Pure path resolver. */
  sessionLogPath?(workdir: string, sessionStartedAfter?: number): string | null

  /** Parse a sessionLogPath result into telemetry. */
  parseSessionLog?(path: string): SessionTelemetry

  /** Install/update metadata. */
  installMeta?: InstallMeta
}

export class HarnessError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HarnessError'
  }
}
