"""opencode adapter — invokes the `opencode run` CLI.

`--format json` makes every run event carry the native `sessionID`; that exact
ID keys the `message` rows read from opencode's sqlite DB under
`Global.Path.data` (`$XDG_DATA_HOME|~/.local/share` + `opencode`, or
`OPENCODE_DB`). No workdir/basename/latest matching and no cost estimates.
"""
from __future__ import annotations

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
    ScrollKeys,
    SessionTelemetry,
    absolute_workdir,
)
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
        args = [
            "run",
            "--format",
            "json",
            "--dir",
            str(absolute_workdir(spec.workdir)),
            "--model",
            resolved.model,
            spec.prompt,
        ]
        return self.finalize_command(spec, cmd="opencode", args=args)

    def parse_output(self, spec: RunSpec, outcome: SubprocOutcome) -> ParsedOutput:
        session_id = native_session_id_from_events(outcome.stdout)
        if session_id is None:
            return {"cost_usd": None, "tokens_in": None, "tokens_out": None, "raw": None}
        tokens_in, tokens_out, cost, _model = _read_opencode_session_totals(session_id, Path(spec.workdir), spec.env)
        return {"cost_usd": cost, "tokens_in": tokens_in, "tokens_out": tokens_out, "raw": identity_raw(session_id, cost)}

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


def _opencode_db_path(session_id: str, workdir: Path, extra_env: dict[str, str] | None = None) -> Path | None:
    """The DB the CLI run wrote to, as its child environment decided. A nonempty
    `OPENCODE_DB` is authoritative (upstream `Database.path()`); otherwise the
    release-channel filename is not observable, so the exact session row is
    looked for among the data dir's `*.db` files."""
    env = effective_env(extra_env)
    data_dir = xdg_data_dir(env, "opencode", workdir)
    override = env.get("OPENCODE_DB", "")
    if override:
        return resolve_native_db(override, data_dir)
    return discover_session_db(
        data_dir,
        session_id,
        channel_db="opencode.db",
        channel_disabled=channel_db_disabled(env, "OPENCODE_DISABLE_CHANNEL_DB"),
    )


def _read_opencode_session_totals(session_id: str, workdir: Path, extra_env: dict[str, str] | None = None) -> SessionTotals:
    """(tokens_in, tokens_out, cost_usd, model) for the exact native session; all None when unavailable."""
    return read_message_totals(_opencode_db_path(session_id, workdir, extra_env), session_id)
