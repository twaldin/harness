"""pi adapter — invokes the `pi` CLI from @mariozechner/pi-coding-agent.

pi's `--mode json` emits an event stream on stdout, one JSON object per line:
  - first line: `{"type":"session","version":...,"cwd":...}`
  - then: agent/turn/message events
  - `agent_end` carries the full `messages` array with per-message `usage`

Each AssistantMessage has:
    usage: {
        input, output, cacheRead, cacheWrite, totalTokens,
        cost: { input, output, cacheRead, cacheWrite, total }
    }

We sum usage across assistant messages in the `agent_end` event and report
aggregate tokens + cost. See
https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/json.md
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
from harness.util import last_non_empty_join, strip_ansi

# pi's idle prompt has a footer line with cost/token stats:
# "↑39k ↓6.4k R84k $0.428 (sub) 14.7%/272k (auto)". The "(sub)" + cost
# pattern is reliable and only renders when pi is at a usable prompt.
_PI_IDLE_FOOTER_RE = re.compile(r"\$\d+\.\d+\s+\(sub\)")
_SLASH_COMMAND_RE = re.compile(r"/[a-z][a-z0-9_-]*", re.IGNORECASE)
_PI_WORDS_RE = re.compile(r"pi|model|provider", re.IGNORECASE)
_PROMPT_LINE_RE = re.compile(r"^\s*[>❯]\s*$")
_LOGIN_RE = re.compile(r"chatgpt plus|login|oauth|select a provider", re.IGNORECASE)
_UPDATE_RE = re.compile(r"Update Available", re.IGNORECASE)
_RATE_LIMIT_RE = re.compile(r"^.*rate.?limit", re.IGNORECASE | re.MULTILINE)
_RETRY_RE = re.compile(r"retry|wait|seconds", re.IGNORECASE)
_WORKING_RE = re.compile(r"[⠁-⣿]\s*Working\.\.\.", re.IGNORECASE)


class PiAdapter(Adapter):
    name = "pi"
    instructions_filename = "AGENTS.md"
    submit_keys = ("Enter",)
    install_meta = InstallMeta(
        package_manager="npm",
        install_command=("npm", "install", "-g", "@mariozechner/pi-coding-agent"),
        update_command=("npm", "install", "-g", "@mariozechner/pi-coding-agent@latest"),
        version_command=("pi", "--version"),
    )

    DEFAULT_MODEL = "sonnet"

    def build_command(self, spec: RunSpec) -> BuildCommand:
        resolved = self.resolve_run_spec(spec)
        args = ["--mode", "json", "--no-session", "--model", resolved.model, spec.prompt]
        return self.finalize_command(spec, cmd="pi", args=args)

    def parse_output(self, spec: RunSpec, outcome: SubprocOutcome) -> ParsedOutput:
        tokens_in, tokens_out, cost, raw = _parse_pi_events(outcome.stdout)
        return {"cost_usd": cost, "tokens_in": tokens_in, "tokens_out": tokens_out, "raw": raw}

    # ---- session-aware ---------------------------------------------------

    def detect_ready(self, pane: str) -> ReadyState:
        stripped = strip_ansi(pane)
        last20 = last_non_empty_join(pane, 20)
        # Idle-prompt footer is authoritative — present means pi is ready, regardless
        # of whether an "Update Available" banner is also showing above it.
        if _PI_IDLE_FOOTER_RE.search(stripped):
            return "ready"
        if _SLASH_COMMAND_RE.search(last20) and _PI_WORDS_RE.search(last20):
            return "ready"
        if any(_PROMPT_LINE_RE.match(line.strip()) for line in stripped.split("\n")):
            return "ready"
        if _LOGIN_RE.search(last20):
            return "ready"
        # Banner check is a last-resort fallback — only fires if no prompt is visible
        # yet. handle_dialog returns None since the banner isn't dismissable.
        if _UPDATE_RE.search(last20):
            return "dialog"
        return "loading"

    def handle_dialog(self, pane: str) -> list[str] | None:
        # pi's "Update Available" is a banner, not a blocking modal — no key
        # dismisses it; the prompt is still usable below the banner.
        return None

    def detect_status(self, pane: str) -> AgentStatus:
        # pi's UI is binary: when a model turn is in flight, the working banner
        # contains a braille spinner glyph followed by 'Working...'. Pi prints
        # model OUTPUT (test failures, error messages, stack traces) into the
        # pane — those words MUST NOT influence status. Only the spinner counts.
        last10 = last_non_empty_join(pane, 10)
        # Rate-limit overlay is a specific status-bar message (not free-form text).
        if _RATE_LIMIT_RE.search(last10) and _RETRY_RE.search(last10):
            return "rate-limited"
        if _WORKING_RE.search(last10):
            return "running"
        return "idle"

    # ~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<sid>.jsonl
    # Encoding: '-' + realpath(workdir).replace('/', '-') + '--'
    # (TWO leading dashes, TWO trailing dashes; underscores preserved).
    def session_log_path(self, workdir: Path, session_started_after: float | None = None) -> str | None:
        try:
            real = workdir.resolve()
        except OSError:
            real = workdir
        encoded = "-" + str(real).replace("/", "-") + "--"
        d = Path.home() / ".pi" / "agent" / "sessions" / encoded
        if not d.exists() or not d.is_dir():
            return None
        try:
            files = sorted((p for p in d.glob("*.jsonl") if p.is_file()), key=lambda p: p.stat().st_mtime, reverse=True)
        except OSError:
            return None
        return str(files[0]) if files else None

    def parse_session_log(self, path: str) -> SessionTelemetry:
        p = Path(path)
        if not p.exists():
            return SessionTelemetry(path, None, None, None, None, None)
        tokens_in = tokens_out = 0
        cost_usd = 0.0
        model_name: str | None = None
        saw_usage = saw_cost = False
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
                if event.get("type") == "model_change":
                    m = event.get("modelId")
                    if isinstance(m, str) and model_name is None:
                        model_name = m
                message = event.get("message") if isinstance(event.get("message"), dict) else {}
                usage = message.get("usage")
                if isinstance(usage, dict):
                    saw_usage = True
                    tokens_in += int(usage.get("input") or 0)
                    tokens_out += int(usage.get("output") or 0)
                    cost_obj = usage.get("cost")
                    c = cost_obj.get("total") if isinstance(cost_obj, dict) else None
                    if isinstance(c, (int, float)) and not isinstance(c, bool):
                        saw_cost = True
                        cost_usd += float(c)
        except OSError:
            return SessionTelemetry(path, None, None, None, None, None)
        ti = tokens_in if saw_usage else None
        to = tokens_out if saw_usage else None
        cost = cost_usd if saw_cost else derive_cost(model_name, ti, to)
        return SessionTelemetry(path, ti, to, cost, model_name, None)


def _parse_pi_events(stdout: str) -> tuple[int | None, int | None, float | None, list | None]:
    """Walk the JSON event stream and sum assistant-message usage.

    Prefers the `agent_end` event's full `messages` array (authoritative final
    state). Falls back to summing per-`turn_end` assistant messages when no
    `agent_end` carries a `messages` list (e.g., truncated / timed-out output).
    """
    events: list = []
    for line in stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(ev, dict):
            events.append(ev)

    if not events:
        return None, None, None, None

    # Preferred: agent_end.messages
    for ev in reversed(events):
        if ev.get("type") == "agent_end" and isinstance(ev.get("messages"), list):
            tokens_in, tokens_out, cost = _sum_assistant_usage(ev["messages"])
            return tokens_in, tokens_out, cost, events

    # Fallback: sum usage from each turn_end's assistant message
    tokens_in = tokens_out = 0
    cost = 0.0
    any_assistant = False
    for ev in events:
        if ev.get("type") != "turn_end":
            continue
        msg = ev.get("message") or {}
        if msg.get("role") != "assistant":
            continue
        usage = msg.get("usage") or {}
        tokens_in += int(usage.get("input") or 0)
        tokens_out += int(usage.get("output") or 0)
        cost_obj = usage.get("cost") or {}
        cost += float(cost_obj.get("total") or 0.0)
        any_assistant = True

    if not any_assistant:
        return None, None, None, events
    return tokens_in, tokens_out, cost, events


def _sum_assistant_usage(messages: list) -> tuple[int, int, float]:
    tokens_in = tokens_out = 0
    cost = 0.0
    for msg in messages:
        if not isinstance(msg, dict) or msg.get("role") != "assistant":
            continue
        usage = msg.get("usage") or {}
        tokens_in += int(usage.get("input") or 0)
        tokens_out += int(usage.get("output") or 0)
        cost_obj = usage.get("cost") or {}
        cost += float(cost_obj.get("total") or 0.0)
    return tokens_in, tokens_out, cost
