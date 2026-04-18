"""claude-code adapter — invokes the `claude` CLI in print mode.

Output format: --output-format json gives a structured envelope:
    { "type": "result", "result": "...", "usage": {...}, "total_cost_usd": ... }
"""
from __future__ import annotations

import json

from harness._subproc import run_subprocess, write_instructions
from harness.base import Adapter, RunResult, RunSpec


class ClaudeCodeAdapter(Adapter):
    name = "claude-code"
    instructions_filename = "CLAUDE.md"

    DEFAULT_MODEL = "sonnet"

    def run(self, spec: RunSpec) -> RunResult:
        model = spec.model or self.DEFAULT_MODEL
        write_instructions(spec.workdir, self.instructions_filename, spec.instructions)

        cmd = [
            "claude",
            "-p",
            spec.prompt,
            "--model",
            model,
            "--output-format",
            "json",
            "--dangerously-skip-permissions",
        ]
        outcome = run_subprocess(
            cmd,
            cwd=spec.workdir,
            timeout_seconds=spec.timeout_seconds,
            extra_env=spec.env,
        )

        cost = tokens_in = tokens_out = None
        raw: dict | None = None
        if outcome.stdout.strip():
            try:
                raw = json.loads(outcome.stdout)
            except json.JSONDecodeError:
                raw = None

        if isinstance(raw, dict):
            usage = raw.get("usage") or {}
            tokens_in = usage.get("input_tokens")
            tokens_out = usage.get("output_tokens")
            cost = raw.get("total_cost_usd")

        return RunResult(
            harness=self.name,
            model=model,
            exit_code=outcome.exit_code,
            duration_seconds=outcome.duration_seconds,
            stdout=outcome.stdout,
            stderr=outcome.stderr,
            timed_out=outcome.timed_out,
            cost_usd=cost,
            tokens_in=tokens_in,
            tokens_out=tokens_out,
            raw=raw,
        )
