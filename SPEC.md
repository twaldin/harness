# harness — specification

This is the shared contract for `harness` (Python) and `@twaldin/harness-ts` (TypeScript). The current implementation provides CLI command construction, one-shot execution, output parsing and optional externally hosted session helpers. The [backend and session implementation gates](#backend-and-session-implementation-gates) specify requirements for future RPC/SDK support; they are not shipped APIs.

**Repo layout (monorepo):**
```
harness/
├── SPEC.md                 (this file — the contract)
├── ADAPTER-MATRIX.md       (per-CLI flag + output parsing reference)
├── tests/fixtures/*.json   (shared golden tests both impls must pass)
├── src/harness/            (python)
│   ├── base.py             (types)
│   ├── registry.py         (run/list_adapters/get_adapter)
│   ├── adapters/*.py       (13 adapters)
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
  harness: string                  // "claude-code" | "openclaude" | "factory-droid" | "codex" | "gemini" | "opencode" | "aider" | "swe-agent" | "qwen" | "continue-cli" | "pi" | "crush" | "kilo"
  prompt: string                   // the task (becomes positional arg or stdin)
  workdir: string                  // cwd for the subprocess; normalized to an absolute path
  model?: string                   // canonical or adapter-specific identifier (normalized per harness; see ADAPTER-MATRIX.md)
  instructions?: string            // temporarily projected into the adapter's instruction file
  timeoutSeconds?: number          // default 1800
  env?: Record<string, string>     // extra env vars merged onto process.env
  modelNoResolve?: boolean         // skip harness-specific rewriting; whitespace is still trimmed
  backend?: Backend               // default 'cli'; 'rpc' and 'sdk' explicitly unsupported today
  permissionPolicy?: PermissionPolicy // default 'upstream'; never inject bypass by default
  nativeOptions?: NativeOptions   // typed, agent-specific CLI options; mismatches are errors
  executable?: string              // bare executable name or absolute path; no shell expansion
  configHome?: string              // absolute, caller-selected upstream config/state home
  configFile?: string              // absolute, caller-selected config file; supported adapters only
  cancel?: AbortSignal             // Python: threading.Event; explicit cancellation returns a result
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
  costUsd: number | null           // null if adapter can't report cost
  tokensIn: number | null
  tokensOut: number | null
  raw: unknown | null              // adapter-specific structured payload (parsed JSON)
}

type Termination = 'exited' | 'signaled' | 'timed-out' | 'cancelled' | 'launch-failed'
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
type NativeOptions = ClaudeCodeOptions | CodexOptions
interface Capabilities {
  backend: Backend
  permissionPolicies: readonly PermissionPolicy[]
  nativeOptions: 'claude-code' | 'codex' | null
  streaming: boolean
  cancellation: boolean
  sessions: boolean
  configHomeEnv: string | null      // supported native home variable, not an isolation guarantee
  configFileFlag: string | null     // supported native config-file flag
}
```

Python exports `Backend`, `PermissionPolicy`, `NativeOptions`, `Capabilities`,
`ClaudeCodeOptions` and `CodexOptions` with equivalent values. Construct native
options as `ClaudeCodeOptions(effort="high")` or
`CodexOptions(sandbox="read-only")`; their `kind` is fixed by the dataclass.
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

Selector/permission/native-option/config-override rejection happens before
preparation and before any subprocess starts. A caller can
catch `HarnessError` without parsing its message. Existing message-only
construction retains `adapter-error`.

Non-zero subprocess exit, timeout, explicit cancellation and OS launch failure
are represented in `RunResult`, not `HarnessError`. Python task cancellation
propagates `CancelledError` after cleanup. Invalid low-level arguments and
unsupported operating systems raise before launch. Cleanup failures (including
failure to reap the leader within the cleanup deadline) raise rather than
returning a result that falsely implies completed cleanup. See
[ownership and execution](#ownership-and-execution).

### Backend selection and capabilities

`harness` identifies the agent; `backend` identifies its execution integration.
Omitted backend means CLI for existing callers. No preference order, dependency
probe or failure path may silently change CLI into SDK/RPC, or vice versa.
Selecting `rpc` or `sdk` currently raises `unsupported-backend` in both languages;
importing Harness loads no optional SDK and does not initialize upstream settings.

`getCapabilities("codex")` reports CLI support, `["upstream", "bypass"]`,
native option kind `"codex"`, `true` for cancellation, and `false` for streaming
and sessions. All thirteen CLI adapters share these lifecycle capabilities.
They describe
Harness-controlled operations, not whether the underlying tool supports a
protocol or writes session logs. Optional pane/log helper availability is
separate from a controllable live session. Capability queries perform no
installation/authentication/version checks; see the adapter matrix for evidence.

### Permission policy and migration

Omitted policy and `"upstream"` mean Harness adds no approval/bypass flag.
Upstream policy still depends on the selected tool, its headless mode, caller
environment and existing configuration. This does **not** promise a sandbox,
an interactive approval channel, or denial of every tool call. An upstream
may reject an operation when stdin is closed. Harness never responds to an
approval request by silently escalating.

`"bypass"` is an explicit request to use the adapter's documented bypass mapping:

| adapter | explicit bypass flag |
|---|---|
| claude-code, openclaude | `--dangerously-skip-permissions` |
| codex | `--dangerously-bypass-approvals-and-sandbox` (also disables sandboxing) |
| factory-droid | `--skip-permissions-unsafe` |
| gemini, qwen | `-y` |
| aider | `--yes-always` |
| kilo | `--auto` |

The other five adapters reject `"bypass"` as unsupported; a missing mapping is
not evidence that upstream has no permissions. Unsupported choices are never
silently ignored. Narrow native options stay explicit: Codex `sandbox` emits
`--sandbox`, and cannot be combined with `"bypass"` because that would override
the selected sandbox. Claude Code `effort` emits `--effort`; it is not a common
model/effort policy for every tool.

**Compatibility change:** older command builders inserted the eight mappings
above unconditionally. Existing unattended callers that intentionally require
that authority must set `permission_policy="bypass"` (Python) or
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

Cost and tokens come from the sqlite session DB read after the process exits.

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
  "raw": null
}
```

### aider

`costUsd` is always null — aider does not emit pricing data. Tokens are parsed from a log line regex.

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

Cost and tokens come from the `--json` envelope emitted on stdout.

```json
{
  "harness": "continue-cli",
  "model": "claude-sonnet-4-6",
  "exitCode": 0,
  "durationSeconds": 7.1,
  "timedOut": false,
  "costUsd": 0.0187,
  "tokensIn": 950,
  "tokensOut": 380,
  "raw": {
    "type": "result",
    "result": "Hello from harness",
    "usage": { "input_tokens": 950, "output_tokens": 380 },
    "total_cost_usd": 0.0187
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

---

## Adapter contract

Each adapter provides:

| field | meaning |
| --- | --- |
| `name` | short id used in RunSpec.harness — matches the CLI name |
| `instructionsFilename` | where to write RunSpec.instructions; empty string = no file (fold into prompt) |
| `defaultModel` | used when RunSpec.model is unset |
| `buildCommand(spec)` | returns a side-effect-free command and instruction plan |
| `parseOutput(spec, outcome)` | returns `{costUsd, tokensIn, tokensOut, raw}` |

`buildCommand` MUST NOT write files, create directories, or fork a subprocess.
Built-in builders apply the common launch finalizer so direct adapter calls and
registry calls honor executable, cwd, env and supported config overrides alike.
`parseOutput` MAY read files the CLI wrote (opencode/kilo/crush sqlite DBs, swe-agent trajectory JSON) but MUST NOT block on I/O > 5s.

### JSON-fixture-driven verification

Every adapter has a matching fixture at `tests/fixtures/<name>.json`:

```json
{
  "spec": {
    "harness": "claude-code",
    "prompt": "fix the bug in main.py",
    "workdir": "/tmp/harness-fixture",
    "model": "sonnet",
    "instructions": "You are a careful engineer.\n",
    "timeoutSeconds": 300
  },
  "expectedCommand": {
    "cmd": "claude",
    "args": ["-p", "fix the bug in main.py", "--model", "sonnet", "--output-format", "json", "--append-system-prompt", "You are a careful engineer.\n"],
    "instructionsFile": "/tmp/harness-fixture/CLAUDE.md"
  },
  "sampleOutput": {
    "stdout": "...",
    "stderr": "",
    "exitCode": 0,
    "durationSeconds": 12.3,
    "timedOut": false
  },
  "expectedParsed": {
    "costUsd": 0.0342,
    "tokensIn": 1823,
    "tokensOut": 412
  }
}
```

Both suites load the shared fixtures, but the assertions are not identical. TypeScript compares command arguments and instruction paths exactly; Python uses adapter-specific checks and temporary-path substitutions. Database fixtures with an `expectedParsed.note` cover missing-DB/null results rather than asserting the recorded non-null metrics.

Fixtures support drift prevention for the cases actually asserted; they do not prove byte-level equivalence of all behavior. New adapters need explicit test registration in `tests/test_fixtures.py` and `ts/tests/fixtures.test.ts`, not just a new JSON file.

---

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
| aider | unsupported | `--config` |
| continue-cli | unsupported | `--config` |
| all others | unsupported | unsupported |

An unsupported explicit override raises `unsupported-capability`. Home/file
paths must be absolute. `executable` accepts a bare name resolved through the
child's PATH or an absolute path; relative paths with separators and empty/NUL
values reject with `invalid-options`. Workdir is normalized without changing
process-global cwd. Preparation requires an existing caller-owned workdir.

These mappings select existing upstream state, not a sandbox or an empty home.
For example, Codex stores authentication alongside configuration under
`CODEX_HOME`; pointing it at a new home does not copy authentication there.
Managed settings, upstream project discovery and upstream writes still apply.
Raw `HOME`, `XDG_*` and native env overrides remain caller-controlled; passing
an env variable does not claim the upstream supports it or separates credentials.
Harness does not rewrite a user's settings to make a model selection stick.
An omitted/empty model retains the existing adapter default contract.

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
[Aider options](https://aider.chat/docs/config/options.html), and
[Continue CLI](https://github.com/continuedev/continue/blob/main/extensions/cli/README.md).
Claude Code 2.1.220 and Codex 0.153.4 help were inspected locally. These are
configuration/flag checks, not provider execution or credential-isolation proof.

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
time conventions. Pass the same instant after converting units. Not every
adapter honors the cutoff; newest-file and basename-based database selectors
are discovery heuristics, not proof of session ownership. Do not use them to
attribute concurrent runs without an upstream session ID.

Current execution behavior and limits:

| concern | shipped behavior |
|---|---|
| sync execution | Python `run` and both low-level `run_subprocess` / `runSubprocess` helpers block |
| async execution | Python `run_async` is a coroutine; TS `run` and `runAsync` are non-blocking Promises |
| stdin | closed by the headless entry points; there is no prompt/approval input channel |
| output | stdout/stderr captured separately; no output callback or backpressure API |
| timeout | finite non-negative seconds, default 1800; zero expires immediately after launch; `exitCode=-1`, `timedOut=true` |
| process cleanup | fresh owned POSIX process group; SIGTERM, then SIGKILL after 0.5 seconds if still present; drain/close within a further 1 second |
| cancellation | optional `cancel`: Python `threading.Event`, TS `AbortSignal`; explicit cancellation returns `termination="cancelled"`, `exitCode=-1`, `timedOut=false` |
| launch failure | `termination="launch-failed"`, `exitCode=-1`, `launchError` / `launch_error` carries the OS code |
| signal reporting | `termination="signaled"`, negative signal number as exit code and a separate signal name; SIGTERM alone is not a timeout |
| memory/decoding | captured output is memory-buffered; UTF-8 replacement decoding preserves characters split across reads |

`termination="exited"` covers both zero and non-zero ordinary exits. Timeout
and cancellation retain their cause even if the leader handles SIGTERM and
exits zero. `signal` records the leader's actual terminating signal, if any.
The first terminal condition observed by the runner wins. After ordinary
leader exit, cleanup stops leftover group members without changing the leader's
result; inherited pipes must not turn a completed leader into a timeout.

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
languages; whitespace is trimmed after default selection. Explicit
`modelNoResolve` skips rewriting, not trimming.

Null means unknown/unavailable, not zero. Zero is a legitimate reported value.
Cost may be reported or estimated according to the adapter matrix; it is not
necessarily the amount billed. CLI versus SDK, or headless versus interactive,
does not identify a subscription/billing tier. Cache tokens and pricing need
upstream-specific semantics; never apply historical multipliers universally.
Raw payloads retain upstream details but are untrusted and may contain prompts,
paths or secrets. No telemetry is transmitted by Harness. Upstream tools may
have their own telemetry settings, which remain caller-controlled.

## Backend and session implementation gates

The following is the accepted contract for future implementations, **not
exported session methods or enabled capabilities today**. It replaces the old
SDK exclusion while keeping the common library small.

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
API PRs or source-text/member-count tests as parity proof. Streaming, controlled
sessions and SDKs remain implementation-gated above, not hidden as shipped
features behind no-op methods. No package release is implied by this contract.

---

## Registry behavior

Both package roots register all shipped adapters on import. `import harness;
harness.list_adapters()` and `import { listAdapters } from '@twaldin/harness-ts'`
therefore expose the same built-ins without a prior run/build call.
Registering the same class (Python) or object (TypeScript) again is idempotent;
a different implementation under that name raises `duplicate-adapter`.

```
["aider", "claude-code", "codex", "continue-cli", "crush", "factory-droid", "gemini", "kilo", "openclaude", "opencode", "pi", "qwen", "swe-agent"]
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
- Streaming callbacks (`onOutput`) — not implemented; use `run_async()` / `runAsync()` for non-blocking subprocess execution without streaming callbacks

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

Current manifests record Python `0.3.4` and TypeScript `0.2.8`, which do not satisfy the documented MAJOR.MINOR alignment. This factual skew does not change the release requirement above.

This source-tree contract change does not publish a package, create a release tag
or change those versions. A separately authorized coordinated release must account
for the permission-default compatibility change and existing version skew.
