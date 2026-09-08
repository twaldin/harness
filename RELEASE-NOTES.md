# Release notes

## Unreleased — shared Python/TypeScript contract

- Repaired Claude Code, OpenClaude, Factory Droid, Gemini, Qwen, Continue and
  SWE-wrapper artifact helpers in both languages, with shared upstream-shaped
  fixtures and native cutoff units. Discovery honors qualified config roots and
  project metadata instead of unrelated latest/basename logs. OpenClaude now
  uses only its own config root and preserves provider model namespaces.
  Native session metrics replace guessed schemas; Continue headless output
  remains non-telemetry. See [sources and runtime limits](ADAPTER-MATRIX.md#artifact-qualification--2026-09-08).
  Malformed or unsafe Claude token totals and non-finite Continue metrics remain
  unknown rather than throwing or reporting invalid numeric telemetry.
  Pane precedence and controlled-session ownership are unchanged.
- Added the standalone `cline` CLI adapter in Python and TypeScript, with native
  provider/approval options, `CLINE_DIR`, explicit instruction attachment and
  terminal NDJSON usage. Upstream defaults to auto-approval.
  Cline selects one SIGINT through the shared lifecycle engine; other adapters
  retain SIGTERM. External command drivers must honor the planned graceful signal.
  See [setup, cancellation and provider coverage limits](ADAPTER-MATRIX.md#cline).
- Added `goose` in Python and TypeScript using the official headless JSONL CLI
  and shared subprocess lifecycle. Preserves caller-selected model/provider/extensions,
  supports inline instructions, `GOOSE_PATH_ROOT` and explicit `GOOSE_MODE=auto`,
  and retains final cumulative usage plus native error events.
  See [setup, synthetic-provider smoke and extension cleanup limits](ADAPTER-MATRIX.md#goose).
- Added `copilot` in Python and TypeScript for the current official GitHub Copilot
  CLI, with JSONL native events, explicit `CopilotOptions` tool allow/deny rules,
  opt-in bypass and `COPILOT_HOME` selection through the shared subprocess lifecycle.
  Token/USD totals stay null; premium requests and AI credits remain native data.
  See [setup and dated provider/cancellation coverage](ADAPTER-MATRIX.md#copilot).
- **Instruction lifecycle migration:** command builders are now side-effect-free.
  `run` / `runAsync` prepare and restore instructions automatically. External
  drivers must pair `prepare_command` / `prepareCommand` with
  `cleanup_command` / `cleanupCommand` after their process tree stops.
  Same-workdir overlap and unsafe symlinks reject. Cleanup preserves changed
  user content and its original backup rather than overwriting either.
  Cancellation restores instructions only after subprocess teardown; a teardown
  failure retains instructions, backup and lease until manual recovery.
- Added explicit executable and supported config-home/config-file selection in
  both languages. Caller-selected authentication and environment are retained;
  unsupported overrides reject without editing configuration. Continue no longer
  generates credential YAML, Aider no longer replaces configuration with an
  empty generated file, and Kilo preserves selected inline configuration.
- `write_instructions` / `writeInstructions` now exclusively create files rather
  than truncate existing content. Projection's unsafe `backup=false` option
  rejects. See [SPEC migration and recovery](SPEC.md#instruction-preparation-and-restoration).
- The provider smoke script no longer rewrites process PATH or substitutes a
  local proxy credential; it uses the launch-selected binaries and authentication.
- **Intentional compatibility change:** omitted permission policy now preserves
  upstream defaults. Callers that require the former automatic-approval flags
  must explicitly select Python `permission_policy="bypass"`, TypeScript
  `permissionPolicy: 'bypass'`, or CLI `--permission-policy bypass`. Unmapped
  adapters reject bypass instead of silently ignoring it.
- Added explicit backend selection and static capability queries. The one-shot
  API executes only `cli`; `rpc` and `sdk` fail before preparation or process
  creation. Controlled Pi RPC now uses the separate session API.
- Added typed Claude Code effort and Codex sandbox options, validated before
  file writes. Codex sandbox and bypass cannot be combined.
- Aligned eager registry initialization, collision errors, model selection,
  root helper exports, and Python's optional pane/session-log helpers with
  TypeScript. Removed duplicated Python one-shot execution methods.
- Malformed Gemini usage now returns unavailable telemetry in both languages,
  rather than raising, producing `NaN`, or fabricating a zero count.
  Token totals that exceed the safe-integer limit also return unavailable
  telemetry, even when every per-model count is individually valid.
- Corrected Kilo install/update metadata to the official `@kilocode/cli`
  package. The bringup runner records unsupported requests per adapter and
  continues the batch without executing an unsupported request.
- Expanded [SPEC](SPEC.md) with ownership, future backend/session gates,
  telemetry limits, and paired migration examples. Existing results remain
  compatible; these source changes are not yet a package release. Paired
  fixture-update patch bumps follow SPEC and do not publish packages.

## 2026-05-06 (later)

- Added per-adapter `getCurrentScrollKeys(): ScrollKeys | null` (TS) / `get_current_scroll_keys()` (Python). Returns the four chord keys (`lineDown`/`lineUp`/`pageDown`/`pageUp`) the consumer should forward right now, or `null` to fall through to tmux scrollback. Lets mode-aware CLIs surface the active routing instead of consumers sniffing tmux state.
- Adapter implementations:
  - `opencode`: returns the static `C-M-e` / `C-M-y` / `NPage` / `PPage` map on every call (opencode always uses simulated scrollback).
  - `claude-code`: reads `~/.claude/settings.json` (user scope, v1) and returns the same map when `tui` is `"fullscreen"`, else `null`. The full managed → local → project → user precedence cascade is intentionally deferred — user-scope is where `/tui`-style global preferences live.
  - All other adapters: default `null` (no key forwarding).
- The pre-existing `scrollOwnership` field is retained for now (additive release; consumers that haven't migrated keep working).
- Tests added for opencode + claude-code (`fullscreen` / `default` / absent / malformed / mutation-between-calls) on both runtimes.
- Version bumps:
  - `@twaldin/harness-ts`: `0.2.7`
  - Python `harness-cli`: `0.3.4`

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
