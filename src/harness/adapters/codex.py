"""codex adapter — invokes the `codex exec` CLI.

`codex --json` emits JSONL on stdout with `turn.completed` events that carry
per-turn token usage. We sum across all turns.
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
    absolute_workdir,
)
from harness.pricing import derive_cost
from harness.util import last_non_empty_join, strip_ansi

_PROMPT_WITH_TEXT_RE = re.compile(r"^\s*[❯›]\s+\S")
_PROMPT_EMPTY_RE = re.compile(r"^\s*[❯›]\s*$")
_STATUS_BAR_RE = re.compile(r"\d+%\s+left|model:", re.IGNORECASE)
_PRESS_ENTER_TO_CONTINUE_RE = re.compile(r"Press enter to continue", re.IGNORECASE)
_PRESS_ENTER_RE = re.compile(r"Press enter", re.IGNORECASE)
_NUMBERED_CHOICE_RE = re.compile(r"›\s+\d+\.")
_UPDATE_RE = re.compile(r"Update available", re.IGNORECASE)
_INTERRUPT_RE = re.compile(r"esc to interrupt", re.IGNORECASE)
_WORKING_PAREN_RE = re.compile(r"Working\s*\(", re.IGNORECASE)
_BACKGROUND_RE = re.compile(r"background terminal running", re.IGNORECASE)
_PERCENT_LEFT_RE = re.compile(r"\d+%\s+left", re.IGNORECASE)
_WORKING_RE = re.compile(r"working", re.IGNORECASE)


class CodexAdapter(Adapter):
    name = "codex"
    instructions_filename = "AGENTS.md"
    permission_bypass_args = ("--dangerously-bypass-approvals-and-sandbox",)
    native_options_kind = "codex"
    config_home_env = "CODEX_HOME"
    submit_keys = ("Enter",)
    install_meta = InstallMeta(
        package_manager="npm",
        install_command=("npm", "install", "-g", "@openai/codex"),
        update_command=("npm", "install", "-g", "@openai/codex@latest"),
        version_command=("codex", "--version"),
    )

    DEFAULT_MODEL = "gpt-5.3-codex"

    def build_command(self, spec: RunSpec) -> BuildCommand:
        resolved = self.resolve_run_spec(spec)
        args = [
            "exec",
            "-m", resolved.model,
            *resolved.native_args,
            *resolved.permission_args,
            "--json",
            "-C", str(absolute_workdir(spec.workdir)),
            spec.prompt,
        ]
        return self.finalize_command(spec, cmd="codex", args=args)

    def parse_output(self, spec: RunSpec, outcome: SubprocOutcome) -> ParsedOutput:
        tokens_in, tokens_out, saw_turn = _sum_turn_usage(outcome.stdout)
        return {
            "cost_usd": None,
            "tokens_in": tokens_in if saw_turn else None,
            "tokens_out": tokens_out if saw_turn else None,
            "raw": None,
        }

    # ---- session-aware ---------------------------------------------------

    def detect_ready(self, pane: str) -> ReadyState:
        last20 = last_non_empty_join(pane, 20)
        lines = strip_ansi(pane).split("\n")
        has_prompt = any(_PROMPT_WITH_TEXT_RE.search(line) or _PROMPT_EMPTY_RE.search(line) for line in lines)
        if has_prompt and _STATUS_BAR_RE.search(last20):
            return "ready"
        if _PRESS_ENTER_TO_CONTINUE_RE.search(last20):
            return "dialog"
        if _NUMBERED_CHOICE_RE.search(last20) and not has_prompt:
            return "dialog"
        if _UPDATE_RE.search(last20):
            return "dialog"
        return "loading"

    def handle_dialog(self, pane: str) -> list[str] | None:
        text = strip_ansi(pane)
        if _UPDATE_RE.search(text):
            return ["Down", "Enter"]  # skip update
        if _PRESS_ENTER_RE.search(text):
            return ["Enter"]
        if _NUMBERED_CHOICE_RE.search(text):
            return ["Enter"]
        return None

    def detect_status(self, pane: str) -> AgentStatus:
        last15 = last_non_empty_join(pane, 15)
        last5 = last_non_empty_join(pane, 5)
        if _UPDATE_RE.search(last15):
            return "dialog"
        if _INTERRUPT_RE.search(last15) or _WORKING_PAREN_RE.search(last15) or _BACKGROUND_RE.search(last15):
            return "running"
        if any(_PROMPT_EMPTY_RE.search(line) for line in last5.split("\n")):
            return "idle"
        if _PERCENT_LEFT_RE.search(last5) and not _WORKING_RE.search(last5):
            return "idle"
        return "unknown"

    # ~/.codex/sessions/<year>/<month>/<day>/...jsonl — most recent jsonl
    def session_log_path(self, workdir: Path, session_started_after: float | None = None) -> str | None:
        root = Path.home() / ".codex" / "sessions"
        if not root.exists():
            return None
        cutoff = session_started_after or 0.0
        best: tuple[float, Path] | None = None
        stack = [root]
        while stack:
            d = stack.pop()
            try:
                entries = list(d.iterdir())
            except OSError:
                continue
            for p in entries:
                try:
                    if p.is_dir():
                        stack.append(p)
                        continue
                    if not p.name.endswith(".jsonl"):
                        continue
                    mtime = p.stat().st_mtime
                except OSError:
                    continue
                if mtime >= cutoff and (best is None or mtime > best[0]):
                    best = (mtime, p)
        return str(best[1]) if best else None

    def parse_session_log(self, path: str) -> SessionTelemetry:
        p = Path(path)
        if not p.exists():
            return SessionTelemetry(path, None, None, None, None, None)
        # Codex JSONL format (codex-cli 0.125+):
        #   { "type": "event_msg", "payload": { "type": "token_count", "info": {
        #       "total_token_usage": { "input_tokens": N, "output_tokens": M, ... },
        #       "last_token_usage": { ... }
        #   }}}
        # Tokens are CUMULATIVE in total_token_usage; take the last token_count event.
        last_in = last_out = 0
        saw_usage = False
        model_name: str | None = None
        try:
            for line in p.read_text(encoding="utf-8").splitlines():
                t = line.strip()
                if not t.startswith("{"):
                    continue
                try:
                    event = json.loads(t)
                except json.JSONDecodeError:
                    continue
                if not isinstance(event, dict):
                    continue
                if event.get("type") == "event_msg":
                    payload = event.get("payload") if isinstance(event.get("payload"), dict) else {}
                    if payload.get("type") == "token_count":
                        info = payload.get("info") if isinstance(payload.get("info"), dict) else {}
                        total = info.get("total_token_usage")
                        if isinstance(total, dict):
                            saw_usage = True
                            last_in = int(total.get("input_tokens") or 0)
                            last_out = int(total.get("output_tokens") or 0)
                if event.get("type") == "session.created":
                    m = event.get("model")
                    if isinstance(m, str) and model_name is None:
                        model_name = m
        except OSError:
            return SessionTelemetry(path, None, None, None, None, None)
        ti = last_in if saw_usage else None
        to = last_out if saw_usage else None
        return SessionTelemetry(path, ti, to, derive_cost(model_name or "gpt-5.4", ti, to), model_name, None)


def _sum_turn_usage(stdout: str) -> tuple[int, int, bool]:
    tokens_in = tokens_out = 0
    saw_turn = False
    for line in stdout.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(event, dict):
            continue
        if event.get("type") == "turn.completed":
            saw_turn = True
            usage = event.get("usage") or {}
            tokens_in += int(usage.get("input_tokens") or 0)
            tokens_out += int(usage.get("output_tokens") or 0)
    return tokens_in, tokens_out, saw_turn
