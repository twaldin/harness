"""Kilo adapter — invokes `kilo run` and reads token/cost totals from sqlite.

`--format json` puts the native `sessionID` on every run event; that exact ID
keys the `message` rows read from the DB. The builder pins an absolute
per-workdir `KILO_DB` unless the caller chose one; a caller's relative value
stays verbatim and, as upstream, resolves against `Global.Path.data`
(`$XDG_DATA_HOME|~/.local/share` + `kilo`).
"""
from __future__ import annotations

import json
import os
import re
from pathlib import Path

from harness._subproc import SubprocOutcome
from harness.adapters._native_db import (
    NO_TOTALS,
    SessionTotals,
    channel_db_disabled,
    discover_session_db,
    effective_env,
    identity_raw,
    native_session_id_from_events,
    parse_session_selector,
    read_message_totals,
    resolve_native_db,
    session_telemetry,
    xdg_data_dir,
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
        override = _kilo_db_override(spec.env)
        env: dict[str, str] = {}
        directories: tuple[Path, ...] = ()
        if override is None:
            # Deterministic per-workdir DB for container safety; its parent is a
            # harness artifact prepare creates.
            db_path = _kilo_default_db_path(workdir)
            env["KILO_DB"] = str(db_path)
            directories = (db_path.parent,)
        elif override:
            # Caller-owned (e.g. a container-only path): passed verbatim, never
            # expanded or re-rooted, and left to the runtime to create.
            env["KILO_DB"] = override
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
        session_id = native_session_id_from_events(outcome.stdout)
        if session_id is None:
            return {"cost_usd": None, "tokens_in": None, "tokens_out": None, "raw": None}
        tokens_in, tokens_out, cost, _model = _read_kilo_session_totals(session_id, Path(spec.workdir), spec.env)
        return {"cost_usd": cost, "tokens_in": tokens_in, "tokens_out": tokens_out, "raw": identity_raw(session_id, cost)}

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

    # The DB alone identifies nothing: correlation needs the native session ID
    # from a run's `--format json` output, which this hook has no access to.
    def session_log_path(self, workdir: Path, session_started_after: float | None = None) -> str | None:
        return None

    def parse_session_log(self, path: str) -> SessionTelemetry:
        selector = parse_session_selector(path)
        if selector is None:
            return session_telemetry(path, None, NO_TOTALS)
        db_path, session_id = selector
        return session_telemetry(path, session_id, read_message_totals(db_path, session_id))


def _kilo_db_override(extra_env: dict[str, str] | None) -> str | None:
    """The `KILO_DB` the child sees before the builder's default: the caller's
    value when the caller set the key (an explicit empty string included, since
    `finalize_command` lets it win), else a nonempty inherited value."""
    if extra_env is not None and "KILO_DB" in extra_env:
        return extra_env["KILO_DB"]
    return os.environ.get("KILO_DB") or None


def _kilo_default_db_path(workdir: Path) -> Path:
    return workdir / ".harness" / "kilo" / "kilo.db"


def _kilo_db_path(session_id: str, workdir: Path, extra_env: dict[str, str] | None = None) -> Path | None:
    """The DB the run wrote to. A nonempty override follows upstream
    `Database.path()`; an explicit empty one hands upstream its channel default,
    whose filename is not observable, so the exact session row is looked for
    among the data dir's `*.db` files; otherwise the builder's per-workdir DB."""
    override = _kilo_db_override(extra_env)
    if override is None:
        return _kilo_default_db_path(absolute_workdir(workdir))
    env = effective_env(extra_env)
    data_dir = xdg_data_dir(env, "kilo", workdir, strip_newlines=True)
    if override:
        return resolve_native_db(override, data_dir)
    return discover_session_db(
        data_dir,
        session_id,
        channel_db="kilo.db",
        channel_disabled=channel_db_disabled(env, "KILO_DISABLE_CHANNEL_DB"),
    )


def _read_kilo_session_totals(session_id: str, workdir: Path, extra_env: dict[str, str] | None = None) -> SessionTotals:
    """(tokens_in, tokens_out, cost_usd, model) for the exact native session; all None when unavailable."""
    return read_message_totals(_kilo_db_path(session_id, workdir, extra_env), session_id)
