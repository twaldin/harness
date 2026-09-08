"""OpenClaude adapter — invokes `openclaude` (`claude`) in print JSON mode.

OpenClaude (github.com/Gitlawb/openclaude) is a Claude Code fork. It keeps the
``<config>/projects/<encoded cwd>/<session-id>.jsonl`` transcript layout but
resolves its config root independently: ``NFC(OPENCLAUDE_CONFIG_DIR or
~/.openclaude)`` (``src/utils/envUtils.ts``). It deliberately never reads
``CLAUDE_CONFIG_DIR`` or ``~/.claude``, so discovery here never falls back to
Claude Code transcripts either.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

from harness._subproc import SubprocOutcome
from harness.adapters.claude_code import (
    canonical_project_path,
    config_home,
    newest_session_log,
    parse_claude_transcript,
    project_dirs,
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
)
from harness.util import last_non_empty_join, strip_ansi

OPENCLAUDE_CONFIG_DIR_ENV = "OPENCLAUDE_CONFIG_DIR"

_READY_RE = re.compile(r"Ready\s*[-—]", re.IGNORECASE)
_PROMPT_LINE_RE = re.compile(r"^\s*❯\s*$")
_PROMPT_TAIL_RE = re.compile(r"❯\s*$")
_UPDATE_RE = re.compile(r"Update available", re.IGNORECASE)
_RATE_LIMIT_RE = re.compile(r"rate.?limit", re.IGNORECASE)
_SPINNER_RE = re.compile(r"[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]")
_WORKING_RE = re.compile(r"Thinking|Working", re.IGNORECASE)


class OpenClaudeAdapter(Adapter):
    name = "openclaude"
    instructions_filename = "CLAUDE.md"
    permission_bypass_args = ("--dangerously-skip-permissions",)
    submit_keys = ("Enter",)
    install_meta = InstallMeta(
        package_manager="npm",
        install_command=("npm", "install", "-g", "@gitlawb/openclaude"),
        update_command=("npm", "install", "-g", "@gitlawb/openclaude@latest"),
        version_command=("openclaude", "--version"),
    )

    DEFAULT_MODEL = "gpt-5.4"

    def build_command(self, spec: RunSpec) -> BuildCommand:
        resolved = self.resolve_run_spec(spec)
        model = resolved.model

        args = [
            "-p",
            spec.prompt,
            "--output-format",
            "json",
            *resolved.permission_args,
        ]
        if spec.instructions:
            args += ["--append-system-prompt", spec.instructions]

        # OpenAI-compatible provider path: prefer env-based setup. openclaude's
        # README documents OPENAI_MODEL + CLAUDE_CODE_USE_OPENAI rather than an
        # explicit --model flag for custom OpenAI-compatible endpoints.
        env: dict[str, str] = {}
        if spec.env.get("OPENAI_API_KEY") or spec.env.get("OPENAI_BASE_URL"):
            env["CLAUDE_CODE_USE_OPENAI"] = "1"
            if "OPENAI_MODEL" not in spec.env:
                env["OPENAI_MODEL"] = model
        else:
            args += ["--model", model]

        return self.finalize_command(spec, cmd="openclaude", args=args, env=env)

    def parse_output(self, spec: RunSpec, outcome: SubprocOutcome) -> ParsedOutput:
        raw = _parse_last_json_object(outcome.stdout)
        if not isinstance(raw, dict):
            return {"cost_usd": None, "tokens_in": None, "tokens_out": None, "raw": None}

        usage = raw.get("usage") if isinstance(raw.get("usage"), dict) else {}
        return {
            "cost_usd": _to_float(raw.get("total_cost_usd")),
            "tokens_in": _to_int(usage.get("input_tokens")),
            "tokens_out": _to_int(usage.get("output_tokens")),
            "raw": raw,
        }

    def session_log_path(self, workdir: Path, session_started_after: float | None = None) -> str | None:
        projects = config_home(OPENCLAUDE_CONFIG_DIR_ENV, ".openclaude", empty_is_unset=True) / "projects"
        project_path = canonical_project_path(workdir)
        return newest_session_log(project_dirs(projects, project_path), project_path, session_started_after)

    def parse_session_log(self, path: str) -> SessionTelemetry:
        return parse_claude_transcript(path)

    # ---- session-aware ---------------------------------------------------

    def detect_ready(self, pane: str) -> ReadyState:
        last20 = last_non_empty_join(pane, 20)
        # openclaude shows "Ready — type /help to begin" + ❯ prompt
        if _READY_RE.search(last20) or any(_PROMPT_LINE_RE.match(line.strip()) for line in strip_ansi(pane).split("\n")):
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
        if _READY_RE.search(last10) or _PROMPT_TAIL_RE.search(last10):
            return "idle"
        return "unknown"


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
