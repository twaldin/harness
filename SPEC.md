# harness — specification

This is the shared contract for `harness` (Python) and `@twaldin/harness-ts` (TypeScript). It provides CLI command construction, one-shot execution, output parsing, controlled Pi RPC, optional OMP/Amp SDK bridge sessions, optional native Claude SDK sessions, caller-owned OpenCode HTTP and OpenHands Agent Server sessions, and externally hosted pane/log helpers. The [backend and session implementation gates](#backend-and-session-implementation-gates) apply to all controlled sessions.

**Repo layout (monorepo):**
```
harness/
├── SPEC.md                 (this file — the contract)
├── ADAPTER-MATRIX.md       (per-CLI flag + output parsing reference)
├── tests/fixtures/*.json   (shared golden tests both impls must pass)
├── src/harness/            (python)
│   ├── base.py             (types)
│   ├── registry.py         (run/list_adapters/get_adapter)
│   ├── adapters/*.py       (26 adapters)
│   ├── _instructions.py    (owned projection lifecycle)
│   └── _subproc.py         (subprocess lifecycle)
└── ts/                     (typescript, new)
    ├── package.json        (@twaldin/harness-ts)
    ├── src/base.ts
    ├── src/registry.ts
    ├── src/adapters/*.ts
    ├── src/instructions.ts
    └── src/subproc.ts
```

Version lockstep is the documented release requirement (see [Versioning](#versioning)). The current manifests are not aligned. The checked-in GitHub workflows publish each language separately and check its version against its own tag; they do not enforce cross-language API equivalence on PRs.

---

## Public API

The core headless API is described here. Both package roots also expose adapters, subprocess outcomes, instruction-projection, pricing and optional pane/session helpers. Python uses snake_case and dataclasses/typed dictionaries; TypeScript uses camelCase and interfaces. Python's `RunResult.ok` convenience and keyword arguments for instruction projection remain language-specific conveniences, not different execution semantics.

### Types

```ts
// RunSpec — everything an adapter needs to invoke its CLI
interface RunSpec {
  harness: string                  // registered adapter name; see Registry below
  prompt: string                   // the task (becomes positional arg or stdin)
  workdir: string                  // cwd for the subprocess; normalized to an absolute path
  model?: string                   // canonical or adapter-specific identifier (normalized per harness; see ADAPTER-MATRIX.md)
  instructions?: string            // temporarily projected into the adapter's instruction file
  timeoutSeconds?: number | null   // default 1800; null disables wall timeout
  env?: Record<string, string>     // extra env vars merged onto process.env
  modelNoResolve?: boolean         // skip harness-specific rewriting; whitespace is still trimmed
  backend?: Backend               // default 'cli'; 'rpc' and 'sdk' explicitly unsupported today
  permissionPolicy?: PermissionPolicy // default 'upstream'; never inject bypass by default
  nativeOptions?: NativeOptions   // typed, agent-specific CLI options; mismatches are errors
  executable?: string              // bare executable name or absolute path; no shell expansion
  configHome?: string              // absolute, caller-selected upstream config/state home
  configFile?: string              // absolute, caller-selected config file; supported adapters only
  cancel?: AbortSignal             // Python: threading.Event; explicit cancellation returns a result
  stdin?: string | null            // finite UTF-8 input, then EOF; omitted/empty means EOF
  onOutput?: OutputCallback        // decoded chunks, not framed agent events
  inactivityTimeoutSeconds?: number // opt-in positive finite seconds
  maxOutputBytes?: number          // per-stream raw prefix cap; default 1048576
}

// BuildCommand — what to invoke, without invoking it (for interactive consumers like flt)
interface BuildCommand {
  cmd: string                      // executable name, e.g. "claude", "codex"
  args: string[]                   // full argv tail
  cwd: string                      // resolved workdir
  env: Record<string, string>      // adapter additions + caller env/overrides; inherit parent env at exec
  instructionsFile: string | null  // planned path; building does not create it
  instructionContent?: string      // exact bytes to encode as UTF-8 during preparation; empty is valid
  directories?: string[]           // planned artifact directories created during preparation
  model?: string | null            // requested/default reporting label; null when selected by config
  gracefulSignal?: 'SIGTERM' | 'SIGINT' // first teardown signal; omitted means SIGTERM
}

// RunResult — after execution + output parsing
interface RunResult {
  harness: string
  model: string | null
  exitCode: number                 // -1 for timeout/cancel/launch failure; termination disambiguates
  durationSeconds: number
  stdout: string
  stderr: string
  timedOut: boolean
  termination?: Termination | null // always populated by execution; optional for legacy constructed results
  signal?: string | null           // leader's terminating signal, e.g. SIGTERM
  launchError?: string | null      // OS code such as ENOENT or EACCES
  stdoutBytes?: number             // total raw bytes read, including discarded bytes
  stderrBytes?: number
  stdoutTruncated?: boolean        // cap exceeded or pipe forced closed before EOF
  stderrTruncated?: boolean
  timeoutKind?: 'wall' | 'inactivity' | null
  callbackError?: string | null    // callback failure or interrupted delivery
  parseError?: string | null       // parser exception; execution outcome is retained
  costUsd: number | null           // null if adapter can't report cost
  tokensIn: number | null
  tokensOut: number | null
  raw: unknown | null              // adapter-specific structured payload (parsed JSON)
}

type Termination = 'exited' | 'signaled' | 'timed-out' | 'cancelled' | 'launch-failed' | 'callback-error'
type OutputStream = 'stdout' | 'stderr'
type OutputCallback = (chunk: string, stream: OutputStream) => void | Promise<void>
```

(Python equivalents are dataclasses with snake_case fields, such as `exit_code` and `cost_usd`; the TypeScript examples below use camelCase. The Python CLI's JSON output uses snake_case and omits `raw`.)

```ts
type Backend = 'cli' | 'rpc' | 'sdk'
type PermissionPolicy = 'upstream' | 'bypass'
interface ClaudeCodeOptions {
  kind: 'claude-code'
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
}
interface CodexOptions {
  kind: 'codex'
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access'
}
interface ClineOptions {
  kind: 'cline'
  provider?: string                // upstream provider ID, independent of model
  autoApprove?: boolean            // explicit per-run tool approval override
}
interface CopilotOptions {
  kind: 'copilot'
  allowTools?: readonly string[]
  denyTools?: readonly string[]
}
interface AmpOptions {
  kind: 'amp'
  mode?: string                    // built-in or plugin mode, not a model ID
}
interface VibeOptions {
  kind: 'mistral-vibe'
  agent?: string                   // exact upstream profile name
  trust?: boolean                  // explicit invocation-only workspace trust
}
interface KiroOptions {
  kind: 'kiro'
  trustTools?: string              // verbatim comma-separated native tool names
  requireMcpStartup?: boolean      // fail if configured MCP startup fails
}
interface QoderOptions {
  kind: 'qoder'
  permissionMode?: 'default' | 'accept_edits' | 'dont_ask'
}
type QoderPermissionMode = 'default' | 'accept_edits' | 'dont_ask'
type NativeOptions = ClaudeCodeOptions | CodexOptions | ClineOptions | CopilotOptions | AmpOptions | VibeOptions | KiroOptions | QoderOptions
interface Capabilities {
  backend: Backend
  permissionPolicies: readonly PermissionPolicy[]
  nativeOptions: 'claude-code' | 'codex' | 'cline' | 'copilot' | 'amp' | 'mistral-vibe' | 'kiro' | 'qoder' | null
  streaming: boolean
  cancellation: boolean
  sessions: boolean
  configHomeEnv: string | null      // supported native home variable, not an isolation guarantee
  configFileFlag: string | null     // supported native config-file flag
}
```

Python exports `Backend`, `PermissionPolicy`, `NativeOptions`, `Capabilities`,
`ClaudeCodeOptions`, `CodexOptions`, `ClineOptions`, `CopilotOptions`, `AmpOptions`, `VibeOptions`, `KiroOptions` and `QoderOptions` with equivalent values.
`QoderPermissionMode` is also exported in both languages.
Construct native options as `ClaudeCodeOptions(effort="high")`,
`CodexOptions(sandbox="read-only")`,
`ClineOptions(provider="openai-compatible", auto_approve=False)` or
`CopilotOptions(allow_tools=("shell(git status)",), deny_tools=("write",))`;
their `kind` is fixed by the dataclass. Copilot rule collections accept tuples
or lists in Python and arrays in TypeScript. Empty collections emit no flags.
Each member must be a nonempty, non-whitespace, NUL-free string; valid native
rules are preserved verbatim, including upstream's comma/filter syntax.
`AmpOptions(mode="low")` / `{kind: 'amp', mode: 'low'}` selects an Amp mode,
including a plugin mode key or label. It must be a nonblank, NUL-free string;
Harness preserves it verbatim and does not equate a mode with a model.
Native options are a discriminated union, not an untyped bag passed to an
arbitrary upstream. New variants land with a real implementation in both languages.

### Functions

```ts
// List all registered adapter names.
listAdapters(): string[]

// Resolve an adapter without spawning or probing installed tools.
getAdapter(name: string): Adapter

// Report implemented support for the selected backend, not local availability.
getCapabilities(name: string, backend?: Backend): Capabilities

// Plan argv/env/cwd and instruction projection WITHOUT writing files or executing.
buildCommand(spec: RunSpec): BuildCommand

// Acquire the workdir lease and prepare the planned files/directories.
prepareCommand(command: BuildCommand): PreparedCommand

// Restore only still-owned projections, then release the lease; idempotent on success.
cleanupCommand(prepared: PreparedCommand): void

// The caller passes this command to its host driver and retains the opaque handle.
interface PreparedCommand { readonly command: BuildCommand }

// Parse adapter output after execution. Called by run() internally, also callable
// standalone by interactive consumers (flt) that exec'd the command themselves via tmux.
parseOutput(spec: RunSpec, outcome: SubprocOutcome): {
  costUsd: number | null
  tokensIn: number | null
  tokensOut: number | null
  raw: unknown | null
}

// SubprocOutcome has the execution fields of RunResult, including
// termination, signal and launchError, without harness/model/metrics/raw.

// Full headless invocation — buildCommand + exec + parseOutput.
// py: synchronous RunResult; ts: non-blocking Promise<RunResult>.
run(spec: RunSpec): Promise<RunResult>

// Non-blocking headless invocation; independent calls can run concurrently.
// py: coroutine using the shared runner in a shielded worker thread;
// ts: the same asynchronous execution engine as run().
runAsync(spec: RunSpec): Promise<RunResult>  // py: async def run_async(spec) -> RunResult
```

### Errors

Both languages expose `HarnessError.code` (`ErrorCode`) independently of message
wording:

| code | condition |
|---|---|
| `unknown-harness` | case-sensitive adapter lookup failed |
| `duplicate-adapter` | a different implementation already owns that registry name |
| `unsupported-backend` | a recognized backend is not implemented for the adapter |
| `unsupported-capability` | the adapter cannot honor the requested capability, such as bypass |
| `invalid-options` | invalid backend/policy/native options, mismatched native kind, or conflicting choices |
| `adapter-error` | other adapter prerequisite error, including a missing swe-agent wrapper |
| `instruction-conflict` | an overlapping lease, unsafe projection path, or modified owned artifact prevents safe preparation/restoration |
| `launch-failed` | session process could not start, or exited/disconnected before the native handshake |
| `protocol-error` | session handshake/response/framing failure, including command-response deadline |
| `session-closed` | operation attempted after session disposal |

Selector/permission/native-option/config-override rejection happens before
preparation and before any subprocess starts. A caller can
catch `HarnessError` without parsing its message. Existing message-only
construction retains `adapter-error`.

For one-shot execution, non-zero subprocess exit, timeout, explicit cancellation,
OS launch failure and output callback failure are represented in `RunResult`,
not `HarnessError`. Session startup rejects; accepted turns use `SessionTurnResult`.
Execution catches parser exceptions into `parseError`, with null metrics/raw and
the original terminal outcome and captured text. Standalone `parseOutput` remains
strict. Python task cancellation propagates `CancelledError` after cleanup.
Invalid low-level arguments and
unsupported operating systems raise before launch. Cleanup failures (including
failure to reap the leader within the cleanup deadline) raise rather than
returning a result that falsely implies completed cleanup. See
[ownership and execution](#ownership-and-execution).

### Backend selection and capabilities

`harness` identifies the agent; `backend` identifies its execution integration.
Omitted backend means CLI for existing callers. No preference order, dependency
probe or failure path may silently change CLI into SDK/RPC, or vice versa.
Selecting `rpc` or `sdk` for a registered CLI adapter through the one-shot
`RunSpec` API raises `unsupported-backend` in both languages. Controlled RPC uses the separate
[session API](#controlled-rpc-sessions); no one-shot call changes into a session.
Importing Harness loads no optional SDK and does not initialize upstream settings.

`getCapabilities("codex")` reports CLI support, `["upstream", "bypass"]`,
native option kind `"codex"`, `true` for cancellation and streaming, and `false`
for sessions. All twenty-six CLI adapters share these lifecycle capabilities.
They describe
Harness-controlled operations, not whether the underlying tool supports a
protocol or writes session logs. Optional pane/log helper availability is
separate from a controllable live session. Capability queries perform no
installation/authentication/version checks; see the adapter matrix for evidence.

### Permission policy and migration

Omitted policy and `"upstream"` mean Harness adds no approval/bypass flag or mode environment override unless
the caller explicitly supplies a native override such as `ClineOptions.autoApprove`.
Upstream policy still depends on the selected tool, its headless mode, caller
environment and existing configuration. This does **not** promise a sandbox,
an interactive approval channel, or denial of every tool call. An upstream
may reject an operation when stdin is closed. Harness never responds to an
approval request by silently escalating.

`"bypass"` is an explicit request to use the adapter's documented bypass mapping:

| adapter | explicit bypass mapping |
|---|---|
| claude-code, openclaude | `--dangerously-skip-permissions` |
| codex | `--dangerously-bypass-approvals-and-sandbox` (also disables sandboxing) |
| factory-droid | `--skip-permissions-unsafe` |
| gemini, qwen | `-y` |
| aider | `--yes-always` |
| kilo, continue-cli | `--auto` |
| hermes, mini-swe-agent | `--yolo` |
| omp | `--auto-approve` |
| cline | `--auto-approve true` |
| goose | child environment `GOOSE_MODE=auto` (no flag); conflicting explicit `env.GOOSE_MODE` rejects |
| copilot | `--allow-all` |
| mistral-vibe | `--auto-approve` |
| cursor | `--force` (native explicit denies and team policy still apply) |
| kiro | `--trust-all-tools` |

Adapters without a mapping (including Amp, Kimi Code and Qoder) reject `"bypass"` as unsupported; a missing mapping is
not evidence that upstream has no permissions. Unsupported choices are never
silently ignored. Narrow native options stay explicit: Codex `sandbox` emits
`--sandbox`, and cannot be combined with `"bypass"` because that would override
the selected sandbox. Claude Code `effort` emits `--effort`; it is not a common
model/effort policy for every tool.
Cline `provider` emits `--provider`; `autoApprove` emits `--auto-approve true|false`.
An explicit `autoApprove` and `"bypass"` conflict, even when both request approval.
Cline's upstream CLI defaults to auto-approval; `"upstream"` is not a denial policy.
Copilot `allowTools` / `denyTools` emit repeated `--allow-tool=<rule>` /
`--deny-tool=<rule>` arguments, respectively; upstream denial takes precedence
over grants, including explicit bypass. These rules do not enable bypass.

**Compatibility change:** older command builders inserted bypass mappings
unconditionally. Hermes, OMP and Continue's mappings postdate that change.
Callers that intentionally require that authority must set `permission_policy="bypass"` (Python) or
`permissionPolicy: "bypass"` (TypeScript). Otherwise upstream defaults apply.
The existing RunSpec/RunResult fields and entry points are retained; this is an
intentional behavior change, not a claim of fully unchanged compatibility.
Review the upstream risk before opting in, especially Codex's disabled sandbox.

### Acceptance examples

These build commands without a provider request. `/tmp/owned-checkout` denotes
a caller-owned working directory. No instructions are supplied, so these two
adapters do not write an instruction file.

```python
from pathlib import Path
from harness import (
    RunSpec, CodexOptions, HarnessError, build_command, get_capabilities,
)

spec = RunSpec(
    harness="codex", prompt="Review this code", workdir=Path("/tmp/owned-checkout"),
    backend="cli", native_options=CodexOptions(sandbox="read-only"),
)
command = build_command(spec)  # --sandbox read-only; no bypass flag
assert "--dangerously-bypass-approvals-and-sandbox" not in command.args
assert get_capabilities("codex").sessions is False
try:
    build_command(RunSpec(
        harness="codex", prompt="Review", workdir=spec.workdir, backend="sdk",
    ))
except HarnessError as error:
    assert error.code == "unsupported-backend"  # no CLI fallback or writes
```

```ts
import { buildCommand, getCapabilities, HarnessError } from '@twaldin/harness-ts'

const spec = {
  harness: 'codex', prompt: 'Review this code', workdir: '/tmp/owned-checkout',
  backend: 'cli' as const,
  nativeOptions: { kind: 'codex' as const, sandbox: 'read-only' as const },
}
const command = buildCommand(spec) // --sandbox read-only; no bypass flag
if (command.args.includes('--dangerously-bypass-approvals-and-sandbox')) {
  throw new Error('unexpected bypass')
}
if (getCapabilities('codex').sessions) throw new Error('unexpected session support')
try {
  buildCommand({ ...spec, backend: 'sdk', nativeOptions: undefined })
} catch (error) {
  if (!(error instanceof HarnessError) || error.code !== 'unsupported-backend') throw error
}
```

For intentional bypass, omit the conflicting sandbox options and set the
permission policy explicitly. A native option kind for another adapter, invalid
enum value, or unsupported bypass must fail before instruction-file side effects.
Deterministic tests exercise those cases in both languages. They do not establish
provider authentication, current upstream flag compatibility or successful model use.

---

## Example RunResults

What `run()` returns for each adapter on a successful invocation. `raw` holds the adapter-specific parsed payload; `stdout` / `stderr` are abbreviated.

### claude-code

```json
{
  "harness": "claude-code",
  "model": "sonnet",
  "exitCode": 0,
  "durationSeconds": 12.3,
  "stdout": "{\"type\":\"result\",\"result\":\"Hello from harness\",\"usage\":{...},\"total_cost_usd\":0.0342}",
  "stderr": "",
  "timedOut": false,
  "costUsd": 0.0342,
  "tokensIn": 1823,
  "tokensOut": 412,
  "raw": {
    "type": "result",
    "result": "Hello from harness",
    "usage": { "input_tokens": 1823, "output_tokens": 412 },
    "total_cost_usd": 0.0342
  }
}
```

### codex

`costUsd` is always null — codex does not emit pricing data.

```json
{
  "harness": "codex",
  "model": "gpt-5.3-codex",
  "exitCode": 0,
  "durationSeconds": 8.1,
  "timedOut": false,
  "costUsd": null,
  "tokensIn": 323,
  "tokensOut": 133,
  "raw": null
}
```

### gemini

Gemini CLI does not report a dollar cost. The adapter estimates `costUsd` from token totals and the first model in `stats.models` when that model has a known price; otherwise it returns null.
Malformed nested usage returns null metrics, not exceptions or `NaN`.
Counts must be nonnegative safe integers; decimal strings remain accepted.
Absent fields in an otherwise valid legacy stats envelope retain their existing
zero defaults. This compatibility behavior is not proof of zero billed usage.

```json
{
  "harness": "gemini",
  "model": "gemini-2.5-pro",
  "exitCode": 0,
  "durationSeconds": 15.7,
  "timedOut": false,
  "costUsd": 0.00573,
  "tokensIn": 2104,
  "tokensOut": 310,
  "raw": {
    "response": "Hello from harness",
    "stats": { "models": { "gemini-2.5-pro": { "tokens": { "input": 2104, "candidates": 310 } } } }
  }
}
```

### opencode

Cost and tokens come from the sqlite session DB read after exit, selected by
the native `sessionID` observed in `run --format json`, not by workdir or recency.

```json
{
  "harness": "opencode",
  "model": "gpt-5.4",
  "exitCode": 0,
  "durationSeconds": 21.4,
  "timedOut": false,
  "costUsd": 0.0821,
  "tokensIn": 4201,
  "tokensOut": 887,
  "raw": {"sessionID": "ses_example", "costSource": "reported"}
}
```

### aider

`costUsd` stays null: Harness does not parse Aider's textual cost report.
Tokens sum the formatted per-message `sent`/`received` reports, including lines
with intermediate cache-write/cache-hit fields. These rounded text counts are
heuristic telemetry, not exact provider billing.

```json
{
  "harness": "aider",
  "model": "openrouter/anthropic/claude-sonnet-4.6",
  "exitCode": 0,
  "durationSeconds": 18.2,
  "timedOut": false,
  "costUsd": null,
  "tokensIn": 12300,
  "tokensOut": 2145,
  "raw": null
}
```

### swe-agent

Cost and tokens come from the trajectory JSON file written by the wrapper.

```json
{
  "harness": "swe-agent",
  "model": "gpt-5.4",
  "exitCode": 0,
  "durationSeconds": 94.3,
  "timedOut": false,
  "costUsd": 0.23,
  "tokensIn": 18420,
  "tokensOut": 3102,
  "raw": {
    "info": { "model_stats": { "instance_cost": 0.23 } },
    "messages": ["..."]
  }
}
```

### qwen

`costUsd` is always null — Qwen CLI does not embed pricing data in its output.

```json
{
  "harness": "qwen",
  "model": "qwen3-coder",
  "exitCode": 0,
  "durationSeconds": 11.2,
  "timedOut": false,
  "costUsd": null,
  "tokensIn": 1100,
  "tokensOut": 280,
  "raw": [
    { "type": "assistant", "content": "Hello from harness" },
    { "type": "result", "usage": { "input_tokens": 1100, "output_tokens": 280 } }
  ]
}
```

### continue-cli

`cn --format json` emits the model's final response, not a usage envelope.
Cost and token metrics are always null, including when the model produces fields
named `usage` or `total_cost_usd`. `raw` preserves the parsed final JSON; leading
compaction status records are skipped. [Upstream headless contract](https://docs.continue.dev/cli/headless-mode).

An omitted/empty model delegates selection to the existing upstream configuration
and reports null. An explicit model is a Continue Hub `owner/package` slug,
preserved without provider-prefix normalization; bare model IDs reject as
`unsupported-capability`. A caller-selected `configFile` owns model selection
and cannot be combined with an explicit model. Instructions are projected into
`CONTINUE.md` and passed through `--rule`, because Continue does not discover
that root filename. Explicit bypass adds `--auto`; upstream policy remains the
default. The adapter's empty-string default-model metadata denotes no selection.

```json
{
  "harness": "continue-cli",
  "model": null,
  "exitCode": 0,
  "durationSeconds": 7.1,
  "timedOut": false,
  "costUsd": null,
  "tokensIn": null,
  "tokensOut": null,
  "raw": {
    "response": "Hello from harness",
    "status": "success",
    "note": "Response was not valid JSON, so it was wrapped in a JSON object"
  }
}
```

### pi

Cost and tokens are summed from assistant messages in the `--mode json` event
stream, once per agent cycle: each terminal `agent_end.messages` snapshot
replaces that cycle's incremental `message_end` / `turn_end` records without
discarding earlier cycles, and a cut-off final cycle keeps its completed
messages.

```json
{
  "harness": "pi",
  "model": "sonnet",
  "exitCode": 0,
  "durationSeconds": 4.8,
  "timedOut": false,
  "costUsd": 0.0087,
  "tokensIn": 1200,
  "tokensOut": 340,
  "raw": [
    { "type": "session", "version": 3, "id": "..." },
    { "type": "agent_start" },
    { "type": "turn_end", "message": { "role": "assistant", "usage": { "input": 1200, "output": 340, "cost": { "total": 0.0087 } } } },
    { "type": "agent_end", "messages": [ { "role": "assistant", "usage": { "input": 1200, "output": 340, "cost": { "total": 0.0087 } } } ] }
  ]
}
```

### hermes

Metrics are always null: Hermes' `--quiet` output has no machine-readable usage
contract and stdout is never parsed as JSON. `raw` is `{"session_id": ...}` when
stderr contains a complete `session_id: <id>` line (last one wins), otherwise
null. `model` is null when the spec omits it, because the upstream
configuration selects the model.

```json
{
  "harness": "hermes",
  "model": null,
  "exitCode": 0,
  "durationSeconds": 12.4,
  "timedOut": false,
  "stdout": "Hello from harness\n",
  "stderr": "session_id: 20260908_094809_a1b2c3\n",
  "costUsd": null,
  "tokensIn": null,
  "tokensOut": null,
  "raw": { "session_id": "20260908_094809_a1b2c3" }
}
```

### goose

`raw` retains typed JSONL objects from `goose run --quiet --output-format stream-json`.
The last `complete` event supplies optional cumulative `input_tokens`,
`output_tokens` and `cost_usd`; no complete means null metrics with partial
events retained. Upstream cost can be estimated, not necessarily billed spend.
An upstream provider error can emit `error`, then `complete`, and exit zero:
inspect `raw` for agent failure; Harness preserves the actual process status.
Setup and noninteractive approval failures can exit nonzero without `complete`.
See [Goose](ADAPTER-MATRIX.md#goose) for its config, output and teardown limits.

### copilot

`raw` is the ordered array of complete JSON objects from stdout, including
assistant deltas/messages, native errors and the terminal `result`; null if
none were decoded. Noise, JSON scalars/arrays and incomplete records are ignored
by the parser but remain in `stdout`. A complete final JSON object needs no
trailing newline. Interrupted runs retain their complete preceding events.

Token totals and USD cost are null: the qualified 1.0.83 JSONL result reports
premium requests, durations and code changes, not aggregate tokens or billed
USD. Cache checkpoints and AI credits are not interchangeable with those metrics.
Native error/result fields remain in `raw`; they do not overwrite the process
exit code or Harness termination cause. Omitted model leaves upstream selection
in charge and reports null. See the [adapter reference](ADAPTER-MATRIX.md#copilot)
for setup, explicit permissions and qualification limits.

### amp

Local `--executor local --stream-json --execute=<prompt>` only. Nonempty
`model` requests reject as `unsupported-capability`; model reporting is null.
`AmpOptions.mode` selects an upstream mode, not a model. Empty prompts reject;
finite stdin supplements the prompt. Remote orbs/runners, thread continuation,
streaming JSON input, thinking output and controlled RPC/SDK sessions are not
exposed. See [setup and permissions](ADAPTER-MATRIX.md#amp).

`raw` preserves every complete JSON object line, including `session_id`,
native errors, cache usage and unknown event types; null if none. Malformed,
non-object and incomplete lines are ignored; stdout itself is preserved under
the shared capture limit. `tokensIn` and `tokensOut` independently prefer valid
`input_tokens` / `output_tokens` from the last top-level `result.usage`;
missing/invalid fields fall back to sums of observed top-level
`assistant.message.usage` fields. Parent-tool events are retained but not counted.
Counts and their sums must be nonnegative safe integers; missing counts are null, reported
zero remains zero. Cache read/creation counts stay in raw, not `tokensIn`,
matching the Claude headless convention. Partial output reports observed counts,
not an estimate of the full run. Cost is null: the documented stream does not
report USD and Amp's mode routing does not establish a price.

Native provider failures can emit `result.is_error: true` and still exit zero.
Callers must inspect the terminal event; Harness preserves the process exit
and termination status rather than converting a native error into a parse failure.

### mistral-vibe

`vibe --output streaming --prompt=PROMPT` emits completed native history entries
as JSONL, not token deltas or a terminal usage envelope. `raw` preserves every
complete JSON object in order; malformed/nonobject lines are ignored, and no
objects means null. Complete entries survive partial output and process failure.
All token/cost metrics are null; native error notices do not rewrite process exit.

Omitted model uses upstream configuration and reports null. An explicit model
alias is trimmed and set as child `VIBE_ACTIVE_MODEL`; conflicting explicit
environment selection rejects. `VibeOptions(agent="ask", trust=True)` /
`{kind: 'mistral-vibe', agent: 'ask', trust: true}` selects a native profile and
invocation-only workspace trust. Trust loads project configuration, hooks and
instructions; it is distinct from tool auto-approval. Nonempty `instructions`
requires explicit `trust=true`, otherwise `unsupported-capability`, rather than
silently projecting an ignored file or granting trust implicitly. Empty prompts
reject before preparation. Harness never passes `--worktree`. See the
[adapter reference](ADAPTER-MATRIX.md#mistral-vibe) for unsupported operations.

### kimi-code

The maintained Kimi Code CLI runs as
`kimi --output-format stream-json [--model=ALIAS] --prompt=PROMPT`.
Equals-form options preserve flag-shaped prompts and model aliases as data.
Empty or whitespace-only prompts reject before preparation. Explicit aliases
are trimmed but otherwise unchanged; omitted model preserves upstream selection
and reports null. Instructions use shared owned workdir `AGENTS.md` projection.

**Print mode uses native `auto` permissions, even under Harness `upstream`.**
Static deny rules still apply; this is not an interactive approval channel.
Upstream rejects `--yolo`, `--auto` and `--plan` with a prompt, so Harness exposes
only `upstream` and rejects explicit `bypass` as `unsupported-capability`.
No native permission/plan options are exposed.

`configHome` maps to `KIMI_CODE_HOME`; the native filename remains `config.toml`.
Arbitrary `configFile` overrides are unsupported. Caller environment, config
and authentication remain authoritative; Harness does not log in, copy
credentials, alter global configuration or migrate predecessor sessions.

`raw` retains complete stdout JSON objects in order: assistant content/tool calls,
tool results and unknown messages. Malformed, truncated and nonobject lines are
ignored; no objects means null. Stderr remains separate. All token/USD totals
stay null, including when an unknown event resembles usage. Process exits and
shared termination metadata are not rewritten using predecessor exit semantics.
CLI streaming/cancellation use the shared owned-process lifecycle; ACP/web/SDK,
resume and session-log helpers are unsupported. See
[source qualification and runtime gaps](ADAPTER-MATRIX.md#kimi-code).

### kiro

`kiro-cli chat --no-interactive --agent-engine v2 --output-format stream-json`
selects the qualified V2 one-shot path, not the legacy V1 or preview V3 engine.
The prompt follows `--` so leading hyphens remain data; empty prompts reject.
Omitted model preserves upstream selection and reports null; explicit model
IDs are trimmed and otherwise preserved as `--model=<value>`.

`KiroOptions(trust_tools="read,grep", require_mcp_startup=True)` /
`{kind: 'kiro', trustTools: 'read,grep', requireMcpStartup: true}` emits
`--trust-tools=read,grep --require-mcp-startup`. Tool names are a NUL-free string
in upstream comma-separated syntax; empty explicitly trusts no tools, while
whitespace-only values reject. Explicit `trustTools`
conflicts with bypass, which would broaden the requested trust. Omitted trust
adds no permission flags; false `requireMcpStartup` adds no flag.
Instructions use the shared owned `AGENTS.md` projection.

`raw` preserves every complete JSON object line in order, including unknown
events; malformed, truncated and nonobject lines are ignored. No objects means
null. Complete events survive failure and timeout. Token and USD totals remain
null: no aggregate accounting schema is qualified. Native error events do not
rewrite the observed process exit. Raw stdout/stderr and shared streaming
callbacks preserve output independently of parsing.

Config home/file overrides, native agent/engine switching, session resume,
ACP/RPC and SDK execution are unsupported. Unknown native fields reject rather
than disappear. See [setup and qualification limits](ADAPTER-MATRIX.md#kiro).

### qoder

`qoder --print --output-format json --input-format text --max-turns 20
[--model MODEL] [--permission-mode MODE] --prompt=PROMPT` selects local
one-shot execution. Empty prompts reject. Qoder 1.1.47 rejects a positional
prompt beginning `--` even after the argument separator, so Harness uses the
still-supported, deprecated equals-form prompt flag; its warning remains on
stderr. Omitted model uses upstream selection and reports null; explicit IDs
are trimmed and otherwise preserved. Shared preparation projects `AGENTS.md`.

`QoderOptions(permission_mode="accept_edits")` /
`{kind: 'qoder', permissionMode: 'accept_edits'}` explicitly approves safe
workspace edits, not shell commands or sensitive paths. Supported modes are
`default`, `accept_edits` and `dont_ask`; omission emits no permission flag.
Text-input headless confirmation requests are denied. Existing upstream
permission rules remain authoritative; these modes are not a sandbox.
Bypass, automatic agent-decided permissions and host-driven approvals are
unsupported; Harness never injects `--yolo`.

A whole JSON object is retained as `raw`; otherwise complete JSON object
lines are retained as an ordered list. A valid nonobject JSON document yields
null, not nested result extraction. Malformed/truncated lines are ignored;
complete events survive incomplete streams. No objects means null.
Native result/error/permission fields remain raw and do not rewrite process
exit or cancellation. Token and USD metrics stay null: metadata is not a
qualified usage contract, and 1.1.47's result builder hardcodes USD to zero.

`configHome` maps to `QODER_CONFIG_DIR`; inherited and explicit authentication
remain caller-selected. Config-file overrides, output/input protocol switches,
resume, RPC and SDK sessions are unsupported. Stream-json parsing is diagnostic
only, not the separate host-driven approval protocol. See
[qualification and provider-smoke gaps](ADAPTER-MATRIX.md#qoder).

### cursor

`raw` preserves all complete JSON object lines in order, including assistant
deltas, duplicate buffered flushes, tool events and terminal results. Malformed,
truncated and non-object lines are ignored by parsing, not removed from stdout.
The last `type: "result"` object's optional `usage.inputTokens` and
`usage.outputTokens` supply independent nonnegative safe-integer counts (at most
2^53 - 1); invalid or missing fields are null. Qualified Cursor 2026.09.02-c22c1a3 already subtracts
cache reads/writes from `inputTokens`; Harness does not add them back or sum
message events. No USD metric is reported. Older documented results without
usage remain valid and report null counts. Process exit/termination remains
authoritative even if a native event describes an error.

The command is local print/stream-JSON with partial output, native model
selection when omitted, explicit `--force` only for bypass, and SIGINT graceful
teardown. No native mode/sandbox/trust/MCP approval or persist/resume/worker
mapping is exposed. See [setup and qualification limits](ADAPTER-MATRIX.md#cursor).

### mini-swe-agent

The distinct native `mini` CLI uses `--task=TEXT --exit-immediately --output
<workdir>/.harness/mini-swe-agent.traj.json`. Instructions are prepended to the
task, not projected to a file. No model is selected by Harness when omitted;
explicit model IDs pass through unchanged apart from surrounding whitespace.
`MSWEA_CONFIGURED=true` in the child skips onboarding, not tool confirmation.
An empty task or explicit empty `MSWEA_CONFIGURED` rejects as `invalid-options`.
Only explicit bypass adds `--yolo`; upstream policy retains native confirmation
or configured approvals. With stock confirm mode, closed stdin causes EOF failure
instead of granting permission. Unattended coding needs bypass or caller-configured
approvals. `--exit-immediately` disables only the final new-task prompt.

The parser reads the reserved workdir trajectory only after a zero, non-timeout
exit whose stdout ends with the exact `Saved trajectory to 'PATH'` marker
(ANSI and Rich line wrapping tolerated). Missing marker/file, malformed JSON,
or an unrecognized `trajectory_format` returns null metrics/raw. In particular, an interrupted or
provider-failed invocation never reuses an earlier run's file. Its stdout/stderr
remains available, but unconfirmed partial trajectory telemetry is not exposed.
The CLI overwrites this reserved path; use a caller-owned workdir.
Artifact reads reject symlinks, non-regular files, files larger than 16 MiB and
files whose length changes while being read. They open nonblocking and read at
most the checked size plus one byte; rejected artifacts yield null metrics/raw.

For `mini-swe-agent-1.1` trajectories, `raw` retains the whole object.
`info.model_stats.instance_cost` is a nonnegative finite USD value, including zero.
Assistant `extra.response.usage` counts are summed independently: `prompt_tokens`
then `input_tokens`, and `completion_tokens` then `output_tokens`, falling back
only for missing/null primary keys. Invalid counts are omitted; a dimension with
no valid counts or a total above 2^53 - 1 is null. No repricing or non-assistant
usage aggregation occurs. A native `LimitsExceeded` exit status can accompany
process exit zero; inspect `raw.info.exit_status` for `Submitted`, rather than
treating process success as task completion.

Streaming is console text, not structured events. Default local shell actions
start separate process groups in mini 2.4.6 and can survive Harness cancellation;
only the owned CLI group has the shared teardown guarantee. Container/custom
environments selected in native config remain caller-owned and unqualified.
No SDK/RPC, resume, pane or session-discovery mapping is exposed. See the
[adapter reference](ADAPTER-MATRIX.md#mini-swe-agent) for setup and evidence.

### auggie

`auggie --print --output-format json --show-cost` emits a compact terminal
`type: "result"` object, not streaming assistant/tool events. `raw` retains all
complete JSON object lines in order (null when none); noise, nonobjects and
truncated records remain in stdout. The last result's `billing.total_cost`
populates `costUsd` only when `billing.usage_unit` is exactly `"usd"` and the
cost is a finite nonnegative number. Credit billing and missing/invalid billing
yield null; no conversion, summation or earlier-result fallback. Token metrics
are always null.

Process success alone does not establish agent completion. Inspect the final
native `is_error` and `subtype`: `success` differs from `empty_completion`,
`error_during_execution` and `error_max_turns`. Native error fields remain in raw;
Harness preserves the actual process exit and its own timeout/cancellation cause.
Authentication and enterprise noninteractive-entitlement failures can exit 1
without JSON. See [setup and qualification limits](ADAPTER-MATRIX.md#auggie).

---

## Adapter contract

Each adapter provides:

| field | meaning |
| --- | --- |
| `name` | short id used in RunSpec.harness — matches the CLI name |
| `instructionsFilename` | where to write RunSpec.instructions; empty string = no file (fold into prompt) |
| `defaultModel` | used when RunSpec.model is unset; `amp`, `auggie`, `hermes`, `goose`, `copilot`, `cursor`, `kimi-code`, `kiro`, `mini-swe-agent`, `mistral-vibe` and `qoder` have none (empty sentinel), so upstream selection applies and the reported model is null |
| `buildCommand(spec)` | returns a side-effect-free command and instruction plan |
| `parseOutput(spec, outcome)` | returns `{costUsd, tokensIn, tokensOut, raw}` |

`buildCommand` MUST NOT write files, create directories, or fork a subprocess.
Built-in builders apply the common launch finalizer so direct adapter calls and
registry calls honor executable, cwd, env and supported config overrides alike.
`parseOutput` MAY read files the CLI wrote (opencode/kilo/crush sqlite DBs, swe-agent/mini-swe-agent trajectory JSON) but MUST NOT block on I/O > 5s.

### JSON-fixture-driven verification

Every registered adapter MUST have a matching `tests/fixtures/<name>.json`.
Both language loaders discover these files and require their names to equal
the registry; adding an adapter or fixture alone fails conformance.

| fixture field | shared assertion |
|---|---|
| `spec` | synthetic caller input; `<root>` and `<workdir>` resolve to fresh temporary directories |
| `expectedCommand` | exact executable, argv, cwd, env additions, instruction path, planned directories, resolved model and optional graceful signal; building writes nothing |
| `capabilities` | complete capability record; unsupported backend, permission, native-option and config requests reject before preparation |
| `sampleOutput` / `expectedParsed` | identical parsed metrics and structured `raw` payload |
| `artifacts` | optional synthetic SQLite statements or trajectory JSON, created before direct parsing and by the substitute CLI during execution |
| `expectedParsedWithoutArtifacts` | explicit missing-artifact result, required when `artifacts` are declared |
| `cases` | optional named edge cases overriding `spec` fields or replacing output, artifacts, expected command/parsed result; `expectedError` declares pre-launch rejection |
| `cases[].expectedParseError` | `true` requires standalone parsing to throw; both run entrypoints capture `parseError`, preserve the subprocess outcome and match `expectedParsed` with null metrics/raw |

See [the Claude fixture](tests/fixtures/claude-code.json) for stdout parsing and
[the OpenCode fixture](tests/fixtures/opencode.json) for database-backed parsing.
Database expectations are asserted against synthetic populated databases, not
skipped through prose notes. Existing schema/session-specific regression suites
remain complementary coverage.

The same Python and TypeScript fixture assertions also drive each adapter's
public run entry points through `tests/fixtures/fixture_cli.py`, an explicit
substitute executable. The child records actual argv/cwd/selected env and
projected instructions, emits fixture output, and writes declared artifacts.
Assertions cover parsed results, lifecycle metadata and owned cleanup. No
installed coding-agent CLI or live database is used.

`tests/subprocess_cases.json` supplies shared scenarios and expected observations
for spawn errors, stdin EOF, signals, deadlines, cancellation, grandchildren,
output floods and UTF-8/capture boundaries. Python runs them against both
subprocess entry points; TypeScript runs applicable entry points against source
under Bun and the built package under Node. Callback acknowledgements force
split UTF-8 writes into separate reads. Each language's coverage guard rejects
unknown expectations, missing categories or cases without an applicable runner.
TypeScript's blocking helper cannot deliver callbacks or in-flight same-thread
abort signals; those cases explicitly select its async entry point.

This is offline, credential-free library conformance, not upstream CLI, model,
authentication or SDK qualification. [CONTRIBUTING.md](CONTRIBUTING.md#offline-conformance-versus-live-smoke)
declares platform coverage and the separate opt-in real-provider commands.

## Environment handling

Adapters MAY supply env additions (for example `KILO_DB`, `KILO_CONFIG_CONTENT`,
`CLAUDE_CODE_USE_OPENAI`; `swe-agent` also reads `SWE_WRAPPER`).
`BuildCommand.env` contains those additions followed by `RunSpec.env`, so explicit
caller values win. An explicit `configHome` supplies the adapter's mapped variable;
conflicting values in `RunSpec.env` reject rather than silently choosing one.
Inherited values may be overridden by an explicit choice. Execution inherits the
parent environment and overlays this command env without mutating either input.
Harness does not enumerate managed homes or switch accounts.

Credentials and account selection belong to the caller. Harness does not discover,
copy, serialize into generated config, or log credentials. Caller-selected
host-local authentication remains available through inherited environment, explicit
env additions, and the selected upstream configuration. `BuildCommand.env` can
contain caller-supplied secrets: do not publish command objects or raw output.
Configuration files are passed by path, never read or copied by the builder.

### Supported configuration overrides

| adapter | `configHome` mapping | `configFile` mapping |
|---|---|---|
| claude-code | `CLAUDE_CONFIG_DIR` | `--settings` |
| codex | `CODEX_HOME` | unsupported |
| hermes | `HERMES_HOME` | unsupported |
| cline | `CLINE_DIR` | unsupported |
| goose | `GOOSE_PATH_ROOT` | unsupported |
| copilot | `COPILOT_HOME` | unsupported |
| amp | unsupported | `--settings-file` (custom user settings; workspace/managed settings still apply) |
| mistral-vibe | `VIBE_HOME` | unsupported |
| cursor | `CURSOR_CONFIG_DIR` (config, not all data/credentials) | unsupported |
| mini-swe-agent | `MSWEA_GLOBAL_CONFIG_DIR` | `--config` (complete config replacement, not an overlay on `mini.yaml`) |
| kiro | unsupported | unsupported |
| kimi-code | `KIMI_CODE_HOME` | unsupported (native `config.toml` under the selected home) |
| qoder | `QODER_CONFIG_DIR` | unsupported |
| aider | unsupported | `--config` |
| continue-cli | unsupported | `--config` |
| omp | `PI_CODING_AGENT_DIR` (also selects `--profile default`) | `--config` |
| all others | unsupported | unsupported |

An unsupported explicit override raises `unsupported-capability`. Home/file
paths must be absolute. `executable` accepts a bare name resolved through the
child's PATH or an absolute path; relative paths with separators and empty/NUL
values reject with `invalid-options`. Workdir is normalized without changing
process-global cwd. Preparation requires an existing caller-owned workdir.

These mappings select existing upstream state, not a sandbox or an empty home.
For example, Codex stores authentication alongside configuration under
`CODEX_HOME`, and Hermes keeps `config.yaml`, `.env`, sessions and skills under
`HERMES_HOME`; pointing either at a new home does not copy authentication there.
Managed settings, upstream project discovery and upstream writes still apply.
Raw `HOME`, `XDG_*` and native env overrides remain caller-controlled; passing
an env variable does not claim the upstream supports it or separates credentials.
Harness does not rewrite a user's settings to make a model selection stick.
An omitted/empty model retains the existing adapter default contract; for Hermes,
Cline, Goose and Copilot that contract is no `--model` flag and a null reported model.

OMP preserves the requested model string, including unknown provider prefixes;
it does not apply Pi's `openai-codex/` inference. An explicit OMP `configHome`
also selects the default profile because named upstream profiles ignore the
agent-directory override. Without `configHome`, inherited profile selection
remains upstream-controlled. This selects agent state, not all global/project
discovery or a sandbox. OMP config files are additional overlays, not replacements.
See the [OMP adapter reference](ADAPTER-MATRIX.md#omp-oh-my-pi) for setup,
event semantics, native errors and qualification limits.

Cline's CLI backend selects local runtime execution, disables its detached
auto-updater and clears daemon entry through per-run environment additions.
Conflicting caller-supplied values reject, rather than changing backend silently.
Native provider and approval choices are independent of the model. `configHome`
selects existing Cline configuration; upstream writes still occur in that home.
See the [Cline adapter reference](ADAPTER-MATRIX.md#cline) for the exact env
contract, instruction attachment, event parsing, cancellation and coverage limits.

Goose preserves explicit model IDs without provider inference. `GOOSE_PROVIDER`
and extensions remain caller-configured. `GOOSE_PATH_ROOT` relocates config,
data and state directories, but system config, additional config paths and
project discovery can still apply; it is not credential isolation. Instructions
use `--system=<text>` without a projected file. See the
[Goose adapter reference](ADAPTER-MATRIX.md#goose) for official sources and
the observed macOS stdio-extension process-group escape.

Continue no longer generates YAML containing API keys. Its former explicit
OpenAI-compatible env branch requires a caller-selected `configFile`.
When using that file, omit `model`: the selected file owns model configuration,
and an explicit model is rejected rather than discarded (`--model` in current
Continue is a Hub model slug, not a native model ID). The result's model is
unknown in this case. Aider no longer writes an empty `.agentelo-aider.yml`:
upstream configuration or `configFile` applies, and textual instructions are
projected into `.harness-aider-instructions.md` and supplied through `--read`.
Its headless chat/input histories use the platform null device. Kilo preserves
caller-selected `KILO_CONFIG_CONTENT`; it generates its single-model env default
only when neither inherited nor explicit env selected that variable.

Override evidence: [Claude settings](https://code.claude.com/docs/en/settings),
[Codex configuration/state](https://developers.openai.com/codex/config-advanced/),
[Aider options](https://aider.chat/docs/config/options.html),
[Continue CLI](https://github.com/continuedev/continue/blob/main/extensions/cli/README.md),
and [Hermes installation](https://hermes-agent.nousresearch.com/docs/getting-started/installation/)
/ [CLI guide](https://hermes-agent.nousresearch.com/docs/user-guide/cli/).
Claude Code 2.1.220, Codex 0.153.4 and Hermes Agent v0.20.0 (2026.8.3) help were
inspected locally; the Hermes flags were also checked against the current
upstream [`hermes_cli/_parser.py`](https://github.com/NousResearch/hermes-agent/blob/main/hermes_cli/_parser.py).
These are configuration/flag checks, not provider execution or
credential-isolation proof.

---

## Ownership and execution

A **run** is one prompt invocation ending in a `RunResult`. `run`/`runAsync`
own the subprocess they start and collect its terminal output. `buildCommand`
only prepares argv/env/cwd; its caller owns execution, timeout and teardown.
`parseOutput` parses a caller-supplied outcome and may read upstream artifacts;
it does not acquire process ownership.

An upstream **session** is persistent conversation state, not a process ID,
working directory or latest log file. Existing `sessionLogPath` and
`parseSessionLog` helpers locate/read artifacts; they do not open, own, resume
or cancel a session. Python `session_started_after` is Unix seconds and
TypeScript `sessionStartedAfter` is Unix milliseconds, preserving their native
time conventions. Pass the same instant after converting units. Claude Code,
OpenClaude, Factory, Gemini, Qwen, Continue and the SWE wrapper honor an
inclusive file-mtime cutoff. Other adapter limitations remain documented in
the [matrix](ADAPTER-MATRIX.md#session-telemetry-coverage). A modified/resumed
old conversation can pass the cutoff; newest-file selectors are
discovery heuristics, not proof of ownership. Do not attribute concurrent runs
without an upstream session ID. File helpers read the caller process's selected
config environment, not remembered child `RunSpec` overrides.

Current execution behavior and limits:

| concern | shipped behavior |
|---|---|
| sync execution | Python `run` and both low-level `run_subprocess` / `runSubprocess` helpers block |
| async execution | Python `run_async` is a coroutine; TS `run` and `runAsync` are non-blocking Promises |
| stdin | finite `stdin` UTF-8 text, fed concurrently with output reads, then EOF; omitted/null/empty closes stdin; no interactive approval channel |
| output | stdout/stderr separate; optional `onOutput(chunk, stream)` with serialized callback backpressure |
| timeout | finite non-negative seconds, default 1800; null/None disables; zero expires immediately after launch; `exitCode=-1`, `timedOut=true`, `timeoutKind="wall"` |
| inactivity | disabled by default; positive finite seconds since the last raw byte on either output stream; expiry sets `timeoutKind="inactivity"` |
| process cleanup | fresh owned POSIX process group; one graceful signal (SIGTERM by default, SIGINT for Cline), then SIGKILL after 0.5 seconds if still present; drain/close within a further 1 second |
| cancellation | optional `cancel`: Python `threading.Event`, TS `AbortSignal`; explicit cancellation returns `termination="cancelled"`, `exitCode=-1`, `timedOut=false` |
| launch failure | `termination="launch-failed"`, `exitCode=-1`, `launchError` / `launch_error` carries the OS code |
| signal reporting | `termination="signaled"`, negative signal number as exit code and a separate signal name; SIGTERM alone is not a timeout |
| memory/decoding | per-stream raw prefix cap `maxOutputBytes`, default 1 MiB; incremental UTF-8 decoding; visible byte counts/truncation flags |
| callback failure | `callbackError` retains the exception; while the leader runs, `termination="callback-error"`, `exitCode=-1`, `timedOut=false`; same owned teardown |

`termination="exited"` covers both zero and non-zero ordinary exits. Timeout
and cancellation retain their cause even if the leader handles the graceful signal and
exits zero. `signal` records the leader's actual terminating signal, if any.
The first terminal condition observed by the runner wins. After ordinary
leader exit, cleanup stops leftover group members without changing the leader's
result; inherited pipes must not turn a completed leader into a timeout.

`BuildCommand.gracefulSignal` (`graceful_signal` in Python) tells external
drivers which first teardown signal the adapter needs. The low-level subprocess
helpers accept the same option, restricted to `SIGTERM` or `SIGINT`; omission
retains SIGTERM. Execution forwards the planned value through the shared engine.
Cline needs SIGINT: its qualified one-shot SIGTERM handler cannot reach the
active session, while SIGINT disposes that session and stops its shell tools.
This does not expand ownership beyond the process-group boundary below or
guarantee cleanup after a crash or forced kill.

### Streaming, stdin and output limits

The same controls apply to `RunSpec` and low-level subprocess options (snake_case
in Python). They are execution controls, not command flags: `buildCommand` does
not copy them into argv or change an adapter's prompt transport. External drivers
must pass their selected controls to the subprocess helper. `stdin` adds no
newline and does not replace `prompt`. A child may close stdin early; EPIPE ends
the feed without replacing its terminal outcome. Python's legacy low-level
`stdin_close=False` inherits stdin only when `stdin` is absent; combining it with
any supplied text, including empty text, is rejected.

Callbacks receive nonempty decoded chunks in per-stream order. There is no
cross-stream ordering guarantee, line boundary, JSONL frame, or normalized
agent-event schema. Multi-byte UTF-8 sequences split across reads remain intact;
invalid bytes and an incomplete sequence at actual EOF use U+FFFD replacement.
Consumers framing JSONL must retain a partial record across callbacks. The
terminal Codex/Pi parsers retain complete records preceding a partial final
record; that tail remains visible in captured stdout. A parser exception does
not erase interrupted output or change the process termination cause.

`maxOutputBytes` is a finite non-negative safe integer, applied separately to
the first raw bytes of stdout and stderr. Zero disables capture, not draining or
streaming. Capture discards further bytes while continuing to read, count and
deliver callbacks. A cap cutting a valid UTF-8 sequence omits the incomplete
codepoint rather than manufacturing replacement text. `stdoutBytes` and
`stderrBytes` count all raw bytes read, not decoded string lengths or bytes the
child attempted to write. Truncation flags mean the cap was exceeded or a pipe
was force-closed before EOF; bytes beyond that closure cannot be counted.
Flags are metadata, not markers inserted into potentially structured output.
The CLI exposes them in JSON and warns in human output.

Capture and callback decoding are independent: callbacks can receive more than
the capture cap. The library retains bounded capture plus bounded read buffers
and one outstanding callback, not an accumulating callback queue. Memory the
consumer retains, the supplied finite stdin, and adapter-owned external artifacts
are outside the output-capture budget. Parsed metrics may be incomplete when
capture is truncated; callers must check the flags before treating them as totals.

Python `run_async` invokes callbacks on the caller's event loop and awaits
awaitables; TypeScript `run`/`runAsync` await returned Promises. Reading pauses
while a callback is outstanding. Wall timeout and cancellation remain active;
inactivity excludes time spent waiting on the consumer. Only received output
bytes reset inactivity, not stdin writes or callback completion. Silence alone
is never an inactivity failure unless the watchdog was explicitly enabled.

Callbacks must be cooperative: synchronous code that blocks the caller's event
loop cannot be preempted. Python blocking `run` accepts synchronous callbacks
only; they run on its reading thread and must return promptly. An async callable
is rejected before launch; an unexpected awaitable/non-None return is a callback
error. TypeScript's low-level blocking `runSubprocess` rejects `onOutput` before
launch because its supervisor cannot serialize caller functions; use its async
counterpart. This restriction does not apply to either public TypeScript run API.

Teardown retains the existing bounded drain budget, including callback delivery.
A callback that remains pending at the deadline is abandoned and reported via
`callbackError`; no new callbacks start after delivery is disabled. Python
requests cancellation of the pending callback task; TypeScript consumes late
Promise rejection. User callback work cannot be forcibly terminated. After a
callback failure, reads continue for bounded capture without further callbacks.
The first observed terminal cause wins: a later callback failure does not replace
an already observed exit, timeout or cancellation, but `callbackError` still
reports it. Python `RunResult.ok` is false for callback or parser errors even
when the child exited zero.

Migration: output is now capped by default. Raise `maxOutputBytes` explicitly for
larger terminal JSON envelopes, or consume output incrementally with `onOutput`.
There is no implicit unbounded-capture mode. New outcome fields are optional only
for caller-constructed legacy outcomes; execution populates them in both languages.

Python `Task.cancel()` sets a private stop event and waits for the shielded
worker's cleanup before re-raising `CancelledError`, including repeated task
cancellation during startup or output collection. Explicit `cancel.set()`
instead returns a result in both Python entry points. TS callers pass
`controller.signal` and call `controller.abort()`; use `run`/`runAsync` for
in-flight event-loop cancellation. A pre-cancelled token launches nothing.
The synchronous TS helper blocks its caller's event loop, so same-thread
timers cannot deliver an abort while it runs.
To retain its synchronous return type without blocking cleanup timers,
`runSubprocess` uses a short-lived JS supervisor running the same async engine.
The supervisor exits with that invocation; it is not a daemon. It requires
an on-disk module and a Node/Bun `process.execPath` capable of loading it;
compiled single-file Bun executables are not a supported hosting mode.

The TypeScript engine uses descriptor-backed POSIX FIFOs rather than runtime
subprocess stream wrappers, so Node and Bun both enforce backpressure before
reading more output. It requires `/usr/bin/mkfifo` on the supported macOS/Linux
hosts and a writable system temporary directory. Pipe paths are created in an
owned private directory and unlinked after opening; only descriptors survive
launch, and teardown closes them. Pipe setup failure returns a launch-failed
outcome without starting the agent.

Ownership is the newly created process group, not a global PID/name search.
The direct child is reaped; descendants are stopped and reaped by their parents
or the OS reaper. Deliberately detached descendants (`setsid`/new groups),
remote/container processes, credential-changing children, and unrelated
sessions are outside that boundary. If they retain inherited pipes, Harness
closes its read endpoints at the cleanup deadline rather than waiting for EOF.
It neither adopts arbitrary descendants nor starts a persistent supervisor.
OS process creation and uninterruptible kernel waits cannot be bounded by a
user-space library; deadlines apply once the OS returns control.

Lifecycle support targets macOS and Linux; other platforms fail explicitly
before process creation rather than pretending leader-only termination is
tree cleanup. Deterministic conformance tests use synthetic processes, not
authenticated provider calls. Local qualification: macOS 26.6 arm64,
Python 3.11.15, Bun 1.3.14 and the built package under Node 26.6.0.
The `subprocess lifecycle` workflow runs full suites and a packaged Node
smoke on macOS and Linux with Python 3.10 and Node 22; its checks are the
cross-platform acceptance gate. No Windows lifecycle support is claimed.

Migration: existing ordinary exit codes, timeout sentinel, output and metric
fields remain. Lifecycle fields are additive and may be omitted on manually
constructed outcomes. Python OS launch errors now return a result; TS signal
exits now expose the negative signal number rather than an ambiguous `-1`.
TS `run()` remains Promise-returning but no longer blocks the event loop.
No permission default, upstream model/config selection, or session state is
changed by this lifecycle repair.

References: [Python subprocess](https://docs.python.org/3/library/subprocess.html)
documents `start_new_session`, signal return codes and process-creation limits;
[Node child_process](https://nodejs.org/api/child_process.html) distinguishes
`exit` from pipe `close` and documents detached POSIX groups.

The consumer owns workdir/worktree isolation, host drivers, auth selection and
approval decisions. Harness owns only the lease and artifacts described below.
No code may change process-global cwd/env, discover or copy credentials, or
install an SDK implicitly.

### Instruction preparation and restoration

**Compatibility change:** `buildCommand` is now a plan, not a “prepare workdir”
operation. External host drivers must call `prepareCommand`, retain its handle
until their process and owned children have stopped, then call `cleanupCommand`.
`run` and `runAsync` do this automatically after confirmed process teardown,
including launch failure, successful cancellation and parsing failure. If the
subprocess engine raises without confirming teardown, they propagate that error
and retain the projection, original backup and lease for manual recovery. Stop
any surviving owned process group before restoring those artifacts.
Python exposes `prepare_command` and `cleanup_command` with equivalent semantics.
No automatic cleanup occurs merely because a command was built.

Preparation takes an exclusive `.harness-run.lock` directory in the canonical
workdir. Python and TypeScript share this protocol across processes. All runs,
even those without instructions, acquire the lease so they cannot observe another
Harness run's temporary instructions. Overlapping runs in the same canonical
workdir reject with `instruction-conflict`; different workdirs can run concurrently.
An empty `.owner-<UUID>` directory identifies each lease independently of filesystem
inode reuse. Cleanup verifies this marker before modifying files.
The caller must give upstream processes separate workdirs and, when required,
separate supported config/state locations. A shared external state directory
explicitly selected by the caller is not isolated by this workdir lease.

Projection rejects absolute/traversing filenames, symlinks below the canonical
workdir (including dangling targets), nonregular targets, and hard-linked files.
An existing regular file is moved, not copied, into the owned lease directory.
Restoration preserves its bytes, inode and mode. New projected files are private
to the owner; empty content creates an empty file. Parent directories are tracked:
cleanup removes only owned empty directories, never preexisting ones or
directories containing upstream-created artifacts.

Cleanup checks the projected file's identity, content and mode, its parents,
the lease and the backup before restoring. If another actor edited, deleted,
replaced or redirected an owned artifact, cleanup raises `instruction-conflict`
and preserves current content and the backup for manual recovery. It does not
overwrite user edits, follow replacement symlinks, or steal a stale lease.
Successful cleanup is idempotent on the same handle. Legacy
`.harness-backup-*` files are unrelated content and are never consumed.

After a conflict or uncatchable process crash, stop all affected processes,
inspect the current file and backup, reconcile them manually, then remove the
empty ownership marker and stale lease. Do not blindly delete the lease or call
a new projection over it.
The lease coordinates cooperative Harness callers; it is not a security boundary
against a hostile process rewriting the filesystem between checks.

`projectInstructions` / `project_instructions` use the same ownership protocol
for explicit external projections. `replace` writes content plus a newline;
`prepend` inserts content plus a blank separator before the original UTF-8 text.
Optional `replaceBetweenMarkers: {start, end}` / `replace_between_markers=(start, end)`
replaces the first well-ordered literal marker block, including both delimiters,
with the content; otherwise the selected mode applies.
Invalid modes/markers and `backup: false` reject before writes. A handle is
process-local ownership, not a serializable cleanup recipe.

`writeInstructions` / `write_instructions` now exclusively create a persistent
caller-owned file. Existing files and unsafe symlinks reject instead of being
truncated; null/None skips creation, while empty content is valid. Use projection
or preparation for temporary files that need restoration.

## Optional pane and telemetry helpers

`getAdapter` exposes optional `submitKeys`, `flattenOnPaste`, `scrollOwnership`,
`getCurrentScrollKeys`, `detectReady`, `detectStatus`, `handleDialog`,
`sessionLogPath`, `parseSessionLog` and `installMeta` (snake_case in Python).
These remain optional so a minimal third-party headless adapter need not pretend
to implement live behavior. Check for a callable/non-null helper before use.
Unsupported metadata is absent/`None`; it is not a fabricated ready state.
Installation metadata only describes argv; Harness never runs it on import.

`detectReady` returns `loading | dialog | ready`; `detectStatus` returns
`running | idle | error | rate-limited | unknown | exited | dialog`.
Pane matching is heuristic over caller-captured text, not authoritative
protocol state. `handleDialog` returns suggested keystrokes or null; some
suggestions approve permissions/trust. It never sends them. The caller must
apply its permission policy rather than automatically sending every suggestion.

`SessionTelemetry` contains `sessionLogPath`, `tokensIn`, `tokensOut`, `costUsd`,
`model` and `raw`. Preserve these and the flat `RunResult` fields; do not add
a redundant nested telemetry copy merely for symmetry. `RunResult.model`
is the requested/default model, not proof of which model executed; normalization
occurs in argv. An omitted or empty model selects the adapter default in both
languages; whitespace is trimmed after default selection. Hermes has no library
default: an omitted or empty model adds no `--model` flag and reports null.
Explicit `modelNoResolve` skips rewriting, not trimming.

Null means unknown/unavailable, not zero. Zero is a legitimate reported value.
Cost may be reported or estimated according to the adapter matrix; it is not
necessarily the amount billed. CLI versus SDK, or headless versus interactive,
does not identify a subscription/billing tier. Cache tokens and pricing need
upstream-specific semantics; never apply historical multipliers universally.
Raw payloads retain upstream details but are untrusted and may contain prompts,
paths or secrets. No telemetry is transmitted by Harness. Upstream tools may
have their own telemetry settings, which remain caller-controlled.

OpenCode, Kilo and Crush correlate database metrics only with an observed native
run ID. Their `raw` contains `sessionID` and `costSource` (`reported` or
`unavailable`); missing/conflicting identity gives null metrics/raw. A missing
artifact retains an observed ID with unavailable metrics. Reported zero stays
zero; these adapters do not estimate cost. “Reported” names the upstream field,
which may itself be estimated/defaulted and is not proof of billed USD.
OpenCode/Kilo sum complete assistant metrics; Crush exposes native last-step
token counters, not cumulative run totals. Cache semantics remain
[adapter-specific](ADAPTER-MATRIX.md#opencode).

These database adapters cannot discover ownership from `sessionLogPath(workdir,
since)` and return null there. `parseSessionLog` accepts only
`<database-path>#session=<percent-encoded-native-ID>`; legacy basename selectors
and bare paths return unavailable metrics. Exact-ID telemetry lookup neither
opens nor resumes a controlled session and does not change its owner lifecycle.

## Controlled RPC sessions

`open_session(SessionSpec(...))` / `openSession(spec)` opens an owned native
Pi JSONL subprocess on macOS/Linux. This is separate from one-shot `run` and
from consumer-owned tmux/PTY sessions. Both package roots export the same
session types and operations, with snake_case in Python and camelCase in TS.

The qualified protocol is **Pi 0.85.1**, distributed as
`@earendil-works/pi-coding-agent` (`pi`, Node >=22.19). Install/select it
explicitly; Harness does not install, change provider accounts, or fall back to
another binary/backend. Older Pi protocols and OMP RPC are not interchangeable:
OMP has different framing, acknowledgement and local-command completion rules.
Other pairings reject with `unsupported-backend`, except the separately
documented OMP/Amp/Claude SDK and caller-owned OpenCode/OpenHands sessions below. Unknown
names still produce `unknown-harness`.

### Session inputs and capabilities

`SessionSpec` requires `harness`, `workdir` and explicit `backend: "rpc"`.
Optional fields:

| TypeScript field | semantics |
|---|---|
| `model` | trimmed native model selector; omission preserves upstream model/config choice, without one-shot model normalization |
| `executable` | bare name or absolute path, default `pi`; no shell expansion |
| `env` | caller-selected environment overlay; parent environment is inherited |
| `permissionPolicy` | default `upstream`; `bypass` is explicitly unsupported |
| `instructions` | existing owned `AGENTS.md` preparation; lease lasts until disposal |
| `resume` | explicit `SessionReference`, never latest or a partial ID |
| `timeoutSeconds` | per-turn wall deadline, default 1800; null disables it |
| `requestTimeoutSeconds` | positive finite startup/command deadline, default 30 |
| `maxBufferBytes` | nonnegative byte bound per pending event stream and stderr prefix; default 1048576 |

`get_session_capabilities("pi")` / `getSessionCapabilities("pi")` reports
`backend: "rpc"`, `events`, `interrupt`, `followUp`, `resume` true;
`concurrentTurns` and `approval` false. It performs no local availability/auth
probe. Existing `getCapabilities` describes one-shot execution and retains
its CLI behavior. There is no generic raw-command, steering, queued follow-up
or arbitrary native-options channel. Pi's `respondApproval` /
`respond_approval` rejects with `unsupported-capability`.

### Identity, turns and events

`LiveSession.reference` is a native `SessionReference`:
`sessionId`, `sessionFile` (absolute path or null), `workdir` (absolute).
Native persistence may be lazy: a reported path is not proof the file exists.
Resume requires an existing session file whose header identifies the exact
requested native ID and workdir. The requested spawn workdir must identify that
same directory; startup verifies the native state response again.
The library never chooses the newest session, silently forks, or deletes
upstream history. A missing/unusable reference is an error, not a fresh session.

`session.startTurn(prompt)` synchronously reserves the active slot and returns
a `SessionTurn`: unique string `id`, `events` async iterable, and `result`
Promise (Python awaitable). Consume events while awaiting the result. The next
`startTurn` after completion is a follow-up in the same native session.
Concurrent turns are rejected with `unsupported-capability`, including while
an interrupt acknowledgement is pending.

Every `SessionEvent` carries `backend: "rpc"`, `harness: "pi"`, `sessionId`,
`turnId` (null outside a turn), `requestId` (native ID or null), native `type`,
and the complete JSON object in `raw`. `session.events` exposes idle/session
events; `turn.events` exposes events and responses associated with the active
turn. Both are single-consumer streams. Unknown event types stay visible.
Native events have no common upstream turn ID; serial turn ownership provides
the local correlation while retaining native request IDs verbatim.
Stopping iteration does not discard queued events or disable the byte bound.
Continue draining the acquired iterator or close the session; an unconsumed
stream still fails loudly on overflow.

Responses correlate by ID and command, not arrival order. A prompt response is
only acknowledgement. Completion requires the valid prompt response plus
`agent_settled`; intermediate `agent_end` events may be followed by retries or
compaction. Native error responses settle rejected prompts without waiting
for a completion event. Pi extension commands or input hooks can handle a
prompt locally without an `agent_settled` event; this model-turn API does not
fabricate their completion. Such operations can reach the configured deadline.
Use the native extension API when local-command completion is required.

### Results, interruption and disposal

Each locally accepted turn has exactly one `SessionTurnResult`, including
transport failure. Fields: `sessionId`, `turnId`, `status`, `raw`, `error`,
`exitCode`, `signal`, `stderr`, `stderrBytes`, `stderrTruncated`,
`eventsTruncated`. Unknown fields use null, not fabricated zero/empty usage.

Statuses distinguish `completed`, `agent-error`, `interrupted`,
`protocol-error`, `disconnected`, `timed-out`, `closed`, `exited`, `signaled`.
`raw` retains the last `agent_end` payload or native rejection. Assistant
`stopReason: "error"` / `"aborted"` distinguishes native failure/interruption
from successful settlement; an earlier retry error does not override the final
successful run. `exitCode` and `signal` retain observed process termination.
Usage stays in native payloads: streaming usage is cumulative, `message_end`
is authoritative, and repeated snapshots must not be summed. No billing tier,
common pricing estimate, or fabricated usage total is added.

`await session.interrupt()` sends native `abort`, waits for its acknowledgement
and turn settlement, and preserves the session for follow-up. An ordinary
completion racing interruption is not relabelled interrupted. Interrupting an
idle session is unsupported. Request timeout or transport failure invalidates
the handle and starts bounded owned teardown.

`await session.close()` is idempotent and safe for concurrent callers. It
settles an active turn as `closed`, closes stdin, terminates the owned process
group (500 ms TERM grace, then KILL and bounded 1000 ms reap/pipe drain), and
restores still-owned instructions. Descendants are stopped even when the
leader already exited. Cleanup failure raises rather than implying disposal
succeeded. Python task cancellation performs shielded cleanup before propagating
`CancelledError`. Operations after disposal raise `session-closed`.

### Framing, bounds and qualification

Stdin stays open between JSONL commands; close supplies EOF. Stdout accepts
strict UTF-8 JSON objects delimited by LF only (CRLF allowed). Unicode line
separators inside strings are not delimiters. Invalid/missing-type/nonobject
frames, oversized frames (1 MiB), partial final frames, invalid correlation and
duplicate responses fail explicitly as `protocol-error`; they are not skipped.
Stderr is a separate bounded prefix with byte count and visible truncation.

Each event stream is byte-bounded. A stalled consumer cannot cause unlimited
buffering: overflow fails the session and sets `eventsTruncated`, retaining
already queued events. This deliberate fail-fast policy keeps command deadlines
and disposal responsive rather than blocking the protocol reader behind event
delivery. There is no callback API or inactivity watchdog; silence alone is
not failure before a configured deadline.

`tests/session_cases.json` and the synthetic `tests/helpers/rpc_agent.py` peer
exercise the same outcomes in Python, Bun and packaged Node. These are offline
protocol/conformance tests, not provider-success evidence. Native Pi 0.85.1
startup, ID/state, out-of-order abort response and missing-auth prompt rejection
were separately exercised on macOS/Node 26.6.0. Both language APIs also drove
the real Pi runtime against a **local synthetic SSE provider**, verifying native
streaming, successful settlement, follow-up, interruption and persisted native
session resume. That is native-runtime qualification, not an LLM/provider smoke.
The selected `openai-codex` provider reported credentials not configured;
real-provider successful generation/interruption remains unverified.
No credentials or private conversations are included in fixtures.

Sources refreshed September 8:
[Pi RPC](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md),
[Pi session implementation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/agent-session.ts),
[OMP RPC differences](https://github.com/can1357/oh-my-pi/blob/main/docs/rpc.md).

## Optional OMP SDK sessions

`open_session` / `openSession` also accept `harness: "omp", backend: "sdk"`.
They retain the session types, serial turns, event queues, native references,
deadlines, instruction lease, interruption and owned disposal described above.
The one-shot `RunSpec` API remains CLI-only; there is no automatic fallback.

### Explicit dependencies and host-local configuration

The qualified SDK is **`@oh-my-pi/pi-coding-agent` 18.1.14**, with **Bun
>=1.3.14**. Other package names/versions reject at startup (`launch-failed`).
Install the SDK separately in a caller-owned project. Harness does not install
it, declare it as a mandatory dependency, or load it during ordinary imports,
CLI execution or capability queries.

Both languages use the **same shipped Bun bridge worker**, hosting one native
`createAgentSession` per owned process. This is a supported Python and Node
bridge, not a native Python SDK or in-process embedding into the caller's
TypeScript runtime. OMP imports mutate process-global environment/discovery
state and register CLI-oriented signal handlers; process isolation prevents
these from changing the caller's OMP settings, environment, cwd or listeners.
The worker owns its own termination handlers and calls native SDK disposal.

`SessionSpec.omp_sdk` / `ompSdk` is required only for OMP SDK and rejected for other backends.
The exported `OmpSdkOptions` has three required fields:

| TypeScript / Python | meaning |
|---|---|
| `packageRoot` / `package_root` | absolute directory of the installed SDK package, containing its `package.json` |
| `agentDir` / `agent_dir` | absolute caller-selected OMP profile/state directory |
| `auth` | `"local"` opens `<agentDir>/agent.db`; `"environment"` uses an in-memory credential database |

`executable` selects Bun (bare name or absolute path), default `bun`.
`model` is the native model pattern, trimmed but otherwise unchanged; omission
retains native model/config/resume selection. Native fallback notices remain
visible as `harness_model_fallback` events. Both auth modes preserve upstream
environment, dotenv and `models.yml` key resolution. `"environment"` means
no persisted credential database is opened for authentication, not an
environment whitelist or a promise of no upstream state writes. `"local"`
permits native credential-store schema/cache writes and OAuth refresh in the
selected database; Harness neither copies credentials nor discovers a broker.

The worker pins OMP's default profile resolver and both agent/config roots to
`agentDir` before importing the SDK. It translates the config root into OMP's
HOME-relative `PI_CONFIG_DIR` format. Conflicting explicit
`PI_CODING_AGENT_DIR`, `PI_CONFIG_DIR`, `OMP_PROFILE` or `PI_PROFILE` entries
reject before preparation. Inherited named profiles cannot redirect this
selection. Other environment entries are inherited and overlaid as usual.
`Settings.loadReadOnly` avoids settings migration/persistence; native model
configuration, caches, session files and tools can still perform upstream
writes in their selected locations. This is not a filesystem sandbox.

`--no-env-file` disables **Bun's** automatic dotenv loading, not OMP's own
profile/project/HOME dotenv loading. Native project discovery, configured
extensions, tools, MCP and permission defaults remain upstream behavior.
Choose a trusted profile/workdir and set child `HOME` explicitly when isolation
from ambient home configuration is required. No approval-response channel or
permission bypass is exposed; unsupported common operations reject rather than
being simulated. Custom SDK objects, steering, queued follow-up, forks and
arbitrary native method calls have no Harness mapping.

### SDK events, settlement and resume

`get_session_capabilities("omp", "sdk")` /
`getSessionCapabilities("omp", "sdk")` reports `backend: "sdk"`, with events,
interrupt, follow-up and resume true; concurrent turns and approval false.
It reports implemented behavior, not installed dependencies or authentication.

SDK subscriptions feed the same bounded async event streams. Events carry
`backend: "sdk", harness: "omp"` and retain the complete native event in `raw`;
transport wrappers are not exposed. Request responses carry bridge request
IDs, not invented upstream request IDs. Native `agent_end` snapshots remain
available, including `isTerminal: false`, unknown events and usage fields.
Do not sum repeated cumulative usage snapshots.

Completion waits for the native `prompt()` promise, `waitForIdle()` and pending
owner-scoped async work, never an intermediate `agent_end` or Pi's
`agent_settled`. SDK-local commands can finish without a model event.
Thrown prompt errors produce `agent-error` with an explicitly identified
`sdk_settled` bridge error in `raw`; assistant errors/aborts retain native
`agent_end`. Native abort acknowledgement and turn settlement must both finish
before follow-up. An interrupt that cannot settle reaches the configured
request deadline and owned teardown rather than pretending to have stopped.

Native session files/IDs are preserved. Resume validates the exact ID/workdir
before startup and again after opening the SDK manager. OMP's optional leading
title record is accepted only for this backend; it does not weaken Pi framing.
Close unsubscribes, calls `beginDispose`/`dispose`, closes the owned auth store,
and retains persisted history. The existing 500 ms TERM / KILL / 1000 ms drain
bound applies. Failed or forced SDK disposal raises `adapter-error` after owned
cleanup instead of claiming native disposal succeeded.

Shared `tests/omp_sdk_cases.json` and a synthetic SDK package exercise the
actual bridge in Python, Bun and packaged Node without provider dependencies.
Native 18.1.14/Bun 1.3.14 qualification uses isolated homes and a local
synthetic SSE provider, separate from credentialed provider success. No real
provider success or cross-version SDK compatibility is claimed.

Sources refreshed September 8:
[SDK guide](https://github.com/can1357/oh-my-pi/blob/main/docs/sdk.md),
[18.1.14 package metadata](https://www.npmjs.com/package/@oh-my-pi/pi-coding-agent/v/18.1.14),
[native environment](https://github.com/can1357/oh-my-pi/blob/v18.1.14/packages/utils/src/env.ts),
[SDK session lifecycle](https://github.com/can1357/oh-my-pi/blob/v18.1.14/packages/coding-agent/src/session/agent-session.ts).

## Optional Claude Agent SDK sessions

Select `harness: "claude-code", backend: "sdk"` through `open_session` /
`openSession`, not a new adapter or one-shot `RunSpec`. The existing serial
turns, bounded events, deadlines, instruction lease and owned process lifecycle
apply. No SDK, binary, backend or model fallback is added.

### Pinned native dependencies

| Host | SDK package | Native Claude Code |
|---|---|---|
| Python >=3.10 | `claude-agent-sdk==0.2.152` | **2.1.259** |
| TypeScript, Node or Bun | `@anthropic-ai/claude-agent-sdk@0.3.263` | **2.1.263** |

These exact pairs are required at startup; the two SDK releases bundle different
CLI versions. Missing packages, wrong versions or an unusable executable fail
with `launch-failed`, never installation or discovery. Python offers the
optional `harness-cli[claude-sdk]` extra; TypeScript callers install the SDK
separately. Ordinary imports, CLI calls and capability queries do not import it.

Each implementation hosts its **own language's SDK in an owned worker**.
Python retains `ClaudeSDKClient` for native control routing and permissions.
Its implementation of the exported `Transport` interface reproduces the pinned
SDK's private `SubprocessCLITransport` argv/environment and depends on the native
internal JSONL/control protocol. It does not import private SDK modules.
Strict raw retention runs before the lossy SDK dataclass parser; interrupt
control receipts are captured before the SDK discards their return value.
This internal protocol dependency is intentional, not a cross-version guarantee.
The SDK also labels its exported `Transport` interface internal and changeable
in any release; the exact pin is required for both interface and wire behavior.
TypeScript uses `query` with streaming input and its supported
`spawnClaudeCodeProcess` hook to retain and validate raw native messages before
SDK iteration. Deprecated/removed V2 session-preview APIs are not used.

### Explicit configuration and permissions

`SessionSpec.claude_sdk` / `claudeSdk` is required for this pairing and rejected
elsewhere. Both roots export `ClaudeSdkOptions` and `ClaudeSettingSource`:

| TypeScript / Python | meaning |
|---|---|
| `packageRoot` / `package_root` | required absolute SDK package directory: Python's `site-packages/claude_agent_sdk`, or TypeScript's `node_modules/@anthropic-ai/claude-agent-sdk` |
| `cliPath` / `cli_path` | required absolute executable for the pinned native CLI; independent of the worker runtime |
| `configDir` / `config_dir` | required absolute `CLAUDE_CONFIG_DIR` selection |
| `settingSources` / `setting_sources` | required sequence of `user`, `project`, `local`; empty is allowed, duplicates are invalid |
| `settingsFile` / `settings_file` | optional absolute native JSON settings file (`--settings`) |

`executable` selects the worker runtime: default `sys.executable` in Python,
`process.execPath` in TypeScript. The Python interpreter must contain the SDK's
dependencies; selecting another package root does not install them. Bun named
`bun` receives `--no-env-file`; Node does not. `model` is trimmed but otherwise
passed unchanged; omission delegates to native configuration.

The inherited environment plus explicit `env` overlay is preserved, with
`CLAUDE_CONFIG_DIR` pinned to `configDir`. A conflicting explicit entry rejects.
`settingSources: []` disables those filesystem settings sources, **not** managed
policy, credential/environment resolution, global configuration or auto-memory.
The settings file and native settings precedence remain upstream behavior.
Use trusted directories and explicitly select child `HOME` when needed;
these options are not an authentication sandbox or promise of zero native writes.
`instructions` uses the owned `CLAUDE.md` projection and requires `project` in
`settingSources`; otherwise it rejects before preparation rather than being ignored.

Capabilities report events, interruption, follow-up, resume and approval true;
concurrent turns false. `permissionPolicy: "bypass"` is unsupported. Native
permission defaults and existing allow/deny rules remain authoritative: the SDK
callback is not invoked for every tool. An interactive native permission request
becomes `claude_permission`, retaining tool name, input, tool-use ID and
serializable native callback context in `raw`. Its `requestId` is explicitly a
**bridge-local approval ID**, not an invented native control request ID.
Reply with `respond_approval` / `respondApproval(id, "once" | "reject")`.
`once` allows only the original input; `reject` denies it. No persistent rules,
rewritten tool input or `"always"` approval are exposed. Unknown, duplicate and
cancelled IDs reject; native cancellation emits `claude_permission_cancelled`.

### Native identity, result and disposal

Fresh open selects an explicit UUID through the native session-ID option.
The returned ID is **selected**, not evidence a native session event has already
been observed. No bootstrap prompt is sent. `sessionFile` stays null until a
native identity hook supplies an absolute transcript path. The `Stop` hook
supplies this in both languages; Python does not support `SessionStart`.
Hook inputs remain visible as `claude_session_hook`. Reported IDs and hook cwd
must match the selected reference; identity changes fail, never silently fork.

Resume requires the exact UUID, existing absolute transcript file and matching
workdir. A bounded scan of native Claude JSONL identity/cwd records validates the
reference; it is not a Pi session header. The **absolute transcript path** is
passed to native resume, and subsequent hooks must confirm that same path.
No newest-file lookup, encoded-directory heuristic or partial-ID resolution is used.

Every ordinary native message, including unknown types, unknown content blocks
and unknown assistant/result fields, remains intact in `SessionEvent.raw`.
Valid lines preceding malformed output remain observable. Native control frames
stay with the SDK; bridge command responses use bridge IDs. Partial native
messages are enabled. Result settlement requires prompt acknowledgement plus
exactly one native `result` with the selected session ID. `raw` is that complete
result, not a projection through SDK message dataclasses.
`terminal_reason` of `aborted_streaming` / `aborted_tools` means `interrupted`
even when `is_error` is true. Otherwise `is_error` or a non-`success` subtype
means `agent-error`; errors and successful native results remain distinguishable.
Missing/duplicate results and malformed/oversized/partial JSONL fail explicitly.

`interrupt()` requires the native `interrupt_receipt_v1` receipt and settlement.
`claude_interrupt.raw.receipt` preserves `still_queued`; an absent or refused
receipt fails explicitly rather than fabricating an acknowledgement. A completed
result racing an interrupt stays `completed`. Follow-up retains the same session.
`total_cost_usd` and cumulative `modelUsage` are native **estimates/snapshots**:
do not sum repeated results or label them billed cost. Harness adds no totals.

Close, timeout and cancellation dispose the SDK and the owned worker/native
process group within the existing 500 ms TERM / KILL / 1000 ms drain bounds.
Pending approvals are released and still-owned instructions restored; history
is retained. Native exit/disconnect diagnostics live in an explicit
`sdk_failure` bridge frame in result `raw`; common `exitCode` / `signal` describe
the owned worker, not a fabricated native child exit. Disposal failures raise.

No raw SDK method/options escape hatch, custom tools/MCP objects, arbitrary
hooks, fork/clear, concurrent or queued turns, steering, session discovery or
permission-mode widening is exposed. Native features that change session identity
are unsupported; use the native SDK directly when these operations are required.

### Qualification

`tests/claude_sdk_cases.json` and a finite synthetic CLI exercise the **real
optional SDKs** in Python, Bun and packaged Node. This checks raw retention,
identity/follow-up/resume, native errors, partial/framing failures, interruption
receipts and races, permission allow/reject, deadlines and disposal without a
provider. Dependency installation is separate; tests never invoke a bundled CLI.

Actual SDK/CLI qualification uses isolated temporary home/config/workdirs and a
local synthetic Anthropic SSE provider. This is native-runtime evidence, not
authenticated model generation. Successful authenticated-provider generation is
not claimed; no credentials or private conversations appear in fixtures.

Sources refreshed September 9:
[Python reference](https://platform.claude.com/docs/en/agent-sdk/python),
[TypeScript reference](https://platform.claude.com/docs/en/agent-sdk/typescript),
[native settings and hook compatibility](https://code.claude.com/docs/en/agent-sdk/claude-code-features),
[Python SDK source](https://github.com/anthropics/claude-agent-sdk-python).

## Optional Amp SDK sessions

`open_session` / `openSession` accept `harness: "amp", backend: "sdk"`.
Both languages use the same isolated **Node >=22** worker and the official
TypeScript SDK. Python is an explicit bridge, not the native `amp-sdk` Python
package: the latter filters unknown events and usage fields and can discard a
nonzero native exit after a result. Bun callers also launch Node for this worker.
The one-shot API remains CLI-only. No dependency, executable or backend fallback
occurs; ordinary imports and capability queries do not load the optional SDK.

### Pinned dependencies and native configuration

The supported pair is **`@ampcode/sdk@0.1.0-20260823161614-g3631dc6`** and
**Amp Neo CLI `0.0.1788883237-g0b98e3`**. Different package names, versions,
CLI versions or worker runtimes fail explicitly at startup. Install both
separately in caller-owned locations; Harness never installs or upgrades them.
The SDK's package metadata says `releaseTag: legacy`, but its CLI dependency
is the floating `latest` selector rather than a numeric compatibility floor.
Neither that tag nor the SDK's version check qualifies an arbitrary local CLI.

`SessionSpec.amp_sdk` / `ampSdk` is required only for this pairing.
The exported `AmpSdkOptions` contains:

| TypeScript / Python | requirement and meaning |
|---|---|
| `packageRoot` / `package_root` | required absolute SDK package directory containing `package.json` |
| `cliPath` / `cli_path` | required absolute path to the pinned CLI |
| `executor` | required literal `"local"`; remote executors/orbs/projects are unsupported |
| `mode` | required nonblank native mode, e.g. `"low"`; explicit selection avoids the SDK's silent `"medium"` default |
| `effort` | optional `"none"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"` or `"max"`; native mode support remains upstream |
| `visibility` | optional `"private"`, `"unlisted"`, `"workspace"` or `"group"` for creation only; rejected on resume |
| `settingsFile` / `settings_file` | optional absolute caller-selected settings file |

`SessionSpec.executable` selects **Node**, default `node`, not the Amp CLI.
Common `model`, permission bypass, other backend option bags and unknown Amp
fields reject before preparation. There is no invented model-to-mode mapping,
approval-response channel, arbitrary SDK-object injection or raw CLI argument
channel. Native plugins, tools, permissions, settings and authentication remain
upstream behavior; this is not a sandbox.

`AMP_URL` uses the explicit environment overlay, then inherited environment,
then `https://ampcode.com`; it must identify an HTTP(S) origin without
credentials, path, query or fragment. The normalized origin becomes part of
the reference. The selected CLI and optional settings file override the
worker's `AMP_CLI_PATH` and `AMP_SETTINGS_FILE`; other environment/configuration
is inherited as usual. `AMP_SKIP_UPDATE_CHECK=1` is forced; an explicit
conflicting value rejects. Native state/tool writes are still possible.
Use trusted configuration and explicit disposable child HOME/XDG directories
when ambient settings must not be read.

The SDK prefers a local `@ampcode/cli` dependency over `AMP_CLI_PATH`.
The worker rejects a conflicting installed CLI instead of silently redirecting
it. Only inside its isolated process, it guards the SDK's spawn call, verifies
the selected executable, and adds the pinned SDK's omitted `--executor local`
flag. The SDK still owns `threads.new`, `threads.markdown` and `execute`; this
is not a substitute direct-CLI transport. Local selects **tool execution**:
Neo still uses the selected Amp service for its thread actor and authentication.

### Identity, events and owned lifecycle

Capabilities report events, interrupt, follow-up and resume true; concurrent
turns and approval false. They do not probe installation or authentication.
A reference contains the complete native `T-UUID`, `sessionFile: null`,
workdir and normalized endpoint. Creation retains the native ID returned by
`threads.new`; resume verifies that exact ID through `threads.markdown`.
Workdir and endpoint must match. No latest-thread selection, partial ID,
local-file discovery, silent new thread, fork or remote-history deletion occurs.

Each open/resume or turn is one finite SDK-worker process group, supervised by
the shared subprocess engine. The public session retains its instruction lease
across operations. Turns call `execute` with a finite string prompt, explicit
thread ID, mode and local executor. A native `system/init` must verify the
thread/workdir within the request deadline. Follow-up uses the same exact
thread, not a long-lived SDK input iterator or a guessed `end_turn` boundary.

Events carry `backend: "sdk", harness: "amp"` and preserve each complete
native JSON object in `raw`, including unknown types, permission errors, null
usage and provider-specific usage fields. Transport envelopes are not events.
No common token/cost totals are invented. Completion requires a valid native
terminal `result`, SDK iterator completion, native process exit and owned group
cleanup. The result remains in `SessionTurnResult.raw`; `is_error` gives
`agent-error`, while a later nonzero native exit remains `exited` with the
native exit code. Partial assistant output is not success.

Malformed/invalid-UTF-8 JSONL, partial final frames, duplicate results and
identity changes fail with `protocol-error`. Each native frame and worker
envelope is bounded to 1 MiB; pending event streams and retained stderr use
`maxBufferBytes`. Native stderr is drained concurrently with stdout; only a
bounded prefix is replayed to the SDK's error parser.

Interrupt cancels and reaps the **current operation**, not the native thread.
The next turn may continue that exact thread after cleanup. A terminal
completion already observed before the interrupt wins the race. Close,
timeout, protocol failure and event overflow invalidate the public handle and
perform shared bounded TERM/KILL/drain cleanup before releasing its lease.
Close does not claim the SDK has a reusable in-process abort or erase native
history. Native failures before init remain failures without a fabricated
successful handshake.

### Qualification boundary

`tests/amp_sdk_cases.json` drives synthetic SDK/native-child cases in Python,
Bun and packaged Node. Separate qualification uses the unmodified pinned npm
SDK with a synthetic CLI: native event/usage preservation, exact continuation,
nonzero exit after result and strict framing are distinct from provider success.
The pinned Neo executable recognizes the local executor and reports its native
thread-actor connection failure and a finite loopback peer's HTTP 401 rejection
through the real SDK without fallback. Unauthenticated creation can wait until
the request deadline. No authenticated provider success, native successful model
turn or offline native-thread creation is claimed: no real `AMP_API_KEY` was
available. The loopback probe used a synthetic key and disposable HOME/XDG
directories. No real credentials or transcripts are included in fixtures.

Sources refreshed September 9:
[SDK overview](https://ampcode.com/docs/sdk),
[pinned SDK package](https://www.npmjs.com/package/@ampcode/sdk/v/0.1.0-20260823161614-g3631dc6),
[pinned CLI package](https://www.npmjs.com/package/@ampcode/cli/v/0.0.1788883237-g0b98e3).

## Caller-owned OpenCode HTTP sessions

`open_session` / `openSession` accept `harness: "opencode", backend: "rpc"`.
Here RPC means direct documented HTTP routes with an SSE event subscription,
not the OpenCode CLI, TUI automation, an owned server, or a Python SDK.
One-shot `run` remains CLI-only. There is no dependency/backend fallback.

### Explicit endpoint, authentication and remote identity

The source-qualified release is **OpenCode 1.18.29**, tag commit
`16747470f976aca3d362ad730bcd3fe82ecc2c9a`. Startup requires authenticated
`GET /global/health` to return `healthy: true, version: "1.18.29"`.
Other versions, including source builds reporting `"local"`, reject with
`unsupported-backend`. The pinned OpenAPI document is 3.1.0 with a constant
`info.version: "1.0.0"`; that field is not a release-compatibility guarantee.

`SessionSpec.opencode` is required for this pairing and rejected elsewhere.
Both roots export `OpenCodeOptions`, `OpenCodeAuth` (`"none" | "basic"`) and
`OpenCodeApprovalResponse` (`"once" | "reject"`):

| field | semantics |
|---|---|
| `endpoint` | required HTTP(S) origin; optional trailing slash; no embedded credentials, path prefix, query, fragment or discovery |
| `auth` | required `"none"` or `"basic"`; never inferred from environment or local auth stores |
| `username`, `password` | required nonempty strings for `"basic"`, forbidden with `"none"`; username cannot contain a colon; control characters reject |

Basic credentials travel only in `Authorization`, never a URL. Redirects are
not followed. The caller must trust the selected endpoint; HTTP provides no
transport encryption. `"none"` explicitly selects an unsecured endpoint, not
an authentication fallback. Successful Basic requests do not prove the server
requires authentication: upstream disables its check when no password is set.
No `workspace` routing query is sent; upstream could otherwise proxy the
request and its credentials to a different server.

Python requires the optional `harness-cli[opencode]` extra (`httpx` 0.28.x),
loaded only when this backend opens. Missing `httpx` fails explicitly, without
launching a CLI. Its client disables ambient proxy/netrc configuration.
TypeScript uses the runtime's standard `fetch` API under Bun and packaged Node, without
an OpenCode SDK dependency. Ordinary imports and capability queries do not
connect to an endpoint or initialize upstream settings.

`workdir` is a literal absolute POSIX **server-side** directory. Relative paths,
dot segments and noncanonical separators reject; Harness does not resolve
remote paths against its own cwd or filesystem. `GET /path?directory=...`
must echo the selected directory. If the server resolves a symlink differently,
opening fails with the returned canonical directory in the diagnostic; the
caller must explicitly select that spelling. The created/resumed session's
`directory` must also match: upstream session routes use the stored directory
even when a different query was supplied.

An OpenCode `SessionReference` contains the full native `sessionId`, null
`sessionFile`, canonical `workdir`, and normalized `endpoint`. Python adds an
optional `endpoint=None` field; TS adds optional `endpoint`. Pi/OMP references
do not use it and reject endpoint-bearing resume references. OpenCode resume
requires exact endpoint/workdir association and null `sessionFile`, verifies
`GET /session/{id}`, and never creates a replacement when that lookup fails.
No local session file, sqlite discovery, newest-session selection or history
deletion is involved.

Nonempty `env`, any `executable`, `instructions`, `ompSdk` / `omp_sdk`, and
permission bypass are unsupported for this backend. No local instruction
lease or projection is acquired. Optional `model` is a trimmed native
`provider/model` selector; omission leaves the server's selection unchanged.
No server config/provider/auth mutation, installation or server startup occurs.

### Turns, correlation and bounded events

The common serial `startTurn` / `start_turn`, events, result, interrupt and
close operations remain. `getSessionCapabilities("opencode", "rpc")` reports
events, interrupt, follow-up, resume and approval true; concurrent turns false.
The caller must have exclusive write access to the selected native session.
Upstream supplies no atomic cross-client lease; an idle status check is not a
lock and an externally busy session is not silently joined.

Opening subscribes to scoped `GET /event` and awaits `server.connected`, which
the pinned server sends after registering its listener. A turn supplies a
fresh `msg_...` ID to `POST /session/{id}/message`, with text parts and optional
model. The synchronous route waits for the native run loop. The asynchronous
`/prompt_async` route is not used: its 204 is only acceptance, not persistence
or completion.

Completion requires **both** the correlated synchronous HTTP response and an
SSE `session.status` idle observed after this turn's user-message echo.
Assistant `info.parentID` must equal the submitted message ID, and its
`sessionID` must match. Busy/retry statuses, intermediate assistant/tool steps,
an old idle event and an HTTP acknowledgement cannot settle the turn. Native
`MessageAbortedError` means interrupted; other native assistant errors mean
agent-error. Success requires completed assistant metadata and a nonempty
`finish` other than `"tool-calls"` or `"unknown"`.

This is deliberately strict correlation, not inferred ancestry. OpenCode's
automatic context-overflow compaction, replay/continue prompts, or subtask
paths can create another user message internally and return an assistant
parented to it. Such a result is **unsupported** and fails with a correlation
`protocol-error`, retaining its native payload. The same mismatch can arise
from an external writer; Harness does not invent lineage or report success.
Automatic compaction is therefore not qualified for long-context sessions.

Events retain the complete native `{id?, type, properties}` payload and stream
order, with `backend: "rpc", harness: "opencode"`. Native message/permission
IDs provide `requestId` where available. Known current-turn messages feed the
turn stream; historical/unassociated message updates feed `session.events`
with null `turnId`. Explicitly foreign-session events are filtered. Unknown
selected-session event types stay visible. Server connection/heartbeat events
are idle events; `server.instance.disposed` is visible before disconnect.
The caller must drain both bounded streams when retaining a long-lived handle.

SSE accepts UTF-8, LF/CRLF framing, comments and multiline `data:` fields.
Frames/partial input and HTTP JSON bodies are bounded to 1 MiB; identity and
permission tracking are bounded too. Invalid UTF-8/JSON, invalid shapes,
oversized frames/bodies and a partial final SSE frame fail as protocol-error.
Clean EOF is disconnected. Queue overflow retains prior events and exposes
`eventsTruncated`; no transparent reconnect, replay or silent loss occurs.
Upstream emits no SSE replay cursor. Resume opens a fresh subscription and
continues persisted session history, not missed event delivery.

`result.raw` retains the authoritative native HTTP response when available;
partial progress remains in queued events on failure. Usage/cost fields stay
native: repeated cumulative snapshots must not be summed, zero is preserved,
and no billing/price estimate is fabricated. There is no owned process, so
`exitCode` and `signal` are null and stderr is empty with byte count zero.
HTTP status failure during startup is `launch-failed`; successful responses
with malformed/wrong identity are `protocol-error`. Native prompt HTTP errors
are `agent-error`; redirects and unexpected 204 are protocol violations.

### Approval, interruption and disposal

`await session.respondApproval(requestId, response)` /
`await session.respond_approval(request_id, response)` answers an observed
outstanding `permission.asked` for this session through
`POST /permission/{id}/reply?directory=...`, body `{reply: response}`.
Only `"once"` and `"reject"` are supported; no automatic answer is sent.
Upstream rejection can reject **all** outstanding permissions in the same
session, and a model may recover from a rejected tool and finish successfully.
The native `"always"` reply raises `unsupported-capability` before HTTP because
it changes instance-wide allow rules shared with other clients.
Stale/unknown IDs reject explicitly. Pi/OMP expose the same method but reject
it as unsupported. Native question dialogs, arbitrary tools/commands, forks
and broader approval/config controls have no Harness mapping.

`interrupt()` explicitly sends `POST /session/{id}/abort`, requires true plus
the turn's native settlement, and preserves follow-up. A normal completion
racing abort remains completed. Request/interrupt deadlines are bounded;
long-running prompt completion uses the turn deadline, not the short request
deadline. An unanswered permission/question can reach that turn deadline.

`close()` is idempotent and safe for concurrent callers. It settles an active
turn as closed and cancels/closes only client requests, tasks and the SSE
subscription. It **never** calls abort, instance/global dispose, history
deletion or server shutdown. Timeout and protocol/transport failure likewise
close local transport without claiming the server-side work stopped.
Server-side work may continue; explicitly interrupt before closing when a
confirmed stop is required. Python cancellation waits for shielded local
cleanup. Neither language takes ownership of the caller's server or tools.

### Qualification evidence

`tests/opencode_cases.json`, the bounded synthetic HTTP/SSE peer, Python tests,
Bun source tests and `node tests/node-opencode.mjs` exercise shared protocol
and ownership scenarios. This is **mock-server conformance**, not an installed
OpenCode run. No real credentials or conversations are in fixtures.

- **Native-runtime synthetic-provider evidence: not run/unqualified.** OpenCode
  1.18.29 is the source pin, not an installed-runtime result; no caller-supplied
  real endpoint was available.
- **Authenticated-provider evidence: not run/unqualified.** No real endpoint,
  provider, model or credentials were selected. Generation, tool execution and
  native cleanup have not been exercised. Fixture success does not fill this gap.

Pinned sources:
[OpenAPI schema](https://github.com/anomalyco/opencode/blob/16747470f976aca3d362ad730bcd3fe82ecc2c9a/packages/sdk/openapi.json),
[session routes](https://github.com/anomalyco/opencode/blob/16747470f976aca3d362ad730bcd3fe82ecc2c9a/packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts),
[SSE](https://github.com/anomalyco/opencode/blob/16747470f976aca3d362ad730bcd3fe82ecc2c9a/packages/opencode/src/server/routes/instance/httpapi/handlers/event.ts),
[runner](https://github.com/anomalyco/opencode/blob/16747470f976aca3d362ad730bcd3fe82ecc2c9a/packages/opencode/src/effect/runner.ts),
[permission scope](https://github.com/anomalyco/opencode/blob/16747470f976aca3d362ad730bcd3fe82ecc2c9a/packages/opencode/src/permission/index.ts),
[compaction](https://github.com/anomalyco/opencode/blob/16747470f976aca3d362ad730bcd3fe82ecc2c9a/packages/opencode/src/session/compaction.ts).

## Caller-owned OpenHands Agent Server sessions

`open_session` / `openSession` accept the **session-only** name
`harness: "openhands", backend: "rpc"`. RPC means direct Agent Server HTTP
requests and its WebSocket session channel, not the legacy CLI, Canvas, a
native TypeScript agent, or runtime provisioning. The CLI adapter registry
and one-shot API are unchanged; `getAdapter("openhands")` is still
`unknown-harness`. No CLI/SDK fallback occurs.

### Explicit caller-owned configuration

The source pin is **OpenHands Agent Server 1.45.0**, release commit
`49ea74587c376b90700f6eff128c3d9b57585d27`. Startup requires `/server_info` to
report server, SDK, tools and workspace package versions all equal to
`1.45.0`; mismatches fail explicitly. This metadata is a compatibility check,
not proof of an installed-runtime qualification or a trustworthy deployment.
The upstream server/SDK packages require Python >=3.12; Harness uses the
protocol directly and does not import them into its Python >=3.10 client.
The upstream TypeScript package is a remote client, not an in-process agent;
Harness does not depend on it.

Both package roots export `OpenHandsOptions`. `SessionSpec.openhands` is
required for this pairing and rejected elsewhere:

| TypeScript / Python field | required meaning |
|---|---|
| `endpoint` | HTTP(S) origin; no embedded credentials, path prefix, query, fragment or discovery; normalized as for OpenCode |
| `apiKey` / `api_key` | nonempty caller-supplied **server session key**, never a provider credential; printable ASCII token without whitespace (`0x21..0x7E`) |
| `agentProfile` / `agent_profile` | exact existing server-side agent profile name, not the active/default/newest profile |
| `confirmNoUnwantedCallbacks` / `confirm_no_unwanted_callbacks` | must be exactly `true`: caller confirms the supplied server has no unwanted automation callbacks/webhooks |

**The confirmation is a caller prerequisite, not client-enforced exclusion.**
Harness registers no automation callbacks, but this API cannot inspect or
disable server-configured webhooks. The caller must trust and check its
server's configuration. Agent profile tools, MCP servers, skills and server
memory preferences likewise remain upstream configuration, not a sandbox.
Harness does not change server settings or authentication to satisfy the
prerequisite.

`model` is also required: the exact native model selector, without CLI model
normalization. `workdir` is the literal canonical absolute POSIX directory
in the caller's existing **server** workspace; no local stat, mkdir, instruction
projection or path discovery occurs. Nonempty `env`, `executable`, `instructions`, other backend
options and permission bypass reject before network activity.

Startup reads only the named `/api/agent-profiles/{name}` and its referenced
`/api/profiles/{name}`, verifies an OpenHands (not ACP) profile and the selected
model, then sends the profile UUID in the conversation request. It never lists,
seeds, activates or edits profiles, requests exposed secrets, or copies local
provider settings/credentials to the server. Provider authentication remains
in the caller-selected server profile. Profile/model selection is checked
against the returned conversation and before a turn; mismatches fail rather
than silently switching.

REST uses `X-Session-API-Key`; WebSocket authentication uses the first
`{"type":"auth","session_api_key":"..."}` frame, never a query-string token.
Redirects are not followed. Python disables ambient proxy/netrc discovery.
Sending a key does **not** prove the server requires authentication: upstream
accepts requests unconditionally when its key list is empty. The caller owns
TLS, endpoint trust and authentication enforcement; HTTP is not encrypted.

Python loads `httpx` 0.28.x and `websockets` 15.x only when this backend opens
(`harness-cli[openhands]`). TypeScript lazily loads the `ws` module: packaged
Node requires the optional `ws` 8.x peer; Bun supplies its runtime implementation.
Missing dependencies are explicit
prerequisite failures. Ordinary imports and capability queries perform no
network, credential/configuration lookup or upstream SDK initialization.

### Identity, turns and native events

A new conversation uses a fresh full UUID, the explicit server workdir and
selected profile. Creation disables unrequested automatic title generation,
does not request a worktree and sends no initial message. Only a `201` new
conversation response is accepted; a collision is not a resume.
Creation is not transactional with client transport startup: a conversation
can already be persisted if a later socket handshake fails. Harness does not
delete that history to roll back a client error.

The reference contains canonical `sessionId` UUID, null `sessionFile`,
literal `workdir` and normalized `endpoint`. Resume requires that exact
association and verifies `GET /api/conversations/{id}` plus profile
provenance/model. **A resume 404 fails; it never POSTs a replacement.**
No latest-session search, fork, history deletion or local persistence is used.
The caller must retain exclusive write access to this conversation and its
selected configuration while the handle is used. HTTP preflight checks do
not provide an atomic cross-client lease.

`getSessionCapabilities("openhands", "rpc")` reports events, interrupt,
follow-up and resume true; concurrent turns and approval false. Common
serial `startTurn`, event streams, result, interrupt and close operations
apply. A turn appends a user message with `run: false`, observes its matching
native echo, then calls `/run`. This deliberately avoids upstream's
`run: true` behavior, which can queue a rerun instead of surfacing busy.
HTTP `409` is a non-success outcome with the numeric status retained, not a
retry or permission to interrupt another caller.
Every HTTP request, including its response body, has the configured request
deadline. The prompt's HTTP acknowledgement and matching socket echo share
one deadline starting at submission; receiving the acknowledgement does not
grant another full wait for the echo. An unanswered turn request is a
`protocol-error`, distinct from a transport disconnect. Native execution
itself uses the longer turn deadline.

The live-only `/sockets/session/{id}` subscription uses the initial `sync`
frame's sequence baseline. Startup also waits for the initial native
`full_state` snapshot within the request deadline; missing readiness fails.
Durable events must advance contiguously;
duplicates, backwards sequences and gaps fail rather than silently skipping
history. Harness does not reconnect/replay automatically. A `sync` frame,
HTTP acknowledgement, stale state snapshot or `idle` transition is not turn
completion.

Completion requires the matched user message, successful `/run`
acknowledgement, a current-run durable terminal `execution_status` transition,
and a subsequent native `full_state` snapshot with matching terminal state.
This conservative barrier retains final native errors and cumulative stats;
a missing barrier reaches the configured deadline rather than inventing
success. Native `finished` maps to `completed`, `error` to `agent-error`,
`stuck` to the distinct `stuck` result, and `paused` to `interrupted`.
Normal completion racing interruption remains completed.

Every received event retains the complete WebSocket envelope in `raw`,
including durable `seq` and the opaque native event. `type` is the inner
event `kind` for durable/transient envelopes, otherwise the outer frame
type; native event IDs supply `requestId` when present. Unknown well-shaped
types remain visible in wire order. Events retain native session and local
turn correlation; events outside a turn use null `turnId`.
The pinned session channel does **not** produce token-delta frames: upstream
intentionally drops `StreamingDeltaEvent` on this channel. No incremental
token delivery or lossless upstream-history guarantee is claimed.

HTTP JSON bodies and WebSocket messages are bounded to 1 MiB. Invalid UTF-8,
JSON, known frame shapes, binary messages and oversized input fail as
protocol-error; disconnect remains distinct. Existing single-consumer byte
queues retain prior events and expose overflow through `eventsTruncated`.
Native cumulative stats and estimated cost stay in
`result.raw = {state, terminal_event}` and native events. Repeated totals
are never summed, turned into per-turn deltas or represented as billed USD.
There is no owned process: exitCode/signal are null and stderr is empty.

### Permission and transport ownership

Permissions preserve upstream defaults; the native default is `NeverConfirm`,
not a sandbox. Harness does not change that policy or expose the native
batch-approval endpoint. `respondApproval` is unsupported; a native
`waiting_for_confirmation` state yields an explicit agent-error with native
evidence, without granting/rejecting authority behind the caller's back.
The server can remain waiting after the client releases its transport.
Arbitrary commands/tools, profile/model switching, forks, goals, history
management, provisioning and native callback registration have no API mapping.

`interrupt()` sends `/interrupt` at most once, only after this handle's `/run`
is accepted. An early call waits for submission; a rejected/busy run is never
interrupted. It waits for acknowledgement plus native paused/terminal evidence,
bounded by the request deadline. A complete terminal snapshot is latched while
an interrupt reply is pending, so later pause frames cannot overwrite normal
completion. A failed ancillary interrupt request does not discard that latched
`finished`/`error`/`stuck` result; the local handle closes instead, so no
follow-up turn runs against a handle whose remote interrupt state is unknown.
While an interrupt mutation is still pending, the turn is not reported as
settled. Native `paused` reports the agent state; it does not prove every
remote tool process has exited. An HTTP success alone is insufficient:
upstream may return after its bounded wait while native work still exists.

`close()` is idempotent, settles an active local turn as `closed`, and releases
only owned HTTP/WebSocket connections and client tasks. It never sends pause,
interrupt, DELETE, server shutdown or configuration requests. Timeouts,
protocol failures and disconnects likewise do not prove remote work stopped.
Python cancellation waits for shielded local cleanup. Never kill the
caller-owned server or its tools to escalate client disposal. Persisted
conversation history and continuing remote work belong to the caller.

### Qualification evidence

`tests/openhands_cases.json`, the finite-lifetime synthetic HTTP/WebSocket
peer, Python tests, Bun source tests and `node tests/node-openhands.mjs`
cover the shared client protocol and ownership contract. These are
**mock-server conformance**, not execution of OpenHands or a provider.

- **Native-runtime synthetic-provider evidence: not run/unqualified.**
  1.45.0 is the source pin; no caller-owned native endpoint was supplied.
- **Authenticated-provider evidence: not run/unqualified.** No native endpoint,
  workspace, model/profile or server auth was supplied for execution.
  Fixture success does not qualify native tools, provider generation or cleanup.

Pinned sources:
[server metadata](https://github.com/OpenHands/software-agent-sdk/blob/49ea74587c376b90700f6eff128c3d9b57585d27/openhands-agent-server/openhands/agent_server/server_details_router.py),
[conversation requests](https://github.com/OpenHands/software-agent-sdk/blob/49ea74587c376b90700f6eff128c3d9b57585d27/openhands-sdk/openhands/sdk/conversation/request.py),
[conversation routes](https://github.com/OpenHands/software-agent-sdk/blob/49ea74587c376b90700f6eff128c3d9b57585d27/openhands-agent-server/openhands/agent_server/conversation_router.py),
[event execution](https://github.com/OpenHands/software-agent-sdk/blob/49ea74587c376b90700f6eff128c3d9b57585d27/openhands-agent-server/openhands/agent_server/event_service.py),
[session envelope](https://github.com/OpenHands/software-agent-sdk/blob/49ea74587c376b90700f6eff128c3d9b57585d27/openhands-agent-server/openhands/agent_server/session_protocol.py),
[ordered socket](https://github.com/OpenHands/software-agent-sdk/blob/49ea74587c376b90700f6eff128c3d9b57585d27/openhands-agent-server/openhands/agent_server/session_socket.py),
[profile API](https://github.com/OpenHands/software-agent-sdk/blob/49ea74587c376b90700f6eff128c3d9b57585d27/openhands-agent-server/openhands/agent_server/agent_profiles_router.py),
[LLM profile API](https://github.com/OpenHands/software-agent-sdk/blob/49ea74587c376b90700f6eff128c3d9b57585d27/openhands-agent-server/openhands/agent_server/profiles_router.py),
[server webhooks and memory policy](https://github.com/OpenHands/software-agent-sdk/blob/49ea74587c376b90700f6eff128c3d9b57585d27/openhands-agent-server/openhands/agent_server/conversation_service.py).

## Backend and session implementation gates

These requirements govern the shipped Pi RPC, OMP/Amp SDK, Claude SDK and caller-owned
OpenCode/OpenHands session implementations above and future backends. They keep the common library small; they do not
enable additional SDKs or native protocols by themselves.

- Backend selection is explicit and stable for a run/session. SDK dependencies
  are optional and lazy; importing or selecting CLI must not load/configure an
  SDK. A missing SDK/runtime is a prerequisite error, never CLI fallback.
  A Python bridge must be named and qualified as a bridge, not represented as a
  native Python SDK. Capability support must agree across languages or return
  an explicit unsupported error.
- A session handle owns only resources it created. Connecting to a caller-owned
  server does not authorize killing it. Closing an owned transport cleans up
  owned subscriptions/processes; it does not delete persisted upstream history.
  Preserve native session identity, backend identity and working-directory
  association. Resume requires an explicit native ID; “latest” is not resume.
- Keep operations to starting a turn, observing events and its terminal result,
  interrupting that turn, and closing the handle. Follow-up reuses the same
  upstream session only when supported. Concurrent turns on one session must
  either be explicitly supported with correlation or rejected, never mixed.
  Request acknowledgements are not completed turns.
- Events preserve order within their upstream stream and carry turn/request
  correlation. Exactly one terminal outcome follows each accepted turn;
  protocol failure, disconnect, cancellation, timeout, signal exit and non-zero
  agent result are distinguishable. Unknown upstream event payloads stay
  available through a typed backend-specific route, not silently discarded.
- Interrupt stops the active turn without silently deleting the session;
  close disposes owned transport resources. Cancellation/timeout must initiate
  bounded graceful termination, escalate if necessary, drain or close pipes,
  reap owned children and leave unrelated processes/servers untouched.
  Callback failure follows the same cleanup path and retains its cause.
- Streaming must define stdin EOF, stdout versus stderr, incremental UTF-8 and
  JSONL decoding, backpressure and bounded capture with visible truncation.
  Silence alone is not failure; an inactivity watchdog is opt-in.
- Permissions preserve upstream defaults unless explicitly selected. An approval
  channel is a separate capability from bypass/sandbox options; a transport
  without one must not simulate approval or silently broaden authority.
- Usage events declare whether counts are deltas or totals and how native IDs
  prevent double counting. Reported cost, estimates and unavailable pricing
  remain distinguishable; subscription billing cannot be inferred from backend.
  Preserve upstream-specific options/events as typed variants alongside the
  common contract, not an ever-growing universal option object.

Acceptance for a backend includes matching deterministic Python/TypeScript
scenarios for native identity, follow-up/resume, interrupt/dispose, protocol
errors, partial output and unsupported operations. Actual provider smoke
evidence is separate and records exact installed/runtime versions, auth
prerequisites and unavailable cases. Fixture success alone is not support
qualification. Fixtures/logs must be synthetic or redacted; no private prompts
or credentials enter the public suite.

Primary sources refreshed for this contract:
[Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview),
[Claude CLI](https://code.claude.com/docs/en/cli-reference),
[Codex SDK](https://developers.openai.com/codex/sdk),
[Codex app-server](https://developers.openai.com/codex/app-server),
[OpenCode SDK](https://opencode.ai/docs/sdk/),
[OpenCode server](https://opencode.ai/docs/server/), and
[Pi RPC](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/rpc.md).
Installed help was inspected for Claude Code 2.1.220 and Codex 0.153.4,
including effort, sandbox and bypass options; this was not a provider smoke.

### Codex app-server qualification outcome

Codex app-server sessions are **deferred/unsupported**, not shipped experimental
support. Qualification of direct stdio CLI **0.153.4** found ordinary native tools
surviving app-server-group teardown on macOS under Python, Bun and Node.
Cooperative interruption and EOF shutdown do not establish forced containment.
The [qualification record](ADAPTER-MATRIX.md#codex-app-server-unsupported-after-qualification)
preserves exact versions, SDK execution-model differences and evidence limits.

`get_session_capabilities("codex", "rpc")` / `getSessionCapabilities("codex", "rpc")`
and Codex `open_session` / `openSession` on `rpc` or `sdk` still raise
`unsupported-backend`. CLI behavior, imports, dependencies, permissions and the
documented process-group boundary are unchanged. Completing
[TWA-103](https://linear.app/twaldin/issue/TWA-103) means unsupported qualification
documentation, not satisfying the implementation gates above. Future support
is deferred to [TWA-107](https://linear.app/twaldin/issue/TWA-107); it must first
establish reliable native-tool containment, then meet the full dual-language
session acceptance. No backend fallback or weaker cleanup contract is enabled.

### Reconciliation of the live-session proposals

The three local May 13 `harness-live-{design,dogfood,use-cases-audit}.md`
documents were proposals, not shipped contracts. Their originals are preserved.
Retained decisions: one library across languages; per-agent command/pane/log
knowledge; consumer-owned host/fleet/worktree lifecycle; explicit execution
selection; existing RunSpec/RunResult callers; behavioral replay plus separate
live evidence. Existing language skew is repaired before adding backends.

Not adopted: mandatory bypass, billing-tier inference from headless/live mode,
historical hard-coded cache prices, a mandatory thin Session facade, automatic
OAuth proxy configuration, consumer/fleet migrations, staged single-language
API PRs or source-text/member-count tests as parity proof. CLI chunk streaming
now ships under the execution contract above; controlled Pi RPC and optional
OMP/Amp SDK, Claude SDK and caller-owned OpenCode/OpenHands sessions ship through
their explicit API. Additional protocols and
SDKs remain implementation-gated.
No package release is implied.

---

## Registry behavior

Both package roots register all shipped adapters on import. `import harness;
harness.list_adapters()` and `import { listAdapters } from '@twaldin/harness-ts'`
therefore expose the same built-ins without a prior run/build call.
Registering the same class (Python) or object (TypeScript) again is idempotent;
a different implementation under that name raises `duplicate-adapter`.

```
["aider", "amp", "auggie", "claude-code", "cline", "codex", "continue-cli", "copilot", "crush", "cursor", "factory-droid", "gemini", "goose", "hermes", "kilo", "kimi-code", "kiro", "mini-swe-agent", "mistral-vibe", "omp", "openclaude", "opencode", "pi", "qoder", "qwen", "swe-agent"]
```

(sorted, locale-independent)

Adapter lookup is case-sensitive. `"Claude-Code"` → `HarnessError`.

---

## What harness does NOT ship

Explicit non-goals, to keep the library narrow:

- tmux lifecycle, pane capture and polling — **the consumer's job**; both languages expose optional pure pane-status/dialog helpers, but the consumer drives capture and decides whether to send any returned keystrokes
- challenge seeding, grading, ELO — **agentelo's job**
- prompt mutation, GEPA, training loops — **hone's job**
- Vertex/OAuth proxy shims, regional routing — **agentelo's job** (context-specific, varies by billing arrangement)

Harness provides CLI command construction, output parsing and headless execution, plus instruction-projection, pricing and session helpers. It does not own the consumer's terminal lifecycle.

Optional agent SDK/protocol integrations are now in scope for the library.
This supersedes the historical blanket SDK exclusion in CONTRIBUTING, not the
consumer-owned host/fleet boundary. The optional OMP/Amp SDK bridges, native
Claude SDK sessions and caller-owned OpenCode/OpenHands clients implement the
dependency and behavior requirements above. A raw model API, fleet manager,
Linear engine or application is not an agent backend.

---

## Compatibility guarantees

- Field names in RunSpec/RunResult are STABLE. Optional field additions preserve call shape; they do not automatically preserve behavior. The explicit [permission migration](#permission-policy-and-migration) is an approved compatibility change. Renaming/removing fields requires a major version bump.
- Adapter registration is STABLE — the shipped adapters always exist with the listed names.
- Default models MAY change across minor versions. Consumers that pin should specify `spec.model` explicitly.
- Command flag construction MAY change within a major version if the upstream CLI changes flags. Fixture updates go in the same PR.

---

## Versioning

- `harness-cli` (Python distribution; import `harness`) — semver, tracked in `pyproject.toml`
- `@twaldin/harness-ts` — semver, tracked in `ts/package.json`
- `harness` (py) and ts share the MAJOR.MINOR. Patch versions MAY diverge for implementation-only fixes.
- Breaking changes to SPEC.md bump both simultaneously, with a coordinated release PR.

Current manifests record Python `0.3.16` and TypeScript `0.2.20`, which do not satisfy the documented MAJOR.MINOR alignment. This factual skew does not change the release requirement above.

The paired fixture-update patch bumps do not publish packages or create release
tags. A separately authorized coordinated release must account for the
permission-default compatibility change and existing version skew.
