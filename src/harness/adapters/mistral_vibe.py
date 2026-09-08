"""Mistral Vibe (`vibe`, PyPI `mistral-vibe`) in non-interactive streaming mode.

`vibe --output streaming --prompt=<text>` emits one JSON object per stdout
line (JSONL) mirroring the conversation history. Qualified with 2.25.0: the
stream carries no aggregate token or cost totals, so every metric stays None
and each valid JSON object event is preserved in `raw` (None when the stream
carried none).

The model is selected through `VIBE_ACTIVE_MODEL` in the child env only when a
model was requested; the default leaves selection to the caller's vibe config.
`--auto-approve` is the explicit permission bypass. `VibeOptions` adds
`--agent=` and `--trust`; a projected `AGENTS.md` is only read from a trusted
workspace, so non-empty instructions require `trust=True`.
"""
from __future__ import annotations

import json

from harness._subproc import SubprocOutcome
from harness.base import Adapter, BuildCommand, HarnessError, InstallMeta, ParsedOutput, RunSpec, VibeOptions

_MODEL_ENV = "VIBE_ACTIVE_MODEL"


class MistralVibeAdapter(Adapter):
    name = "mistral-vibe"
    instructions_filename = "AGENTS.md"
    DEFAULT_MODEL = ""  # Leave model selection to the caller's vibe config.
    permission_bypass_args = ("--auto-approve",)
    native_options_kind = "mistral-vibe"
    config_home_env = "VIBE_HOME"
    install_meta = InstallMeta(
        package_manager="pip",
        install_command=("uv", "tool", "install", "mistral-vibe"),
        update_command=("uv", "tool", "upgrade", "mistral-vibe"),
        version_command=("vibe", "--version"),
    )

    def reported_model(self, spec: RunSpec) -> str | None:
        return spec.model or None

    def build_command(self, spec: RunSpec) -> BuildCommand:
        resolved = self.resolve_run_spec(spec)
        if not spec.prompt:
            raise HarnessError("mistral-vibe requires a non-empty prompt for non-interactive mode", code="invalid-options")
        native = spec.native_options
        trusted = isinstance(native, VibeOptions) and native.trust is True
        if spec.instructions and not trusted:
            raise HarnessError(
                "mistral-vibe only reads a projected AGENTS.md from a trusted workspace; "
                "set VibeOptions(trust=True) or omit instructions",
                code="unsupported-capability",
            )
        env: dict[str, str] = {}
        if resolved.model:
            explicit = spec.env.get(_MODEL_ENV)
            if explicit is not None and explicit != resolved.model:
                raise HarnessError(
                    f"model conflicts with env[{_MODEL_ENV!r}]={explicit!r}; set one of them",
                    code="invalid-options",
                )
            env[_MODEL_ENV] = resolved.model
        args = ["--output", "streaming", *resolved.permission_args, *resolved.native_args]
        # Equals form keeps leading '-' prompts from being parsed as flags.
        args.append(f"--prompt={spec.prompt}")
        return self.finalize_command(spec, cmd="vibe", args=args, env=env)

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
