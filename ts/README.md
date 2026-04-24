# @twaldin/harness-ts

TypeScript SDK for [harness](../) — invoke claude-code, openclaude, opencode, codex, gemini, aider, swe-agent, qwen, continue-cli, pi, factory-droid, crush, or kilo as a subprocess with a uniform RunSpec → RunResult contract.

## Install

```bash
npm install @twaldin/harness-ts
# or: bun add @twaldin/harness-ts
```

Requires Node 18+ or Bun 1.0+. The package ships ESM only.

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

console.log(`exit=${r.exitCode}  cost=$${r.costUsd?.toFixed(4) ?? 'n/a'}  tokens=${r.tokensIn}/${r.tokensOut}`)
console.log(r.stdout.slice(0, 200))
```

See [`examples/hello-world.ts`](examples/hello-world.ts) for a runnable file.

## API reference

### `run(spec: RunSpec): Promise<RunResult>`

Full headless invocation: builds the command, executes it as a subprocess, parses output. Awaiting blocks until the agent exits or times out.

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
}

interface RunResult {
  harness: string
  model: string | null
  exitCode: number           // -1 on timeout
  durationSeconds: number
  stdout: string
  stderr: string
  timedOut: boolean
  costUsd: number | null     // null if the CLI doesn't report cost
  tokensIn: number | null
  tokensOut: number | null
  raw: unknown | null        // adapter-specific parsed payload
}
```

`costUsd` is null for codex, gemini, aider, and qwen — those CLIs don't report cost. It's populated for claude-code (from the `--output-format json` envelope), opencode (from its sqlite session DB), swe-agent (from the trajectory JSON), continue-cli (from the `--json` envelope), and pi (summed from the `--mode json` event stream). See [ADAPTER-MATRIX.md](../ADAPTER-MATRIX.md) for details.

---

## Errors

`HarnessError` is thrown (not rejected via a failed RunResult) on:
- Unknown harness name
- Duplicate adapter registration

Subprocess failures (non-zero exit, timeout) are surfaced in RunResult, not as thrown errors.

---

## Shared context

- [SPEC.md](../SPEC.md) — full contract; Python and TypeScript implement the same interface
- [ADAPTER-MATRIX.md](../ADAPTER-MATRIX.md) — per-CLI flags, cost-reporting quirks, output shapes
- [CONTRIBUTING.md](../CONTRIBUTING.md) — adding a new adapter
