"""Kiro CLI (`kiro-cli`) in headless streaming mode.

`kiro-cli chat --no-interactive --agent-engine v2 --output-format stream-json -- <text>`
emits native ACP events as JSON Lines (2.21.1). No aggregate accounting schema
is qualified, so every cost and token metric stays None and each valid JSON
object event is preserved in `raw` (None when the stream carried none).

The model is selected with `--model=<name>` only when requested; the default
leaves selection to the caller's Kiro config. `--trust-all-tools` is the
explicit permission bypass. `KiroOptions` adds `--trust-tools=` (upstream's
comma-separated categories, which conflicts with bypass) and
`--require-mcp-startup`. Authentication comes from the caller's `KIRO_API_KEY`
or a prior interactive login.
"""
from __future__ import annotations

import json

from harness._subproc import SubprocOutcome
from harness.base import Adapter, BuildCommand, HarnessError, InstallMeta, ParsedOutput, RunSpec


class KiroAdapter(Adapter):
    name = "kiro"
    instructions_filename = "AGENTS.md"
    DEFAULT_MODEL = ""  # Leave model selection to the caller's Kiro config.
    permission_bypass_args = ("--trust-all-tools",)
    native_options_kind = "kiro"
    install_meta = InstallMeta(
        package_manager="binary",
        install_command=("bash", "-c", "curl -fsSL https://cli.kiro.dev/install | bash"),
        update_command=("kiro-cli", "update"),
        version_command=("kiro-cli", "--version"),
    )

    def reported_model(self, spec: RunSpec) -> str | None:
        return spec.model or None

    def build_command(self, spec: RunSpec) -> BuildCommand:
        resolved = self.resolve_run_spec(spec)
        if not spec.prompt:
            raise HarnessError("kiro requires a non-empty prompt for non-interactive mode", code="invalid-options")
        args = ["chat", "--no-interactive", "--agent-engine", "v2", "--output-format", "stream-json"]
        if resolved.model:
            # Equals form keeps leading '-' model names from being parsed as flags.
            args.append(f"--model={resolved.model}")
        args.extend(resolved.permission_args)
        args.extend(resolved.native_args)
        # `--` ends option parsing so a leading '-' prompt stays positional.
        args.extend(["--", spec.prompt])
        return self.finalize_command(spec, cmd="kiro-cli", args=args)

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
