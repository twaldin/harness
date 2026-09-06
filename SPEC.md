# harness — specification

This is the shared contract for `harness` (Python) and `@twaldin/harness-ts` (TypeScript). Consumers (hone, agentelo, flt) depend on cross-language parity. Current implementation differences are noted below and in [CLAUDE.md](CLAUDE.md#dual-language-parity-contract); the contract remains the parity target.

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
│   └── _subproc.py         (shared helpers)
└── ts/                     (typescript, new)
    ├── package.json        (@twaldin/harness-ts)
    ├── src/base.ts
    ├── src/registry.ts
    ├── src/adapters/*.ts
    └── src/subproc.ts
```

Version lockstep is the documented release requirement (see [Versioning](#versioning)). The current manifests are not aligned. The checked-in GitHub workflows publish each language separately and check its version against its own tag; they do not enforce cross-language API equivalence on PRs.

---

## Public API

The core headless API is described here. The packages also expose instruction-projection, pricing and session helpers; their complete export surfaces differ. See `src/harness/__init__.py` and `ts/src/index.ts`.

### Types

```ts
// RunSpec — everything an adapter needs to invoke its CLI
interface RunSpec {
  harness: string                  // "claude-code" | "openclaude" | "factory-droid" | "codex" | "gemini" | "opencode" | "aider" | "swe-agent" | "qwen" | "continue-cli" | "pi" | "crush" | "kilo"
  prompt: string                   // the task (becomes positional arg or stdin)
  workdir: string                  // absolute path; cwd for the subprocess
  model?: string                   // canonical or adapter-specific identifier (normalized per harness; see ADAPTER-MATRIX.md)
  instructions?: string            // content written to per-harness instructions file
  timeoutSeconds?: number          // default 1800
  env?: Record<string, string>     // extra env vars merged onto process.env
  modelNoResolve?: boolean         // optional escape hatch: pass model through exactly as provided
}

// BuildCommand — what to invoke, without invoking it (for interactive consumers like flt)
interface BuildCommand {
  cmd: string                      // executable name, e.g. "claude", "codex"
  args: string[]                   // full argv tail
  cwd: string                      // resolved workdir
  env: Record<string, string>      // adapter-specified env additions (merge w/ process.env at exec time)
  instructionsFile: string | null  // adapter wrote content here, null if no instructions
}

// RunResult — after execution + output parsing
interface RunResult {
  harness: string
  model: string | null
  exitCode: number                 // -1 on timeout
  durationSeconds: number
  stdout: string
  stderr: string
  timedOut: boolean
  costUsd: number | null           // null if adapter can't report cost
  tokensIn: number | null
  tokensOut: number | null
  raw: unknown | null              // adapter-specific structured payload (parsed JSON)
}
```

(Python equivalents are dataclasses with snake_case fields, such as `exit_code` and `cost_usd`; the TypeScript examples below use camelCase. The Python CLI's JSON output uses snake_case and omits `raw`.)

### Functions

```ts
// List all registered adapter names.
listAdapters(): string[]

// Build the command WITHOUT executing. Writes the instructions file to workdir
// as a side effect (consumers expect this — it's part of the "prepare workdir" step).
buildCommand(spec: RunSpec): BuildCommand

// Parse adapter output after execution. Called by run() internally, also callable
// standalone by interactive consumers (flt) that exec'd the command themselves via tmux.
parseOutput(spec: RunSpec, outcome: SubprocOutcome): {
  costUsd: number | null
  tokensIn: number | null
  tokensOut: number | null
  raw: unknown | null
}

// Where SubprocOutcome = { exitCode, durationSeconds, stdout, stderr, timedOut }

// Full headless invocation — buildCommand + exec + parseOutput. Blocks until complete.
// py: synchronous (returns RunResult directly); ts: Promise<RunResult>, but synchronous subprocess execution blocks the event loop
run(spec: RunSpec): Promise<RunResult>

// Non-blocking headless invocation — same as run() but uses async subprocess execution.
// Multiple runAsync() calls can run concurrently without blocking each other.
// py: coroutine (asyncio.create_subprocess_exec); ts: Promise wrapping Node spawn()
runAsync(spec: RunSpec): Promise<RunResult>  // py: async def run_async(spec) -> RunResult
```

### Errors

Both raise `HarnessError` (py) / throw `HarnessError` (ts) on:
- unknown harness name
- adapter prerequisites missing (e.g. swe-agent wrapper not on disk)
- duplicate adapter registration

**Current registration skew:** TypeScript rejects any duplicate name. Python
allows idempotently registering the same class again and rejects a different
class under an existing name.

Subprocess failures (non-zero exit, timeout) do NOT throw — they're reflected in RunResult.

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
| `buildCommand(spec)` | returns `{cmd, args, cwd, env, instructionsFile}` |
| `parseOutput(spec, outcome)` | returns `{costUsd, tokensIn, tokensOut, raw}` |

`buildCommand` MAY write files (instructions, config) but MUST NOT fork a subprocess.
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
    "args": ["-p", "fix the bug in main.py", "--model", "sonnet", "--output-format", "json", "--dangerously-skip-permissions", "--append-system-prompt", "You are a careful engineer.\n"],
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

Adapters MAY set env vars (for example `OPENCODE_DB`, `KILO_DB`, `KILO_CONFIG_CONTENT`, `CLAUDE_CODE_USE_OPENAI`; `swe-agent` also reads `SWE_WRAPPER`). These go in `BuildCommand.env`. The caller merges `env` onto `process.env` at exec time.

Adapters MUST NOT read env vars for USER secrets (API keys). Those are user-env responsibility. If an adapter needs an API key, it expects the caller to have set it (e.g. `ANTHROPIC_API_KEY`, `GOOGLE_CLOUD_PROJECT`).

Exception: `extraEnv` from RunSpec.env is always passed through unchanged.

---

## Registry behavior

The registry contract is import-time registration of all shipped adapters, with the sorted list below. TypeScript implements it at the package entrypoint.

**Current Python skew:** importing `harness` alone does not populate its registry.
Import `harness.adapters` before calling `list_adapters()` or
`harness.registry.get_adapter()` in a fresh process. The command-build, parse
and run entrypoints import adapters lazily; TypeScript's package entrypoint
registers them immediately.

```
["aider", "claude-code", "codex", "continue-cli", "crush", "factory-droid", "gemini", "kilo", "openclaude", "opencode", "pi", "qwen", "swe-agent"]
```

(sorted, locale-independent)

Adapter lookup is case-sensitive. `"Claude-Code"` → `HarnessError`.

---

## What harness does NOT ship

Explicit non-goals, to keep the library narrow:

- tmux lifecycle, pane capture and polling — **the consumer's job**; TypeScript adapters expose optional pure pane-status/dialog helpers, but the consumer drives capture and sends any returned keystrokes
- challenge seeding, grading, ELO — **agentelo's job**
- prompt mutation, GEPA, training loops — **hone's job**
- Vertex/OAuth proxy shims, regional routing — **agentelo's job** (context-specific, varies by billing arrangement)
- Streaming callbacks (`onOutput`) — not implemented; use `run_async()` / `runAsync()` for non-blocking subprocess execution without streaming callbacks

Harness provides CLI command construction, output parsing and headless execution, plus instruction-projection, pricing and session helpers. It does not own the consumer's terminal lifecycle.

---

## Compatibility guarantees

- Field names in RunSpec/RunResult are STABLE. Adding fields is non-breaking; renaming/removing is a major version bump.
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
