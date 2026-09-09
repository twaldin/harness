"""Auggie 0.36.0 print-mode JSON; see ADAPTER-MATRIX.md for qualification.

The native terminal result, not streamed assistant text, supplies optional
unit-tagged billing. Credits are not USD and no token counts are reported.
Preserve native completion/errors independently of the subprocess outcome.
"""

from __future__ import annotations

import json
import math

from harness._subproc import SubprocOutcome
from harness.base import (
    Adapter,
    BuildCommand,
    HarnessError,
    InstallMeta,
    ParsedOutput,
    RunSpec,
    absolute_workdir,
)


class AuggieAdapter(Adapter):
    name = "auggie"
    instructions_filename = "AGENTS.md"
    DEFAULT_MODEL = (
        ""  # Leave model selection to the caller's Augment account defaults.
    )
    install_meta = InstallMeta(
        package_manager="npm",
        install_command=("npm", "install", "-g", "@augmentcode/auggie"),
        update_command=("npm", "install", "-g", "@augmentcode/auggie@latest"),
        version_command=("auggie", "--version"),
        platforms=("darwin", "linux"),
    )

    def reported_model(self, spec: RunSpec) -> str | None:
        return spec.model or None

    def build_command(self, spec: RunSpec) -> BuildCommand:
        resolved = self.resolve_run_spec(spec)
        if not spec.prompt:
            raise HarnessError(
                "auggie requires a non-empty prompt for print mode",
                code="invalid-options",
            )
        args = [
            "--print",
            "--output-format",
            "json",
            "--show-cost",
            "--workspace-root",
            str(absolute_workdir(spec.workdir)),
        ]
        if resolved.model:
            args.extend(["--model", resolved.model])
        # Equals form keeps leading '-' prompts from being parsed as flags.
        args.append(f"--instruction={spec.prompt}")
        return self.finalize_command(
            spec, cmd="auggie", args=args, env={"AUGMENT_DISABLE_AUTO_UPDATE": "1"}
        )

    def parse_output(self, spec: RunSpec, outcome: SubprocOutcome) -> ParsedOutput:
        events = _json_object_events(outcome.stdout)
        return {
            "cost_usd": _result_cost_usd(events),
            "tokens_in": None,
            "tokens_out": None,
            "raw": events,
        }


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
        except (ValueError, RecursionError):
            continue
        if isinstance(event, dict):
            events.append(event)
    return events or None


def _result_cost_usd(events: list[dict] | None) -> float | None:
    """`billing.total_cost` from the last `result` object, only when that
    billing is denominated in USD; credits, absent billing and invalid totals
    are None. Earlier objects never supply a fallback."""
    if not events:
        return None
    for event in reversed(events):
        if event.get("type") != "result":
            continue
        billing = event.get("billing")
        if not isinstance(billing, dict) or billing.get("usage_unit") != "usd":
            return None
        return _cost(billing.get("total_cost"))
    return None


def _cost(value: object) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if value < 0 or not math.isfinite(value):
        return None
    return float(value)
