"""Cursor CLI (`agent`) in headless stream-JSON mode.

`agent --print --output-format stream-json --stream-partial-output -- <prompt>`
emits one JSON object per stdout line (JSONL). Qualified with 2026.09.02-c22c1a3,
the final `result` event carries `duration_ms`, `result`, `session_id` and an
optional `usage` object whose `inputTokens` (already net of cache reads and
writes upstream) and `outputTokens` supply the token metrics; cache counters
and partial assistant deltas are never summed. No dollar total is reported, so
cost stays None. Every valid JSON object event is preserved in `raw` (None when
the stream carried none).

The official installer (`curl https://cursor.com/install | bash`) provides the
`agent` binary; the legacy `cursor-agent` name accepts the same arguments and
works through `RunSpec.executable`. Tool permissions retain upstream policy;
`--force` is the explicit bypass. Harness adds no separate trust, MCP approval
or sandbox flags. Sessions, resume and worker modes are unsupported. Headless
mode aborts in-flight work on SIGINT but treats SIGTERM as a global exit, so
SIGINT is the graceful signal.
"""
from __future__ import annotations

import json
import math

from harness._subproc import SubprocOutcome
from harness.base import Adapter, BuildCommand, HarnessError, InstallMeta, ParsedOutput, RunSpec


class CursorAdapter(Adapter):
    name = "cursor"
    instructions_filename = "AGENTS.md"
    DEFAULT_MODEL = ""  # Leave model selection to the caller's Cursor config.
    permission_bypass_args = ("--force",)
    config_home_env = "CURSOR_CONFIG_DIR"
    graceful_signal = "SIGINT"
    install_meta = InstallMeta(
        package_manager="binary",
        install_command=("bash", "-c", "curl https://cursor.com/install -fsS | bash"),
        update_command=("agent", "update"),
        version_command=("agent", "--version"),
        platforms=("darwin", "linux"),
    )

    def reported_model(self, spec: RunSpec) -> str | None:
        return spec.model or None

    def build_command(self, spec: RunSpec) -> BuildCommand:
        resolved = self.resolve_run_spec(spec)
        if not spec.prompt:
            raise HarnessError("cursor requires a non-empty prompt for headless mode", code="invalid-options")
        args = ["--print", "--output-format", "stream-json", "--stream-partial-output"]
        if resolved.model:
            args.extend(["--model", resolved.model])
        args.extend(resolved.permission_args)
        # '--' keeps leading '-' prompts from being parsed as flags.
        args.extend(["--", spec.prompt])
        return self.finalize_command(spec, cmd="agent", args=args)

    def parse_output(self, spec: RunSpec, outcome: SubprocOutcome) -> ParsedOutput:
        events = _json_object_events(outcome.stdout)
        tokens_in, tokens_out = _result_usage(events)
        return {"cost_usd": None, "tokens_in": tokens_in, "tokens_out": tokens_out, "raw": events}


def _reject_constant(value: str) -> None:
    raise ValueError(f"non-JSON constant: {value}")


def _json_object_events(stdout: str) -> list[dict] | None:
    """Every complete JSON object line, in order; malformed, truncated and
    non-object lines are skipped. A final line without a newline still counts."""
    events: list[dict] = []
    for line in stdout.split("\n"):
        line = line.strip()
        if not line:
            continue
        try:
            event = json.loads(line, parse_constant=_reject_constant)
        except ValueError:
            continue
        if isinstance(event, dict):
            events.append(event)
    return events or None


def _result_usage(events: list[dict] | None) -> tuple[int | None, int | None]:
    """`inputTokens` / `outputTokens` from the last `result` event's `usage`,
    each validated independently; missing or invalid counters are None."""
    if not events:
        return None, None
    for event in reversed(events):
        if event.get("type") != "result":
            continue
        usage = event.get("usage")
        if not isinstance(usage, dict):
            return None, None
        return _token_count(usage.get("inputTokens")), _token_count(usage.get("outputTokens"))
    return None, None


def _token_count(value: object) -> int | None:
    """A nonnegative integer exactly representable in both language APIs."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value if 0 <= value <= 2**53 - 1 else None
    if isinstance(value, float) and 0 <= value <= 2**53 - 1 and math.isfinite(value) and value.is_integer():
        return int(value)
    return None
