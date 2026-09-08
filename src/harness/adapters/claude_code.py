"""claude-code adapter — invokes the `claude` CLI in print mode.

Output format: --output-format json gives a structured envelope:
    { "type": "result", "result": "...", "usage": {...}, "total_cost_usd": ... }

Session transcripts live at ``<config>/projects/<encoded cwd>/<session-id>.jsonl``.
The layout below was read from the Claude Code 2.1.220 native binary's embedded
bundle (OpenClaude, a fork, ships the same algorithm in
``src/utils/sessionStoragePortable.ts``):

- config root: ``NFC(CLAUDE_CONFIG_DIR ?? ~/.claude)``
- project key: ``NFC(realpath(cwd))``, or ``NFC(cwd)`` when realpath fails
- directory name: every char outside ``[a-zA-Z0-9]`` becomes ``-``; names longer
  than 200 chars are cut to 200 and suffixed ``-<base36(abs(djb2(project key)))>``
- lookups also accept sibling directories sharing that 200-char prefix

JavaScript works on UTF-16 code units, so the sanitizer and hash do too.
"""
from __future__ import annotations

import json
import os
import re
import string
import struct
import unicodedata
from pathlib import Path
from typing import Iterable

from harness._subproc import SubprocOutcome
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

PROJECT_DIR_NAME_LIMIT = 200
_PROJECT_DIR_SAFE_UNITS = frozenset(map(ord, string.ascii_letters + string.digits))
_BASE36_DIGITS = string.digits + string.ascii_lowercase


def _utf16_units(text: str) -> tuple[int, ...]:
    raw = text.encode("utf-16-le", "surrogatepass")
    return struct.unpack(f"<{len(raw) // 2}H", raw)


def _djb2(units: Iterable[int]) -> int:
    """Upstream ``((hash << 5) - hash + charCode) | 0`` over UTF-16 code units."""
    h = 0
    for unit in units:
        h = ((h << 5) - h + unit) & 0xFFFFFFFF
    return h - 0x100000000 if h >= 0x80000000 else h


def _base36(n: int) -> str:
    if n == 0:
        return "0"
    digits = []
    while n:
        n, rem = divmod(n, 36)
        digits.append(_BASE36_DIGITS[rem])
    return "".join(reversed(digits))


def encode_project_path(project_path: str) -> str:
    """Directory name Claude-family CLIs use for ``project_path`` under ``projects/``."""
    units = _utf16_units(project_path)
    sanitized = "".join(chr(u) if u in _PROJECT_DIR_SAFE_UNITS else "-" for u in units)
    if len(sanitized) <= PROJECT_DIR_NAME_LIMIT:
        return sanitized
    return f"{sanitized[:PROJECT_DIR_NAME_LIMIT]}-{_base36(abs(_djb2(units)))}"


def canonical_project_path(workdir: Path) -> str:
    """``NFC(realpath(workdir))``; upstream keeps the unresolved path when realpath fails."""
    absolute = os.path.abspath(workdir)
    try:
        resolved = os.path.realpath(absolute, strict=True)
    except OSError:
        resolved = absolute
    return unicodedata.normalize("NFC", resolved)


def config_home(env_var: str, default_dirname: str, *, empty_is_unset: bool = False) -> Path:
    """NFC config root; Claude preserves an explicit empty path, OpenClaude does not."""
    explicit = os.environ.get(env_var)
    root = explicit if explicit is not None and (explicit or not empty_is_unset) else os.path.join(os.path.expanduser("~"), default_dirname)
    return Path(unicodedata.normalize("NFC", root)).absolute()


def project_dirs(projects_root: Path, project_path: str) -> list[Path]:
    """Existing transcript directories for ``project_path``, exact match first.

    Mirrors upstream resume lookups: a truncated name also matches sibling
    directories that share its 200-char prefix (hash suffixes differ across
    runtimes and versions).
    """
    encoded = encode_project_path(project_path)
    exact = projects_root / encoded
    dirs = [exact] if exact.is_dir() else []
    if len(encoded) <= PROJECT_DIR_NAME_LIMIT:
        return dirs
    prefix = encoded[:PROJECT_DIR_NAME_LIMIT] + "-"
    try:
        siblings = sorted(
            p for p in projects_root.iterdir() if p.name.startswith(prefix) and p.is_dir() and not p.is_symlink()
        )
    except OSError:
        return dirs
    dirs.extend(p for p in siblings if p != exact)
    return dirs


def _transcript_matches_project(path: Path, project_path: str) -> bool:
    # Bounded metadata lookup: path sanitization and truncated prefixes collide.
    # Missing identity is unavailable, never permission to select a foreign log.
    with path.open("rb") as stream:
        header = stream.read(65536).decode("utf-8", errors="replace")
    for line in header.splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(event, dict) or event.get("isSidechain"):
            continue
        cwd = event.get("cwd")
        if isinstance(cwd, str) and cwd and os.path.isabs(cwd):
            return canonical_project_path(Path(cwd)) == project_path
    return False


def newest_session_log(dirs: Iterable[Path], project_path: str, session_started_after: float | None) -> str | None:
    """Newest matching-project JSONL at/after the epoch-seconds mtime cutoff."""
    newest: tuple[float, Path] | None = None
    for d in dirs:
        try:
            entries = list(d.iterdir())
        except OSError:
            continue
        for p in entries:
            try:
                if p.suffix != ".jsonl" or not p.is_file():
                    continue
                mtime = p.stat().st_mtime
                if session_started_after is not None and mtime < session_started_after:
                    continue
                if newest is not None and (mtime, str(p)) <= (newest[0], str(newest[1])):
                    continue
                if _transcript_matches_project(p, project_path):
                    newest = (mtime, p)
            except OSError:
                continue
    return str(newest[1]) if newest else None


def _token_count(value: object) -> int | None:
    """Match JavaScript's safe-integer range instead of accepting lossy counts."""
    if value is None:
        return 0
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not 0 <= value <= 2**53 - 1:
        return None
    count = int(value)
    return count if count == value else None


def parse_claude_transcript(path: str) -> SessionTelemetry:
    """Sum assistant usage once per API message id; derive cost when no cost field exists.

    Claude Code writes one transcript line per assistant content block, each
    repeating the same ``message.id`` and ``message.usage``; upstream groups
    those lines by id, so usage is counted once per id here.
    """
    p = Path(path)
    if not p.exists():
        return SessionTelemetry(path, None, None, None, None, None)

    tokens_in = 0
    tokens_out = 0
    cost_usd = 0.0
    model_name: str | None = None
    saw_usage = False
    saw_cost = False
    seen_message_ids: set[str] = set()
    previous_usage: dict[str, tuple[int, int]] = {}

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
            message_id = msg.get("id")
            duplicate = isinstance(message_id, str) and message_id in seen_message_ids
            if isinstance(message_id, str):
                seen_message_ids.add(message_id)
            if usage:
                current_in = _token_count(usage.get("input_tokens"))
                current_out = _token_count(usage.get("output_tokens"))
                if current_in is None or current_out is None:
                    return SessionTelemetry(path, None, None, None, None, None)
                prior_in, prior_out = previous_usage.get(message_id, (0, 0)) if isinstance(message_id, str) else (0, 0)
                tokens_in += current_in - prior_in
                tokens_out += current_out - prior_out
                if tokens_in > 2**53 - 1 or tokens_out > 2**53 - 1:
                    return SessionTelemetry(path, None, None, None, None, None)
                if isinstance(message_id, str):
                    previous_usage[message_id] = (current_in, current_out)
                saw_usage = True
            event_cost = event.get("costUSD")
            if not isinstance(event_cost, (int, float)) or isinstance(event_cost, bool):
                event_cost = event.get("total_cost_usd")
            if isinstance(event_cost, (int, float)) and not isinstance(event_cost, bool) and not duplicate:
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


def _has_prompt_line(pane: str) -> bool:
    return any(_PROMPT_LINE_RE.match(line.strip()) for line in strip_ansi(pane).split("\n"))


class ClaudeCodeAdapter(Adapter):
    name = "claude-code"
    instructions_filename = "CLAUDE.md"
    scroll_ownership = "fullscreen-aware"
    permission_bypass_args = ("--dangerously-skip-permissions",)
    native_options_kind = "claude-code"
    config_home_env = "CLAUDE_CONFIG_DIR"
    config_file_flag = "--settings"
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
        # renderer ("fullscreen"). Persisted under `tui` in the user-scope
        # settings.json inside the config root. v1: user-scope only — full
        # managed → local → project → user precedence is intentionally
        # deferred.
        return _CLAUDE_CODE_FULLSCREEN_SCROLL_KEYS if _read_claude_code_tui_mode() == "fullscreen" else None

    def build_command(self, spec: RunSpec) -> BuildCommand:
        resolved = self.resolve_run_spec(spec)
        args = [
            "-p", spec.prompt,
            "--model", resolved.model,
            *resolved.native_args,
            "--output-format", "json",
            *resolved.permission_args,
            *resolved.config_args,
        ]
        # -p mode does not auto-walk workdir for CLAUDE.md; inject explicitly so
        # the instructions are always visible to the model.
        if spec.instructions:
            args += ["--append-system-prompt", spec.instructions]
        return self.finalize_command(spec, cmd="claude", args=args)

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

    def session_log_path(self, workdir: Path, session_started_after: float | None = None) -> str | None:
        projects = config_home(self.config_home_env, ".claude") / "projects"
        project_path = canonical_project_path(workdir)
        return newest_session_log(project_dirs(projects, project_path), project_path, session_started_after)

    def parse_session_log(self, path: str) -> SessionTelemetry:
        return parse_claude_transcript(path)


def _read_claude_code_tui_mode() -> str | None:
    settings_path = config_home("CLAUDE_CONFIG_DIR", ".claude") / "settings.json"
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
