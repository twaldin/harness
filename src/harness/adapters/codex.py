"""codex adapter — invokes the `codex exec` CLI.

`codex --json` emits JSONL on stdout with `turn.completed` events that carry
per-turn token usage. We sum across all turns.
"""
from __future__ import annotations

import json

from harness._subproc import SubprocOutcome, run_subprocess, write_instructions
from harness.base import Adapter, BuildCommand, RunResult, RunSpec
from harness.model_normalization import normalize_model_for_harness


class CodexAdapter(Adapter):
    name = "codex"
    instructions_filename = "AGENTS.md"

    DEFAULT_MODEL = "gpt-5.3-codex"

    def build_command(self, spec: RunSpec) -> BuildCommand:
        model = normalize_model_for_harness(self.name, spec.model or self.DEFAULT_MODEL, resolve=not spec.model_no_resolve)
        instructions_file = write_instructions(spec.workdir, self.instructions_filename, spec.instructions)
        args = [
            "exec",
            "-m", model,
            "--dangerously-bypass-approvals-and-sandbox",
            "--json",
            "-C", str(spec.workdir),
            spec.prompt,
        ]
        return BuildCommand(cmd="codex", args=args, cwd=spec.workdir, env={}, instructions_file=instructions_file)

    def parse_output(self, spec: RunSpec, outcome: SubprocOutcome) -> dict:
        tokens_in, tokens_out, saw_turn = _sum_turn_usage(outcome.stdout)
        return {
            "cost_usd": None,
            "tokens_in": tokens_in if saw_turn else None,
            "tokens_out": tokens_out if saw_turn else None,
            "raw": None,
        }

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


def _sum_turn_usage(stdout: str) -> tuple[int, int, bool]:
    tokens_in = tokens_out = 0
    saw_turn = False
    for line in stdout.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if event.get("type") == "turn.completed":
            saw_turn = True
            usage = event.get("usage") or {}
            tokens_in += int(usage.get("input_tokens") or 0)
            tokens_out += int(usage.get("output_tokens") or 0)
    return tokens_in, tokens_out, saw_turn
