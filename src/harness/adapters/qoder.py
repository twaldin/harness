"""Qoder CLI 1.1.47 print-mode JSON; see ADAPTER-MATRIX.md for qualification.

Print mode emits one JSON result object (the native ``--output-format json``
envelope), or a line-framed ``stream-json`` event sequence. The whole object
is preserved as ``raw``; failing that, every complete JSON object line is
kept for diagnostics. Cost and token counts stay null: 1.1.47 hardcodes
``total_cost_usd: 0`` and reports no qualified usage, so echoing it would
imply real billing. Native errors and the subprocess outcome are preserved
independently of one another.
"""

from __future__ import annotations

import json

from harness._subproc import SubprocOutcome
from harness.base import (
    Adapter,
    BuildCommand,
    HarnessError,
    InstallMeta,
    ParsedOutput,
    RunSpec,
)


class QoderAdapter(Adapter):
    name = "qoder"
    instructions_filename = "AGENTS.md"
    DEFAULT_MODEL = ""  # Leave model selection to the caller's Qoder account defaults.
    native_options_kind = "qoder"
    config_home_env = "QODER_CONFIG_DIR"
    install_meta = InstallMeta(
        package_manager="npm",
        install_command=("npm", "install", "-g", "@qoder-ai/qodercli"),
        update_command=("npm", "install", "-g", "@qoder-ai/qodercli@latest"),
        version_command=("qoder", "--version"),
        platforms=("darwin", "linux"),
    )

    def reported_model(self, spec: RunSpec) -> str | None:
        return spec.model or None

    def build_command(self, spec: RunSpec) -> BuildCommand:
        resolved = self.resolve_run_spec(spec)
        if not spec.prompt:
            # An empty positional would make print mode read the prompt from stdin.
            raise HarnessError(
                "qoder requires a non-empty prompt for print mode",
                code="invalid-options",
            )
        args = [
            "--print",
            "--output-format",
            "json",
            "--input-format",
            "text",
            "--max-turns",
            "20",
        ]
        if resolved.model:
            args.extend(["--model", resolved.model])
        args.extend(resolved.permission_args)
        args.extend(resolved.native_args)
        args.extend(resolved.config_args)
        # Native rejects any positional query starting with '--', even after
        # '--'; the equals form of the hidden --prompt option carries every
        # prompt, including leading '-' ones.
        args.append(f"--prompt={spec.prompt}")
        return self.finalize_command(spec, cmd="qoder", args=args)

    def parse_output(self, spec: RunSpec, outcome: SubprocOutcome) -> ParsedOutput:
        return {
            "cost_usd": None,
            "tokens_in": None,
            "tokens_out": None,
            "raw": _result_or_events(outcome.stdout),
        }


def _reject_constant(value: str) -> None:
    raise ValueError(f"non-JSON constant: {value}")


def _result_or_events(stdout: str) -> dict | list[dict] | None:
    """The whole stdout when it is one JSON object (possibly pretty-printed);
    otherwise every complete JSON object line in order, skipping malformed,
    truncated and non-object lines. Scalars and arrays are never a result."""
    text = stdout.strip()
    if not text:
        return None
    try:
        whole = json.loads(text, parse_constant=_reject_constant)
    except (ValueError, RecursionError):
        pass
    else:
        return whole if isinstance(whole, dict) else None
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
