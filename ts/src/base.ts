import { isAbsolute, join, resolve, sep } from 'node:path'
import { normalizeModelForHarness } from './model-normalization.js'

/** Execution backend. Only `cli` is implemented; `rpc`/`sdk` are reserved and always rejected. */
export type Backend = 'cli' | 'rpc' | 'sdk'

/**
 * `upstream` (default): inject no permission-bypass or auto-approve flags; the
 * CLI's own defaults and user config decide. `bypass`: restore the adapter's
 * documented bypass flag; adapters without one reject the request.
 */
export type PermissionPolicy = 'upstream' | 'bypass'

export type ClaudeCodeEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type CodexSandbox = 'read-only' | 'workspace-write' | 'danger-full-access'

export interface ClaudeCodeOptions {
  kind: 'claude-code'
  /** Emitted as `--effort <value>`. */
  effort?: ClaudeCodeEffort
}

export interface CodexOptions {
  kind: 'codex'
  /** Emitted as `--sandbox <value>`. Conflicts with `permissionPolicy: 'bypass'`. */
  sandbox?: CodexSandbox
}

export interface CopilotOptions {
  kind: 'copilot'
  /**
   * Each entry is one upstream tool rule passed verbatim as `--allow-tool=<rule>`
   * (Copilot's own comma grammar applies inside a rule). Emitted before deny rules.
   */
  allowTools?: readonly string[]
  /** Each entry is one upstream tool rule passed verbatim as `--deny-tool=<rule>`. Coexists with bypass; upstream decides precedence. */
  denyTools?: readonly string[]
}

/** Typed per-harness CLI options. `kind` must match `RunSpec.harness`. */
export type NativeOptions = ClaudeCodeOptions | CodexOptions | CopilotOptions

export type OutputStream = 'stdout' | 'stderr'

/**
 * Receives decoded output as it arrives. Chunk boundaries are arbitrary (not
 * line or JSONL framed); each chunk is complete UTF-8 text, never a split
 * code point. Calls are serialized: a returned promise pauses reading until
 * it settles (the process blocks on a full pipe meanwhile, wall timeout still
 * applies). A throw or rejection ends the run with `termination:
 * 'callback-error'`. A synchronous callback cannot be preempted; it must
 * return promptly.
 */
export type OutputCallback = (chunk: string, stream: OutputStream) => void | Promise<void>

export interface RunSpec {
  harness: string
  prompt: string
  /** Working directory. Relative paths resolve against the current process cwd at build time. */
  workdir: string
  model?: string
  /** Instruction text projected into the adapter's instructions file for the run. Empty string projects an empty file. */
  instructions?: string
  /** Wall-clock limit; defaults to 1800. `0` times out immediately, `null` disables it. */
  timeoutSeconds?: number | null
  /** Ends the run with `timeoutKind: 'inactivity'` after this many seconds without stdout/stderr bytes. Off by default. Time spent awaiting `onOutput` does not count. */
  inactivityTimeoutSeconds?: number | null
  /** Per-stream capture cap in raw bytes (default 1 MiB). Output beyond it is drained and counted, not kept; the result flags `stdoutTruncated`/`stderrTruncated`. `0` captures nothing. */
  maxOutputBytes?: number
  /** Written to the child's stdin as UTF-8, then EOF. Omitted or empty: stdin is EOF from the start. */
  stdin?: string | null
  onOutput?: OutputCallback
  /** Caller env additions layered over the adapter's own; never mutated. */
  env?: Record<string, string>
  /**
   * Pass `model` through exactly as provided, without harness-specific
   * normalization. Escape hatch for odd provider/model combinations.
   */
  modelNoResolve?: boolean
  /** Defaults to `cli`. */
  backend?: Backend
  /** Defaults to `upstream`. */
  permissionPolicy?: PermissionPolicy
  nativeOptions?: NativeOptions
  /** Replaces the adapter's default binary: a bare name resolved on PATH or an absolute path. */
  executable?: string
  /** Absolute directory exported through the adapter's `configHomeEnv`; rejected when the adapter has none. */
  configHome?: string
  /** Absolute file passed through the adapter's `configFileFlag`; rejected when the adapter has none. Never opened or checked. */
  configFile?: string
  /** Abort to tear down the run's process group; the result reports `termination: 'cancelled'`. */
  cancel?: AbortSignal
}

export interface BuildCommand {
  cmd: string
  args: string[]
  /** Absolute working directory. */
  cwd: string
  /** Adapter additions, then `spec.env`, then the mapped config-home variable. Layered over the inherited process env at execution. */
  env: Record<string, string>
  /** Planned absolute instructions path, or null when the adapter has none for this run. Nothing is written at build time. */
  instructionsFile: string | null
  /** Text to project into `instructionsFile` during `prepareCommand`; undefined means no projection. */
  instructionContent?: string
  /** Directories `prepareCommand` creates before launch (adapter artifact parents under the workdir). Empty when absent; never removed by cleanup. */
  directories?: readonly string[]
  /** Model reported on `RunResult`: the requested model or the adapter default, or null when a caller config file selects it. Absent means requested/default. */
  model?: string | null
}

/**
 * Why a run reached its terminal state.
 * - exited: leader returned an exit code (`exitCode` is that code)
 * - signaled: leader was killed by a signal outside harness teardown
 *   (`signal` names it; `exitCode` is the negated signal number, e.g. -15)
 * - timed-out: `timeoutSeconds` or `inactivityTimeoutSeconds` elapsed (`timeoutKind` says which); `exitCode: -1`, `timedOut: true`
 * - cancelled: the `cancel` signal aborted; `exitCode: -1`
 * - callback-error: `onOutput` threw or rejected while the leader was alive; `callbackError` holds the message, `exitCode: -1`
 * - launch-failed: the leader never started; `launchError` is the OS code (`ENOENT`, `EACCES`, ...)
 */
export type Termination = 'exited' | 'signaled' | 'timed-out' | 'cancelled' | 'callback-error' | 'launch-failed'

export type TimeoutKind = 'wall' | 'inactivity'

export interface SubprocOutcome {
  exitCode: number
  durationSeconds: number
  stdout: string
  stderr: string
  timedOut: boolean
  /** Always set by harness execution; optional only for caller-constructed outcomes. */
  termination?: Termination | null
  /** Signal that ended the leader (also on timed-out/cancelled teardown), else null. */
  signal?: string | null
  /** OS error code when `termination === 'launch-failed'`, else null. */
  launchError?: string | null
  /** Raw bytes read from each stream, including bytes beyond `maxOutputBytes`. */
  stdoutBytes?: number
  stderrBytes?: number
  /** Captured text is a prefix of the stream: the cap was exceeded or teardown force-closed the pipe with output unread. */
  stdoutTruncated?: boolean
  stderrTruncated?: boolean
  /**
   * `onOutput` failure (`<ErrorName>: <message>`), also when it happened after
   * the leader had already exited (termination then keeps the exit reason),
   * or a notice that a pending callback was abandoned at the drain deadline.
   * Null when every callback settled cleanly.
   */
  callbackError?: string | null
  /** Which deadline expired when `termination === 'timed-out'`, else null. */
  timeoutKind?: TimeoutKind | null
}

export interface RunResult {
  harness: string
  model: string | null
  exitCode: number
  durationSeconds: number
  stdout: string
  stderr: string
  timedOut: boolean
  termination?: Termination | null
  signal?: string | null
  launchError?: string | null
  stdoutBytes?: number
  stderrBytes?: number
  stdoutTruncated?: boolean
  stderrTruncated?: boolean
  callbackError?: string | null
  timeoutKind?: TimeoutKind | null
  /** `parseOutput` failure (`<ErrorName>: <message>`); metrics and `raw` are null then. Null when parsing succeeded. */
  parseError?: string | null
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

/**
 * tmux send-keys notation for the four scroll directions an app's
 * virtualized scrollback responds to. Used by terminal-multiplexer
 * consumers (e.g. flt) to decide what chord to forward when the user
 * scrolls a pane belonging to this CLI.
 */
export interface ScrollKeys {
  lineDown: string
  lineUp: string
  pageDown: string
  pageUp: string
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

  // ---- shared-contract capability declarations (optional) ----

  /**
   * argv the adapter injects when `spec.permissionPolicy === 'bypass'`.
   * Absent means the CLI has no documented bypass mapping and an explicit
   * `bypass` request is rejected with `unsupported-capability`.
   */
  permissionBypassArgs?: readonly string[]

  /** Which `NativeOptions.kind` this adapter accepts. Absent means none. */
  nativeOptionsKind?: NativeOptions['kind']

  /**
   * Environment variable the CLI reads its config/state home from. Absent
   * means `spec.configHome` is rejected with `unsupported-capability`.
   */
  configHomeEnv?: string

  /**
   * Flag the CLI takes a config file path through. Absent means
   * `spec.configFile` is rejected with `unsupported-capability`.
   */
  configFileFlag?: string

  // ---- session-aware (optional; fall back to flt's local impl when missing) ----

  /** Keystrokes to submit a message in this CLI's TUI. e.g. ['Enter'] or ['Escape','Enter']. */
  submitKeys?: string[]

  /** When `flatten=true`, paste-buffer writes will collapse \n → ' ' before send. */
  flattenOnPaste?: boolean

  /**
   * Scroll-key routing policy for terminal multiplexer integrations (e.g.
   * flt's TUI). Consumers can use this to decide whether j/k, ctrl-u/d, etc.
   * should be forwarded into the CLI or treated as tmux scrollback.
   *
   *   'tmux'             — always tmux copy-mode scrollback. Default.
   *   'app'              — always forward to the CLI; this CLI owns its
   *                        own viewport regardless of mode.
   *   'fullscreen-aware' — forward to the CLI only when the pane is in
   *                        alt-screen / fullscreen render mode; else tmux.
   *                        Consumer check for tmux: #{alternate_on}.
   */
  scrollOwnership?: 'tmux' | 'app' | 'fullscreen-aware'

  /**
   * Per-CLI scroll-key chord lookup. Returns the four direction keys the
   * consumer should forward into this CLI right now, or `null` to fall
   * through to tmux scrollback. Allows mode-aware CLIs (e.g. claude-code's
   * `/tui fullscreen` vs `default`) to surface the active routing instead of
   * relying on alt-screen sniffing. Pure (or near-pure) lookup; consumers
   * may call it on every scroll keypress.
   */
  getCurrentScrollKeys?(): ScrollKeys | null

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

export type ErrorCode =
  | 'adapter-error'
  | 'unknown-harness'
  | 'duplicate-adapter'
  | 'unsupported-backend'
  | 'unsupported-capability'
  | 'invalid-options'
  | 'instruction-conflict'
  | 'session-closed'
  | 'protocol-error'
  | 'launch-failed'

export class HarnessError extends Error {
  readonly code: ErrorCode

  constructor(message: string, code: ErrorCode = 'adapter-error') {
    super(message)
    this.name = 'HarnessError'
    this.code = code
  }
}

/** What a harness actually supports on a backend. Static; never probes installs or credentials. */
export interface Capabilities {
  backend: Backend
  permissionPolicies: readonly PermissionPolicy[]
  nativeOptions: NativeOptions['kind'] | null
  /** Env variable `configHome` maps to, or null when overrides are unsupported. */
  configHomeEnv: string | null
  /** argv flag `configFile` maps to, or null when overrides are unsupported. */
  configFileFlag: string | null
  streaming: boolean
  cancellation: boolean
  sessions: boolean
}

/** `RunSpec` after defaults and validation; what `buildCommand` consumes. */
export interface ValidatedRunSpec {
  backend: Backend
  model: string
  permissionPolicy: PermissionPolicy
  /** argv to splice in at the adapter's bypass slot; empty under `upstream`. */
  permissionArgs: readonly string[]
  nativeOptions: NativeOptions | null
  /** argv the native options render to, to splice in at the adapter's native slot; empty when none apply. */
  nativeArgs: readonly string[]
  /** Absolute working directory; relative input resolved against the process cwd without changing it. */
  workdir: string
  executable: string | null
  configHome: string | null
  configFile: string | null
  /** `[configFileFlag, configFile]` to splice in at the adapter's config slot; empty when no file was given. */
  configArgs: readonly string[]
}

const KNOWN_BACKENDS: Readonly<Record<Backend, true>> = { cli: true, rpc: true, sdk: true }
const KNOWN_PERMISSION_POLICIES: Readonly<Record<PermissionPolicy, true>> = { upstream: true, bypass: true }
/** How one native-options field is validated and rendered into argv. */
type NativeField =
  /** Closed enum emitted as `flag value`. */
  | { readonly shape: 'enum'; readonly flag: string; readonly values: readonly string[] }
  /** Verbatim upstream rules, each emitted as `flag=rule` in caller order. */
  | { readonly shape: 'rules'; readonly flag: string }
/** Per native-options kind: field name → schema. Field order is argv order. */
const NATIVE_OPTION_FIELDS: Readonly<Record<NativeOptions['kind'], Readonly<Record<string, NativeField>>>> = {
  'claude-code': {
    effort: { shape: 'enum', flag: '--effort', values: ['low', 'medium', 'high', 'xhigh', 'max'] satisfies readonly ClaudeCodeEffort[] },
  },
  codex: {
    sandbox: { shape: 'enum', flag: '--sandbox', values: ['read-only', 'workspace-write', 'danger-full-access'] satisfies readonly CodexSandbox[] },
  },
  copilot: {
    allowTools: { shape: 'rules', flag: '--allow-tool' },
    denyTools: { shape: 'rules', flag: '--deny-tool' },
  },
}
const NATIVE_OPTION_KINDS = Object.keys(NATIVE_OPTION_FIELDS).map((kind) => JSON.stringify(kind)).join(', ')

/** Upstream tool rules: non-blank strings the CLI can take as arguments, in caller order. */
function isToolRuleList(value: unknown): value is readonly string[] {
  if (!Array.isArray(value)) return false
  for (const rule of value) {
    if (typeof rule !== 'string' || rule.trim() === '' || rule.includes('\0')) return false
  }
  return true
}

interface ResolvedNativeOptions {
  options: NativeOptions | null
  args: readonly string[]
}

/** Rejects every backend except the shipped `cli`. Shared by the validator and `getCapabilities`. */
export function resolveBackend(backend: unknown): Backend {
  if (backend === undefined) return 'cli'
  if (typeof backend !== 'string' || !Object.hasOwn(KNOWN_BACKENDS, backend)) {
    throw new HarnessError(`Unknown backend: ${JSON.stringify(backend)}. Expected one of: cli, rpc, sdk`, 'invalid-options')
  }
  if (backend !== 'cli') {
    throw new HarnessError(`Backend "${backend}" is not implemented; only "cli" is available`, 'unsupported-backend')
  }
  return 'cli'
}

function resolveNativeOptions(adapter: Adapter, spec: RunSpec): ResolvedNativeOptions {
  // Runtime shape check: specs routinely arrive from JSON/JS callers.
  const raw: unknown = spec.nativeOptions
  if (raw === undefined) return { options: null, args: [] }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw) || !('kind' in raw) || typeof raw.kind !== 'string' || !Object.hasOwn(NATIVE_OPTION_FIELDS, raw.kind)) {
    throw new HarnessError(`nativeOptions must be an object with kind ${NATIVE_OPTION_KINDS}`, 'invalid-options')
  }
  const kind = raw.kind as NativeOptions['kind']
  if (kind !== spec.harness || adapter.nativeOptionsKind !== kind) {
    throw new HarnessError(`Harness "${adapter.name}" does not accept nativeOptions of kind "${kind}"`, 'invalid-options')
  }
  const fields = NATIVE_OPTION_FIELDS[kind]
  for (const key of Object.keys(raw)) {
    if (key !== 'kind' && !Object.hasOwn(fields, key)) {
      throw new HarnessError(`Unknown nativeOptions field "${key}" for kind "${kind}"`, 'invalid-options')
    }
  }
  const args: string[] = []
  for (const [key, field] of Object.entries(fields)) {
    const value: unknown = Reflect.get(raw, key)
    if (value === undefined) continue
    if (field.shape === 'enum') {
      if (typeof value !== 'string' || !field.values.includes(value)) {
        throw new HarnessError(
          `Invalid nativeOptions.${key} ${JSON.stringify(value)}; expected one of: ${field.values.join(', ')}`,
          'invalid-options',
        )
      }
      args.push(field.flag, value)
    } else {
      if (!isToolRuleList(value)) {
        throw new HarnessError(
          `Invalid nativeOptions.${key} ${JSON.stringify(value)}; expected an array of non-blank tool rules`,
          'invalid-options',
        )
      }
      for (const rule of value) args.push(`${field.flag}=${rule}`)
    }
  }
  return { options: raw as NativeOptions, args }
}

function resolveExecutable(raw: unknown): string | null {
  if (raw === undefined) return null
  if (typeof raw !== 'string' || raw === '' || raw.includes('\0')) {
    throw new HarnessError('executable must be a non-empty string without NUL bytes', 'invalid-options')
  }
  if ((raw.includes('/') || raw.includes(sep)) && !isAbsolute(raw)) {
    throw new HarnessError(`executable ${JSON.stringify(raw)} must be a bare binary name or an absolute path`, 'invalid-options')
  }
  return raw
}

function resolveWorkdir(raw: unknown): string {
  if (typeof raw !== 'string' || raw === '' || raw.includes('\0')) {
    throw new HarnessError('workdir must be a non-empty string without NUL bytes', 'invalid-options')
  }
  return resolve(raw)
}

function resolveConfigPath(field: 'configHome' | 'configFile', raw: unknown, mapping: string | undefined, adapter: Adapter): string | null {
  if (raw === undefined) return null
  if (mapping === undefined) {
    throw new HarnessError(`Harness "${adapter.name}" has no ${field} mapping`, 'unsupported-capability')
  }
  if (typeof raw !== 'string' || raw === '' || raw.includes('\0') || !isAbsolute(raw)) {
    throw new HarnessError(`${field} must be an absolute path, got ${JSON.stringify(raw)}`, 'invalid-options')
  }
  return raw
}

/**
 * Apply defaults and validate a `RunSpec` against an adapter. Pure: no
 * filesystem or process side effects, so callers can reject bad specs before
 * any file is touched. Every shipped adapter calls this first thing in
 * `buildCommand`; custom adapters called directly must do the same. Public
 * registry entry points validate before dispatching to any adapter.
 *
 * Check order: backend, permission policy, native options, model,
 * executable, workdir, configHome, configFile.
 */
export function validateRunSpec(adapter: Adapter, spec: RunSpec): ValidatedRunSpec {
  const backend = resolveBackend(spec.backend)

  const policyRaw: unknown = spec.permissionPolicy
  if (policyRaw !== undefined && (typeof policyRaw !== 'string' || !Object.hasOwn(KNOWN_PERMISSION_POLICIES, policyRaw))) {
    throw new HarnessError(`Unknown permissionPolicy: ${JSON.stringify(policyRaw)}. Expected "upstream" or "bypass"`, 'invalid-options')
  }
  const permissionPolicy: PermissionPolicy = policyRaw === undefined ? 'upstream' : (policyRaw as PermissionPolicy)
  let permissionArgs: readonly string[] = []
  if (permissionPolicy === 'bypass') {
    if (!adapter.permissionBypassArgs) {
      throw new HarnessError(`Harness "${adapter.name}" has no permission bypass mapping`, 'unsupported-capability')
    }
    permissionArgs = adapter.permissionBypassArgs
  }

  const { options: nativeOptions, args: nativeArgs } = resolveNativeOptions(adapter, spec)
  if (nativeOptions?.kind === 'codex' && nativeOptions.sandbox !== undefined && permissionPolicy === 'bypass') {
    throw new HarnessError(
      'nativeOptions.sandbox conflicts with permissionPolicy "bypass" (codex bypass disables the sandbox); choose one',
      'invalid-options',
    )
  }

  // Empty string falls back to the default like undefined; whitespace is
  // trimmed after selection by the normalizer (matches Python).
  const model = normalizeModelForHarness(adapter.name, spec.model || adapter.defaultModel, { resolve: !spec.modelNoResolve })
    ?? adapter.defaultModel

  const executable = resolveExecutable(spec.executable)
  const workdir = resolveWorkdir(spec.workdir)
  const configHome = resolveConfigPath('configHome', spec.configHome, adapter.configHomeEnv, adapter)
  if (configHome !== null) {
    const explicit = spec.env?.[adapter.configHomeEnv!]
    if (explicit !== undefined && explicit !== configHome) {
      throw new HarnessError(
        `configHome conflicts with env.${adapter.configHomeEnv}; set one`,
        'invalid-options',
      )
    }
  }
  const configFile = resolveConfigPath('configFile', spec.configFile, adapter.configFileFlag, adapter)
  const configArgs: readonly string[] = configFile === null ? [] : [adapter.configFileFlag!, configFile]

  return { backend, model, permissionPolicy, permissionArgs, nativeOptions, nativeArgs, workdir, executable, configHome, configFile, configArgs }
}

/** What an adapter plans before the shared finalizer applies the spec-level overrides. */
export interface PlannedCommand {
  cmd: string
  args: string[]
  /** Adapter env additions; `spec.env` and the config-home mapping layer on top. */
  env?: Record<string, string>
  /** Artifact parent directories `prepareCommand` must create. */
  directories?: readonly string[]
  /** Overrides the reported model (requested or default), e.g. `null` when the CLI picks it from a caller config. */
  model?: string | null
}

/**
 * Turn an adapter's plan into the public `BuildCommand`. Pure: applies
 * `executable`, the absolute workdir, the env layering (adapter, then caller,
 * then config home) and plans the instructions projection from
 * `adapter.instructionsFilename`. Every built-in builder returns through here.
 */
export function finalizeCommand(adapter: Adapter, spec: RunSpec, validated: ValidatedRunSpec, planned: PlannedCommand): BuildCommand {
  const env: Record<string, string> = { ...(planned.env ?? {}), ...(spec.env ?? {}) }
  if (validated.configHome !== null) env[adapter.configHomeEnv!] = validated.configHome
  const project = adapter.instructionsFilename !== '' && spec.instructions !== undefined
  const built: BuildCommand = {
    cmd: validated.executable ?? planned.cmd,
    args: planned.args,
    cwd: validated.workdir,
    env,
    instructionsFile: project ? join(validated.workdir, adapter.instructionsFilename) : null,
    directories: planned.directories?.map((directory) => resolve(validated.workdir, directory)) ?? [],
    model: planned.model === undefined ? spec.model || adapter.defaultModel : planned.model,
  }
  if (project) built.instructionContent = spec.instructions
  return built
}
