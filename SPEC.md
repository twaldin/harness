# harness — specification

This is the shared contract for `harness` (Python) and `@twaldin/harness-ts` (TypeScript). It provides CLI command construction, one-shot execution, output parsing, controlled Pi RPC sessions and optional externally hosted pane/log helpers. The [backend and session implementation gates](#backend-and-session-implementation-gates) apply to controlled sessions and future backends; SDK execution remains unsupported.

**Repo layout (monorepo):**
```
harness/
├── SPEC.md                 (this file — the contract)
├── ADAPTER-MATRIX.md       (per-CLI flag + output parsing reference)
├── tests/fixtures/*.json   (shared golden tests both impls must pass)
├── src/harness/            (python)
│   ├── base.py             (types)
│   ├── registry.py         (run/list_adapters/get_adapter)
│   ├── adapters/*.py       (23 adapters)
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
type NativeOptions = ClaudeCodeOptions | CodexOptions | ClineOptions | CopilotOptions | AmpOptions | VibeOptions | KiroOptions
interface Capabilities {
  backend: Backend
  permissionPolicies: readonly PermissionPolicy[]
  nativeOptions: 'claude-code' | 'codex' | 'cline' | 'copilot' | 'amp' | 'mistral-vibe' | 'kiro' | null
  streaming: boolean
  cancellation: boolean
  sessions: boolean
  configHomeEnv: string | null      // supported native home variable, not an isolation guarantee
  configFileFlag: string | null     // supported native config-file flag
}
```

Python exports `Backend`, `PermissionPolicy`, `NativeOptions`, `Capabilities`,
`ClaudeCodeOptions`, `CodexOptions`, `ClineOptions`, `CopilotOptions`, `AmpOptions`, `VibeOptions` and `KiroOptions` with equivalent values.
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
Selecting `rpc` or `sdk` through the one-shot `RunSpec` API raises
`unsupported-backend` in both languages. Controlled RPC uses the separate
[session API](#controlled-rpc-sessions); no one-shot call changes into a session.
Importing Harness loads no optional SDK and does not initialize upstream settings.

`getCapabilities("codex")` reports CLI support, `["upstream", "bypass"]`,
native option kind `"codex"`, `true` for cancellation and streaming, and `false`
for sessions. All twenty-three CLI adapters share these lifecycle capabilities.
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
| hermes | `--yolo` |
| omp | `--auto-approve` |
| cline | `--auto-approve true` |
| goose | child environment `GOOSE_MODE=auto` (no flag); conflicting explicit `env.GOOSE_MODE` rejects |
| copilot | `--allow-all` |
| mistral-vibe | `--auto-approve` |
| cursor | `--force` (native explicit denies and team policy still apply) |
| kiro | `--trust-all-tools` |

The other five adapters (including Amp) reject `"bypass"` as unsupported; a missing mapping is
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

Cost and tokens are summed from assistant messages in the `--mode json` event stream.

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
| `defaultModel` | used when RunSpec.model is unset; `amp`, `auggie`, `hermes`, `goose`, `copilot`, `cursor`, `mistral-vibe` and `kiro` have none (empty sentinel), so upstream selection applies and the reported model is null |
| `buildCommand(spec)` | returns a side-effect-free command and instruction plan |
| `parseOutput(spec, outcome)` | returns `{costUsd, tokensIn, tokensOut, raw}` |

`buildCommand` MUST NOT write files, create directories, or fork a subprocess.
Built-in builders apply the common launch finalizer so direct adapter calls and
registry calls honor executable, cwd, env and supported config overrides alike.
`parseOutput` MAY read files the CLI wrote (opencode/kilo/crush sqlite DBs, swe-agent trajectory JSON) but MUST NOT block on I/O > 5s.

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
| kiro | unsupported | unsupported |
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
Other registered adapters reject session selection with `unsupported-backend`.
Unknown names still produce `unknown-harness`.

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
its CLI behavior. There is no generic raw-command, steering, queued follow-up,
approval-response or arbitrary native-options channel.

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

## Backend and session implementation gates

These requirements govern the shipped Pi RPC session implementation above and
future backends. They replace the old SDK exclusion while keeping the common
library small; they do not enable SDKs or additional native protocols by themselves.

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
now ships under the execution contract above; controlled Pi RPC sessions ship
through their explicit API. Additional protocols and SDKs remain implementation-gated.
No package release is implied.

---

## Registry behavior

Both package roots register all shipped adapters on import. `import harness;
harness.list_adapters()` and `import { listAdapters } from '@twaldin/harness-ts'`
therefore expose the same built-ins without a prior run/build call.
Registering the same class (Python) or object (TypeScript) again is idempotent;
a different implementation under that name raises `duplicate-adapter`.

```
["aider", "amp", "auggie", "claude-code", "cline", "codex", "continue-cli", "copilot", "crush", "cursor", "factory-droid", "gemini", "goose", "hermes", "kilo", "kiro", "mistral-vibe", "omp", "openclaude", "opencode", "pi", "qwen", "swe-agent"]
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
consumer-owned host/fleet boundary. There is no SDK backend implemented yet;
its dependency and behavior requirements are defined in the implementation gates above. A raw model API,
fleet manager, Linear engine or application is not an agent backend.

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

Current manifests record Python `0.3.14` and TypeScript `0.2.18`, which do not satisfy the documented MAJOR.MINOR alignment. This factual skew does not change the release requirement above.

The paired fixture-update patch bumps do not publish packages or create release
tags. A separately authorized coordinated release must account for the
permission-default compatibility change and existing version skew.
