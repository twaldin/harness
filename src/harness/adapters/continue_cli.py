"""continue-cli adapter — invokes the `cn` CLI (Continue) in print mode.

`cn -p PROMPT --json` emits a JSON envelope matching claude-code's shape:
    { "type": "result", "result": "...", "usage": {...}, "total_cost_usd": ... }
"""
from __future__ import annotations

import json

from harness._subproc import SubprocOutcome, run_subprocess, write_instructions
from harness.base import Adapter, BuildCommand, RunResult, RunSpec


class ContinueCliAdapter(Adapter):
    name = "continue-cli"
    instructions_filename = "CONTINUE.md"

    DEFAULT_MODEL = "claude-sonnet-4-6"

    def build_command(self, spec: RunSpec) -> BuildCommand:
        model = spec.model or self.DEFAULT_MODEL
        instructions_file = write_instructions(spec.workdir, self.instructions_filename, spec.instructions)
        args = ["-p", spec.prompt, "--model", model, "--json"]
        return BuildCommand(cmd="cn", args=args, cwd=spec.workdir, env={}, instructions_file=instructions_file)

    def parse_output(self, spec: RunSpec, outcome: SubprocOutcome) -> dict:
        raw: dict | None = None
        if outcome.stdout.strip():
            try:
                raw = json.loads(outcome.stdout)
            except json.JSONDecodeError:
                raw = None

        cost = tokens_in = tokens_out = None
        if isinstance(raw, dict):
            usage = raw.get("usage") or {}
            tokens_in = usage.get("input_tokens")
            tokens_out = usage.get("output_tokens")
            cost = raw.get("total_cost_usd")

        return {"cost_usd": cost, "tokens_in": tokens_in, "tokens_out": tokens_out, "raw": raw}

    def run(self, spec: RunSpec) -> RunResult:
        bc = self.build_command(spec)
        outcome = run_subprocess(
            [bc.cmd] + bc.args,
            cwd=bc.cwd,
            timeout_seconds=spec.timeout_seconds,
            extra_env={**bc.env, **spec.env},
        )
        parsed = self.parse_output(spec, outcome)
        return RunResult(
            harness=self.name,
            model=spec.model or self.DEFAULT_MODEL,
            exit_code=outcome.exit_code,
            duration_seconds=outcome.duration_seconds,
            stdout=outcome.stdout,
            stderr=outcome.stderr,
            timed_out=outcome.timed_out,
            cost_usd=parsed.get("cost_usd"),
            tokens_in=parsed.get("tokens_in"),
            tokens_out=parsed.get("tokens_out"),
            raw=parsed.get("raw"),
        )
