"""Crush adapter — invokes `crush run` and reads token/cost totals from sqlite.

`--verbose` routes crush's logger to stderr, where the non-interactive run
announces the session it created (`Created session for non-interactive run
session_id=<uuid>`). That exact ID keys the `sessions` aggregate row read
from `<data dir>/crush.db`. No latest/root-session guessing, no estimates.
"""
from __future__ import annotations

import os
import re
import sqlite3
from pathlib import Path

from harness._subproc import SubprocOutcome
from harness.adapters._native_db import (
    NO_TOTALS,
    SessionTotals,
    cost_value,
    identity_raw,
    parse_session_selector,
    read_only,
    session_telemetry,
    token_count,
    unanimous_model,
)
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
from harness.util import last_non_empty_join, strip_ansi

# internal/cmd/run.go: slog.Info("Created session for non-interactive run", "session_id", sess.ID)
# rendered by charm log's default text formatter (no timestamp/prefix) as the
# whole line `INFO Created session for non-interactive run session_id=<uuid>`.
# Continuation records are deliberately not matched: only a session created by
# this run is this run's.
_CREATED_SESSION_RE = re.compile(
    r"^INFO\s+Created session for non-interactive run session_id="
    r"([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\r?$",
    re.MULTILINE,
)

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
        override = _crush_data_dir_override(spec.env)
        data_dir = _crush_data_dir(workdir, override)
        # The default per-workdir data dir is a harness artifact prepare creates;
        # a CRUSH_DATA_DIR override is caller-owned upstream state.
        directories = () if override else (data_dir,)

        # `--verbose` surfaces the session-creation log record on stderr (and
        # hides the spinner). Strict same-model fairness: pin both model flags.
        args = [
            "run",
            "--verbose",
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
        session_id = _created_session_id(outcome.stderr)
        if session_id is None:
            return {"cost_usd": None, "tokens_in": None, "tokens_out": None, "raw": None}
        tokens_in, tokens_out, cost, _model = _read_crush_session_totals(session_id, Path(spec.workdir), spec.env)
        return {"cost_usd": cost, "tokens_in": tokens_in, "tokens_out": tokens_out, "raw": identity_raw(session_id, cost)}

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

    # The DB alone identifies nothing: correlation needs the session ID crush
    # logged for the run, which this hook has no access to.
    def session_log_path(self, workdir: Path, session_started_after: float | None = None) -> str | None:
        return None

    def parse_session_log(self, path: str) -> SessionTelemetry:
        selector = parse_session_selector(path)
        if selector is None:
            return session_telemetry(path, None, NO_TOTALS)
        db_path, session_id = selector
        return session_telemetry(path, session_id, _read_crush_session_totals_by_db_path(db_path, session_id))


def _created_session_id(stderr: str) -> str | None:
    """The session crush logged as created for this run; None unless exactly
    one distinct ID was announced."""
    ids = {match.group(1) for match in _CREATED_SESSION_RE.finditer(strip_ansi(stderr))}
    return next(iter(ids)) if len(ids) == 1 else None


def _crush_data_dir_override(extra_env: dict[str, str] | None) -> str | None:
    """The caller's `CRUSH_DATA_DIR` (a harness convention translated to
    `--data-dir`): the caller's value when set, even empty, else inherited."""
    env = {**os.environ, **(extra_env or {})}
    return env.get("CRUSH_DATA_DIR") or None


def _crush_data_dir(workdir: Path, override: str | None) -> Path:
    """`--data-dir` as crush resolves it: relative to the child's cwd (the
    workdir), never `~`-expanded; default `<workdir>/.harness/crush-data`."""
    if override:
        return workdir / override
    return workdir / ".harness" / "crush-data"


def _crush_db_path(workdir: Path, extra_env: dict[str, str] | None = None) -> Path:
    return _crush_data_dir(absolute_workdir(workdir), _crush_data_dir_override(extra_env)) / "crush.db"


def _read_crush_session_totals_by_db_path(db_path: Path, session_id: str) -> SessionTotals:
    """crush's `sessions` row carries upstream's own aggregates for the exact
    session (`prompt_tokens`, `completion_tokens`, `cost`). The model comes
    from the session's assistant messages when they agree on one; a missing
    `messages` table only costs the model, never the aggregates."""

    def read(conn: sqlite3.Connection) -> SessionTotals:
        row = conn.execute(
            "SELECT prompt_tokens, completion_tokens, cost FROM sessions WHERE id = ?",
            (session_id,),
        ).fetchone()
        if row is None:
            return NO_TOTALS
        model = None
        try:
            rows = conn.execute(
                "SELECT model, provider FROM messages WHERE session_id = ? AND role = 'assistant'",
                (session_id,),
            ).fetchall()
        except sqlite3.Error:
            rows = []
        if rows:
            model = unanimous_model(rows)
        return token_count(row[0]), token_count(row[1]), cost_value(row[2]), model

    return read_only(db_path, read) or NO_TOTALS


def _read_crush_session_totals(session_id: str, workdir: Path, extra_env: dict[str, str] | None = None) -> SessionTotals:
    return _read_crush_session_totals_by_db_path(_crush_db_path(workdir, extra_env), session_id)
