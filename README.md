# harness

<img src=".github/social-card.png" alt="harness" width="100%" />

One CLI (and one Python API, and one TypeScript API) to invoke every headless coding-CLI agent as a subprocess. `claude-code`, `cline`, `openclaude`, `opencode`, `codex`, `gemini`, `aider`, `amp`, `auggie`, `swe-agent`, `mini-swe-agent`, `qwen`, `continue-cli`, `pi`, `omp`, `factory-droid`, `kilo`, `crush`, `hermes`, `goose`, `copilot`, `cursor`, `mistral-vibe`, `kimi-code`, `kiro`, `qoder` — one `RunSpec`, one `RunResult`, zero per-CLI adapter code in your project.

## Quick start

**Python** — `pip install harness-cli` (imports as `harness`; `harness` was squatted on PyPI)

```python
from harness import RunSpec, run

r = run(RunSpec(
    harness="claude-code",
    model="sonnet",
    prompt="Write a one-line Python hello-world.",
    workdir="/tmp/scratch",
))
cost = f"${r.cost_usd:.4f}" if r.cost_usd is not None else "n/a"
print(f"exit={r.exit_code}  cost={cost}  tokens={r.tokens_in}/{r.tokens_out}")
```

**TypeScript** — `npm install @twaldin/harness-ts`

```typescript
import { run } from '@twaldin/harness-ts'

const r = await run({
  harness: 'claude-code',
  model: 'sonnet',
  prompt: 'Write a one-line TypeScript hello-world.',
  workdir: '/tmp/scratch',
})
const cost = r.costUsd == null ? 'n/a' : `$${r.costUsd.toFixed(4)}`
console.log(`exit=${r.exitCode}  cost=${cost}  tokens=${r.tokensIn}/${r.tokensOut}`)
```

See [`examples/hello-world.py`](examples/hello-world.py) and [`ts/examples/hello-world.ts`](ts/examples/hello-world.ts) for runnable versions.

### Permissions and explicit backends

Permission policy now defaults to the upstream tool's normal behavior. Harness
no longer adds approval/bypass flags automatically. This can affect unattended
callers that depended on the old defaults: explicitly choose
`permission_policy="bypass"` (Python), `permissionPolicy: "bypass"` (TypeScript)
or `harness run --permission-policy bypass` only when that authority is intended.
Codex bypass also disables sandboxing. Unsupported bypass requests fail; no
tool is silently escalated. Existing upstream config and environment still apply.

The one-shot execution backend defaults to `"cli"`. Selecting `"rpc"` or `"sdk"`
in `RunSpec` is an explicit unsupported-backend error, never a fallback.
Controlled Pi RPC uses the separate [session API](#controlled-pi-rpc-sessions).
`get_capabilities("codex")` / `getCapabilities('codex')` reports one-shot support
without probing installation or auth. Typed native options cover Claude Code
effort and Codex sandbox selection:

```python
from harness import CodexOptions, RunSpec, build_command

command = build_command(RunSpec(
    harness="codex", prompt="Review this code", workdir="/tmp/scratch",
    backend="cli", native_options=CodexOptions(sandbox="read-only"),
))
```

```typescript
import { buildCommand } from '@twaldin/harness-ts'

const command = buildCommand({
  harness: 'codex', prompt: 'Review this code', workdir: '/tmp/scratch',
  backend: 'cli', nativeOptions: { kind: 'codex', sandbox: 'read-only' },
})
```

Combining a selected Codex sandbox with bypass is an error. See
[SPEC](SPEC.md#permission-policy-and-migration) for migration, supported mappings,
ownership, errors, telemetry and session/backend requirements. These APIs
describe the source tree; published packages are not updated by a documentation
or implementation merge.

Codex app-server sessions remain **deferred/unsupported** after native
tool-containment qualification; the existing Codex CLI adapter is unchanged.
Neither official Codex SDK is enabled as a Harness session backend. See the
[qualification finding and version limits](ADAPTER-MATRIX.md#codex-app-server-unsupported-after-qualification).

### Subprocess lifecycle

Python `run()` blocks; Python `run_async()` and TypeScript `run()` / `runAsync()`
allow concurrent calls. On macOS/Linux, each invocation owns a fresh process
group, terminates leftover group members on exit, and escalates the adapter's
graceful signal (SIGTERM by default; SIGINT for Cline) to SIGKILL after a bounded grace period.

Pass `cancel=threading.Event()` in Python or `cancel: controller.signal` from
an `AbortController` in TypeScript. Explicit cancellation returns a result;
Python task cancellation propagates `CancelledError` after process cleanup.
Check `termination` for `exited`, `signaled`, `timed-out`, `cancelled`,
`launch-failed` or `callback-error`. Output is capped at 1 MiB per stream by
default; check `stdout_truncated` / `stdoutTruncated` and the stderr equivalent
before treating captured output or parsed metrics as complete.

Pass finite `stdin` text to deliver UTF-8 input followed by EOF. Optional
`on_output(chunk, stream)` / `onOutput(chunk, stream)` callbacks receive decoded
stdout/stderr chunks independently of the capture cap. Async runs await callbacks
with backpressure. Callbacks are chunks, not JSONL records or normalized events.

`inactivity_timeout_seconds` / `inactivityTimeoutSeconds` is opt-in: silence is
not failure by default. The wall timeout remains 1800 seconds unless overridden;
explicit `None` / `null` disables it. `timeout_kind` / `timeoutKind` distinguishes
wall and inactivity expiry. Callback or parser failure retains the terminal result
with `callback_error` / `callbackError` or `parse_error` / `parseError`.

See [streaming, stdin and output limits](SPEC.md#streaming-stdin-and-output-limits)
for capture controls, callback restrictions, interrupted delivery and migration.
The [ownership contract](SPEC.md#ownership-and-execution) defines cleanup and OS support.

### Controlled Pi RPC sessions

The asynchronous session API supports the Pi 0.85.1 RPC protocol in both
languages. Select an installed `@earendil-works/pi-coding-agent` executable and
your native model/config explicitly. It does not install tools or authenticate
providers. OMP RPC and other adapters are not silently treated as Pi.

```python
import asyncio
from harness import SessionSpec, open_session

async def main():
    session = await open_session(SessionSpec(
        harness="pi", backend="rpc", workdir="/tmp/scratch",
        model="openai-codex/gpt-5.4",
    ))
    try:
        turn = session.start_turn("Review this repository without editing files.")
        async for event in turn.events:
            print(event.type, event.raw)
        result = await turn.result
        print(result.status, session.reference.session_id)
        # Another start_turn after completion is a follow-up in this session.
    finally:
        await session.close()

asyncio.run(main())
```

```typescript
import { openSession } from '@twaldin/harness-ts'

const session = await openSession({
  harness: 'pi', backend: 'rpc', workdir: '/tmp/scratch',
  model: 'openai-codex/gpt-5.4',
})
try {
  const turn = session.startTurn('Review this repository without editing files.')
  for await (const event of turn.events) console.log(event.type, event.raw)
  const result = await turn.result
  console.log(result.status, session.reference.sessionId)
} finally {
  await session.close()
}
```

`interrupt()` aborts the active native turn without deleting the session.
Resume passes an explicit `session.reference` to `SessionSpec.resume`; its
native session file must exist and match both ID and workdir. Overlapping
turns, queued steering and approval responses are unsupported. Native permission
defaults remain authoritative; the example prompt is not a sandbox.

Events are bounded and must be consumed; overflow fails explicitly rather than
silently dropping events. Acknowledgement and intermediate `agent_end` events
are not completion. See [the session contract](SPEC.md#controlled-rpc-sessions)
for terminal statuses, deadlines, local-only extension limitations, ownership,
and the distinction between offline conformance and native/provider smoke.

### Optional Oh My Pi SDK sessions

Select `harness="omp", backend="sdk"` explicitly. Both languages host the
optional **OMP 18.1.14 SDK in an owned Bun >=1.3.14 child** and expose the same
turn/events/result/interrupt/close API as Pi sessions. This is a supported
Python/Node bridge, not a native Python SDK or caller-process TypeScript
embedding. Ordinary Harness imports and CLI use do not load OMP or initialize
its settings.

Install the optional package in a caller-owned project, for example
`bun add @oh-my-pi/pi-coding-agent@18.1.14`. Then supply its absolute package
directory and an explicit OMP profile:

```python
import asyncio
from pathlib import Path
from harness import OmpSdkOptions, SessionSpec, open_session

async def main():
    session = await open_session(SessionSpec(
        harness="omp", backend="sdk", workdir=Path("/tmp/scratch"),
        omp_sdk=OmpSdkOptions(
            package_root=Path("/your/project/node_modules/@oh-my-pi/pi-coding-agent"),
            agent_dir=Path("/your/omp-profile"),
            auth="environment",
        ),
        model="openai/gpt-4.1",
        # executable="/absolute/path/to/bun",  # optional, default: "bun"
    ))
    try:
        turn = session.start_turn("Review this repository without editing files.")
        async for event in turn.events:
            print(event.type, event.raw)
        result = await turn.result
        print(result.status, session.reference.session_id)
    finally:
        await session.close()

asyncio.run(main())
```

```typescript
import { openSession } from '@twaldin/harness-ts'

const session = await openSession({
  harness: 'omp', backend: 'sdk', workdir: '/tmp/scratch',
  ompSdk: {
    packageRoot: '/your/project/node_modules/@oh-my-pi/pi-coding-agent',
    agentDir: '/your/omp-profile',
    auth: 'environment',
  },
  model: 'openai/gpt-4.1',
})
try {
  const turn = session.startTurn('Review this repository without editing files.')
  for await (const event of turn.events) console.log(event.type, event.raw)
  const result = await turn.result
  console.log(result.status, session.reference.sessionId)
} finally {
  await session.close()
}
```

`"local"` auth
opens the selected profile's credential database; `"environment"` uses an
in-memory credential database. Both still honor native provider environment,
dotenv and model configuration. Set child `HOME` through `env` when needed;
the selected profile/workdir and their extensions must be trusted. Neither
mode is a sandbox, permission bypass or guarantee of no upstream state writes.

`get_session_capabilities("omp", "sdk")` /
`getSessionCapabilities("omp", "sdk")` reports events, interruption, follow-up
and exact native resume; concurrent turns and approval responses are unsupported.
No package/binary/backend fallback occurs. See the
[full SDK contract](SPEC.md#optional-omp-sdk-sessions) for configuration
precedence, disposal bounds, native event semantics and qualification limits.

### Optional Claude Agent SDK sessions

Select `harness="claude-code", backend="sdk"` explicitly. Python uses
**`claude-agent-sdk==0.2.152` with Claude Code 2.1.259**; TypeScript uses
**`@anthropic-ai/claude-agent-sdk@0.3.263` with Claude Code 2.1.263**.
Install the Python `harness-cli[claude-sdk]` extra or the TypeScript SDK
separately. Harness checks these exact pairs and never installs or falls back.
Ordinary CLI imports and capability queries do not load either SDK.

```python
from harness import ClaudeSdkOptions, SessionSpec, open_session

async def review(workdir, package_root, cli_path, config_dir):
    session = await open_session(SessionSpec(
        harness="claude-code", backend="sdk", workdir=workdir,
        model="claude-sonnet-4-6",
        claude_sdk=ClaudeSdkOptions(
            package_root=package_root, cli_path=cli_path,
            config_dir=config_dir, setting_sources=(),
        ),
    ))
    try:
        turn = session.start_turn("Review this repository without editing files.")
        async for event in turn.events:
            if event.type == "claude_permission":
                await session.respond_approval(event.request_id, "reject")
            print(event.type)
        print((await turn.result).status)
        return session.reference
    finally:
        await session.close()
```

```typescript
import { openSession } from '@twaldin/harness-ts'

async function review(workdir: string, packageRoot: string, cliPath: string, configDir: string) {
  const session = await openSession({
    harness: 'claude-code', backend: 'sdk', workdir,
    model: 'claude-sonnet-4-6',
    claudeSdk: { packageRoot, cliPath, configDir, settingSources: [] },
  })
  try {
    const turn = session.startTurn('Review this repository without editing files.')
    for await (const event of turn.events) {
      if (event.type === 'claude_permission') {
        await session.respondApproval(event.requestId!, 'reject')
      }
      console.log(event.type)
    }
    console.log((await turn.result).status)
    return session.reference
  } finally {
    await session.close()
  }
}
```

All four paths are absolute. `packageRoot` is the SDK package directory, not
its parent: Python `site-packages/claude_agent_sdk`, TypeScript
`node_modules/@anthropic-ai/claude-agent-sdk`. `cliPath` selects the native CLI;
`executable` instead selects the worker interpreter (Python's current interpreter,
or TypeScript's current Node/Bun runtime by default).

`settingSources` explicitly selects native `user`, `project`, `local` settings;
empty does not disable managed policy or all native configuration/authentication.
`settingsFile` optionally selects native `--settings`. Projected `instructions`
require the `project` source. These options and the no-edit prompt are **not a
sandbox**; existing native permission rules remain authoritative. Only
`"once"` / `"reject"` replies are supported; no implicit permission bypass.

Follow-up, interrupt receipts and exact transcript-path resume use the shared
session API. The UUID is selected at open; the native transcript path remains
null until a hook reports it, and persistence may be lazy. Native result errors,
unknown events and fields remain in `raw`. Cumulative `modelUsage` and
`total_cost_usd` estimates must not be summed across results or labelled billed
cost. See the [full Claude SDK contract](SPEC.md#optional-claude-agent-sdk-sessions)
for the intentional Python internal-protocol dependency, disposal bounds,
unsupported native features and separate synthetic/native/provider evidence.

### Optional Amp SDK sessions

Select `harness="amp", backend="sdk"` with explicit `AmpSdkOptions`.
Python, Bun and Node callers use the same isolated **Node >=22 bridge**, not
the native Python `amp-sdk`. Install/select these exact optional dependencies
in caller-owned locations:

- `@ampcode/sdk@0.1.0-20260823161614-g3631dc6`
- Amp Neo CLI `0.0.1788883237-g0b98e3`

Harness does not install, upgrade or fall back to another CLI. A conflicting
SDK-local `@ampcode/cli` dependency rejects rather than overriding `cliPath`.
The ordinary imports and CLI API need neither dependency.

```python
from pathlib import Path
from harness import AmpSdkOptions, SessionSpec, open_session

async def run_amp(workdir: Path, sdk_root: Path, cli_path: Path):
    session = await open_session(SessionSpec(
        harness="amp", backend="sdk", workdir=workdir,
        amp_sdk=AmpSdkOptions(
            package_root=sdk_root, cli_path=cli_path,
            executor="local", mode="low",
        ),
    ))
    try:
        turn = session.start_turn("Review this repository without editing files.")
        async for event in turn.events:
            print(event.type, event.raw)
        result = await turn.result
        return result, session.reference
    finally:
        await session.close()
```

```typescript
import { openSession } from '@twaldin/harness-ts'

const session = await openSession({
  harness: 'amp', backend: 'sdk', workdir: '/your/workdir',
  ampSdk: {
    packageRoot: '/your/sdk/package',
    cliPath: '/your/pinned/amp',
    executor: 'local', mode: 'low',
  },
})
try {
  const turn = session.startTurn('Review this repository without editing files.')
  for await (const event of turn.events) console.log(event.type, event.raw)
  console.log(await turn.result, session.reference)
} finally {
  await session.close()
}
```

Use absolute paths. `executable` selects Node, not Amp. Mode is explicit;
optional native effort, creation-only visibility and settings-file selection
are supported. Common model passthrough, approval replies, bypass and remote
executors reject. Native permissions/plugins/configuration/auth remain upstream.
Local means local tool execution, not offline operation: Neo's thread actor
still needs the selected Amp service. No authenticated provider success is
claimed by the synthetic conformance suite.

Save the complete reference for exact resume with matching workdir and
`AMP_URL` origin. Each turn is a finite owned SDK operation; interrupt reaps
that operation before allowing follow-up in the same thread. Native events,
usage and terminal results stay verbatim. See the
[Amp dependency, lifecycle and qualification contract](SPEC.md#optional-amp-sdk-sessions).

### Optional Cline SDK sessions

Select `harness="cline", backend="sdk"` with the official
`@cline/sdk@0.0.82` installed separately. Python and TypeScript use the same
**Node >=22.14 bridge**, not a native Python SDK or the Cline CLI.

```python
from pathlib import Path
from harness import ClineSdkOptions, SessionSpec, open_session

async def review(workdir: Path, sdk_package: Path, profile: Path):
    session = await open_session(SessionSpec(
        harness="cline", backend="sdk", workdir=workdir,
        cline_sdk=ClineSdkOptions(
            package_root=sdk_package, config_dir=profile,
            provider="openai-compatible", features="builtin-only",
            approval="callback",
        ),
    ))
    try:
        turn = session.start_turn("Review the repository without editing files.")
        async for event in turn.events:
            if event.type == "cline_permission":
                await session.respond_approval(event.raw["id"], "reject")
        return await turn.result
    finally:
        await session.close()
```

```typescript
import { openSession } from '@twaldin/harness-ts'

async function review(workdir: string, packageRoot: string, configDir: string) {
  const session = await openSession({
    harness: 'cline', backend: 'sdk', workdir,
    clineSdk: {
      packageRoot, configDir, provider: 'openai-compatible',
      features: 'builtin-only', approval: 'callback',
    },
  })
  try {
    const turn = session.startTurn('Review the repository without editing files.')
    for await (const event of turn.events) {
      if (event.type === 'cline_permission' && typeof event.raw.id === 'string') {
        await session.respondApproval(event.raw.id, 'reject')
      }
    }
    return await turn.result
  } finally {
    await session.close()
  }
}
```

Use absolute paths and a dedicated writable Cline profile with the selected
provider/model configured. Explicit `model` overrides that profile's model;
`executable` selects Node. The SDK remains local: no hub attachment/startup.
`features: "builtin-only"` deliberately excludes hooks, plugins, MCP,
subagents and other unqualified native extensions. Harness owns command
execution through the public bash hook and cancels command groups even when
the SDK worker dies. This is process ownership, not a sandbox.

The example rejects observed tool requests. Use `"once"` only after your
application approves the unchanged native request. Omitted `approval` means
`"upstream"` and retains Cline SDK's **auto-approved defaults**; no interactive
permission guarantee is implied. Native events, exact resume and per-turn/
cumulative usage remain distinct. See the
[Cline SDK contract and evidence limits](SPEC.md#optional-cline-sdk-sessions).

### Caller-owned OpenCode HTTP sessions

Select `harness="opencode", backend="rpc"` with an explicit `OpenCodeOptions`
endpoint and auth choice. The caller supplies an already-running **OpenCode
1.18.29** server and its canonical absolute workdir; Harness does not start,
configure or stop it. Python needs the optional `harness-cli[opencode]` extra
(`httpx` 0.28.x); TypeScript uses runtime `fetch`, with no OpenCode SDK dependency.

```python
from harness import OpenCodeOptions, SessionSpec, open_session

async def review(endpoint: str, server_workdir: str):
    session = await open_session(SessionSpec(
        harness="opencode", backend="rpc", workdir=server_workdir,
        opencode=OpenCodeOptions(endpoint=endpoint, auth="none"),
    ))
    try:
        turn = session.start_turn("Review the repository without editing files.")
        async for event in turn.events:
            print(event.type)
        print((await turn.result).status)
        return session.reference
    finally:
        await session.close()
```

```typescript
import { openSession } from '@twaldin/harness-ts'

async function review(endpoint: string, serverWorkdir: string) {
  const session = await openSession({
    harness: 'opencode', backend: 'rpc', workdir: serverWorkdir,
    opencode: { endpoint, auth: 'none' },
  })
  try {
    const turn = session.startTurn('Review the repository without editing files.')
    for await (const event of turn.events) console.log(event.type)
    console.log((await turn.result).status)
    return session.reference
  } finally {
    await session.close()
  }
}
```

`auth: "none"` deliberately selects an unsecured server. For Basic auth,
explicitly supply `auth: "basic"`, `username` and `password`; no credentials or
endpoint are discovered. Resume passes the exact returned reference, same
endpoint and server workdir. Only one writer may drive that native session.

Observed permission requests can be answered with `respond_approval` /
`respondApproval`, using `"once"` or `"reject"`; `"always"` is unsupported
because it changes rules shared by other clients. `interrupt()` explicitly
aborts the native turn. **Closing or timing out closes only local transport;
server work can continue.** Long-context auto-compaction and other native
synthetic follow-ups that change message ancestry are explicitly unsupported.
Mock-server conformance is not native-runtime or authenticated-provider
qualification; those checks have not run. See the
[HTTP session contract and evidence limits](SPEC.md#caller-owned-opencode-http-sessions).

---

## Who should use this

You're building any of these:

- An **eval framework** or **benchmark harness** that needs to invoke multiple CLI agents headlessly and capture cost + tokens uniformly. (See [agentelo](https://github.com/twaldin/agentelo).)
- A **prompt optimizer** that needs to run the same task against claude-code, gemini, and opencode and compare results without writing six subprocess wrappers. (See [hone](https://github.com/twaldin/hone).)
- A **coding orchestrator** that spawns agents as subprocesses, injects system prompts, and needs to swap the underlying model without touching call sites.
- An **interactive CLI wrapper** (like [flt](https://github.com/twaldin/flt)) that needs command construction (`buildCommand()`) without the subprocess execution.
- Anything that would otherwise make you write "if harness == 'claude': ... elif harness == 'gemini': ..." in multiple places.

If you're writing per-CLI subprocess plumbing from scratch, this library has already done it.

---

## Why

I wrote per-CLI spawn / env / output-parsing logic three separate times across three projects:

- [`flt`](https://github.com/twaldin/flt) — TS adapters in `src/adapters/{claude-code,opencode,codex,gemini,aider,swe-agent}.ts`. Each one knew how to launch its CLI in tmux, strip ANSI, detect a ready prompt, send keys to approve dialogs.
- [`agentelo`](https://github.com/twaldin/agentelo) — `bin/agentelo` (1847 lines of Node) with ~800 lines of `if (harness === 'X')` blocks. Per-CLI argv, env setup (Vertex tokens, GCloud, OpenAI proxy), inactivity watchdogs, six different token/cost parsers (claude's JSON envelope, codex's JSONL turn events, gemini's `stats.models`, opencode's session sqlite, aider's "Tokens: N sent" scrape, swe-agent's trajectory file).
- [`hone`](https://github.com/twaldin/hone) — `src/hone/mutators/claude_code.py`, then almost the same logic again for an `anthropic_api.py` mutator, then a `custom_script.py` shape, with the JSON parsing rewritten each time.

Three implementations, three sets of bugs, knowledge gained in one project never crossed to the others. When `opencode` changed its session DB schema, only agentelo learned. When `claude --output-format json` added a `cache_creation_input_tokens` field that mattered for accurate cost, only hone fixed it.

`harness` is the deduped version. Each CLI's quirks live in exactly one adapter file, all twenty-six adapters share the same `RunSpec → RunResult` contract, and the next consumer (TS or Python) shells out to `harness run --json` instead of starting from scratch.

---

## Examples by problem

### "Run an agent, capture cost + tokens"

```python
from pathlib import Path
from harness import RunSpec, run

result = run(RunSpec(
    harness="claude-code",
    model="sonnet",
    prompt="Fix the failing tests in this repo and report what you changed.",
    workdir=Path("/tmp/my-bug-fix-checkout"),
    timeout_seconds=1800,
))

cost = f"${result.cost_usd:.4f}" if result.cost_usd is not None else "n/a"
print(f"exit={result.exit_code} cost={cost} "
      f"tokens={result.tokens_in}/{result.tokens_out} "
      f"wall={result.duration_seconds:.1f}s")
```

### "Swap models without rewriting call sites"

```python
for spec in [
    RunSpec(harness="claude-code", model="sonnet",          prompt=task, workdir=wd),
    RunSpec(harness="opencode",    model="gpt-5.4",         prompt=task, workdir=wd),
    RunSpec(harness="gemini",      model="gemini-2.5-pro",  prompt=task, workdir=wd),
]:
    r = run(spec)
    cost = f"${r.cost_usd:.4f}" if r.cost_usd is not None else "n/a"
    print(f"{spec.harness:12} {spec.model:25} {cost}")
```

Canonical model names like `gpt-5.4` are normalized per harness at command-build time. Provider-prefixed forms are added where required (for example `opencode -> openai/gpt-5.4`, `pi -> openai-codex/gpt-5.4`) and stripped for CLIs that expect bare model IDs.
Continue instead accepts Hub `owner/package` slugs or defers to upstream config
when model is omitted. Factory preserves managed IDs and exact caller-supplied
`custom:` IDs; it does not invent a BYOK model. See the
[dated qualification ledger](ADAPTER-MATRIX.md#dated-qualification-ledger) for
installed checks, failed provider smoke and known session-helper limitations.

Resolution is intentionally best-effort, not a full provider registry. If a model/provider/harness combo resolves incorrectly for your setup, please send a small PR. These fixes should stay easy to review and easy to merge.

### "Inject a system prompt / agent guide"

```python
result = run(RunSpec(
    harness="opencode",
    model="gpt-5.4",
    prompt="Fix the failing test described in the issue.",
    workdir=Path("/tmp/repo"),
    instructions="""You are an autonomous bug-fixing agent. No human will respond.
Run the failing tests, identify the root cause, fix the source (not the tests),
verify, then stop. Make the smallest possible change.""",
    timeout_seconds=1800,
))
```

`instructions` is temporarily projected into the adapter's instruction file in
`workdir` (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `QWEN.md`, or `CONTINUE.md`).
Aider uses `.harness-aider-instructions.md` through `--read`; Continue passes its
projected file through `--rule`; swe-agent and mini-swe-agent include instructions in the prompt.
`run` restores still-owned files when execution
finishes. Use different workdirs for concurrent runs: overlapping preparation in
one canonical workdir rejects instead of mixing instructions.

### "Prepare a command for an external host"

```typescript
import { buildCommand, prepareCommand, cleanupCommand, runSubprocessAsync } from '@twaldin/harness-ts'

const command = buildCommand({
  harness: 'claude-code',
  model: 'sonnet',
  prompt: 'Fix the failing tests.',
  workdir: '/tmp/repo',
  instructions: 'You are a careful engineer.',
})
// Building does not touch the filesystem. Retain this handle until execution stops.
const prepared = prepareCommand(command)
const { cmd, args, cwd, env } = prepared.command
await runSubprocessAsync([cmd, ...args], { cwd, extraEnv: env })
// A returned outcome confirms teardown. A thrown engine error requires recovery.
cleanupCommand(prepared)
```

Python exposes the same operations as `prepare_command` and `cleanup_command`.
External tmux/PTY hosts must stop their owned process tree before cleanup.
If a projected file was edited or replaced, cleanup raises `instruction-conflict`
and keeps both the current file and the original backup for manual recovery.
It never silently overwrites those edits or steals a stale lease.

`RunSpec.executable` selects a bare binary name or absolute executable path.
`config_home` / `configHome` and `config_file` / `configFile` select absolute
upstream paths only where the adapter declares support (`configHome` maps to
`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `HERMES_HOME`, `CLINE_DIR` or `PI_CODING_AGENT_DIR`). Unsupported choices
reject; no files or credentials are copied. Omitted overrides preserve the
caller-selected environment and host-local authentication. See the
[configuration mappings and migration](SPEC.md#supported-configuration-overrides).

### "Use it as a hone mutator"

```bash
hone run prompt.md \
    --grader ./grade.sh \
    --mutator harness:claude-code:sonnet \
    --budget 20
```

---

## Install

### Python

```bash
pip install harness-cli
```

The PyPI name is `harness-cli` (`harness` was squatted). The Python import is `from harness import ...`.

For dev work:

```bash
git clone https://github.com/twaldin/harness
cd harness
pip install -e ".[dev]"
```

### TypeScript

```bash
npm install @twaldin/harness-ts
# or: bun add @twaldin/harness-ts
```

See [`ts/README.md`](ts/README.md) for full TypeScript docs.

---

## CLI use

```bash
harness list
harness run --harness opencode --model gpt-5.4 \
    --workdir /tmp/repo --instructions /tmp/agents.md \
    --timeout 1800 \
    "Fix the failing tests."

# bypass harness-specific normalization (surrounding whitespace is still trimmed)
harness run --harness pi --model openai-codex/gpt-5.4 --model-no-resolve \
    --workdir /tmp/repo \
    "Fix the failing tests."
```

Add `--json` to emit a structured RunResult on stdout:

```json
{
  "harness": "opencode",
  "model": "gpt-5.4",
  "exit_code": 0,
  "duration_seconds": 47.2,
  "cost_usd": 0.0821,
  "tokens_in": 4201,
  "tokens_out": 887,
  "timed_out": false,
  "stdout": "...",
  "stderr": ""
}
```

---

## Adapter contract

Each adapter:

1. Plans the CLI invocation for `spec.prompt` + `spec.model`, with explicit cwd/env.
2. Describes any instruction projection without creating files.
3. For `run`, prepares the workdir lease, executes through the shared subprocess
   runner, and parses output into `RunResult`.
4. Restores only still-owned instruction artifacts and releases the lease.

See [ADAPTER-MATRIX.md](ADAPTER-MATRIX.md) for per-CLI flag details, cost-reporting quirks, and output shapes.

See [SPEC.md](SPEC.md) for the full `RunSpec` / `RunResult` schema and compatibility guarantees.

---

## Workdir / worktrees

`harness` does **not** create or manage git worktrees. `workdir` is opaque — pass any directory you've set up:

- a fresh `git clone` into a tmpdir
- a `git worktree add` path
- the user's existing checkout
- a Docker volume mount

The opt-in `--worktree` features in some CLIs (e.g. `claude --worktree`) are intentionally not wrapped — they pollute the project tree and reduce consumer flexibility.

---

## Used by

- [`hone`](https://github.com/twaldin/hone) — `harness:` mutator prefix routes prompt mutations through `harness.run()`.
- [`agentelo`](https://github.com/twaldin/agentelo) — migrating from ~800 lines of per-harness TS blocks to `harness run --json`.
- [`flt`](https://github.com/twaldin/flt) — uses `@twaldin/harness-ts` for CLI command construction; flt adds tmux lifecycle on top.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for code conventions and the "add an adapter" guide (~20 minutes).

Looking for an adapter contribution? See [WANTED-ADAPTERS.md](WANTED-ADAPTERS.md) for source-qualified candidates, installation identities, headless paths, validation gaps and existing implementation tickets. Reuse the linked ticket rather than starting duplicate work; deferred candidates need fresh qualification first.

---

## Status

Twenty-six adapters are included: `claude-code`, `cline`, `openclaude`, `opencode`, `codex`, `gemini`, `aider`, `amp`, `auggie`, `swe-agent`, `mini-swe-agent`, `qwen`, `continue-cli`, `pi`, `omp`, `factory-droid`, `kilo`, `crush`, `hermes`, `goose`, `copilot`, `cursor`, `mistral-vibe`, `kimi-code`, `kiro`, `qoder`. Current package versions are recorded in [`pyproject.toml`](pyproject.toml) and [`ts/package.json`](ts/package.json).

### host Node version

This repo now includes `.nvmrc` pinned to Node `20.20.2` for interactive host usage:

```bash
cd ~/harness
nvm use
```

That helps for local dev and agent worktrees. In Docker / benchmark containers, prefer an explicit Node 20 install instead of relying on shell hooks.

### bringup helpers

Quick checks for the current gpt-5.4 harness set:

```bash
cd ~/harness
./scripts/check_binaries.sh
PYTHONPATH=src ./scripts/smoke_gpt54.py --timeout 90
```

The smoke runner asks each harness to write `hi` to `hi.txt` in cwd. If the file exists with the expected content, that harness is considered minimally alive for gpt-5.4 bringup.

It now preserves upstream permission defaults. For a deliberately isolated
Claude Code smoke requiring automatic approval, select
`--harness claude-code --permission-policy bypass` explicitly. Adapters without
a bypass mapping reject that request; the script does not silently escalate.

### model resolution policy

The current resolution layer is deliberately rough:

- optimize for common cases like `gpt-5.4`
- keep harness-specific fixes tiny
- prefer explicit escape hatches over clever inference

To bypass harness-specific normalization, use `--model-no-resolve` (Python: `RunSpec(model_no_resolve=True)`; TypeScript: `modelNoResolve: true`). Surrounding whitespace is still trimmed.

### Linux/container caveats (harness-bench)

- Upstream CLI runtime requirements are independent of the Harness package: current OpenClaude requires Node >=22; verify each selected distribution/version in the [qualification ledger](ADAPTER-MATRIX.md#dated-qualification-ledger).
- `kilo` and `crush` default to per-workdir SQLite locations and preserve caller overrides. Database telemetry requires an observed native run ID; see [identity and accounting limits](ADAPTER-MATRIX.md#opencode). Reported zero is not a billing guarantee; Crush token counters are not run totals.
- `kilo` and `crush` enforce strict same-model defaults (`model == small_model`) to avoid helper-model drift.
- `openclaude` adapter does not set `--fallback-model`; single-model runs are default.
- `factory-droid` adapter pins `--model` and `--spec-model` to the same value for fairness.
- `hermes` is a Python CLI (`hermes chat --cli --quiet --query=<prompt>`, upstream Python `>=3.11,<3.14`) installed by the [official installer](https://hermes-agent.nousresearch.com/docs/getting-started/installation/); it reports null tokens/cost, preserves stdout verbatim and exposes only `raw.session_id` from stderr. The library has no default model for it: omit `model` to use the upstream `config.yaml` selection, and pass `configHome` to select an existing `HERMES_HOME`. Optional Docker/SSH/Modal terminal backends are configured upstream by the caller.
- `cline` uses the standalone npm `cline` CLI, not the VS Code extension or background hub. It selects the local runtime and SIGINT teardown, uses caller-selected provider/model settings, and parses terminal JSON usage. Upstream defaults to auto-approval; `ClineOptions(auto_approve=False)` / `{ kind: 'cline', autoApprove: false }` explicitly requires approval, which is denied with stdin closed. See [setup, capabilities and qualification limits](ADAPTER-MATRIX.md#cline).
- `goose` uses the official native CLI's `run --quiet --output-format stream-json`. Model/provider/extensions remain caller-selected; explicit bypass sets child `GOOSE_MODE=auto`. Usage comes from the final `complete` event, and provider errors can still exit zero. Configured stdio MCP extensions use separate process groups and can survive cancellation on macOS; see [setup and qualification limits](ADAPTER-MATRIX.md#goose).
- `copilot` uses the current official `@github/copilot` CLI, not `gh copilot`. It preserves native model/auth selection and JSONL events, supports explicit `CopilotOptions` tool allow/deny rules, and leaves token/USD totals null. See [setup, subscription requirements and qualification limits](ADAPTER-MATRIX.md#copilot).
  The optional Copilot SDK backend is **deferred/unsupported** after native forced-cleanup qualification; this does not remove the CLI adapter. See the [SDK finding and version limits](ADAPTER-MATRIX.md#copilot-sdk-unsupported-after-qualification).
- `amp` runs local execute mode with JSONL events, not remote orbs. Direct model selection rejects; `AmpOptions.mode` selects an upstream mode and `configFile` selects user settings. Thread identity and native failures stay in raw; provider errors can exit zero. See [permissions, accounting and coverage](ADAPTER-MATRIX.md#amp).
- `mistral-vibe` uses official Python package `mistral-vibe`, executable `vibe`, with completed-history JSONL output. Models remain native config aliases, and workspace trust is explicit via `VibeOptions`; instructions require that opt-in. See [setup, permissions and coverage](ADAPTER-MATRIX.md#mistral-vibe).
- `cursor` uses the standalone Cursor `agent` CLI in print/stream-JSON mode, not the editor's `cursor` launcher. Model/auth/config remain native; only explicit bypass adds `--force`. See [permissions, optional usage and qualification limits](ADAPTER-MATRIX.md#cursor).
- `mini-swe-agent` invokes native `mini`, separately from the legacy `swe-agent` wrapper. Onboarding is disabled in the child; tool approval remains explicit. It reads only a trajectory confirmed by the current CLI output. Local shell actions can escape CLI-group cancellation. See [setup, permissions, extraction and coverage](ADAPTER-MATRIX.md#mini-swe-agent).
- `kiro` uses official `kiro-cli` headless V2 with JSONL events. Tool trust is explicit through `KiroOptions`; bypass alone grants all tools. Model/auth remain caller-selected, and token/USD totals remain null. See [setup, migration and coverage](ADAPTER-MATRIX.md#kiro).
- `auggie` uses official `@augmentcode/auggie` in print/JSON mode. A configured Augment account and noninteractive entitlement are required; JSON-native completion/error records remain in `raw`, while authentication, entitlement and other non-JSON failures remain in process status and `stderr`. Credits are never converted to USD. See [setup, permissions and qualification limits](ADAPTER-MATRIX.md#auggie).
- `kimi-code` invokes maintained `@moonshot-ai/kimi-code` (`kimi`), not the Python predecessor. **Print mode always uses native auto permissions**; explicit bypass is unsupported rather than silently dropped. Exact model aliases and `KIMI_CODE_HOME` remain caller-selected. JSONL assistant/tool messages remain in `raw`, with null accounting. Source/fixture qualification only; no installed/provider smoke. See [setup and limits](ADAPTER-MATRIX.md#kimi-code).
- `qoder` uses official `@qoder-ai/qodercli` with JSON output. `QoderOptions(permission_mode="accept_edits")` / `{kind: 'qoder', permissionMode: 'accept_edits'}` approves workspace edits, not shell commands. Model, `QODER_CONFIG_DIR` and account auth remain caller-selected; metrics stay null. See [setup, prompt compatibility and provider-smoke gaps](ADAPTER-MATRIX.md#qoder).

Pending:
- Per-harness inactivity watchdogs (port from `agentelo/bin/agentelo`).
- Vertex AI / GCloud token plumbing (currently consumer-supplied via `env`).
- Wire as the spawn backend for flt and agentelo (TS → Python subprocess boundary; design TBD).
