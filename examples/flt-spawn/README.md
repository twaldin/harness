# flt — adapter relationship

[flt](https://github.com/twaldin/flt) is a fleet orchestrator that spawns long-running interactive agent sessions (claude-code, opencode, codex, gemini, aider, swe-agent) inside tmux windows. Its TS adapters in `src/adapters/` know how to:

- launch each CLI with the right flags
- detect "ready prompt" vs "dialog open" via ANSI-stripped pane scraping
- send keys to approve dialogs / submit prompts
- persist session state across reboots

## Current integration boundary

Harness's shipped execution API is one-shot: spawn → wait → capture output →
exit. flt owns persistent tmux sessions and their lifecycle. Harness also
exposes optional per-adapter pane classifiers, submit/launch metadata, and
session-log readers; these helpers do not own a process or form a live session.

The [shared contract](../../SPEC.md) defines gates for future controlled CLI,
RPC, or SDK sessions. Those implementations are not shipped here. Fleet
scheduling, UI, persistence, and migration of flt remain consumer work.

## What flt can reuse now

- **Output parsers** — Python `parse_output` or TypeScript `parseOutput` for
  captured one-shot output; optional adapter-specific readers for native logs.
- **Pane knowledge** — optional `classify_pane` / `classifyPane` and launch
  metadata, while flt retains tmux/process ownership.
- **Adapter discovery** — `harness list` enumerates registered CLI adapters.
  `get_capabilities` / `getCapabilities` reports implemented policy, not whether
  a binary is installed or authenticated.

One-shot probes can consume provider quota and inherit upstream permission
policy. They are not installation-only checks.

## Sketch: flt shelling out for one-shot tests

```typescript
// src/cli/test-adapter.ts — one-shot provider probe, not a binary-only check
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

This remains a consumer-integration sketch, not evidence of a completed flt
migration. No flt worktree or lifecycle code changes as part of this contract.
