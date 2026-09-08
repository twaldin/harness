"""Kilo adapter — invokes `kilo run` and reads token/cost totals from sqlite."""
from __future__ import annotations

import json
import os
import re
import sqlite3
from pathlib import Path

from harness._subproc import SubprocOutcome
from harness.base import (
    Adapter,
    AgentStatus,
    BuildCommand,
    InstallMeta,
    ParsedOutput,
    ReadyState,
    RunSpec,
    SessionTelemetry,
    absolute_workdir,
)
from harness.pricing import derive_cost
from harness.util import last_non_empty_join

_CONFIRM_CANCEL_RE = re.compile(r"Confirm\s+Cancel", re.IGNORECASE)
_ALLOW_ROW_RE = re.compile(r"Allow once\s+Allow always\s+Reject", re.IGNORECASE)
_UPDATE_RE = re.compile(r"Update available", re.IGNORECASE)
_ASK_ANYTHING_RE = re.compile(r"Ask anything\.\.\.", re.IGNORECASE)
_RATE_LIMIT_RE = re.compile(r"rate.?limit", re.IGNORECASE)
_SPINNER_RE = re.compile(r"[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]")
_WORKING_RE = re.compile(r"thinking|working", re.IGNORECASE)


class KiloAdapter(Adapter):
    name = "kilo"
    instructions_filename = "AGENTS.md"
    permission_bypass_args = ("--auto",)
    submit_keys = ("Enter",)
    install_meta = InstallMeta(
        package_manager="npm",
        install_command=("npm", "install", "-g", "@kilocode/cli"),
        update_command=("npm", "install", "-g", "@kilocode/cli@latest"),
        version_command=("kilo", "--version"),
    )

    DEFAULT_MODEL = "gpt-5.4"

    def build_command(self, spec: RunSpec) -> BuildCommand:
        resolved = self.resolve_run_spec(spec)
        model = resolved.model

        workdir = absolute_workdir(spec.workdir)
        db_path = _kilo_db_path(workdir, spec.env)
        # The default per-workdir DB parent is a harness artifact prepare
        # creates; a KILO_DB override (e.g. a container-only path) is
        # caller-owned and left to the runtime.
        directories = () if _kilo_db_override(spec.env) else (db_path.parent,)

        # Use a deterministic per-workdir DB for container safety.
        env = {"KILO_DB": str(db_path)}
        # Force single-model behavior for helper/small-model paths, unless the
        # caller already selected a config (explicitly or inherited); that
        # content is passed through untouched.
        if "KILO_CONFIG_CONTENT" not in spec.env and "KILO_CONFIG_CONTENT" not in os.environ:
            env["KILO_CONFIG_CONTENT"] = json.dumps(
                {"model": model, "small_model": model, "default_agent": "build"},
                separators=(",", ":"),
            )

        args = [
            "run",
            *resolved.permission_args,
            "--format",
            "json",
            "--dir",
            str(workdir),
            "--model",
            model,
            spec.prompt,
        ]
        return self.finalize_command(spec, cmd="kilo", args=args, env=env, directories=directories)

    def parse_output(self, spec: RunSpec, outcome: SubprocOutcome) -> ParsedOutput:
        tokens_in, tokens_out, cost, _model = _read_kilo_session_totals(Path(spec.workdir), spec.env)
        return {"cost_usd": cost, "tokens_in": tokens_in, "tokens_out": tokens_out, "raw": None}

    # ---- session-aware ---------------------------------------------------

    def detect_ready(self, pane: str) -> ReadyState:
        # Discriminate dialog by visible button row at the bottom (not title).
        tail = last_non_empty_join(pane, 12)
        if _CONFIRM_CANCEL_RE.search(tail) or _ALLOW_ROW_RE.search(tail) or _UPDATE_RE.search(tail):
            return "dialog"
        if _ASK_ANYTHING_RE.search(tail):
            return "ready"
        return "loading"

    def handle_dialog(self, pane: str) -> list[str] | None:
        # kilo permission flow has two dialogs back-to-back. Discriminate by the
        # BUTTON ROW (always at the bottom of the visible pane), not by the title
        # (which lingers in scrollback after the dialog closes):
        #   1. "Allow once   Allow always   Reject" → Right + Enter picks "Allow always".
        #   2. "Confirm   Cancel" → Enter (Confirm is default).
        tail = last_non_empty_join(pane, 12)
        if _CONFIRM_CANCEL_RE.search(tail):
            return ["Enter"]
        if _ALLOW_ROW_RE.search(tail):
            return ["Right", "Enter"]
        if _UPDATE_RE.search(tail):
            return ["Escape"]
        return None

    def detect_status(self, pane: str) -> AgentStatus:
        tail = last_non_empty_join(pane, 12)
        last10 = last_non_empty_join(pane, 10)
        if _CONFIRM_CANCEL_RE.search(tail) or _ALLOW_ROW_RE.search(tail):
            return "dialog"
        if _RATE_LIMIT_RE.search(last10):
            return "rate-limited"
        if _SPINNER_RE.search(last10) or _WORKING_RE.search(last10):
            return "running"
        if _ASK_ANYTHING_RE.search(last10):
            return "idle"
        return "unknown"

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


def _kilo_db_override(extra_env: dict[str, str] | None = None) -> str | None:
    return (extra_env or {}).get("KILO_DB") or os.environ.get("KILO_DB") or None


def _kilo_db_path(workdir: Path, extra_env: dict[str, str] | None = None) -> Path:
    env_path = _kilo_db_override(extra_env)
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
