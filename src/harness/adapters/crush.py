"""Crush adapter — invokes `crush run` and reads token/cost totals from sqlite."""
from __future__ import annotations

import os
import sqlite3
from pathlib import Path

from harness._subproc import SubprocOutcome, write_instructions
from harness.base import Adapter, BuildCommand, RunSpec
from harness.model_normalization import normalize_model_for_harness


class CrushAdapter(Adapter):
    name = "crush"
    instructions_filename = "AGENTS.md"

    DEFAULT_MODEL = "gpt-5.4"

    def build_command(self, spec: RunSpec) -> BuildCommand:
        model = normalize_model_for_harness(self.name, spec.model or self.DEFAULT_MODEL)
        instructions_file = write_instructions(spec.workdir, self.instructions_filename, spec.instructions)

        data_dir = _crush_data_dir(Path(spec.workdir), spec.env)
        data_dir.mkdir(parents=True, exist_ok=True)

        # Strict same-model fairness: pin both large and small model flags.
        args = [
            "--yolo",
            "--data-dir",
            str(data_dir),
            "run",
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


def _crush_data_dir(workdir: Path, extra_env: dict[str, str] | None = None) -> Path:
    env_path = (extra_env or {}).get("CRUSH_DATA_DIR") or os.environ.get("CRUSH_DATA_DIR")
    if env_path:
        return Path(env_path).expanduser()
    return workdir / ".harness" / "crush-data"


def _crush_db_path(workdir: Path, extra_env: dict[str, str] | None = None) -> Path:
    return _crush_data_dir(workdir, extra_env) / "crush.db"


def _read_crush_session_totals(
    workdir: Path,
    extra_env: dict[str, str] | None = None,
) -> tuple[int | None, int | None, float | None]:
    db_path = _crush_db_path(workdir, extra_env)
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
