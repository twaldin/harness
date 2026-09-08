"""swe-agent adapter — invokes mini-swe-agent's headless Python entry point.

mini-swe-agent doesn't have a stable native CLI; agentelo wraps it via
`bin/run-mini-swe.py` which calls the minisweagent Python API and writes a
trajectory JSON. We require the wrapper script path via `env["SWE_WRAPPER"]`
or fall back to the bundled agentelo wrapper at `~/agentelo/bin/run-mini-swe.py`
if present.

Token/cost is read from `<workdir>/.harness/swe-traj.json` after the run.

NOTE: swe-agent has no per-harness instructions file in agentelo's mapping —
the convention is to put system-style guidance directly into `prompt`. If
`instructions` is set, we prepend it to the prompt (best-effort).
"""
from __future__ import annotations

import json
import os
import re
import sys
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
    absolute_workdir,
)
from harness.pricing import derive_cost
from harness.util import last_non_empty_join

_SUBMIT_RE = re.compile(r"Submit message", re.IGNORECASE)
_WHAT_TO_DO_RE = re.compile(r"What do you want to do", re.IGNORECASE)
_IDLE_RE = re.compile(r"What do you want to do|Submit message", re.IGNORECASE)
_RATE_LIMIT_RE = re.compile(r"rate.?limit|quota", re.IGNORECASE)
_ERROR_RE = re.compile(r"error", re.IGNORECASE)
_FATAL_RE = re.compile(r"fatal|crash", re.IGNORECASE)
_SPINNER_RE = re.compile(r"[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]")
_THINKING_RE = re.compile(r"thinking", re.IGNORECASE)


class SweAgentAdapter(Adapter):
    name = "swe-agent"
    instructions_filename = ""  # not file-based; folded into prompt
    submit_keys = ("Escape", "Enter")
    install_meta = InstallMeta(
        package_manager="pip",
        install_command=("pip", "install", "--user", "mini-swe-agent"),
        update_command=("pip", "install", "--user", "--upgrade", "mini-swe-agent"),
        version_command=("mini", "--version"),
    )

    DEFAULT_MODEL = "gpt-5.4"
    DEFAULT_COST_LIMIT_USD = 10.0

    def build_command(self, spec: RunSpec) -> BuildCommand:
        resolved = self.resolve_run_spec(spec)
        wrapper = _resolve_wrapper(spec.env)

        workdir = absolute_workdir(spec.workdir)
        traj_dir = workdir / ".harness"
        traj_file = traj_dir / "swe-traj.json"

        prompt = spec.prompt
        if spec.instructions:
            prompt = f"{spec.instructions.rstrip()}\n\n---\n\n{prompt}"

        args = [
            str(wrapper),
            "--model", resolved.model,
            "--task", prompt,
            "--cwd", str(workdir),
            "--cost-limit", str(self.DEFAULT_COST_LIMIT_USD),
            "--output", str(traj_file),
        ]
        return self.finalize_command(spec, cmd="python3", args=args, directories=(traj_dir,))

    def parse_output(self, spec: RunSpec, outcome: SubprocOutcome) -> ParsedOutput:
        traj_file = Path(spec.workdir) / ".harness" / "swe-traj.json"
        tokens_in, tokens_out, cost, _model, raw = _read_swe_trajectory(traj_file)
        return {"cost_usd": cost, "tokens_in": tokens_in, "tokens_out": tokens_out, "raw": raw}

    # ---- session-aware (mini-swe-agent interactive) ----------------------

    def detect_ready(self, pane: str) -> ReadyState:
        last20 = last_non_empty_join(pane, 20)
        if _SUBMIT_RE.search(last20) or _WHAT_TO_DO_RE.search(last20):
            return "ready"
        return "loading"

    def handle_dialog(self, pane: str) -> list[str] | None:
        return None

    def detect_status(self, pane: str) -> AgentStatus:
        last10 = last_non_empty_join(pane, 10)
        if _RATE_LIMIT_RE.search(last10):
            return "rate-limited"
        if _ERROR_RE.search(last10) and _FATAL_RE.search(last10):
            return "error"
        if _IDLE_RE.search(last10):
            return "idle"
        # mini shows a Rich spinner / "thinking" while working
        if _SPINNER_RE.search(last10) or _THINKING_RE.search(last10):
            return "running"
        return "unknown"

    # mini-swe-agent interactive writes the most recent run's trajectory to
    #   ~/Library/Application Support/mini-swe-agent/last_mini_run.traj.json (macOS)
    #   ~/.local/share/mini-swe-agent/last_mini_run.traj.json (linux, XDG)
    # Headless runs (with --output) drop the per-task trajectory at
    # <workdir>/.harness/swe-traj.json — prefer that when present.
    def session_log_path(self, workdir: Path, session_started_after: float | None = None) -> str | None:
        home = Path.home()
        app_support = (
            home / "Library" / "Application Support" / "mini-swe-agent"
            if sys.platform == "darwin"
            else home / ".local" / "share" / "mini-swe-agent"
        )
        candidates = [
            workdir / ".harness" / "swe-traj.json",
            workdir / "mini-traj.json",
            app_support / "last_mini_run.traj.json",
        ]
        for c in candidates:
            if c.exists():
                return str(c)
        return None

    def parse_session_log(self, path: str) -> SessionTelemetry:
        tokens_in, tokens_out, cost, model, raw = _read_swe_trajectory(Path(path))
        if cost is None:
            cost = derive_cost(model, tokens_in, tokens_out)
        return SessionTelemetry(path, tokens_in, tokens_out, cost, model, raw)


def _resolve_wrapper(env: dict[str, str]) -> Path:
    explicit = env.get("SWE_WRAPPER") or os.environ.get("SWE_WRAPPER")
    if explicit:
        path = Path(explicit).expanduser()
        if not path.exists():
            raise HarnessError(f"SWE_WRAPPER does not exist: {path}")
        return path

    fallback = Path.home() / "agentelo" / "bin" / "run-mini-swe.py"
    if fallback.exists():
        return fallback

    raise HarnessError(
        "swe-agent wrapper not found. Set SWE_WRAPPER env var to your "
        "headless mini-swe-agent runner script, or install agentelo at ~/agentelo."
    )


def _read_swe_trajectory(
    traj_file: Path,
) -> tuple[int | None, int | None, float | None, str | None, dict | None]:
    if not traj_file.exists():
        return None, None, None, None, None
    try:
        traj = json.loads(traj_file.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None, None, None, None, None
    if not isinstance(traj, dict):
        return None, None, None, None, None

    stats = (traj.get("info") or {}).get("model_stats") or {}
    cost = stats.get("instance_cost")
    cost = float(cost) if isinstance(cost, (int, float)) else None

    tokens_in = tokens_out = 0
    saw_usage = False
    model: str | None = None
    for msg in traj.get("messages") or []:
        if not isinstance(msg, dict):
            continue
        response = (msg.get("extra") or {}).get("response") or {}
        if model is None:
            resp_model = response.get("model")
            if isinstance(resp_model, str):
                model = resp_model
        usage = response.get("usage")
        if not isinstance(usage, dict):
            continue
        saw_usage = True
        tokens_in += int(_usage_count(usage, "prompt_tokens", "input_tokens"))
        tokens_out += int(_usage_count(usage, "completion_tokens", "output_tokens"))

    if model is None and stats:
        for key in stats.keys():
            if key != "instance_cost":
                model = key
                break

    return (
        tokens_in if saw_usage else None,
        tokens_out if saw_usage else None,
        cost,
        model,
        traj,
    )


def _usage_count(usage: dict, primary: str, fallback: str) -> object:
    """`usage[primary]` unless missing/null, then `usage[fallback]`, then 0. An
    explicit 0 is a real count and does not fall through."""
    for key in (primary, fallback):
        value = usage.get(key)
        if value is not None:
            return value
    return 0
