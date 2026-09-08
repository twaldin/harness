# @twaldin/harness-ts

TypeScript SDK for [harness](../) — invoke claude-code, openclaude, opencode, codex, gemini, aider, swe-agent, qwen, continue-cli, pi, factory-droid, crush, or kilo as a subprocess with a uniform RunSpec → RunResult contract.

## Install

```bash
npm install @twaldin/harness-ts
# or: bun add @twaldin/harness-ts
```

The package ships ESM only. Use a Node version supported by the installed `better-sqlite3` dependency. The `better-sqlite3@12.9.0` package selected by `bun.lock` declares `engines.node` as `20.x || 22.x || 23.x || 24.x || 25.x`, not Node 18. Bun is used for the repository's build and test commands.

For frontier adapters in containers, prefer Node `>=20` (`openclaude`, `factory-droid`, `kilo` upstream CLIs require modern Node runtimes).

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
Backend selection defaults to `cli`; selecting `rpc` or `sdk` currently throws
`HarnessError` with `code === 'unsupported-backend'`, without CLI fallback.
See the [shared migration and examples](../SPEC.md#permission-policy-and-migration).

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

Returns registered adapter names, sorted: `['aider', 'claude-code', 'codex', 'continue-cli', 'crush', 'factory-droid', 'gemini', 'kilo', 'openclaude', 'opencode', 'pi', 'qwen', 'swe-agent']`.

### `getCapabilities(name: string, backend?: Backend): Capabilities`

Reports implemented support without loading optional SDKs or probing local
installation/auth. All current adapters use CLI and support cancellation;
streaming and controlled sessions remain unsupported. Pure pane/session-log
helpers are not controlled sessions. Native options are typed per agent:

```typescript
buildCommand({
  harness: 'codex', prompt: 'Review the changes', workdir: '/tmp/repo',
  nativeOptions: { kind: 'codex', sandbox: 'read-only' },
})
```

Codex sandbox and bypass conflict. `ClaudeCodeOptions` instead exposes `effort`;
a mismatched native option kind is an error, not a dropped option.

---

## Types

```typescript
interface RunSpec {
  harness: string            // "claude-code" | "openclaude" | "factory-droid" | "codex" | "gemini" | "opencode" | "aider" | "swe-agent" | "qwen" | "continue-cli" | "pi" | "crush" | "kilo"
  prompt: string
  workdir: string            // normalized absolute cwd; must exist when prepared
  model?: string             // canonical or adapter-specific (normalized per harness; see ADAPTER-MATRIX.md)
  instructions?: string      // temporarily projected while the prepared command is owned
  timeoutSeconds?: number    // default 1800
  env?: Record<string, string>
  modelNoResolve?: boolean   // skip harness-specific normalization (input is still trimmed)
  backend?: 'cli' | 'rpc' | 'sdk' // default cli; rpc/sdk unsupported today
  permissionPolicy?: 'upstream' | 'bypass' // default upstream
  nativeOptions?: NativeOptions // ClaudeCodeOptions | CodexOptions
  executable?: string       // bare name or absolute path
  configHome?: string       // caller-selected absolute upstream state home
  configFile?: string       // caller-selected absolute upstream config file
  cancel?: AbortSignal       // abort returns a cancelled result after cleanup
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
  costUsd: number | null     // reported or estimated cost; null when unavailable
  tokensIn: number | null
  tokensOut: number | null
  raw: unknown | null        // adapter-specific parsed payload
}
```

Headless `parseOutput` returns null cost for codex, aider and qwen. Gemini estimates cost from token totals and the first model in `stats.models` when pricing is known. Other adapters read reported cost from stdout, trajectory files or session databases where available. Session-log helpers may also derive estimates and need not match headless parsing. See [ADAPTER-MATRIX.md](../ADAPTER-MATRIX.md) for details.

---

## Errors

`HarnessError` exposes a stable `code` for unknown adapters, conflicting
registration, invalid options, unsupported backends/capabilities and adapter
prerequisites. Re-registering the same adapter object is idempotent.
See [SPEC errors](../SPEC.md#errors) for the exact codes.

Non-zero exit, timeout, explicit cancellation and OS launch failure are surfaced
in `RunResult`. `termination` distinguishes `exited`, `signaled`, `timed-out`,
`cancelled` and `launch-failed`; `signal` and `launchError` retain signal names
and OS error codes. See [ownership and execution](../SPEC.md#ownership-and-execution)
for the macOS/Linux cleanup boundary and compatibility details.

---

## Shared context

- [SPEC.md](../SPEC.md) — shared contract and current cross-language differences
- [ADAPTER-MATRIX.md](../ADAPTER-MATRIX.md) — per-CLI flags, cost-reporting quirks, output shapes
- [CONTRIBUTING.md](../CONTRIBUTING.md) — adding a new adapter
