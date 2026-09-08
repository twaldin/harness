"""GitHub Copilot CLI (`@github/copilot`) in non-interactive JSON mode.

`copilot --output-format json --prompt=<text>` emits one JSON object per stdout
line (JSONL). Qualified with 1.0.83, the final `result` event carries
`sessionId`, `exitCode` and `usage` in premium-request / duration / code-change
terms — never dollars or aggregate token totals — and the intermediate session
usage checkpoint reports cache state rather than usage. Cost and token metrics
therefore stay None; every valid JSON object event is preserved in `raw` (None
when the stream carried none).

Tool permissions retain upstream policy with stdin closed. `--allow-all` is the
explicit bypass; `CopilotOptions` adds `--allow-tool=` / `--deny-tool=` rules.
"""
from __future__ import annotations

import json

from harness._subproc import SubprocOutcome
from harness.base import Adapter, BuildCommand, HarnessError, InstallMeta, ParsedOutput, RunSpec


class CopilotAdapter(Adapter):
    name = "copilot"
    instructions_filename = "AGENTS.md"
    DEFAULT_MODEL = ""  # Leave model selection to the caller's Copilot config.
    permission_bypass_args = ("--allow-all",)
    native_options_kind = "copilot"
    config_home_env = "COPILOT_HOME"
    install_meta = InstallMeta(
        package_manager="npm",
        install_command=("npm", "install", "-g", "@github/copilot"),
        update_command=("npm", "install", "-g", "@github/copilot@latest"),
        version_command=("copilot", "--version"),
    )

    def reported_model(self, spec: RunSpec) -> str | None:
        return spec.model or None

    def build_command(self, spec: RunSpec) -> BuildCommand:
        resolved = self.resolve_run_spec(spec)
        if not spec.prompt:
            raise HarnessError("copilot requires a non-empty prompt for non-interactive mode", code="invalid-options")
        args = ["--no-auto-update", "--no-remote-export", "--no-ask-user", "--output-format", "json"]
        if resolved.model:
            args.extend(["--model", resolved.model])
        args.extend(resolved.permission_args)
        args.extend(resolved.native_args)
        # Equals form keeps leading '-' prompts from being parsed as flags.
        args.append(f"--prompt={spec.prompt}")
        return self.finalize_command(spec, cmd="copilot", args=args)

    def parse_output(self, spec: RunSpec, outcome: SubprocOutcome) -> ParsedOutput:
        return {"cost_usd": None, "tokens_in": None, "tokens_out": None, "raw": _json_object_events(outcome.stdout)}


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
