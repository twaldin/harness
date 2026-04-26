# Release notes

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
