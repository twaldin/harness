"""qwen adapter — invokes the `qwen` CLI in print mode.

`qwen -p PROMPT --output-format json` emits a JSON envelope where token
usage lives at `stats.models[*].tokens.{input,candidates}` (same shape as
the gemini adapter; Alibaba Cloud does not embed pricing in the response).
"""
from __future__ import annotations

import json

from harness._subproc import SubprocOutcome, run_subprocess, write_instructions
from harness.base import Adapter, BuildCommand, RunResult, RunSpec


class QwenAdapter(Adapter):
    name = "qwen"
    instructions_filename = "QWEN.md"

    DEFAULT_MODEL = "qwen3-coder"

    def build_command(self, spec: RunSpec) -> BuildCommand:
        model = spec.model or self.DEFAULT_MODEL
        instructions_file = write_instructions(spec.workdir, self.instructions_filename, spec.instructions)
        args = ["-p", spec.prompt, "-y", "-m", model, "--output-format", "json"]
        return BuildCommand(cmd="qwen", args=args, cwd=spec.workdir, env={}, instructions_file=instructions_file)

    def parse_output(self, spec: RunSpec, outcome: SubprocOutcome) -> dict:
        tokens_in, tokens_out, raw = _parse_qwen_stats(outcome.stdout)
        return {
            "cost_usd": None,
            "tokens_in": tokens_in if raw is not None else None,
            "tokens_out": tokens_out if raw is not None else None,
            "raw": raw,
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


def _parse_qwen_stats(stdout: str) -> tuple[int, int, dict | None]:
    """Try whole-stdout JSON first, then fall back to scanning lines."""
    candidates: list[str] = [stdout.strip()]
    candidates += [ln.strip() for ln in stdout.splitlines() if ln.strip().startswith("{")]

    for blob in candidates:
        if not blob:
            continue
        try:
            parsed = json.loads(blob)
        except json.JSONDecodeError:
            continue
        models = (parsed.get("stats") or {}).get("models")
        if not isinstance(models, dict):
            continue
        tokens_in = tokens_out = 0
        for stats in models.values():
            t = (stats or {}).get("tokens") or {}
            tokens_in += int(t.get("input") or 0)
            tokens_out += int(t.get("candidates") or 0)
        return tokens_in, tokens_out, parsed

    return 0, 0, None
