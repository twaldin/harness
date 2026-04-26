# Track C — Harness 12/12 Session-Log Coverage + py-ts Parity Sync

## Problem

`~/harness/ts/src/adapters/` has 14 adapters but `sessionLogPath` is only wired for 6 of 12 active CLIs: claude-code, codex, gemini, opencode, swe-agent, pi. The 6 missing adapters — continue-cli, crush, factory-droid, openclaude, qwen, kilo — cannot report session costs or token counts via session log. The Python harness (`src/harness/adapters/`) has drifted significantly behind TypeScript (e.g. claude-code: 75 lines py vs 165 ts).

## Goal

Full 12/12 session-log coverage in TS, mirrored to Python, with a parity test suite ensuring both runtimes return identical results for the same fixture.

## Deliverables

### 1. Audit — `ADAPTER-MATRIX.md`

Update `~/harness/ADAPTER-MATRIX.md` with a row per adapter showing `sessionLogPath` status (wired / missing / N-A) and `extract` status (wired / missing / N-A), plus reason if N-A.

Initial state going in:

| adapter | sessionLogPath | extract | notes |
|---|---|---|---|
| claude-code | wired | wired | |
| codex | wired | wired | |
| gemini | wired | wired | |
| opencode | wired | wired | |
| swe-agent | wired | wired | |
| pi | wired | wired | |
| continue-cli | missing | missing | target of this track |
| crush | missing | missing | target of this track |
| factory-droid | missing | missing | target of this track |
| openclaude | missing | missing | target of this track |
| qwen | missing | missing | target of this track |
| kilo | missing | missing | target of this track |

### 2. Wire `sessionLogPath()` — 6 Missing TS Adapters

Implement `sessionLogPath(sessionId: string): string | null` in each adapter. Research-based path hypotheses:

| adapter | expected path | source |
|---|---|---|
| continue-cli | `~/.continue/sessions/<encoded>/*.json` | continue source / docs |
| crush | `~/.crush/<db>.sqlite` | reuse SQLite parser from opencode/kilo |
| factory-droid | `~/.factory/<trajectories>/` | droid source or docs |
| openclaude | `~/.claude/projects/<encoded>/` | mirrors claude-code (openclaude = claude-code via z.ai) |
| qwen | `~/.gemini/tmp/<basename>/logs.json` | gemini-cli compat path |
| kilo | SQLite at `~/.kilo/` | parsers already exist |

If a CLI's session storage is undocumented or path cannot be confirmed, mark **N-A** with reason in the matrix and skip implementation — do not block the release.

Each wired adapter gets a unit test under `harness/ts/tests/adapters/<name>-sessionlog.test.ts` using a fixture session file.

### 3. Wire `extract()` — Cost/Token Parsing from Session Log

For adapters where the session log carries cost or token data, implement `extract(sessionId: string): { costUsd: number | null, tokensIn: number | null, tokensOut: number | null }`. Applies primarily to:

- SQLite-backed: crush, kilo, opencode (pattern: reuse existing SQLite parser)
- JSON-log: continue-cli, qwen (pattern: reuse JSON stream parser)
- openclaude: same as claude-code extraction logic

### 4. Python Parity Sync

For each adapter newly wired in TS:

1. Re-implement `session_log_path(session_id)` and `extract(session_id)` in `src/harness/adapters/<name>.py`.
2. Add a parity test at `harness/tests/adapters/test_<name>_parity.py` that:
   - Loads the same fixture used in the TS unit test
   - Runs both TS and py implementations against it
   - Asserts identical `sessionLogPath` / `extract` results

Also sync the drifted claude-code adapter (priority: bring py to feature parity with TS, 75 → ~165 lines).

### 5. Final Matrix Update

After all adapters are wired or explicitly marked N-A, update `ADAPTER-MATRIX.md` to final 12/12 status.

### 6. Version Bump + Release Notes

- Bump patch version in `ts/package.json` and `pyproject.toml`.
- Write `RELEASE-NOTES.md` (or update `WANTED-ADAPTERS.md`) covering: adapters newly wired, any N-A deferrals with rationale.

## Commit Strategy

One commit per deliverable chunk, in order:

1. `audit: ADAPTER-MATRIX.md initial state`
2. `feat(ts): sessionLogPath for continue-cli, crush, factory-droid, openclaude, qwen, kilo`
3. `feat(ts): extract() for applicable adapters`
4. `feat(py): parity sync for newly-wired adapters`
5. `chore: final matrix update, version bump, release notes`

Each commit runs `npm test` (ts) and `pytest` (py) before proceeding.

## Acceptance Criteria

1. `ADAPTER-MATRIX.md` reflects all 12 adapters with accurate `sessionLogPath` and `extract` status.
2. All 6 formerly-missing adapters have `sessionLogPath` implemented in TS or explicitly N-A, each with a passing unit test.
3. All adapters whose session log carries cost/token data have `extract()` implemented in TS.
4. Python adapters match TS: parity tests pass for all newly-wired adapters; claude-code py brought to feature parity.
5. `ts/package.json` and `pyproject.toml` version bumped; release notes present.
6. `npm test` and `pytest` pass with no regressions on main-branch behavior.

## Autonomy Assessment

Autonomous-possible at gate. Parity check is mechanically verifiable via fixture comparison. The only human-required decision is whether an undocumented session path should be marked N-A or deferred — the agent should mark N-A and note the blocker rather than stalling.
