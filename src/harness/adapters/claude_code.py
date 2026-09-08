"""claude-code adapter — invokes the `claude` CLI in print mode.

Output format: --output-format json gives a structured envelope:
    { "type": "result", "result": "...", "usage": {...}, "total_cost_usd": ... }
"""
from __future__ import annotations

import json
import os
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
    ScrollKeys,
    SessionTelemetry,
)
from harness.pricing import derive_cost
from harness.util import last_non_empty_join, strip_ansi


_CLAUDE_CODE_FULLSCREEN_SCROLL_KEYS = ScrollKeys(line_down="C-M-e", line_up="C-M-y", page_down="NPage", page_up="PPage")

_PROMPT_LINE_RE = re.compile(r"^\s*[>❯]\s*$")
_BYPASS_RE = re.compile(r"bypass.?permissions", re.IGNORECASE)
_ACCEPT_RE = re.compile(r"Yes, I accept", re.IGNORECASE)
_TRUST_RE = re.compile(r"trust this folder|Do you trust the files", re.IGNORECASE)
_UPDATE_RE = re.compile(r"Update available", re.IGNORECASE)
_RATE_LIMIT_RE = re.compile(r"rate.?limit|hit your limit", re.IGNORECASE)
_TIMER_RE = re.compile(r"\((?:\d+m\s+)?\d+s[\s·)]")
_STATUS_BAR_RE = re.compile(r"bypass permissions|Claude Code", re.IGNORECASE)


def _has_prompt_line(pane: str) -> bool:
    return any(_PROMPT_LINE_RE.match(line.strip()) for line in strip_ansi(pane).split("\n"))


class ClaudeCodeAdapter(Adapter):
    name = "claude-code"
    instructions_filename = "CLAUDE.md"
    scroll_ownership = "fullscreen-aware"
    permission_bypass_args = ("--dangerously-skip-permissions",)
    native_options_kind = "claude-code"
    submit_keys = ("Enter",)
    install_meta = InstallMeta(
        package_manager="npm",
        install_command=("npm", "install", "-g", "@anthropic-ai/claude-code"),
        update_command=("npm", "install", "-g", "@anthropic-ai/claude-code@latest"),
        version_command=("claude", "--version"),
    )

    DEFAULT_MODEL = "sonnet"

    def get_current_scroll_keys(self) -> ScrollKeys | None:
        # claude-code's `/tui` slash command toggles between the classic
        # main-screen renderer ("default") and the alt-screen virtualized
        # renderer ("fullscreen"). Persisted under `tui` in
        # ~/.claude/settings.json. v1: user-scope only — full
        # managed → local → project → user precedence is intentionally
        # deferred.
        return _CLAUDE_CODE_FULLSCREEN_SCROLL_KEYS if _read_claude_code_tui_mode() == "fullscreen" else None

    def build_command(self, spec: RunSpec) -> BuildCommand:
        resolved = self.resolve_run_spec(spec)
        instructions_file = write_instructions(spec.workdir, self.instructions_filename, spec.instructions)
        args = [
            "-p", spec.prompt,
            "--model", resolved.model,
            *resolved.native_args,
            "--output-format", "json",
            *resolved.permission_args,
        ]
        # -p mode does not auto-walk workdir for CLAUDE.md; inject explicitly so
        # the instructions are always visible to the model.
        if spec.instructions:
            args += ["--append-system-prompt", spec.instructions]
        return BuildCommand(cmd="claude", args=args, cwd=spec.workdir, env={}, instructions_file=instructions_file)

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

    # ---- session-aware ---------------------------------------------------

    def detect_ready(self, pane: str) -> ReadyState:
        last20 = last_non_empty_join(pane, 20)
        if _has_prompt_line(pane) and _STATUS_BAR_RE.search(strip_ansi(pane)):
            return "ready"
        if _BYPASS_RE.search(last20) and _ACCEPT_RE.search(last20):
            return "dialog"
        if _TRUST_RE.search(last20):
            return "dialog"
        if _UPDATE_RE.search(last20) and "?" in last20:
            return "dialog"
        return "loading"

    def handle_dialog(self, pane: str) -> list[str] | None:
        text = strip_ansi(pane)
        if _BYPASS_RE.search(text) and _ACCEPT_RE.search(text):
            return ["2", "Enter"]
        if _TRUST_RE.search(text):
            return ["Enter"]
        # Decline updates mid-run; an explicit update command is the install path.
        if _UPDATE_RE.search(text):
            return ["Escape"]
        return None

    def detect_status(self, pane: str) -> AgentStatus:
        last10 = last_non_empty_join(pane, 10)
        if _RATE_LIMIT_RE.search(last10):
            return "rate-limited"
        if _UPDATE_RE.search(last10) and "?" in last10:
            return "dialog"
        # claude-code shows "(Xs · ↑M ↓N)" or "·X tokens·" while running
        if _TIMER_RE.search(last10):
            return "running"
        # Idle: prompt visible without timer
        if _has_prompt_line(pane):
            return "idle"
        return "unknown"

    # ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl
    # Encoding: realpath(workdir) → replace both '/' and '_' with '-'.
    def session_log_path(self, workdir: Path, session_started_after: float | None = None) -> str | None:
        home = Path.home()
        try:
            real = workdir.resolve()
        except OSError:
            real = workdir
        encoded = str(real).replace("/", "-").replace("_", "-")
        d = home / ".claude" / "projects" / encoded
        if not d.exists() or not d.is_dir():
            return None
        files = sorted((p for p in d.glob("*.jsonl") if p.is_file()), key=lambda p: p.stat().st_mtime, reverse=True)
        if session_started_after is not None:
            files = [p for p in files if p.stat().st_mtime >= session_started_after]
        return str(files[0]) if files else None

    def parse_session_log(self, path: str) -> SessionTelemetry:
        p = Path(path)
        if not p.exists():
            return SessionTelemetry(path, None, None, None, None, None)

        tokens_in = 0
        tokens_out = 0
        cost_usd = 0.0
        model_name: str | None = None
        saw_usage = False
        saw_cost = False

        try:
            for line in p.read_text(encoding="utf-8").splitlines():
                t = line.strip()
                if not t:
                    continue
                try:
                    event = json.loads(t)
                except json.JSONDecodeError:
                    continue
                if not isinstance(event, dict):
                    continue
                msg = event.get("message") if isinstance(event.get("message"), dict) else {}
                usage = msg.get("usage") if isinstance(msg.get("usage"), dict) else {}
                if usage:
                    saw_usage = True
                    tokens_in += int(usage.get("input_tokens") or 0)
                    tokens_out += int(usage.get("output_tokens") or 0)
                event_cost = event.get("costUSD")
                if not isinstance(event_cost, (int, float)):
                    event_cost = event.get("total_cost_usd")
                if isinstance(event_cost, (int, float)):
                    saw_cost = True
                    cost_usd += float(event_cost)
                # Skip claude-code's "<synthetic>" placeholder — an autoresponder /
                # interrupt turn, not a real model invocation.
                if model_name is None and isinstance(msg.get("model"), str) and msg.get("model") != "<synthetic>":
                    model_name = msg.get("model")
        except OSError:
            return SessionTelemetry(path, None, None, None, None, None)

        final_in = tokens_in if saw_usage else None
        final_out = tokens_out if saw_usage else None
        final_cost = cost_usd if saw_cost else derive_cost(model_name, final_in, final_out)
        return SessionTelemetry(path, final_in, final_out, final_cost, model_name, None)


def _read_claude_code_tui_mode() -> str | None:
    home_str = os.environ.get("HOME")
    home = Path(home_str) if home_str else Path.home()
    settings_path = home / ".claude" / "settings.json"
    if not settings_path.exists():
        return None
    try:
        raw = json.loads(settings_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if isinstance(raw, dict):
        v = raw.get("tui")
        return v if isinstance(v, str) else None
    return None
