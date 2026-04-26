"""Crush adapter — invokes `crush run` and reads token/cost totals from sqlite."""
from __future__ import annotations

import os
import sqlite3
from pathlib import Path

from harness._subproc import SubprocOutcome, write_instructions
from harness.base import Adapter, BuildCommand, RunSpec, SessionTelemetry
from harness.model_normalization import normalize_model_for_harness
from harness.pricing import derive_cost


class CrushAdapter(Adapter):
    name = "crush"
    instructions_filename = "AGENTS.md"

    DEFAULT_MODEL = "gpt-5.4"

    def build_command(self, spec: RunSpec) -> BuildCommand:
        model = normalize_model_for_harness(self.name, spec.model or self.DEFAULT_MODEL, resolve=not spec.model_no_resolve)
        instructions_file = write_instructions(spec.workdir, self.instructions_filename, spec.instructions)

        data_dir = _crush_data_dir(Path(spec.workdir), spec.env)
        data_dir.mkdir(parents=True, exist_ok=True)

        # Strict same-model fairness: pin both large and small model flags.
        args = [
            "run",
            "--data-dir",
            str(data_dir),
            "--model",
            model,
            "--small-model",
            model,
            spec.prompt,
        ]
        return BuildCommand(cmd="crush", args=args, cwd=spec.workdir, env={}, instructions_file=instructions_file)

    def parse_output(self, spec: RunSpec, outcome: SubprocOutcome) -> dict:
        tokens_in, tokens_out, cost = _read_crush_session_totals(Path(spec.workdir), spec.env)
        return {"cost_usd": cost, "tokens_in": tokens_in, "tokens_out": tokens_out, "raw": None}

    def session_log_path(self, workdir: Path, session_started_after: float | None = None) -> str | None:
        db_path = _crush_db_path(workdir, None)
        if not db_path.exists():
            return None
        return f"{db_path}#session({workdir.resolve().name if workdir.exists() else workdir.name})"

    def parse_session_log(self, path: str) -> SessionTelemetry:
        db_raw = path.split("#", 1)[0]
        tokens_in, tokens_out, cost = _read_crush_session_totals_by_db_path(Path(db_raw))
        if (cost is None or cost == 0) and (tokens_in is not None or tokens_out is not None):
            cost = derive_cost("gpt-5.4", tokens_in, tokens_out) or cost
        return SessionTelemetry(path, tokens_in, tokens_out, cost, None, None)


def _crush_data_dir(workdir: Path, extra_env: dict[str, str] | None = None) -> Path:
    env_path = (extra_env or {}).get("CRUSH_DATA_DIR") or os.environ.get("CRUSH_DATA_DIR")
    if env_path:
        return Path(env_path).expanduser()
    return workdir / ".harness" / "crush-data"


def _crush_db_path(workdir: Path, extra_env: dict[str, str] | None = None) -> Path:
    return _crush_data_dir(workdir, extra_env) / "crush.db"


def _read_crush_session_totals_by_db_path(db_path: Path) -> tuple[int | None, int | None, float | None]:
    if not db_path.exists():
        return None, None, None

    try:
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=5.0)
    except sqlite3.Error:
        return None, None, None

    try:
        row = conn.execute(
            """
            SELECT prompt_tokens, completion_tokens, cost
            FROM sessions
            WHERE parent_session_id IS NULL
            ORDER BY updated_at DESC
            LIMIT 1
            """
        ).fetchone()
    except sqlite3.Error:
        conn.close()
        return None, None, None

    conn.close()
    if not row:
        return None, None, None

    tokens_in = int(row[0]) if isinstance(row[0], (int, float)) else None
    tokens_out = int(row[1]) if isinstance(row[1], (int, float)) else None
    cost = float(row[2]) if isinstance(row[2], (int, float)) else None
    return tokens_in, tokens_out, cost


def _read_crush_session_totals(
    workdir: Path,
    extra_env: dict[str, str] | None = None,
) -> tuple[int | None, int | None, float | None]:
    return _read_crush_session_totals_by_db_path(_crush_db_path(workdir, extra_env))
