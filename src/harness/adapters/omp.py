"""omp adapter — invokes the Oh My Pi `omp` CLI in headless print mode.

`omp --print --mode json` emits one JSON object per stdout line. Qualified
with OMP 18.1.10, the stream carries, per agent cycle:
  - `message_end`   — a completed message (assistant messages carry `usage`)
  - `turn_end`      — the same assistant message again (may be duplicated)
  - `agent_end`     — `messages`: the full transcript of the cycle
`message_update` records are streaming partials and carry no usable totals.

Each AssistantMessage has:
    usage: { input, output, cacheRead, cacheWrite, totalTokens,
             cost: { input, output, cacheRead, cacheWrite, total } }

Every `agent_end` with a `messages` array is authoritative for its cycle; cycles
are aggregated. For a cycle that never reached `agent_end` (timeout, kill) the
`message_end` assistant records are summed, falling back to `turn_end` only for
turns that produced no `message_end`.

Provider errors are reported inside the JSON stream (`error` / `stopReason`
fields on the message) and omp may still exit 0; `RunResult.exit_code` is the
process status, and the native records are preserved verbatim in `raw`.
"""
from __future__ import annotations

import json
import math

from harness._subproc import SubprocOutcome
from harness.base import Adapter, BuildCommand, InstallMeta, ParsedOutput, RunSpec

_Totals = tuple[int | None, int | None, float | None]
_NO_TOTALS: _Totals = (None, None, None)


class OmpAdapter(Adapter):
    name = "omp"
    instructions_filename = "AGENTS.md"
    permission_bypass_args = ("--auto-approve",)
    config_home_env = "PI_CODING_AGENT_DIR"
    config_file_flag = "--config"
    install_meta = InstallMeta(
        package_manager="brew",
        install_command=("brew", "install", "can1357/tap/omp"),
        update_command=("brew", "upgrade", "omp"),
        version_command=("omp", "--version"),
    )

    DEFAULT_MODEL = "sonnet"

    def build_command(self, spec: RunSpec) -> BuildCommand:
        resolved = self.resolve_run_spec(spec)
        args = ["--print", "--mode", "json", "--no-session", "--model", resolved.model]
        if spec.config_home is not None:
            # An explicit agent dir must win over a named profile inherited
            # from the caller's environment.
            args += ["--profile", "default"]
        args += [*resolved.permission_args, *resolved.native_args, *resolved.config_args, "--", spec.prompt]
        return self.finalize_command(spec, cmd="omp", args=args)

    def parse_output(self, spec: RunSpec, outcome: SubprocOutcome) -> ParsedOutput:
        tokens_in, tokens_out, cost, raw = _parse_omp_records(outcome.stdout)
        return {"cost_usd": cost, "tokens_in": tokens_in, "tokens_out": tokens_out, "raw": raw}


def _parse_omp_records(stdout: str) -> tuple[int | None, int | None, float | None, list | None]:
    records: list[dict] = []
    for line in stdout.split("\n"):
        line = line.strip()
        if not line:
            continue
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(record, dict):
            records.append(record)
    if not records:
        return None, None, None, None

    totals = _NO_TOTALS
    pending = _NO_TOTALS
    turn_seen = False  # a message_end assistant record was seen for the current turn
    for record in records:
        kind = record.get("type")
        if kind == "message_end":
            usage = _assistant_usage(record.get("message"))
            if usage is not None:
                pending = _add(pending, usage)
                turn_seen = True
        elif kind == "turn_end":
            if not turn_seen:
                usage = _assistant_usage(record.get("message"))
                if usage is not None:
                    pending = _add(pending, usage)
            turn_seen = False
        elif kind == "agent_end":
            messages = record.get("messages")
            if isinstance(messages, list):
                for message in messages:
                    usage = _assistant_usage(message)
                    if usage is not None:
                        totals = _add(totals, usage)
            else:
                totals = _add(totals, pending)
            pending = _NO_TOTALS
            turn_seen = False
    totals = _add(totals, pending)
    return totals[0], totals[1], totals[2], records


def _assistant_usage(message: object) -> _Totals | None:
    """Validated `(input, output, cost.total)` of an assistant message; None if not one."""
    if not isinstance(message, dict) or message.get("role") != "assistant":
        return None
    usage = message.get("usage")
    if not isinstance(usage, dict):
        return _NO_TOTALS
    cost = usage.get("cost")
    return (
        _token_count(usage.get("input")),
        _token_count(usage.get("output")),
        _cost(cost.get("total")) if isinstance(cost, dict) else None,
    )


def _token_count(value: object) -> int | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if value < 0 or (isinstance(value, float) and not value.is_integer()):
        return None
    return int(value)


def _cost(value: object) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if value < 0 or not math.isfinite(value):
        return None
    return float(value)


def _add(a: _Totals, b: _Totals) -> _Totals:
    """Per-metric sum; a metric stays None until some record supplies a valid value."""
    return (
        a[0] if b[0] is None else (a[0] or 0) + b[0],
        a[1] if b[1] is None else (a[1] or 0) + b[1],
        a[2] if b[2] is None else (a[2] or 0) + b[2],
    )
