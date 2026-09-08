"""qwen adapter — invokes the `qwen` CLI in print mode.

`qwen -p PROMPT --output-format json` emits a JSON array on stdout where the
last item with `type='result'` carries usage: `{"input_tokens": N, "output_tokens": M}`.
Alibaba Cloud does not embed pricing in the response.
"""
from __future__ import annotations

import json
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
from harness.pricing import derive_cost
from harness.util import last_non_empty_join

_AUTH_RE = re.compile(r"Qwen OAuth|API Key", re.IGNORECASE)
_AUTH_ACTION_RE = re.compile(r"Discontinued|switch", re.IGNORECASE)
_PROMPT_RE = re.compile(r"Type your message|>\s*$|❯\s*$", re.IGNORECASE | re.MULTILINE)
_RATE_LIMIT_RE = re.compile(r"rate.?limit|quota", re.IGNORECASE)
_SPINNER_RE = re.compile(r"[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]")
_WORKING_RE = re.compile(r"thinking|working", re.IGNORECASE)


class QwenAdapter(Adapter):
    name = "qwen"
    instructions_filename = "QWEN.md"
    permission_bypass_args = ("-y",)
    submit_keys = ("Enter",)
    install_meta = InstallMeta(
        package_manager="npm",
        install_command=("npm", "install", "-g", "@qwen-code/qwen-code"),
        update_command=("npm", "install", "-g", "@qwen-code/qwen-code@latest"),
        version_command=("qwen", "--version"),
    )

    DEFAULT_MODEL = "qwen3-coder"

    def build_command(self, spec: RunSpec) -> BuildCommand:
        resolved = self.resolve_run_spec(spec)
        args = ["-p", spec.prompt, *resolved.permission_args, "-m", resolved.model, "--output-format", "json"]
        return self.finalize_command(spec, cmd="qwen", args=args)

    def parse_output(self, spec: RunSpec, outcome: SubprocOutcome) -> ParsedOutput:
        tokens_in, tokens_out, raw = _parse_qwen_stats(outcome.stdout)
        return {
            "cost_usd": None,
            "tokens_in": tokens_in if raw is not None else None,
            "tokens_out": tokens_out if raw is not None else None,
            "raw": raw,
        }

    # ---- session-aware ---------------------------------------------------

    def detect_ready(self, pane: str) -> ReadyState:
        last30 = last_non_empty_join(pane, 30)
        # Auth dialog (OAuth discontinued / API key prompt)
        if _AUTH_RE.search(last30) and _AUTH_ACTION_RE.search(last30):
            return "dialog"
        if _PROMPT_RE.search(last30):
            return "ready"
        return "loading"

    def handle_dialog(self, pane: str) -> list[str] | None:
        # Auth dialog needs the user — None so the consumer surfaces it.
        return None

    def detect_status(self, pane: str) -> AgentStatus:
        last10 = last_non_empty_join(pane, 10)
        if _RATE_LIMIT_RE.search(last10):
            return "rate-limited"
        if _SPINNER_RE.search(last10) or _WORKING_RE.search(last10):
            return "running"
        if _PROMPT_RE.search(last10):
            return "idle"
        return "unknown"

    def session_log_path(self, workdir: Path, session_started_after: float | None = None) -> str | None:
        base = workdir.name
        primary = Path.home() / ".qwen" / "tmp" / base / "logs.json"
        if primary.exists():
            return str(primary)
        compat = Path.home() / ".gemini" / "tmp" / base / "logs.json"
        if compat.exists():
            return str(compat)
        return None

    def parse_session_log(self, path: str) -> SessionTelemetry:
        p = Path(path)
        if not p.exists():
            return SessionTelemetry(path, None, None, None, None, None)
        try:
            raw_text = p.read_text(encoding="utf-8")
        except OSError:
            return SessionTelemetry(path, None, None, None, None, None)

        stats = _parse_qwen_stats_blob(raw_text)
        if stats["tokens_in"] is not None and stats["tokens_out"] is not None:
            return SessionTelemetry(
                path,
                stats["tokens_in"],
                stats["tokens_out"],
                stats["cost_usd"],
                stats["model"],
                stats["raw"],
            )

        try:
            raw = json.loads(raw_text)
            return SessionTelemetry(path, None, None, None, None, raw)
        except json.JSONDecodeError:
            return SessionTelemetry(path, None, None, None, None, None)


def _parse_qwen_stats_blob(blob: str) -> dict:
    """Extract token/cost/model from a qwen stats envelope (`stats.models[*]`).

    Mirrors the TS `parseQwenStatsBlob`. Returns a dict with keys
    `tokens_in`, `tokens_out`, `cost_usd`, `model`, `raw`. Token fields are
    None when the blob can't be interpreted as a stats envelope.
    """
    try:
        parsed = json.loads(blob)
    except json.JSONDecodeError:
        return {"tokens_in": None, "tokens_out": None, "cost_usd": None, "model": None, "raw": None}
    return _stats_from_parsed(parsed)


def _stats_from_parsed(parsed: object) -> dict:
    if not isinstance(parsed, dict):
        return {"tokens_in": None, "tokens_out": None, "cost_usd": None, "model": None, "raw": parsed}

    stats = parsed.get("stats")
    models = stats.get("models") if isinstance(stats, dict) else None
    if not isinstance(models, dict):
        return {"tokens_in": None, "tokens_out": None, "cost_usd": None, "model": None, "raw": parsed}

    tokens_in = 0
    tokens_out = 0
    model: str | None = None
    for name, model_stats in models.items():
        if not isinstance(model_stats, dict):
            continue
        if model is None:
            model = name
        tokens = model_stats.get("tokens") or {}
        tokens_in += int(tokens.get("input") or 0)
        tokens_out += int(tokens.get("candidates") or 0)

    return {
        "tokens_in": tokens_in,
        "tokens_out": tokens_out,
        "cost_usd": derive_cost(model, tokens_in, tokens_out),
        "model": model,
        "raw": parsed,
    }


def _parse_qwen_stats(stdout: str) -> tuple[int, int, list | dict | None]:
    """Parse qwen's --output-format json output.

    Current qwen emits a JSON array where the last item with `type="result"`
    carries `usage.{input_tokens, output_tokens}`. Older qwen versions emit a
    JSON envelope object with `stats.models[*].tokens.{input, candidates}`;
    we keep a fallback for that for backwards compatibility.
    """
    candidates: list[str] = [stdout.strip()]
    for ln in stdout.splitlines():
        s = ln.strip()
        if s.startswith("[") or s.startswith("{"):
            candidates.append(s)

    for blob in candidates:
        if not blob:
            continue
        try:
            parsed = json.loads(blob)
        except json.JSONDecodeError:
            continue

        if isinstance(parsed, list):
            for item in reversed(parsed):
                if not isinstance(item, dict) or item.get("type") != "result":
                    continue
                usage = item.get("usage") or {}
                tokens_in = int(usage.get("input_tokens") or 0)
                tokens_out = int(usage.get("output_tokens") or 0)
                return tokens_in, tokens_out, parsed
            continue

        if isinstance(parsed, dict):
            stats = _stats_from_parsed(parsed)
            if stats["tokens_in"] is None:
                continue
            return stats["tokens_in"], stats["tokens_out"], parsed

    return 0, 0, None
