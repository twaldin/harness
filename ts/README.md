# @twaldin/harness-ts

TypeScript SDK for [harness](../) — invoke claude-code, cline, openclaude, opencode, codex, gemini, aider, amp, auggie, swe-agent, mini-swe-agent, qwen, continue-cli, pi, omp, factory-droid, crush, kilo, hermes, goose, copilot, cursor, mistral-vibe, kimi-code, kiro, or qoder as a subprocess with a uniform RunSpec → RunResult contract.

## Install

```bash
npm install @twaldin/harness-ts
# or: bun add @twaldin/harness-ts
```

The package ships ESM only. Use a Node version supported by the installed `better-sqlite3` dependency. The `better-sqlite3@12.9.0` package selected by `bun.lock` declares `engines.node` as `20.x || 22.x || 23.x || 24.x || 25.x`, not Node 18. Bun is used for the repository's build and test commands.

Upstream CLI runtime requirements are independent of this package. Current OpenClaude requires Node >=22; check the selected version in the [qualification ledger](../ADAPTER-MATRIX.md#dated-qualification-ledger), which distinguishes installed help checks from provider smoke and synthetic fixtures.

## First example

```typescript
import { run } from '@twaldin/harness-ts'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const wd = mkdtempSync(join(tmpdir(), 'harness-'))

const r = await run({
  harness: 'claude-code',
  model: 'sonnet',
  prompt: "Write a one-line TypeScript hello-world.",
  workdir: wd,
})

const cost = r.costUsd == null ? 'n/a' : `$${r.costUsd.toFixed(4)}`
console.log(`exit=${r.exitCode}  cost=${cost}  tokens=${r.tokensIn}/${r.tokensOut}`)
console.log(r.stdout.slice(0, 200))
```

See [`examples/hello-world.ts`](examples/hello-world.ts) for a runnable file.

Permission policy defaults to upstream behavior; Harness no longer injects
approval/bypass flags automatically. Unattended callers intentionally requiring
the former behavior must set `permissionPolicy: 'bypass'`. Codex bypass also
disables sandboxing. Unsupported bypass fails rather than being ignored.
One-shot backend selection defaults to `cli`; selecting `rpc` or `sdk` through
`RunSpec` throws `unsupported-backend`, without CLI fallback. Controlled Pi RPC
uses `openSession` below. See the [shared migration](../SPEC.md#permission-policy-and-migration).

## Controlled RPC sessions

`openSession({ harness: 'pi', backend: 'rpc', workdir, model? })` opens a native
Pi 0.85.1 RPC subprocess. `getSessionCapabilities('pi')` reports session
operations independently of one-shot capabilities. Install/select the official
`@earendil-works/pi-coding-agent` executable and configure its provider first;
the library does neither and does not fall back to OMP or another backend.

`session.startTurn(prompt)` returns `{ id, events, result }`: consume the bounded
async `events` iterable, then await the terminal `result`. A subsequent turn
reuses the native session; overlapping turns are rejected. `interrupt()` stops
the active turn, and `close()` disposes owned resources without deleting history.
Always close in `finally`. Explicit resume supplies `session.reference` through
`resume`; the file must exist and match its native ID/workdir.

See the [paired runnable usage](../README.md#controlled-pi-rpc-sessions) and
[full session contract](../SPEC.md#controlled-rpc-sessions) for typed events,
errors, bounded output, deadlines, local-only extension limitations, and the
separate offline/native/provider qualification evidence.

## Optional OMP SDK backend

`openSession({ harness: 'omp', backend: 'sdk', workdir, ompSdk })` uses the same
session operations through an owned Bun bridge. `ompSdk` requires absolute
`packageRoot` and `agentDir` paths and `auth: 'local' | 'environment'`.
Install `@oh-my-pi/pi-coding-agent@18.1.14` separately; the bridge requires
Bun >=1.3.14 (`executable` selects it, default `bun`). Neither CLI execution nor
ordinary imports load/configure the SDK.

This works from Node or Bun and has a matching Python bridge; it is not SDK
embedding into the caller's process. `local` auth opens the selected profile's
credential DB; `environment` uses an in-memory DB. Both honor native provider
environment/dotenv/models.yml resolution. Native configuration/tools are not
a sandbox. Always close in `finally`; resume passes the exact native reference.
See the [paired SDK examples](../README.md#optional-oh-my-pi-sdk-sessions) and
[SDK contract](../SPEC.md#optional-omp-sdk-sessions).

## Caller-owned OpenCode HTTP backend

`openSession({ harness: 'opencode', backend: 'rpc', workdir, opencode })`
connects to an already-running OpenCode **1.18.29** server. `opencode` requires
an explicit HTTP(S) origin and `auth: 'none' | 'basic'`; Basic also requires
`username` and `password`. `workdir` is the server's canonical absolute path,
not a local directory to discover or create.

Node and Bun use standard `fetch`; no optional SDK is loaded. Resume uses the
exact reference, endpoint and directory. Permission replies support only
`'once'` and `'reject'`. Close/timeout release local HTTP/SSE connections without
aborting server work, deleting history or disposing the caller's server.
Call `interrupt()` first when a confirmed native stop is needed.

The shared mock suite does not qualify a native OpenCode runtime or authenticated
provider; those checks have not run. See the
[paired examples](../README.md#caller-owned-opencode-http-sessions) and
[full contract](../SPEC.md#caller-owned-opencode-http-sessions), including
single-writer and auto-compaction limits.

## API reference

### `run(spec: RunSpec): Promise<RunResult>`

Full headless invocation: builds the command, executes it asynchronously, and parses output. `run()` and `runAsync()` both permit concurrent calls and accept `cancel: AbortSignal`.

```typescript
import { run } from '@twaldin/harness-ts'

const r = await run({
  harness: 'opencode',
  model: 'gpt-5.4',
  prompt: 'Fix the failing tests.',
  workdir: '/tmp/repo',
  instructions: 'You are an autonomous bug-fixing agent.',
  timeoutSeconds: 1800,
})

const cost = r.costUsd == null ? 'n/a' : `$${r.costUsd.toFixed(4)}`

if (r.timedOut) console.error('timed out')
else console.log(`done — exit ${r.exitCode}, ${cost}`)
```

### `runAsync(spec: RunSpec): Promise<RunResult>`

Same asynchronous execution and cleanup as `run()`. Multiple calls can run concurrently:

```typescript
import { runAsync } from '@twaldin/harness-ts'

const [r1, r2] = await Promise.all([
  runAsync({ harness: 'claude-code', model: 'sonnet',         prompt: task, workdir: wd1 }),
  runAsync({ harness: 'gemini',      model: 'gemini-2.5-pro', prompt: task, workdir: wd2 }),
])
```

### `buildCommand(spec: RunSpec): BuildCommand`

Plans the command **without executing or writing files**. External host drivers
must prepare the command and retain its ownership handle until execution stops.

```typescript
import { buildCommand, prepareCommand, cleanupCommand, runSubprocessAsync } from '@twaldin/harness-ts'

const command = buildCommand({
  harness: 'claude-code',
  model: 'sonnet',
  prompt: 'Fix the failing tests.',
  workdir: '/tmp/repo',
  instructions: 'You are a careful engineer.',
})
const prepared = prepareCommand(command)
const { cmd, args, cwd, env } = prepared.command
await runSubprocessAsync([cmd, ...args], { cwd, extraEnv: env })
// A returned outcome confirms teardown. A thrown engine error requires recovery.
cleanupCommand(prepared)
```

`run` and `runAsync` prepare and clean up automatically. Same-workdir overlap,
unsafe symlinks, or changed projected files raise `instruction-conflict`.
Cleanup preserves changed user content and the original backup for manual recovery;
it never takes over an existing lease. Use distinct workdirs for concurrent runs.

`executable` selects a binary name or absolute executable path. `configHome`
and `configFile` select supported absolute upstream paths without reading/copying
configuration or credentials. Unsupported mappings reject; see
[SPEC](../SPEC.md#supported-configuration-overrides) for support and migration.

### `parseOutput(spec: RunSpec, outcome: SubprocOutcome): ParsedOutput`

Parses adapter output after execution. Call standalone when you've already executed the command (e.g. via tmux) and just need tokens/cost extracted.

### `listAdapters(): string[]`

Returns registered adapter names, sorted: `['aider', 'amp', 'auggie', 'claude-code', 'cline', 'codex', 'continue-cli', 'copilot', 'crush', 'cursor', 'factory-droid', 'gemini', 'goose', 'hermes', 'kilo', 'kimi-code', 'kiro', 'mini-swe-agent', 'mistral-vibe', 'omp', 'openclaude', 'opencode', 'pi', 'qoder', 'qwen', 'swe-agent']`.

### `getCapabilities(name: string, backend?: Backend): Capabilities`

Reports implemented support without loading optional SDKs or probing local
installation/auth. All one-shot adapters use CLI and support cancellation and
chunk streaming (raw subprocess output, not structured events). Controlled
Pi RPC uses `getSessionCapabilities` instead; pure pane/session-log helpers are
not controlled sessions. Native CLI options are typed per agent:

```typescript
buildCommand({
  harness: 'codex', prompt: 'Review the changes', workdir: '/tmp/repo',
  nativeOptions: { kind: 'codex', sandbox: 'read-only' },
})
```

Codex sandbox and bypass conflict. `ClaudeCodeOptions` exposes `effort`.
`ClineOptions` exposes `provider` and `autoApprove`; an explicit `autoApprove`
conflicts with bypass. Cline defaults to upstream auto-approval, so use
`nativeOptions: { kind: 'cline', autoApprove: false }` to request per-run denial
of tools requiring approval when stdin is closed. A mismatched native kind is an error.

---

## Types

```typescript
interface RunSpec {
  harness: string            // registered adapter name; see listAdapters()
  prompt: string
  workdir: string            // normalized absolute cwd; must exist when prepared
  model?: string             // canonical or adapter-specific (normalized per harness; see ADAPTER-MATRIX.md)
  instructions?: string      // temporarily projected while the prepared command is owned
  timeoutSeconds?: number | null // default 1800; null disables wall timeout
  env?: Record<string, string>
  modelNoResolve?: boolean   // skip harness-specific normalization (input is still trimmed)
  backend?: 'cli' | 'rpc' | 'sdk' // default cli; rpc/sdk unsupported today
  permissionPolicy?: 'upstream' | 'bypass' // default upstream
  nativeOptions?: NativeOptions // ClaudeCodeOptions | CodexOptions | ClineOptions | CopilotOptions | AmpOptions | VibeOptions | KiroOptions | QoderOptions
  executable?: string       // bare name or absolute path
  configHome?: string       // caller-selected absolute upstream state home
  configFile?: string       // caller-selected absolute upstream config file
  cancel?: AbortSignal       // abort returns a cancelled result after cleanup
  stdin?: string | null      // finite UTF-8 payload then EOF; no newline added
  onOutput?: (chunk: string, stream: 'stdout' | 'stderr') => void | Promise<void>
  inactivityTimeoutSeconds?: number // positive finite seconds; disabled by default
  maxOutputBytes?: number    // per-stream raw prefix cap; default 1048576
}

interface RunResult {
  harness: string
  model: string | null
  exitCode: number           // -1 for timeout/cancel/launch failure; termination disambiguates
  durationSeconds: number
  stdout: string
  stderr: string
  timedOut: boolean
  termination?: Termination | null
  signal?: string | null
  launchError?: string | null
  stdoutBytes?: number       // all raw bytes read, including discarded bytes
  stderrBytes?: number
  stdoutTruncated?: boolean  // cap exceeded or pipe force-closed
  stderrTruncated?: boolean
  timeoutKind?: 'wall' | 'inactivity' | null
  callbackError?: string | null
  parseError?: string | null
  costUsd: number | null     // reported or estimated cost; null when unavailable
  tokensIn: number | null
  tokensOut: number | null
  raw: unknown | null        // adapter-specific parsed payload
}
```

Headless `parseOutput` returns null cost for codex, aider and qwen, and null cost and tokens for hermes (its stdout is preserved verbatim and never parsed; `raw` only carries a `session_id` read from stderr). Gemini estimates cost from token totals and the first model in `stats.models` when pricing is known. Other adapters read reported cost from stdout, trajectory files or session databases where available. Session-log helpers may also derive estimates and need not match headless parsing. See [ADAPTER-MATRIX.md](../ADAPTER-MATRIX.md) for details.

Goose reads optional cumulative usage from the last `complete` JSONL event.
Its provider failures can emit `error` and still exit zero; inspect `raw`.
Configuration and detached stdio-extension cleanup limits are explicit in the
[Goose reference](../ADAPTER-MATRIX.md#goose).

Copilot also reports null token/USD totals, retaining its native JSONL events in
`raw`. It uses `@github/copilot`, not `gh copilot`, and exposes explicit
`{kind: 'copilot', allowTools: ['shell(git status)'], denyTools: ['write']}`.
See [setup and coverage](../ADAPTER-MATRIX.md#copilot).
The optional Copilot SDK backend is **deferred/unsupported** after native
forced-cleanup qualification; the CLI adapter remains shipped. See the
[SDK finding and version limits](../ADAPTER-MATRIX.md#copilot-sdk-unsupported-after-qualification).

Amp runs local execute mode, not remote orbs. Omit `model`; use
`{kind: 'amp', mode: 'low'}` for upstream mode selection and `configFile` for
custom user settings. `raw` retains native thread identity and failures, which
can accompany process exit zero. See [permissions, accounting and coverage](../ADAPTER-MATRIX.md#amp).

Mistral Vibe uses `vibe --output streaming`, preserving completed history entries
with null token/cost totals. `nativeOptions: {kind: 'mistral-vibe', agent: 'ask',
trust: true}` selects the native agent and explicitly trusts workspace config for
this run. Nonempty instructions require `trust: true`. Model aliases use child
`VIBE_ACTIVE_MODEL`, not a CLI model flag. See [setup and limits](../ADAPTER-MATRIX.md#mistral-vibe).

`mini-swe-agent` invokes native `mini`, not the legacy `swe-agent` wrapper.
It preserves native model/config selection and adds `--yolo` only for explicit
bypass. Current-run-confirmed trajectory JSON supplies metrics and raw output;
partial unconfirmed artifacts are not reused. Native local shell actions can
survive CLI-group cancellation. See [setup and limits](../ADAPTER-MATRIX.md#mini-swe-agent).

Kimi Code uses maintained `kimi --output-format stream-json --prompt=PROMPT`.
**Native print mode implies auto permissions**; explicit `bypass` rejects.
Model aliases pass through after trimming; omitted model uses upstream config.
`configHome` maps to `KIMI_CODE_HOME`; arbitrary `configFile` is unsupported.
Assistant/tool JSONL objects remain in `raw`; token/USD totals stay null.
No installed/provider smoke is claimed. See [setup and limits](../ADAPTER-MATRIX.md#kimi-code).

Kiro uses `kiro-cli chat --no-interactive --agent-engine v2 --output-format stream-json`.
`nativeOptions: {kind: 'kiro', trustTools: 'read,grep', requireMcpStartup: true}`
selects a trusted tool subset and requires configured MCP servers to start.
Empty `trustTools: ''` trusts no tools. Bypass grants all tools and conflicts with `trustTools`. Model IDs pass through;
omitting one uses upstream selection. Complete object events remain in `raw`,
with null token/USD totals. See [setup and limits](../ADAPTER-MATRIX.md#kiro).

Qoder uses `qoder --print --output-format json --input-format text --max-turns 20`.
`nativeOptions: {kind: 'qoder', permissionMode: 'accept_edits'}` explicitly
approves safe workspace edits, not shell commands. `default` and `dont_ask`
are also supported; omission preserves upstream policy and bypass rejects.
Model IDs and caller-selected `QODER_CONFIG_DIR`/authentication are preserved.
Native result objects remain in `raw`, with null tokens/USD. Host-driven
stream-json approvals are unsupported. See [setup and limits](../ADAPTER-MATRIX.md#qoder).

Cursor uses the standalone `agent` executable with print/stream-JSON output.
Only explicit bypass adds `--force`; model/auth/config remain caller-selected.
See [optional usage, permissions and qualification limits](../ADAPTER-MATRIX.md#cursor).

### Streaming and bounded capture

`run` and `runAsync` deliver decoded stdout/stderr chunks to `onOutput` and await
returned Promises with backpressure. UTF-8 split across reads stays intact;
JSONL records may span callbacks. Keep callback work cooperative: synchronous
event-loop blocking cannot be preempted. The low-level blocking `runSubprocess`
rejects callbacks; use `runSubprocessAsync` instead.

Capture keeps the first 1 MiB of raw bytes per stream by default. Raise
`maxOutputBytes` for larger terminal JSON envelopes, or consume callbacks.
Zero keeps no text but still drains output and delivers callbacks. Check
`stdoutTruncated` / `stderrTruncated` before treating output or metrics as complete;
the flags are metadata, not text inserted into structured output.

`stdin` is a finite string followed by EOF, not an interactive approval channel.
Inactivity is opt-in and excludes callback backpressure; wall timeout and abort
remain active while an async callback is pending. Callback delivery cannot extend
the bounded teardown deadline: interrupted delivery is reported in `callbackError`.
See the [shared streaming contract](../SPEC.md#streaming-stdin-and-output-limits)
for byte counts, decoding, callback failure and migration.

---

## Errors

`HarnessError` exposes a stable `code` for unknown adapters, conflicting
registration, invalid options, unsupported backends/capabilities and adapter
prerequisites. Re-registering the same adapter object is idempotent.
See [SPEC errors](../SPEC.md#errors) for the exact codes.

Non-zero exit, timeout, explicit cancellation, OS launch failure and callback
failure are surfaced in `RunResult`. `termination` distinguishes `exited`,
`signaled`, `timed-out`, `cancelled`, `launch-failed` and `callback-error`;
`signal` and `launchError` retain signal names and OS error codes.
Execution retains parser exceptions in `parseError` with null metrics/raw
without losing the terminal output; standalone `parseOutput` still throws.
See [ownership and execution](../SPEC.md#ownership-and-execution) for cleanup limits.

---

## Shared context

- [SPEC.md](../SPEC.md) — shared contract and current cross-language differences
- [ADAPTER-MATRIX.md](../ADAPTER-MATRIX.md) — per-CLI flags, cost-reporting quirks, output shapes
- [CONTRIBUTING.md](../CONTRIBUTING.md) — adding a new adapter
