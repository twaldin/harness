"""continue-cli adapter — invokes the `cn` CLI (Continue) in print mode.

Default: `cn -p <prompt> --model <model> --json`. With `RunSpec.config_file`
the caller-selected Continue config drives model/provider selection:
`cn -p --config <file> --format json <prompt>` (no `--model`, since Continue's
`--model` expects a Hub slug rather than a native model id, an explicit model
is rejected on this path). OPENAI_API_KEY/OPENAI_BASE_URL in `spec.env`
require such a config file; harness no longer generates one.
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
    HarnessError,
    InstallMeta,
    ParsedOutput,
    ReadyState,
    RunSpec,
    SessionTelemetry,
)
from harness.pricing import derive_cost
from harness.util import last_non_empty_join, strip_ansi

_MODEL_LOADING_RE = re.compile(r"Model:\s*Loading", re.IGNORECASE)
_ASK_ANYTHING_RE = re.compile(r"Ask anything", re.IGNORECASE)
_UPDATE_RE = re.compile(r"Update available", re.IGNORECASE)
_RATE_LIMIT_RE = re.compile(r"rate.?limit", re.IGNORECASE)
_SPINNER_RE = re.compile(r"[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]")
_WORKING_RE = re.compile(r"thinking|working", re.IGNORECASE)


class ContinueCliAdapter(Adapter):
    name = "continue-cli"
    instructions_filename = "CONTINUE.md"
    submit_keys = ("Enter",)
    config_file_flag = "--config"
    install_meta = InstallMeta(
        package_manager="npm",
        install_command=("npm", "install", "-g", "@continuedev/cli"),
        update_command=("npm", "install", "-g", "@continuedev/cli@latest"),
        version_command=("cn", "--version"),
    )

    DEFAULT_MODEL = "claude-sonnet-4-6"

    def reported_model(self, spec: RunSpec) -> str | None:
        # With a caller-selected config the model comes from that file.
        return None if spec.config_file is not None else super().reported_model(spec)

    def build_command(self, spec: RunSpec) -> BuildCommand:
        resolved = self.resolve_run_spec(spec)

        if spec.config_file is not None:
            if spec.model:
                raise HarnessError(
                    "continue-cli cannot honor both config_file and an explicit model (cn --model expects a Continue Hub "
                    "slug); select the model inside the config file and leave model unset",
                    code="unsupported-capability",
                )
            args = ["-p", *resolved.config_args, "--format", "json", spec.prompt]
            return self.finalize_command(spec, cmd="cn", args=args)

        if "OPENAI_API_KEY" in spec.env or "OPENAI_BASE_URL" in spec.env:
            raise HarnessError(
                "continue-cli with OPENAI_API_KEY/OPENAI_BASE_URL in env requires a caller-selected config_file; harness "
                "does not generate Continue config",
                code="unsupported-capability",
            )

        args = ["-p", spec.prompt, "--model", resolved.model, "--json"]
        return self.finalize_command(spec, cmd="cn", args=args)

    def parse_output(self, spec: RunSpec, outcome: SubprocOutcome) -> ParsedOutput:
        raw: dict | None = None
        if outcome.stdout.strip():
            try:
                raw = json.loads(outcome.stdout)
            except json.JSONDecodeError:
                raw = None

        cost = tokens_in = tokens_out = None
        if isinstance(raw, dict):
            usage = raw.get("usage") or {}
            tokens_in = usage.get("input_tokens")
            tokens_out = usage.get("output_tokens")
            cost = raw.get("total_cost_usd")

        return {"cost_usd": cost, "tokens_in": tokens_in, "tokens_out": tokens_out, "raw": raw}

    def session_log_path(self, workdir: Path, session_started_after: float | None = None) -> str | None:
        env_dir = os.environ.get("CONTINUE_SESSION_DIR")
        if env_dir:
            d = Path(env_dir).expanduser()
            if d.exists() and d.is_dir():
                files = sorted((p for p in d.glob("*.json") if p.is_file()), key=lambda p: p.stat().st_mtime, reverse=True)
                if files:
                    return str(files[0])

        base = workdir.name
        candidates = [
            Path.home() / ".continue" / "sessions" / base,
            Path.home() / ".continue" / "dev_data" / base,
            Path.home() / ".continue" / "index" / base,
        ]
        for d in candidates:
            if not d.exists() or not d.is_dir():
                continue
            files = sorted((p for p in d.glob("*.json") if p.is_file()), key=lambda p: p.stat().st_mtime, reverse=True)
            if files:
                return str(files[0])
            idx = d / "session.json"
            if idx.exists():
                return str(idx)
        return None

    def parse_session_log(self, path: str) -> SessionTelemetry:
        p = Path(path)
        if not p.exists():
            return SessionTelemetry(path, None, None, None, None, None)
        try:
            raw = json.loads(p.read_text(encoding="utf-8"))
            obj = raw if isinstance(raw, dict) else {}
            usage = obj.get("usage") if isinstance(obj.get("usage"), dict) else {}
            tokens_in = int(usage.get("input_tokens")) if isinstance(usage.get("input_tokens"), (int, float)) else None
            tokens_out = int(usage.get("output_tokens")) if isinstance(usage.get("output_tokens"), (int, float)) else None
            model = obj.get("model") if isinstance(obj.get("model"), str) else None
            cost = float(obj.get("total_cost_usd")) if isinstance(obj.get("total_cost_usd"), (int, float)) else None
            if cost is None:
                cost = derive_cost(model, tokens_in, tokens_out)
            return SessionTelemetry(path, tokens_in, tokens_out, cost, model, raw)
        except (OSError, json.JSONDecodeError, ValueError, TypeError):
            return SessionTelemetry(path, None, None, None, None, None)

    # ---- session-aware ---------------------------------------------------

    def detect_ready(self, pane: str) -> ReadyState:
        last20 = last_non_empty_join(pane, 20)
        # cn shows "Ask anything" placeholder while the model is still loading.
        # Real ready = input visible AND model loaded (no "Model: Loading..." line).
        if _MODEL_LOADING_RE.search(last20):
            return "loading"
        if _ASK_ANYTHING_RE.search(last20):
            return "ready"
        if _UPDATE_RE.search(last20):
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
        if _ASK_ANYTHING_RE.search(last10):
            return "idle"
        return "unknown"
