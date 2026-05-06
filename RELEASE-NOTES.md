# Release notes

## 2026-05-06

- Added optional `scrollOwnership` on `Adapter` in `@twaldin/harness-ts` so terminal multiplexer consumers can route scroll keys by adapter policy (`tmux` default, `app`, `fullscreen-aware` with consumer-side tmux `#{alternate_on}` check).
- Set adapter policy for:
  - `opencode`: `scrollOwnership: 'app'`
  - `claude-code`: `scrollOwnership: 'fullscreen-aware'`
- Added tests for scroll ownership adapter declarations.
- Version bumps:
  - `@twaldin/harness-ts`: `0.2.6` (0.2.5 was already published with an unrelated `files` field fix the same day)
  - Python `harness-cli`: `0.3.3` (parity mirror of `scrollOwnership` as `scroll_ownership` plus adapter declarations/tests).

## 2026-04-29

- `ts/pi.detectReady`: recognizes pi's idle-prompt footer (`(sub) X.X%/Yk`) before falling back to the "Update Available" banner branch, so flt's `waitForReady` returns promptly when pi has both a banner AND a usable prompt visible.
- `ts/projectInstructions`: always writes the backup in the `existedBefore` branch, including the markers fast-path. Previously the markers branch returned with `wroteBackup=false` which made `restoreProjectedInstructions` a silent no-op; flt's per-spawn CLAUDE.md/AGENTS.md projection couldn't be undone, polluting coder diffs.
- Version bumps:
  - `@twaldin/harness-ts`: `0.2.3`
  - Python `harness-cli`: unchanged (`0.3.2`) — fixes are TS-session-aware-only; Python's batch path doesn't have the markers fast-path.

## 2026-04-26

- Added session telemetry wiring (`sessionLogPath` + `parseSessionLog` / extract parity) for:
  - `continue-cli`
  - `crush`
  - `factory-droid`
  - `openclaude`
  - `qwen`
  - `kilo`
- Synced Python adapters to match TypeScript session telemetry behavior, including `claude-code` parity catch-up.
- Added TypeScript session-log unit tests for all newly wired adapters.
- Added cross-runtime parity tests (`tests/adapters/test_session_parity.py`) comparing TS vs py outputs on shared fixtures.
- Added Python pricing module (`src/harness/pricing.py`) and exported `SessionTelemetry` + pricing helpers.
- Version bumps:
  - `@twaldin/harness-ts`: `0.2.1`
  - `harness-cli`: `0.3.1`
