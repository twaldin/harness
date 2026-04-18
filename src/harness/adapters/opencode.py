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

from harness._subproc import run_subprocess, write_instructions
from harness.base import Adapter, RunResult, RunSpec


class OpenCodeAdapter(Adapter):
    name = "opencode"
    instructions_filename = "AGENTS.md"

    DEFAULT_MODEL = "openai/gpt-5.4"

    def run(self, spec: RunSpec) -> RunResult:
        model = spec.model or self.DEFAULT_MODEL
        write_instructions(spec.workdir, self.instructions_filename, spec.instructions)

        cmd = [
            "opencode",
            "run",
            "--dir",
            str(spec.workdir),
            "--model",
            model,
            spec.prompt,
        ]
        outcome = run_subprocess(
            cmd,
            cwd=spec.workdir,
            timeout_seconds=spec.timeout_seconds,
            extra_env=spec.env,
        )

        tokens_in, tokens_out, cost = _read_opencode_session_totals(Path(spec.workdir))

        return RunResult(
            harness=self.name,
            model=model,
            exit_code=outcome.exit_code,
            duration_seconds=outcome.duration_seconds,
            stdout=outcome.stdout,
            stderr=outcome.stderr,
            timed_out=outcome.timed_out,
            cost_usd=cost,
            tokens_in=tokens_in,
            tokens_out=tokens_out,
            raw=None,
        )


def _opencode_db_path() -> Path:
    """Default opencode DB location; override via OPENCODE_DB env var."""
    env_path = os.environ.get("OPENCODE_DB")
    if env_path:
        return Path(env_path).expanduser()
    return Path.home() / ".local" / "share" / "opencode" / "opencode.db"


def _read_opencode_session_totals(workdir: Path) -> tuple[int | None, int | None, float | None]:
    """Query opencode's sqlite for the session that ran in `workdir`.

    Returns (tokens_in, tokens_out, cost_usd). All None if DB unavailable
    or no matching session.
    """
    db_path = _opencode_db_path()
    if not db_path.exists():
        return None, None, None

    try:
        workdir_real = workdir.resolve()
    except OSError:
        workdir_real = workdir

    workdir_basename = workdir_real.name

    try:
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=5.0)
    except sqlite3.Error:
        return None, None, None

    try:
        # Match latest session whose directory contains workdir basename.
        # agentelo uses LIKE %basename% — same heuristic. Tolerates symlinks
        # and tmpdir prefixes (/private/var/folders/...).
        row = conn.execute(
            """
            SELECT
                COALESCE(SUM(json_extract(data, '$.tokens.input')), 0)  AS tokens_in,
                COALESCE(SUM(json_extract(data, '$.tokens.output')), 0) AS tokens_out,
                COALESCE(SUM(json_extract(data, '$.cost')), 0)          AS cost
            FROM message
            WHERE session_id IN (
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
        return None, None, None
    conn.close()

    if not row:
        return None, None, None

    tokens_in = int(row[0]) if row[0] else None
    tokens_out = int(row[1]) if row[1] else None
    cost = float(row[2]) if row[2] else None
    return tokens_in, tokens_out, cost
