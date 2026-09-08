"""Crush adapter — invokes `crush run` and reads token/cost totals from sqlite."""
from __future__ import annotations

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
from harness.util import last_non_empty_join, strip_ansi

_MODEL_PICKER_RE = re.compile(r"choose.*confirm", re.IGNORECASE)
_ARROWS_RE = re.compile(r"↑/↓")
_BRAND_RE = re.compile(r"Ready|Charm|Crush", re.IGNORECASE)
_PROMPT_MARKER_RE = re.compile(r"\$|>|▎|❯")
_RATE_LIMIT_RE = re.compile(r"rate.?limit", re.IGNORECASE)
_SPINNER_RE = re.compile(r"[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]")
_WORKING_RE = re.compile(r"thinking|working", re.IGNORECASE)
_IDLE_RE = re.compile(r"Ready|>\s*$|❯\s*$")


class CrushAdapter(Adapter):
    name = "crush"
    instructions_filename = "AGENTS.md"
    submit_keys = ("Enter",)
    install_meta = InstallMeta(
        package_manager="brew",
        install_command=("brew", "install", "charmbracelet/tap/crush"),
        update_command=("brew", "upgrade", "crush"),
        version_command=("crush", "--version"),
        platforms=("darwin", "linux"),
    )

    DEFAULT_MODEL = "gpt-5.4"

    def build_command(self, spec: RunSpec) -> BuildCommand:
        resolved = self.resolve_run_spec(spec)
        model = resolved.model

        workdir = absolute_workdir(spec.workdir)
        data_dir = _crush_data_dir(workdir, spec.env)
        # The default per-workdir data dir is a harness artifact prepare creates;
        # a CRUSH_DATA_DIR override is caller-owned upstream state.
        directories = () if _crush_data_dir_override(spec.env) else (data_dir,)

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
        return self.finalize_command(spec, cmd="crush", args=args, directories=directories)

    def parse_output(self, spec: RunSpec, outcome: SubprocOutcome) -> ParsedOutput:
        tokens_in, tokens_out, cost, _model = _read_crush_session_totals(Path(spec.workdir), spec.env)
        return {"cost_usd": cost, "tokens_in": tokens_in, "tokens_out": tokens_out, "raw": None}

    # ---- session-aware ---------------------------------------------------

    def detect_ready(self, pane: str) -> ReadyState:
        last30 = last_non_empty_join(pane, 30)
        # First-time setup: model picker shown
        if _MODEL_PICKER_RE.search(last30) and _ARROWS_RE.search(last30):
            return "dialog"
        # Ready: prompt visible (crush uses ▎ or > marker) + model status bar
        if _BRAND_RE.search(last30) and _PROMPT_MARKER_RE.search(last30):
            return "ready"
        return "loading"

    def handle_dialog(self, pane: str) -> list[str] | None:
        if _MODEL_PICKER_RE.search(strip_ansi(pane)):
            return ["Enter"]  # accept the highlighted (default) model
        return None

    def detect_status(self, pane: str) -> AgentStatus:
        last10 = last_non_empty_join(pane, 10)
        if _RATE_LIMIT_RE.search(last10):
            return "rate-limited"
        if _SPINNER_RE.search(last10) or _WORKING_RE.search(last10):
            return "running"
        if _IDLE_RE.search(last10):
            return "idle"
        return "unknown"

    def session_log_path(self, workdir: Path, session_started_after: float | None = None) -> str | None:
        db_path = _crush_db_path(workdir, None)
        if not db_path.exists():
            return None
        return f"{db_path}#session({workdir.resolve().name if workdir.exists() else workdir.name})"

    def parse_session_log(self, path: str) -> SessionTelemetry:
        db_raw = path.split("#", 1)[0]
        tokens_in, tokens_out, cost, model = _read_crush_session_totals_by_db_path(Path(db_raw))
        # sessions.cost is NOT NULL DEFAULT 0.0 upstream, so 0 may be a genuine
        # zero-cost run; without a session model there is nothing to price it with.
        if (cost is None or cost == 0) and (tokens_in is not None or tokens_out is not None):
            cost = derive_cost(model, tokens_in, tokens_out) or cost
        return SessionTelemetry(path, tokens_in, tokens_out, cost, model, None)


def _crush_data_dir_override(extra_env: dict[str, str] | None = None) -> str | None:
    return (extra_env or {}).get("CRUSH_DATA_DIR") or os.environ.get("CRUSH_DATA_DIR") or None


def _crush_data_dir(workdir: Path, extra_env: dict[str, str] | None = None) -> Path:
    env_path = _crush_data_dir_override(extra_env)
    if env_path:
        return Path(env_path).expanduser()
    return workdir / ".harness" / "crush-data"


def _crush_db_path(workdir: Path, extra_env: dict[str, str] | None = None) -> Path:
    return _crush_data_dir(workdir, extra_env) / "crush.db"


def _read_crush_session_totals_by_db_path(
    db_path: Path,
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
            SELECT id, prompt_tokens, completion_tokens, cost
            FROM sessions
            WHERE parent_session_id IS NULL
            ORDER BY updated_at DESC
            LIMIT 1
            """
        ).fetchone()
    except sqlite3.Error:
        conn.close()
        return None, None, None, None

    if not row:
        conn.close()
        return None, None, None, None

    tokens_in = int(row[1]) if isinstance(row[1], (int, float)) else None
    tokens_out = int(row[2]) if isinstance(row[2], (int, float)) else None
    cost = float(row[3]) if isinstance(row[3], (int, float)) else None

    # sessions has no model column upstream; the model lives on messages.model.
    # Report it only when every assistant turn of the session agrees on one.
    model = None
    try:
        model_row = conn.execute(
            """
            SELECT CASE WHEN COUNT(DISTINCT model) = 1 AND COUNT(NULLIF(model, '')) = COUNT(*)
                        THEN MAX(model) END
            FROM messages
            WHERE session_id = ? AND role = 'assistant'
            """,
            (row[0],),
        ).fetchone()
        if model_row and isinstance(model_row[0], str):
            model = model_row[0]
    except sqlite3.Error:
        pass

    conn.close()
    return tokens_in, tokens_out, cost, model


def _read_crush_session_totals(
    workdir: Path,
    extra_env: dict[str, str] | None = None,
) -> tuple[int | None, int | None, float | None, str | None]:
    return _read_crush_session_totals_by_db_path(_crush_db_path(workdir, extra_env))
