"""gemini adapter — invokes the `gemini` CLI in print mode.

`gemini -p PROMPT --output-format json` emits a JSON envelope where token
usage lives at `stats.models[*].tokens.{input,candidates}`.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

from harness._subproc import SubprocOutcome, write_instructions
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
from harness.pricing import derive_cost
from harness.util import last_non_empty_join, strip_ansi

_APPLY_RE = re.compile(r"Apply this change\?", re.IGNORECASE)
_ALLOW_EXEC_RE = re.compile(r"Allow execution of", re.IGNORECASE)
_ACTION_REQUIRED_RE = re.compile(r"Action Required", re.IGNORECASE)
_ALLOW_RE = re.compile(r"Allow", re.IGNORECASE)
_TRUST_FILES_RE = re.compile(r"Do you trust the files", re.IGNORECASE)
_TRUST_FOLDER_RE = re.compile(r"Trust folder", re.IGNORECASE)
_TYPE_MESSAGE_RE = re.compile(r"Type your message", re.IGNORECASE)
_PROMPT_TAIL_RE = re.compile(r"[>❯]\s*$")
_RATE_LIMIT_RE = re.compile(r"rate.?limit|quota.?exceeded|resource.?exhausted", re.IGNORECASE)
_ERROR_RE = re.compile(r"error", re.IGNORECASE)
_FATAL_RE = re.compile(r"fatal|crash", re.IGNORECASE)
_SPINNER_RE = re.compile(r"[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⊶⊷]")
_THINKING_RE = re.compile(r"Thinking\.\.\.", re.IGNORECASE)
_READY_RE = re.compile(r"Ready", re.IGNORECASE)
_CHECK_RE = re.compile(r"[✓✔]")


class GeminiAdapter(Adapter):
    name = "gemini"
    instructions_filename = "GEMINI.md"
    permission_bypass_args = ("-y",)
    submit_keys = ("Enter",)
    install_meta = InstallMeta(
        package_manager="npm",
        install_command=("npm", "install", "-g", "@google/gemini-cli"),
        update_command=("npm", "install", "-g", "@google/gemini-cli@latest"),
        version_command=("gemini", "--version"),
        platforms=("darwin", "linux"),
    )

    DEFAULT_MODEL = "gemini-2.5-pro"

    def build_command(self, spec: RunSpec) -> BuildCommand:
        resolved = self.resolve_run_spec(spec)
        instructions_file = write_instructions(spec.workdir, self.instructions_filename, spec.instructions)
        args = ["-p", spec.prompt, *resolved.permission_args, "-m", resolved.model, "--output-format", "json"]
        return BuildCommand(cmd="gemini", args=args, cwd=spec.workdir, env={}, instructions_file=instructions_file)

    def parse_output(self, spec: RunSpec, outcome: SubprocOutcome) -> ParsedOutput:
        for blob in _json_candidates(outcome.stdout):
            stats = _parse_gemini_stats_blob(blob)
            if stats["tokens_in"] is None or stats["tokens_out"] is None:
                continue
            return {
                "cost_usd": stats["cost_usd"],
                "tokens_in": stats["tokens_in"],
                "tokens_out": stats["tokens_out"],
                "raw": stats["raw"],
            }
        return {"cost_usd": None, "tokens_in": None, "tokens_out": None, "raw": None}

    # ---- session-aware ---------------------------------------------------

    def detect_ready(self, pane: str) -> ReadyState:
        last20 = last_non_empty_join(pane, 20)
        if _APPLY_RE.search(last20) or _ALLOW_EXEC_RE.search(last20):
            return "dialog"
        if _TYPE_MESSAGE_RE.search(last20):
            return "ready"
        if _PROMPT_TAIL_RE.search(last20):
            return "ready"
        return "loading"

    def detect_status(self, pane: str) -> AgentStatus:
        last20 = last_non_empty_join(pane, 20)
        last10 = last_non_empty_join(pane, 10)

        # Mid-run dialogs (need auto-approve)
        if _APPLY_RE.search(last20) or _ALLOW_EXEC_RE.search(last20):
            return "dialog"
        if _ACTION_REQUIRED_RE.search(last20) and _ALLOW_RE.search(last20):
            return "dialog"
        if _TRUST_FILES_RE.search(last20):
            return "dialog"

        if _RATE_LIMIT_RE.search(last10):
            return "rate-limited"
        if _ERROR_RE.search(last10) and _FATAL_RE.search(last10):
            return "error"

        # Spinners
        if _SPINNER_RE.search(last10) or _THINKING_RE.search(last10):
            return "running"

        # Idle
        if _TYPE_MESSAGE_RE.search(last10):
            return "idle"
        if _READY_RE.search(last10) and not _SPINNER_RE.search(last10):
            return "idle"
        if _CHECK_RE.search(last10) and not _SPINNER_RE.search(last10):
            return "idle"

        return "unknown"

    def handle_dialog(self, pane: str) -> list[str] | None:
        text = strip_ansi(pane)
        # "Apply this change?" / "Allow execution of X?" / "Action Required" —
        # option 1 (Allow once) is selected by default; Enter accepts.
        if _APPLY_RE.search(text) or _ALLOW_EXEC_RE.search(text):
            return ["Enter"]
        if _ACTION_REQUIRED_RE.search(text) and _ALLOW_RE.search(text):
            return ["Enter"]
        if _TRUST_FILES_RE.search(text) or _TRUST_FOLDER_RE.search(text):
            return ["Enter"]
        return None

    # gemini-cli writes interactive logs to ~/.gemini/tmp/<basename(workdir)>/logs.json
    # and headless --output-format=json stats to stdout/files with stats.models.
    # session_log_path still points at interactive logs; parse_session_log can
    # parse either shape when given a file path.
    def session_log_path(self, workdir: Path, session_started_after: float | None = None) -> str | None:
        path = Path.home() / ".gemini" / "tmp" / workdir.name / "logs.json"
        return str(path) if path.exists() else None

    def parse_session_log(self, path: str) -> SessionTelemetry:
        p = Path(path)
        if not p.exists():
            return SessionTelemetry(path, None, None, None, None, None)
        try:
            raw_text = p.read_text(encoding="utf-8")
        except OSError:
            return SessionTelemetry(path, None, None, None, None, None)

        stats = _parse_gemini_stats_blob(raw_text)
        if stats["tokens_in"] is not None and stats["tokens_out"] is not None:
            return SessionTelemetry(path, stats["tokens_in"], stats["tokens_out"], stats["cost_usd"], stats["model"], stats["raw"])
        try:
            return SessionTelemetry(path, None, None, None, None, json.loads(raw_text))
        except json.JSONDecodeError:
            return SessionTelemetry(path, None, None, None, None, None)


def _json_candidates(stdout: str) -> list[str]:
    """Whole stdout first, then any line that looks like a JSON object."""
    candidates = [stdout.strip()]
    candidates += [ln.strip() for ln in stdout.splitlines() if ln.strip().startswith("{")]
    return [c for c in candidates if c]


def _gemini_token_count(value: object) -> int | None:
    """Accept nonnegative safe integers; preserve decimal-string compatibility."""
    if value is None:
        return 0
    if isinstance(value, str):
        if re.fullmatch(r"\s*\+?[0-9]+\s*", value) is None:
            return None
        try:
            value = int(value)
        except ValueError:
            return None
    if type(value) in (int, float) and 0 <= value <= 9007199254740991 and int(value) == value:
        return int(value)
    return None


def _parse_gemini_stats_blob(blob: str) -> dict:
    """Extract token/cost/model from a gemini stats envelope (`stats.models[*]`).

    Mirrors the TS `parseGeminiStatsBlob`. Token fields are None when the blob
    is not a stats envelope; a stats block that is present but empty reports
    0/0 ("ran but upstream didn't expose usage").
    """
    try:
        parsed = json.loads(blob)
    except json.JSONDecodeError:
        return {"tokens_in": None, "tokens_out": None, "cost_usd": None, "model": None, "raw": None}
    if not isinstance(parsed, dict):
        return {"tokens_in": None, "tokens_out": None, "cost_usd": None, "model": None, "raw": parsed}

    stats = parsed.get("stats")
    models = stats.get("models") if isinstance(stats, dict) else None
    if not isinstance(models, dict):
        return {"tokens_in": None, "tokens_out": None, "cost_usd": None, "model": None, "raw": parsed}

    tokens_in = tokens_out = 0
    model: str | None = None
    for name, model_stats in models.items():
        if not isinstance(model_stats, dict):
            continue
        if model is None:
            model = name
        tokens = model_stats.get("tokens")
        if tokens is None:
            tokens = {}
        if not isinstance(tokens, dict):
            return {"tokens_in": None, "tokens_out": None, "cost_usd": None, "model": None, "raw": parsed}
        count_in = _gemini_token_count(tokens.get("input"))
        count_out = _gemini_token_count(tokens.get("candidates"))
        if count_in is None or count_out is None:
            return {"tokens_in": None, "tokens_out": None, "cost_usd": None, "model": None, "raw": parsed}
        tokens_in += count_in
        tokens_out += count_out
        if tokens_in > 9007199254740991 or tokens_out > 9007199254740991:
            return {"tokens_in": None, "tokens_out": None, "cost_usd": None, "model": None, "raw": parsed}

    return {
        "tokens_in": tokens_in,
        "tokens_out": tokens_out,
        "cost_usd": derive_cost(model, tokens_in, tokens_out),
        "model": model,
        "raw": parsed,
    }
