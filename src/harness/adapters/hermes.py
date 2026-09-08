"""Hermes Agent's local quiet chat CLI (not the messaging gateway)."""
from __future__ import annotations

import re

from harness._subproc import SubprocOutcome
from harness.base import Adapter, BuildCommand, HarnessError, ParsedOutput, RunSpec

# Require a complete footer line; a capture-truncated session ID is not usable.
_SESSION_ID = re.compile(r"^session_id: ([A-Za-z0-9_-]+)\r?\n", re.MULTILINE)


class HermesAdapter(Adapter):
    name = "hermes"
    instructions_filename = "AGENTS.md"
    DEFAULT_MODEL = ""  # Leave model/provider selection to the caller's Hermes config.
    permission_bypass_args = ("--yolo",)
    config_home_env = "HERMES_HOME"

    def reported_model(self, spec: RunSpec) -> str | None:
        return spec.model or None

    def build_command(self, spec: RunSpec) -> BuildCommand:
        resolved = self.resolve_run_spec(spec)
        if not spec.prompt:
            raise HarnessError("hermes requires a non-empty prompt for headless chat", code="invalid-options")
        # Top-level --oneshot implicitly bypasses approvals. Quiet chat does not.
        args = ["chat", "--cli", "--quiet"]
        if resolved.model:
            args.extend(["--model", resolved.model])
        args.extend(resolved.permission_args)
        # Equals form keeps leading '-' prompts from being parsed as flags.
        args.append(f"--query={spec.prompt}")
        return self.finalize_command(spec, cmd="hermes", args=args)

    def parse_output(self, spec: RunSpec, outcome: SubprocOutcome) -> ParsedOutput:
        session_id = None
        for match in _SESSION_ID.finditer(outcome.stderr):
            session_id = match.group(1)
        # Quiet chat emits text, not JSON/usage events. Stdout remains on RunResult.
        return {
            "cost_usd": None,
            "tokens_in": None,
            "tokens_out": None,
            "raw": {"session_id": session_id} if session_id is not None else None,
        }
