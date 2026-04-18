"""gemini adapter — invokes the `gemini` CLI in print mode.

`gemini -p PROMPT --output-format json` emits a JSON envelope where token
usage lives at `stats.models[*].tokens.{input,candidates}`.
"""
from __future__ import annotations

import json

from harness._subproc import run_subprocess, write_instructions
from harness.base import Adapter, RunResult, RunSpec


class GeminiAdapter(Adapter):
    name = "gemini"
    instructions_filename = "GEMINI.md"

    DEFAULT_MODEL = "gemini-2.5-pro"

    def run(self, spec: RunSpec) -> RunResult:
        model = spec.model or self.DEFAULT_MODEL
        write_instructions(spec.workdir, self.instructions_filename, spec.instructions)

        cmd = [
            "gemini",
            "-p",
            spec.prompt,
            "-y",
            "-m",
            model,
            "--output-format",
            "json",
        ]
        outcome = run_subprocess(
            cmd,
            cwd=spec.workdir,
            timeout_seconds=spec.timeout_seconds,
            extra_env=spec.env,
        )

        tokens_in, tokens_out, raw = _parse_gemini_stats(outcome.stdout)

        return RunResult(
            harness=self.name,
            model=model,
            exit_code=outcome.exit_code,
            duration_seconds=outcome.duration_seconds,
            stdout=outcome.stdout,
            stderr=outcome.stderr,
            timed_out=outcome.timed_out,
            cost_usd=None,
            tokens_in=tokens_in or None,
            tokens_out=tokens_out or None,
            raw=raw,
        )


def _parse_gemini_stats(stdout: str) -> tuple[int, int, dict | None]:
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
        if tokens_in or tokens_out:
            return tokens_in, tokens_out, parsed

    return 0, 0, None
