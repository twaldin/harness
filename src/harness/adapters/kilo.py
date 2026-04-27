"""Kilo adapter — invokes `kilo run` and reads token/cost totals from sqlite."""
from __future__ import annotations

import json
import os
import sqlite3
from pathlib import Path

from harness._subproc import SubprocOutcome, write_instructions
from harness.base import Adapter, BuildCommand, RunSpec, SessionTelemetry
from harness.model_normalization import normalize_model_for_harness
from harness.pricing import derive_cost


class KiloAdapter(Adapter):
    name = "kilo"
    instructions_filename = "AGENTS.md"

    DEFAULT_MODEL = "gpt-5.4"

    def build_command(self, spec: RunSpec) -> BuildCommand:
        model = normalize_model_for_harness(self.name, spec.model or self.DEFAULT_MODEL, resolve=not spec.model_no_resolve)
        instructions_file = write_instructions(spec.workdir, self.instructions_filename, spec.instructions)

        workdir = Path(spec.workdir)
        db_path = _kilo_db_path(workdir, spec.env)
        # Only attempt mkdir if the parent path already sits under a writable
        # prefix on the host. When KILO_DB points at a container-only path
        # (e.g. /app/...), leave dir creation to the runtime inside the
        # container.
        try:
            db_path.parent.mkdir(parents=True, exist_ok=True)
        except OSError:
            pass

        config_json = json.dumps(
            {
                "model": model,
                "small_model": model,
                "default_agent": "build",
            },
            separators=(",", ":"),
        )

        env = {
            # Use a deterministic per-workdir DB for container safety.
            "KILO_DB": str(db_path),
            # Force single-model behavior for helper/small-model paths.
            "KILO_CONFIG_CONTENT": config_json,
        }

        args = [
            "run",
            "--auto",
            "--format",
            "json",
            "--dir",
            str(workdir),
            "--model",
            model,
            spec.prompt,
        ]
        return BuildCommand(cmd="kilo", args=args, cwd=workdir, env=env, instructions_file=instructions_file)

    def parse_output(self, spec: RunSpec, outcome: SubprocOutcome) -> dict:
        tokens_in, tokens_out, cost, _model = _read_kilo_session_totals(Path(spec.workdir), spec.env)
        return {"cost_usd": cost, "tokens_in": tokens_in, "tokens_out": tokens_out, "raw": None}

    def session_log_path(self, workdir: Path, session_started_after: float | None = None) -> str | None:
        db_path = _kilo_db_path(workdir, None)
        if not db_path.exists():
            return None
        return f"{db_path}#session({workdir.resolve().name if workdir.exists() else workdir.name})"

    def parse_session_log(self, path: str) -> SessionTelemetry:
        db_raw = path.split("#", 1)[0]
        hint = ""
        if "session(" in path and path.endswith(")"):
            hint = path.split("session(", 1)[1][:-1]
        tokens_in, tokens_out, cost, model = _read_kilo_session_totals_by_db_path(Path(db_raw), hint or "/")
        if (cost is None or cost == 0) and (tokens_in is not None or tokens_out is not None):
            cost = derive_cost(model or "gpt-5.4", tokens_in, tokens_out) or cost
        return SessionTelemetry(path, tokens_in, tokens_out, cost, model, None)


def _kilo_db_path(workdir: Path, extra_env: dict[str, str] | None = None) -> Path:
    env_path = (extra_env or {}).get("KILO_DB") or os.environ.get("KILO_DB")
    if env_path:
        return Path(env_path).expanduser()
    return workdir / ".harness" / "kilo" / "kilo.db"


def _read_kilo_session_totals_by_db_path(
    db_path: Path,
    workdir_basename: str,
) -> tuple[int | None, int | None, float | None, str | None]:
    if not db_path.exists():
        return None, None, None, None

    try:
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=5.0)
    except sqlite3.Error:
        return None, None, None, None

    try:
        row = conn.execute(
            """
            SELECT
                COALESCE(SUM(json_extract(data, '$.tokens.input')), 0)  AS tokens_in,
                COALESCE(SUM(json_extract(data, '$.tokens.output')), 0) AS tokens_out,
                COALESCE(SUM(json_extract(data, '$.cost')), 0)          AS cost,
                MAX(json_extract(data, '$.model'))                      AS model,
                COUNT(*)                                                 AS row_count
            FROM message
            WHERE session_id IN (
                SELECT id FROM session
                WHERE directory LIKE ?
                ORDER BY time_updated DESC
                LIMIT 1
            )
            AND json_extract(data, '$.role') = 'assistant'
            """,
            (f"%{workdir_basename}%",),
        ).fetchone()
    except sqlite3.Error:
        conn.close()
        return None, None, None, None

    conn.close()
    if not row or row[4] == 0:
        return None, None, None, None

    model = row[3] if isinstance(row[3], str) else None
    return int(row[0]), int(row[1]), float(row[2]), model


def _read_kilo_session_totals(
    workdir: Path,
    extra_env: dict[str, str] | None = None,
) -> tuple[int | None, int | None, float | None, str | None]:
    try:
        workdir_real = workdir.resolve()
    except OSError:
        workdir_real = workdir
    workdir_basename = workdir_real.name
    return _read_kilo_session_totals_by_db_path(_kilo_db_path(workdir, extra_env), workdir_basename)
