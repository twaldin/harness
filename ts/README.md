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

## API reference

### `run(spec: RunSpec): Promise<RunResult>`

Full headless invocation: builds the command, executes it as a subprocess, parses output. Although it returns a Promise, `run()` uses synchronous subprocess execution and blocks the event loop until the agent exits or times out. Use `runAsync()` for concurrent calls.

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

if (r.timedOut) console.error('timed out')
else console.log(`done — exit ${r.exitCode}, $${r.costUsd?.toFixed(4)}`)
```

### `runAsync(spec: RunSpec): Promise<RunResult>`

Same as `run()`, but uses async subprocess execution. Multiple `runAsync()` calls can run concurrently:

```typescript
import { runAsync } from '@twaldin/harness-ts'

const [r1, r2] = await Promise.all([
  runAsync({ harness: 'claude-code', model: 'sonnet',         prompt: task, workdir: wd1 }),
  runAsync({ harness: 'gemini',      model: 'gemini-2.5-pro', prompt: task, workdir: wd2 }),
])
```

### `buildCommand(spec: RunSpec): BuildCommand`

Builds the command **without executing**. Writes the instructions file to `workdir` as a side effect. Use this when you manage subprocess execution yourself (e.g. flt's tmux integration).

```typescript
import { buildCommand } from '@twaldin/harness-ts'

const { cmd, args, cwd, env, instructionsFile } = buildCommand({
  harness: 'claude-code',
  model: 'sonnet',
  prompt: 'Fix the failing tests.',
  workdir: '/tmp/repo',
  instructions: 'You are a careful engineer.',
})
// cmd = 'claude', args = ['-p', 'Fix the failing tests.', '--model', 'sonnet', ...]
```

### `parseOutput(spec: RunSpec, outcome: SubprocOutcome): ParsedOutput`

Parses adapter output after execution. Call standalone when you've already executed the command (e.g. via tmux) and just need tokens/cost extracted.

### `listAdapters(): string[]`

Returns registered adapter names, sorted: `['aider', 'claude-code', 'codex', 'continue-cli', 'crush', 'factory-droid', 'gemini', 'kilo', 'openclaude', 'opencode', 'pi', 'qwen', 'swe-agent']`.

---

## Types

```typescript
interface RunSpec {
  harness: string            // "claude-code" | "openclaude" | "factory-droid" | "codex" | "gemini" | "opencode" | "aider" | "swe-agent" | "qwen" | "continue-cli" | "pi" | "crush" | "kilo"
  prompt: string
  workdir: string            // absolute path; cwd for the subprocess
  model?: string             // canonical or adapter-specific (normalized per harness; see ADAPTER-MATRIX.md)
  instructions?: string      // written to per-harness file in workdir
  timeoutSeconds?: number    // default 1800
  env?: Record<string, string>
  modelNoResolve?: boolean   // skip harness-specific normalization (input is still trimmed)
}

interface RunResult {
  harness: string
  model: string | null
  exitCode: number           // -1 on timeout
  durationSeconds: number
  stdout: string
  stderr: string
  timedOut: boolean
  costUsd: number | null     // reported or estimated cost; null when unavailable
  tokensIn: number | null
  tokensOut: number | null
  raw: unknown | null        // adapter-specific parsed payload
}
```

Headless `parseOutput` returns null cost for codex, aider and qwen. Gemini estimates cost from token totals and the first model in `stats.models` when pricing is known. Other adapters read reported cost from stdout, trajectory files or session databases where available. Session-log helpers may also derive estimates and need not match headless parsing. See [ADAPTER-MATRIX.md](../ADAPTER-MATRIX.md) for details.

---

## Errors

`HarnessError` is thrown (not rejected via a failed RunResult) on:
- Unknown harness name
- Duplicate adapter registration

Subprocess failures (non-zero exit, timeout) are surfaced in RunResult, not as thrown errors.

---

## Shared context

- [SPEC.md](../SPEC.md) — shared contract and current cross-language differences
- [ADAPTER-MATRIX.md](../ADAPTER-MATRIX.md) — per-CLI flags, cost-reporting quirks, output shapes
- [CONTRIBUTING.md](../CONTRIBUTING.md) — adding a new adapter
