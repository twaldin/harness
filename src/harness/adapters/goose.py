"""Goose headless JSONL. The last `complete` contains cumulative session usage.

Non-JSON banners and partial lines are ignored; events remain in `raw`, including
provider errors that upstream may emit before exiting zero.
"""
from __future__ import annotations

import json
import math

from harness._subproc import SubprocOutcome
from harness.base import Adapter, BuildCommand, HarnessError, ParsedOutput, RunSpec

_MODE_ENV = "GOOSE_MODE"
_BYPASS_MODE = "auto"


class GooseAdapter(Adapter):
    name = "goose"
    instructions_filename = ""  # Inline via --system=; no workdir projection.
    DEFAULT_MODEL = ""  # Leave provider/model selection to the caller's goose config.
    permission_bypass_args = ()  # Bypass is GOOSE_MODE=auto in the child env, not argv.
    config_home_env = "GOOSE_PATH_ROOT"

    def reported_model(self, spec: RunSpec) -> str | None:
        return spec.model or None

    def build_command(self, spec: RunSpec) -> BuildCommand:
        resolved = self.resolve_run_spec(spec)
        env: dict[str, str] = {}
        if spec.permission_policy == "bypass":
            explicit = spec.env.get(_MODE_ENV)
            if explicit is not None and explicit != _BYPASS_MODE:
                raise HarnessError(
                    f"permission_policy='bypass' conflicts with env[{_MODE_ENV!r}]={explicit!r}; "
                    f"bypass requires {_MODE_ENV}={_BYPASS_MODE}",
                    code="invalid-options",
                )
            env[_MODE_ENV] = _BYPASS_MODE
        args = ["run", "--quiet", "--output-format", "stream-json"]
        if resolved.model:
            args += ["--model", resolved.model]
        if spec.instructions is not None:
            args.append(f"--system={spec.instructions}")
        # Equals form keeps leading '-' prompts (and the empty prompt) as the value.
        args.append(f"--text={spec.prompt}")
        return self.finalize_command(spec, cmd="goose", args=args, env=env)

    def parse_output(self, spec: RunSpec, outcome: SubprocOutcome) -> ParsedOutput:
        tokens_in, tokens_out, cost, raw = _parse_goose_events(outcome.stdout)
        return {"cost_usd": cost, "tokens_in": tokens_in, "tokens_out": tokens_out, "raw": raw}


def _parse_goose_events(stdout: str) -> tuple[int | None, int | None, float | None, list[dict] | None]:
    events: list[dict] = []
    complete: dict | None = None
    for line in stdout.split("\n"):
        line = line.strip()
        if not line:
            continue
        try:
            # Strict JSON like the TS port: NaN/Infinity literals invalidate the line.
            event = json.loads(line, parse_constant=_reject_constant)
        except ValueError:
            continue
        if not isinstance(event, dict) or not isinstance(event.get("type"), str):
            continue
        events.append(event)
        if event["type"] == "complete":
            complete = event
    if not events:
        return None, None, None, None
    if complete is None:
        return None, None, None, events
    return (
        _token_count(complete.get("input_tokens")),
        _token_count(complete.get("output_tokens")),
        _cost(complete.get("cost_usd")),
        events,
    )


def _reject_constant(name: str) -> object:
    raise ValueError(f"non-standard JSON constant {name!r}")


def _token_count(value: object) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value if value >= 0 else None
    if isinstance(value, float) and value >= 0 and math.isfinite(value) and value.is_integer():
        return int(value)
    return None


def _cost(value: object) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if value < 0 or not math.isfinite(value):
        return None
    return float(value)
