"""codex adapter — invokes the `codex exec` CLI.

`codex --json` emits JSONL on stdout with `turn.completed` events that carry
per-turn token usage. We sum across all turns.
"""
from __future__ import annotations

import json

from harness._subproc import run_subprocess, write_instructions
from harness.base import Adapter, RunResult, RunSpec


class CodexAdapter(Adapter):
    name = "codex"
    instructions_filename = "AGENTS.md"

    DEFAULT_MODEL = "gpt-5.3-codex"

    def run(self, spec: RunSpec) -> RunResult:
        model = spec.model or self.DEFAULT_MODEL
        write_instructions(spec.workdir, self.instructions_filename, spec.instructions)

        cmd = [
            "codex",
            "exec",
            "-m",
            model,
            "--dangerously-bypass-approvals-and-sandbox",
            "--json",
            "-C",
            str(spec.workdir),
            spec.prompt,
        ]
        outcome = run_subprocess(
            cmd,
            cwd=spec.workdir,
            timeout_seconds=spec.timeout_seconds,
            extra_env=spec.env,
        )

        tokens_in, tokens_out = _sum_turn_usage(outcome.stdout)

        return RunResult(
            harness=self.name,
            model=model,
            exit_code=outcome.exit_code,
            duration_seconds=outcome.duration_seconds,
            stdout=outcome.stdout,
            stderr=outcome.stderr,
            timed_out=outcome.timed_out,
            cost_usd=None,  # codex doesn't report cost
            tokens_in=tokens_in or None,
            tokens_out=tokens_out or None,
            raw=None,
        )


def _sum_turn_usage(stdout: str) -> tuple[int, int]:
    tokens_in = tokens_out = 0
    for line in stdout.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if event.get("type") == "turn.completed":
            usage = event.get("usage") or {}
            tokens_in += int(usage.get("input_tokens") or 0)
            tokens_out += int(usage.get("output_tokens") or 0)
    return tokens_in, tokens_out
