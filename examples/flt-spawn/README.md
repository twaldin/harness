# flt — adapter relationship

[flt](https://github.com/twaldin/flt) is a fleet orchestrator that spawns long-running interactive agent sessions (claude-code, opencode, codex, gemini, aider, swe-agent) inside tmux windows. Its TS adapters in `src/adapters/` know how to:

- launch each CLI with the right flags
- detect "ready prompt" vs "dialog open" via ANSI-stripped pane scraping
- send keys to approve dialogs / submit prompts
- persist session state across reboots

## Why flt does NOT use harness directly

`harness` is a one-shot model: spawn → wait → capture output → exit. flt's agents stay alive across many user interactions. The per-CLI knowledge in flt is mostly tmux + interactive-session lifecycle, not subprocess invocation.

Forcing flt onto `harness` would either:

1. bloat harness with interactive-session support (mission creep, blurs the abstraction), or
2. create a leaky abstraction where flt ignores most of harness's API.

Better to keep them as siblings sharing knowledge informally.

## What flt CAN reuse

- **Per-harness env setup** (Vertex tokens, GCloud, OpenAI proxy) — same logic, can be a shared `harness.env` helper imported by both Python (harness) and shelled out from TS (flt).
- **Output parsers** — when flt eventually wants to surface tokens/cost in its TUI, it can call `harness run --json` for a one-shot version detection / quick-test, or shell out to a `harness parse-output` CLI per-harness.
- **Adapter discovery** — `harness list` enumerates supported CLIs; flt's `--cli` flag could validate against this.

## Sketch: flt shelling out for one-shot tests

```typescript
// src/cli/test-adapter.ts — verify a CLI is installed before spawning persistent agent
import { execaSync } from 'execa'

export function quickTestAdapter(harness: string, model: string): boolean {
  try {
    const { stdout } = execaSync('harness', [
      'run',
      '--harness', harness,
      '--model', model,
      '--workdir', '/tmp',
      '--timeout', '30',
      '--json',
      'reply with the single word OK',
    ])
    const result = JSON.parse(stdout)
    return result.exit_code === 0 && result.stdout.includes('OK')
  } catch {
    return false
  }
}
```

## Status

flt continues to maintain its own TS adapters. harness consultations are for one-shot operations only.
