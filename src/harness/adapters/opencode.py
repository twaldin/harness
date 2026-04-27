"""opencode adapter — invokes the `opencode run` CLI.

opencode persists sessions in a sqlite DB at
`~/.local/share/opencode/opencode.db`. Token/cost totals live in `message`
rows; we match on the `session.directory` column to find the session created
by THIS run (which used `--dir <workdir>`).

Mirror of agentelo/bin/agentelo's opencode parsing path (line ~1491).
"""
from __future__ import annotations

import os
import sqlite3
from pathlib import Path

from harness._subproc import SubprocOutcome, run_subprocess, write_instructions
from harness.base import Adapter, BuildCommand, RunResult, RunSpec
from harness.model_normalization import normalize_model_for_harness


class OpenCodeAdapter(Adapter):
    name = "opencode"
    instructions_filename = "AGENTS.md"

    DEFAULT_MODEL = "gpt-5.4"

    def build_command(self, spec: RunSpec) -> BuildCommand:
        model = normalize_model_for_harness(self.name, spec.model or self.DEFAULT_MODEL, resolve=not spec.model_no_resolve)
        instructions_file = write_instructions(spec.workdir, self.instructions_filename, spec.instructions)
        args = ["run", "--dir", str(spec.workdir), "--model", model, spec.prompt]
        return BuildCommand(cmd="opencode", args=args, cwd=spec.workdir, env={}, instructions_file=instructions_file)

    def parse_output(self, spec: RunSpec, outcome: SubprocOutcome) -> dict:
        tokens_in, tokens_out, cost, _model = _read_opencode_session_totals(Path(spec.workdir), spec.env)
        return {"cost_usd": cost, "tokens_in": tokens_in, "tokens_out": tokens_out, "raw": None}

    def run(self, spec: RunSpec) -> RunResult:
        bc = self.build_command(spec)
        outcome = run_subprocess(
            [bc.cmd] + bc.args,
            cwd=bc.cwd,
            timeout_seconds=spec.timeout_seconds,
            extra_env={**bc.env, **spec.env},
        )
        parsed = self.parse_output(spec, outcome)
        return RunResult(
            harness=self.name,
            model=spec.model or self.DEFAULT_MODEL,
            exit_code=outcome.exit_code,
            duration_seconds=outcome.duration_seconds,
            stdout=outcome.stdout,
            stderr=outcome.stderr,
            timed_out=outcome.timed_out,
            cost_usd=parsed.get("cost_usd"),
            tokens_in=parsed.get("tokens_in"),
            tokens_out=parsed.get("tokens_out"),
            raw=parsed.get("raw"),
        )


def _opencode_db_path(extra_env: dict[str, str] | None = None) -> Path:
    """Default opencode DB location; override via OPENCODE_DB env var."""
    env_path = (extra_env or {}).get("OPENCODE_DB") or os.environ.get("OPENCODE_DB")
    if env_path:
        return Path(env_path).expanduser()
    return Path.home() / ".local" / "share" / "opencode" / "opencode.db"


def _read_opencode_session_totals(
    workdir: Path,
    extra_env: dict[str, str] | None = None,
) -> tuple[int | None, int | None, float | None, str | None]:
    """Query opencode's sqlite for the session that ran in `workdir`.

    Returns (tokens_in, tokens_out, cost_usd, model). All None if DB
    unavailable or no matching session.
    """
    db_path = _opencode_db_path(extra_env)
    if not db_path.exists():
        return None, None, None, None

    try:
        workdir_real = workdir.resolve()
    except OSError:
        workdir_real = workdir

    workdir_basename = workdir_real.name

    try:
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=5.0)
    except sqlite3.Error:
        return None, None, None, None

    try:
        # Match latest session whose directory contains workdir basename.
        # agentelo uses LIKE %basename% — same heuristic. Tolerates symlinks
        # and tmpdir prefixes (/private/var/folders/...).
        row = conn.execute(
            """
            SELECT
                COALESCE(SUM(json_extract(data, '$.tokens.input')), 0)  AS tokens_in,
                COALESCE(SUM(json_extract(data, '$.tokens.output')), 0) AS tokens_out,
                COALESCE(SUM(json_extract(data, '$.cost')), 0)          AS cost,
                MAX(s.model)                                             AS model,
                COUNT(*)                                                 AS row_count
            FROM message m
            JOIN session s ON s.id = m.session_id
            WHERE m.session_id IN (
                SELECT id FROM session
                WHERE directory LIKE ?
                ORDER BY time_updated DESC
                LIMIT 1
            )
            """,
            (f"%{workdir_basename}%",),
        ).fetchone()
    except sqlite3.Error:
        conn.close()
        return None, None, None, None
    conn.close()

    if not row or row[4] == 0:
        # No matching session rows — null means "couldn't find data".
        return None, None, None, None

    # At least one message row matched. Report sums as-is (0 means upstream
    # didn't expose usage, e.g. OAuth-proxied subscription calls — distinct
    # from null which means no session match).
    model = row[3] if isinstance(row[3], str) else None
    return int(row[0]), int(row[1]), float(row[2]), model
