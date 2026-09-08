"""Factory Droid adapter — invokes `droid exec` in headless JSON mode.

Session artifacts (droid 0.213.0 binary, `@factory/droid-sdk` 0.9.1
`src/session-discovery.ts`): `<FACTORY_HOME_OVERRIDE or ~>/.factory/sessions/`
holds one project directory per working directory, named `-` + realpath with
`/` runs replaced by `-` (`/Users/me/app` -> `-Users-me-app`). Each session is
`<uuid>.jsonl` (first line `{"type":"session_start","cwd":...}`) plus
`<uuid>.settings.json` (`model`, `tokenUsage.{inputTokens,outputTokens,...}`).
Older builds wrote `<uuid>.jsonl` flat in `sessions/`; those are matched by
their `session_start.cwd`. Usage never appears in the `--output-format json`
envelope and Factory bills credits, not USD, so cost stays null.
"""
from __future__ import annotations

import json
import os
import re
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
)
from harness.util import last_non_empty_join, strip_ansi

_SETTINGS_SUFFIX = ".settings.json"
_SESSION_START_BYTES = 65536  # upstream reads the first 64 KiB for the session_start line

_READY_RE = re.compile(r'Try\s+"|Auto.*\(Off\)|Auto.*\(On\)', re.IGNORECASE)
_IDLE_RE = re.compile(r'Try\s+"|Auto.*\(', re.IGNORECASE)
_UPDATE_RE = re.compile(r"Update available", re.IGNORECASE)
_RATE_LIMIT_RE = re.compile(r"rate.?limit", re.IGNORECASE)
_SPINNER_RE = re.compile(r"[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]")
_WORKING_RE = re.compile(r"Thinking|Working", re.IGNORECASE)


class FactoryDroidAdapter(Adapter):
    name = "factory-droid"
    instructions_filename = "AGENTS.md"
    permission_bypass_args = ("--skip-permissions-unsafe",)
    submit_keys = ("Enter",)
    install_meta = InstallMeta(
        package_manager="npm",
        install_command=("npm", "install", "-g", "droid"),
        update_command=("npm", "install", "-g", "droid@latest"),
        version_command=("droid", "--version"),
    )

    DEFAULT_MODEL = "gpt-5.4"

    def build_command(self, spec: RunSpec) -> BuildCommand:
        resolved = self.resolve_run_spec(spec)
        model = resolved.model

        # Keep strict same-model fairness by pinning spec generation to the
        # same model as execution.
        args = [
            "exec",
            "--output-format",
            "json",
            *resolved.permission_args,
            "--model",
            model,
            "--spec-model",
            model,
            spec.prompt,
        ]
        return self.finalize_command(spec, cmd="droid", args=args)

    def parse_output(self, spec: RunSpec, outcome: SubprocOutcome) -> ParsedOutput:
        raw = _parse_last_json_object(outcome.stdout)
        if not isinstance(raw, dict):
            return {"cost_usd": None, "tokens_in": None, "tokens_out": None, "raw": None}

        usage = raw.get("usage") if isinstance(raw.get("usage"), dict) else {}
        cost = _to_float(raw.get("total_cost_usd"))
        if cost is None:
            usage_cost = usage.get("cost")
            if isinstance(usage_cost, (int, float)):
                cost = float(usage_cost)
            elif isinstance(usage_cost, dict):
                cost = _to_float(usage_cost.get("total"))

        return {
            "cost_usd": cost,
            "tokens_in": _to_int(_first_present(usage, "input_tokens", "input")),
            "tokens_out": _to_int(_first_present(usage, "output_tokens", "output")),
            "raw": raw,
        }

    # ---- session-aware ---------------------------------------------------

    def detect_ready(self, pane: str) -> ReadyState:
        last30 = last_non_empty_join(pane, 30)
        if _READY_RE.search(last30):
            return "ready"
        if _UPDATE_RE.search(last30):
            return "dialog"
        return "loading"

    def handle_dialog(self, pane: str) -> list[str] | None:
        if _UPDATE_RE.search(strip_ansi(pane)):
            return ["Escape"]
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
        cwd = _canonical_cwd(workdir)
        sessions = factory_sessions_dir()
        newest: tuple[float, Path] | None = None

        def consider(p: Path) -> None:
            nonlocal newest
            try:
                mtime = p.stat().st_mtime
            except OSError:
                return
            if session_started_after is not None and mtime < session_started_after:
                return
            if newest is not None and (mtime, str(p)) <= (newest[0], str(newest[1])):
                return
            if _session_start_cwd(p) == cwd:
                newest = (mtime, p)

        for p in _jsonl_files(sessions / encode_project_dir(cwd)):
            consider(p)
        # Older builds use a flat directory; both layouts require matching cwd.
        for p in _jsonl_files(sessions):
            consider(p)
        return str(newest[1]) if newest else None

    def parse_session_log(self, path: str) -> SessionTelemetry:
        p = Path(path)
        settings_path = p if path.endswith(_SETTINGS_SUFFIX) else p.with_name(p.stem + _SETTINGS_SUFFIX)
        settings = _read_json_object(settings_path)
        if settings is None and not p.exists():
            return SessionTelemetry(path, None, None, None, None, None)

        fields = settings or {}
        usage = fields.get("tokenUsage") if isinstance(fields.get("tokenUsage"), dict) else {}
        model = fields.get("model") if isinstance(fields.get("model"), str) else None
        if model is None and settings_path != p:
            model = _last_assistant_model_id(p)
        return SessionTelemetry(
            path,
            _to_int(usage.get("inputTokens")),
            _to_int(usage.get("outputTokens")),
            None,
            model,
            settings,
        )


def factory_sessions_dir() -> Path:
    """`<FACTORY_HOME_OVERRIDE or ~>/.factory/sessions`; the override replaces `~`, not `~/.factory`."""
    home = os.environ.get("FACTORY_HOME_OVERRIDE") or os.path.expanduser("~")
    return Path(home) / ".factory" / "sessions"


def encode_project_dir(cwd: str) -> str:
    """`-` + cwd without leading/trailing slashes and every `/` run replaced by `-` (POSIX rule)."""
    return "-" + re.sub(r"/+", "-", cwd.strip("/"))


def _canonical_cwd(workdir: Path) -> str:
    absolute = os.path.abspath(workdir)
    try:
        return os.path.realpath(absolute, strict=True)
    except OSError:
        return absolute


def _jsonl_files(directory: Path) -> list[Path]:
    try:
        return [p for p in directory.iterdir() if p.suffix == ".jsonl" and p.is_file()]
    except OSError:
        return []


def _session_start_cwd(path: Path) -> str | None:
    """`cwd` from a session file's first `session_start` line, or None."""
    try:
        with path.open("rb") as fh:
            first = fh.read(_SESSION_START_BYTES).split(b"\n", 1)[0]
        event = json.loads(first)
    except (OSError, ValueError):
        return None
    if not isinstance(event, dict) or event.get("type") != "session_start":
        return None
    cwd = event.get("cwd")
    return cwd if isinstance(cwd, str) else None


def _read_json_object(path: Path) -> dict | None:
    try:
        parsed = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return parsed if isinstance(parsed, dict) else None


def _last_assistant_model_id(path: Path) -> str | None:
    """`message.modelId` of the last assistant line (recent droid builds stamp it; older ones do not)."""
    model: str | None = None
    try:
        with path.open(encoding="utf-8") as fh:
            for line in fh:
                if '"modelId"' not in line:
                    continue
                try:
                    event = json.loads(line)
                except ValueError:
                    continue
                message = event.get("message") if isinstance(event, dict) else None
                if isinstance(message, dict) and message.get("role") == "assistant" and isinstance(message.get("modelId"), str):
                    model = message["modelId"]
    except OSError:
        return None
    return model


def _parse_last_json_object(stdout: str) -> dict | None:
    blob = stdout.strip()
    if blob:
        try:
            parsed = json.loads(blob)
            if isinstance(parsed, dict):
                return parsed
        except json.JSONDecodeError:
            pass

    for line in reversed(stdout.splitlines()):
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            parsed = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict):
            return parsed

    return None


def _first_present(usage: dict, primary: str, fallback: str) -> object:
    """`usage[primary]` unless it is missing/null; an explicit 0 is a real count."""
    value = usage.get(primary)
    return usage.get(fallback) if value is None else value


def _to_int(v: object) -> int | None:
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return int(v)
    return None


def _to_float(v: object) -> float | None:
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v)
    return None
