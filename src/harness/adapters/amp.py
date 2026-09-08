"""Amp CLI (`amp`) in local-executor execute mode with streaming JSON.

`amp --executor local --stream-json --execute=<prompt>` emits one JSON object
per stdout line (JSONL): `system`, `assistant`, `user` and a final `result`
event. Qualified with 0.0.1788868861-g921679: model selection has no CLI flag
(Amp owns mode-to-model routing), so `model` is rejected and the reported model is
always None; `--settings-file` carries `RunSpec.config_file`; there is no
config-home variable and no permission-bypass flag (execute mode retains
upstream tool policy).

Tokens come from the last top-level `result` event's `usage`
(`input_tokens` / `output_tokens`); when either is absent or invalid, that
field falls back to the sum over top-level `assistant` events'
`message.usage` (excluding sub-agent events, which carry a
`parent_tool_use_id`). Cache token fields are retained in `raw` but not folded
into the aggregate, matching the Claude headless convention. Cost stays None.
Every complete JSON object event is preserved in `raw` (None when the stream
carried none).
"""
from __future__ import annotations

import json

from harness._subproc import SubprocOutcome
from harness.base import Adapter, BuildCommand, HarnessError, InstallMeta, ParsedOutput, RunSpec

#: Largest integer that survives a JavaScript number round-trip.
_MAX_SAFE_INTEGER = 9007199254740991


class AmpAdapter(Adapter):
    name = "amp"
    instructions_filename = "AGENTS.md"
    DEFAULT_MODEL = ""  # No CLI model flag; Amp owns mode-to-model routing.
    native_options_kind = "amp"
    config_file_flag = "--settings-file"
    install_meta = InstallMeta(
        package_manager="binary",
        # The official installer is a shell pipeline (curl | bash); not
        # expressible as argv, so it is documented rather than encoded.
        install_command=(),
        update_command=("amp", "update"),
        version_command=("amp", "version"),
        platforms=("darwin", "linux"),
    )

    def reported_model(self, spec: RunSpec) -> str | None:
        return None

    def build_command(self, spec: RunSpec) -> BuildCommand:
        resolved = self.resolve_run_spec(spec)
        if resolved.model:
            raise HarnessError(
                f"amp has no CLI model flag (requested {resolved.model!r}); leave model unset "
                "and select a mode with AmpOptions",
                code="unsupported-capability",
            )
        if not spec.prompt:
            raise HarnessError("amp requires a non-empty prompt for execute mode", code="invalid-options")
        # Equals form keeps leading '-' prompts from being parsed as flags.
        args = ["--executor", "local", "--stream-json", *resolved.native_args, f"--execute={spec.prompt}", *resolved.config_args]
        return self.finalize_command(spec, cmd="amp", args=args)

    def parse_output(self, spec: RunSpec, outcome: SubprocOutcome) -> ParsedOutput:
        events = _json_object_events(outcome.stdout)
        tokens_in, tokens_out = _tokens(events or ())
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


def _safe_count(value: object) -> int | None:
    """`value` when it is a non-negative integer within JavaScript's safe range
    (bools excluded), else None."""
    if type(value) in (int, float) and 0 <= value <= _MAX_SAFE_INTEGER and int(value) == value:
        return int(value)
    return None


def _usage_of(event: dict, path: tuple[str, ...]) -> dict | None:
    node: object = event
    for key in path:
        if not isinstance(node, dict):
            return None
        node = node.get(key)
    return node if isinstance(node, dict) else None


def _tokens(events: list[dict] | tuple[()]) -> tuple[int | None, int | None]:
    """(tokens_in, tokens_out): each independently from the last top-level
    `result` event's usage, else the sum over top-level `assistant` events'
    usage, else None. Sub-agent events (non-null `parent_tool_use_id`) are
    ignored; result and assistant counts are never combined."""
    result_usage: dict | None = None
    assistant_in: int | None = None
    assistant_out: int | None = None
    for event in events:
        if event.get("parent_tool_use_id") is not None:
            continue
        kind = event.get("type")
        if kind == "result":
            result_usage = _usage_of(event, ("usage",))
        elif kind == "assistant":
            usage = _usage_of(event, ("message", "usage"))
            if usage is None:
                continue
            count = _safe_count(usage.get("input_tokens"))
            if count is not None:
                assistant_in = (assistant_in or 0) + count
            count = _safe_count(usage.get("output_tokens"))
            if count is not None:
                assistant_out = (assistant_out or 0) + count
    tokens_in = _safe_count(result_usage.get("input_tokens")) if result_usage else None
    tokens_out = _safe_count(result_usage.get("output_tokens")) if result_usage else None
    return (
        _safe_count(assistant_in) if tokens_in is None else tokens_in,
        _safe_count(assistant_out) if tokens_out is None else tokens_out,
    )
