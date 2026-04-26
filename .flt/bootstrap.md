Write a one-page spec for: Track C — harness 12/12 session-log coverage + py-ts parity sync.

CONTEXT: harness lib at ~/harness/ has both ts/ and src/harness/ (py). Today flt added 6 new adapters. Current coverage audit:
- harness/ts/src/adapters/: 14 adapters, sessionLogPath wired for ONLY 6/12 active CLIs (claude-code, codex, gemini, opencode, swe-agent, pi). MISSING: continue-cli, crush, factory-droid, openclaude, qwen, kilo.
- harness/src/harness/adapters/ (py): 14 files exist but drift behind ts (e.g. claude-code 75 lines vs 165 in ts).

DELIVERABLES (commit per chunk on this worktree's branch):

1. Audit: ~/harness/ADAPTER-MATRIX.md — update or extend with sessionLogPath status per adapter (wired/missing/N-A and reason if missing).

2. Wire sessionLogPath for the 6 missing TS adapters where feasible:
   - continue-cli: ~/.continue/sessions/<encoded>/*.json or similar (research the actual path).
   - crush: SQLite at ~/.crush/ or similar; harness already has SQLite parser pattern from opencode/kilo.
   - factory-droid: ~/.factory/ or wherever droid stores trajectories.
   - openclaude: same shape as claude-code (~/.claude/projects/...) since it's claude-code via z.ai.
   - qwen: gemini-cli compat → ~/.gemini/tmp/<basename>/logs.json (same as gemini path).
   - kilo: SQLite (parsers already exist).
   For each: implement sessionLogPath() in TS adapter, add unit test under harness/ts/tests/, mark N-A in matrix if not feasible.

3. Wire extract() (cost/tokens) for any of the above where the session log carries it (mostly the SQLite ones).

4. Sync the new TS additions back to harness py:
   - Re-implement each newly-wired sessionLogPath/extract in src/harness/adapters/<name>.py.
   - Add parity test under harness/tests/ that compares ts vs py output for a fixture session log.
   - Goal: harness py and harness ts have functional parity (both return identical sessionLogPath + extract results).

5. Update ~/harness/ADAPTER-MATRIX.md with final 12/12 status.

6. Bump version on both ts/package.json and pyproject.toml. Tag release prep notes in WANTED-ADAPTERS.md or a new RELEASE-NOTES.md.

Run from THIS worktree (~/harness clone). When tests pass at each step, flt workflow pass; if you hit a blocker (e.g., a CLI's session storage is undocumented), flt workflow fail with reason and we'll defer that adapter to N-A.

Hypothesis: autonomous-possible at gate (parity check is mechanically verifiable). . Save to spec.md in your worktree. Run flt workflow pass when done.