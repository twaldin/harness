"""Kimi Code CLI (`kimi`) 0.41.0 print mode; see ADAPTER-MATRIX.md.

`kimi --output-format stream-json --prompt=<text>` runs one non-interactive
turn and emits assistant / tool / meta JSON objects as JSON Lines. No usage or
billing schema is qualified, so every cost and token metric stays None and each
complete JSON object line is preserved in `raw` (None when the stream carried
none).

The model is selected with `--model=<alias>` only when requested; the default
leaves selection to the caller's Kimi config, and the exact alias is passed
through untouched. Print mode is inherently auto-approving and rejects the
interactive `--yolo` / `--auto` / `--plan` mode flags, so only the upstream
permission policy exists. `KIMI_CODE_HOME` relocates the config home; there is
no config-file flag.
"""
from __future__ import annotations

from harness._subproc import SubprocOutcome
from harness.base import Adapter, BuildCommand, HarnessError, InstallMeta, ParsedOutput, RunSpec
from harness.util import json_object_events


class KimiCodeAdapter(Adapter):
    name = "kimi-code"
    instructions_filename = "AGENTS.md"
    DEFAULT_MODEL = ""  # Leave model selection to the caller's Kimi config.
    config_home_env = "KIMI_CODE_HOME"
    install_meta = InstallMeta(
        package_manager="npm",
        install_command=("npm", "install", "-g", "@moonshot-ai/kimi-code"),
        update_command=("npm", "install", "-g", "@moonshot-ai/kimi-code@latest"),
        version_command=("kimi", "--version"),
    )

    def reported_model(self, spec: RunSpec) -> str | None:
        return spec.model or None

    def build_command(self, spec: RunSpec) -> BuildCommand:
        resolved = self.resolve_run_spec(spec)
        if not spec.prompt.strip():
            # Upstream rejects a blank --prompt and would otherwise open the interactive UI.
            raise HarnessError("kimi-code requires a non-empty prompt for print mode", code="invalid-options")
        args = ["--output-format", "stream-json"]
        if resolved.model:
            # Equals form keeps leading '-' model names from being parsed as flags.
            args.append(f"--model={resolved.model}")
        args.append(f"--prompt={spec.prompt}")
        return self.finalize_command(spec, cmd="kimi", args=args)

    def parse_output(self, spec: RunSpec, outcome: SubprocOutcome) -> ParsedOutput:
        return {"cost_usd": None, "tokens_in": None, "tokens_out": None, "raw": json_object_events(outcome.stdout)}
