"""opencode adapter — invokes the `opencode run` CLI.

opencode persists sessions in a sqlite DB at
`~/.local/share/opencode/opencode.db`. Token/cost totals live in `message`
rows; we match on the `session.directory` column to find the session created
by THIS run (which used `--dir <workdir>`).

Mirror of agentelo/bin/agentelo's opencode parsing path (line ~1491).
"""
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
    ScrollKeys,
    SessionTelemetry,
    absolute_workdir,
)
from harness.pricing import derive_cost
from harness.util import last_non_empty_join, strip_ansi


_OPENCODE_SCROLL_KEYS = ScrollKeys(line_down="C-M-e", line_up="C-M-y", page_down="NPage", page_up="PPage")

_UPDATE_RE = re.compile(r"update available|a new version of opencode|upgrade now", re.IGNORECASE)
_ASK_ANYTHING_RE = re.compile(r"Ask anything", re.IGNORECASE)
_VERSION_RE = re.compile(r"\d+\.\d+\.\d+")
_RATE_LIMIT_RE = re.compile(r"rate.?limit|try again later", re.IGNORECASE)
_SPINNER_RE = re.compile(r"[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]")
_WORKING_RE = re.compile(r"thinking|running", re.IGNORECASE)


class OpenCodeAdapter(Adapter):
    name = "opencode"
    instructions_filename = "AGENTS.md"
    scroll_ownership = "app"
    submit_keys = ("Enter",)
    flatten_on_paste = True
    install_meta = InstallMeta(
        package_manager="npm",
        install_command=("npm", "install", "-g", "opencode-ai"),
        update_command=("npm", "install", "-g", "opencode-ai@latest"),
        version_command=("opencode", "--version"),
    )

    DEFAULT_MODEL = "gpt-5.4"

    def get_current_scroll_keys(self) -> ScrollKeys | None:
        # opencode always renders into its own virtualized scrollback — return
        # the fixed chord map regardless of any external mode.
        return _OPENCODE_SCROLL_KEYS

    def build_command(self, spec: RunSpec) -> BuildCommand:
        resolved = self.resolve_run_spec(spec)
        args = ["run", "--dir", str(absolute_workdir(spec.workdir)), "--model", resolved.model, spec.prompt]
        return self.finalize_command(spec, cmd="opencode", args=args)

    def parse_output(self, spec: RunSpec, outcome: SubprocOutcome) -> ParsedOutput:
        tokens_in, tokens_out, cost, _model = _read_opencode_session_totals(Path(spec.workdir), spec.env)
        return {"cost_usd": cost, "tokens_in": tokens_in, "tokens_out": tokens_out, "raw": None}

    # ---- session-aware ---------------------------------------------------

    def detect_ready(self, pane: str) -> ReadyState:
        full = strip_ansi(pane)
        last5 = last_non_empty_join(pane, 5)
        if _UPDATE_RE.search(full):
            return "dialog"
        if _ASK_ANYTHING_RE.search(full) and _VERSION_RE.search(last5):
            return "ready"
        return "loading"

    def handle_dialog(self, pane: str) -> list[str] | None:
        if _UPDATE_RE.search(strip_ansi(pane)):
            return ["Escape"]
        return None

    def detect_status(self, pane: str) -> AgentStatus:
        last10 = last_non_empty_join(pane, 10)
        full = strip_ansi(pane)
        if _UPDATE_RE.search(full):
            return "dialog"
        if _RATE_LIMIT_RE.search(last10):
            return "rate-limited"
        if _SPINNER_RE.search(last10) or _WORKING_RE.search(last10):
            return "running"
        if _ASK_ANYTHING_RE.search(full):
            return "idle"
        return "unknown"

    # opencode telemetry already lives in SQLite; the "path" is the DB plus a
    # session hint so consumers know where to look.
    def session_log_path(self, workdir: Path, session_started_after: float | None = None) -> str | None:
        db_path = _opencode_db_path(None)
        if not db_path.exists():
            return None
        try:
            base = workdir.resolve().name
        except OSError:
            base = workdir.name
        return f"{db_path}#session({base})"

    def parse_session_log(self, path: str) -> SessionTelemetry:
        db_raw = path.split("#", 1)[0]
        hint = ""
        if "session(" in path and path.endswith(")"):
            hint = path.split("session(", 1)[1][:-1]
        db_path = Path(db_raw)
        if not db_path.exists():
            return SessionTelemetry(path, None, None, None, None, None)
        tokens_in, tokens_out, cost, model = _read_opencode_session_totals(Path(hint or "/"), None, db_path=db_path)
        # SQLite cost can be 0 when opencode used a custom provider (no upstream
        # pricing): fall back to derive_cost from tokens if we have any.
        if (cost is None or cost == 0) and tokens_in is not None and (tokens_in > 0 or (tokens_out or 0) > 0):
            cost = derive_cost("gpt-5.4", tokens_in, tokens_out) or cost
        return SessionTelemetry(path, tokens_in, tokens_out, cost, model, None)


def _opencode_db_path(extra_env: dict[str, str] | None = None) -> Path:
    """DB location as the CLI run sees it: caller env over inherited env, with
    `OPENCODE_DB` explicit, then `XDG_DATA_HOME`, then the platform default."""
    env = {**os.environ, **(extra_env or {})}
    explicit = env.get("OPENCODE_DB")
    if explicit:
        return Path(explicit).expanduser()
    data_home = env.get("XDG_DATA_HOME")
    base = Path(data_home) if data_home else Path.home() / ".local" / "share"
    return base / "opencode" / "opencode.db"


def _read_opencode_session_totals(
    workdir: Path,
    extra_env: dict[str, str] | None = None,
    db_path: Path | None = None,
) -> tuple[int | None, int | None, float | None, str | None]:
    """Query opencode's sqlite for the session that ran in `workdir`.

    Returns (tokens_in, tokens_out, cost_usd, model). All None if DB
    unavailable or no matching session.
    """
    if db_path is None:
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
