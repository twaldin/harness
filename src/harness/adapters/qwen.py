"""qwen adapter — invokes the `qwen` CLI in print mode.

`qwen -p PROMPT --output-format json` emits a JSON array on stdout where the
last item with `type='result'` carries usage: `{"input_tokens": N, "output_tokens": M}`.
Alibaba Cloud does not embed pricing in the response.
"""
from __future__ import annotations

import json
from pathlib import Path

from harness._subproc import SubprocOutcome, run_subprocess, write_instructions
from harness.base import Adapter, BuildCommand, RunResult, RunSpec, SessionTelemetry
from harness.model_normalization import normalize_model_for_harness


class QwenAdapter(Adapter):
    name = "qwen"
    instructions_filename = "QWEN.md"

    DEFAULT_MODEL = "qwen3-coder"

    def build_command(self, spec: RunSpec) -> BuildCommand:
        model = normalize_model_for_harness(self.name, spec.model or self.DEFAULT_MODEL, resolve=not spec.model_no_resolve)
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

    def session_log_path(self, workdir: Path, session_started_after: float | None = None) -> str | None:
        base = workdir.name
        primary = Path.home() / ".qwen" / "tmp" / base / "logs.json"
        if primary.exists():
            return str(primary)
        compat = Path.home() / ".gemini" / "tmp" / base / "logs.json"
        if compat.exists():
            return str(compat)
        return None

    def parse_session_log(self, path: str) -> SessionTelemetry:
        p = Path(path)
        if not p.exists():
            return SessionTelemetry(path, None, None, None, None, None)
        try:
            raw = json.loads(p.read_text(encoding="utf-8"))
            return SessionTelemetry(path, None, None, None, None, raw)
        except (OSError, json.JSONDecodeError):
            return SessionTelemetry(path, None, None, None, None, None)

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


def _parse_qwen_stats(stdout: str) -> tuple[int, int, list | dict | None]:
    """Parse qwen's --output-format json output.

    Current qwen emits a JSON array where the last item with `type="result"`
    carries `usage.{input_tokens, output_tokens}`. Older qwen versions emit a
    JSON envelope object with `stats.models[*].tokens.{input, candidates}`;
    we keep a fallback for that for backwards compatibility.
    """
    candidates: list[str] = [stdout.strip()]
    for ln in stdout.splitlines():
        s = ln.strip()
        if s.startswith("[") or s.startswith("{"):
            candidates.append(s)

    for blob in candidates:
        if not blob:
            continue
        try:
            parsed = json.loads(blob)
        except json.JSONDecodeError:
            continue

        if isinstance(parsed, list):
            for item in reversed(parsed):
                if not isinstance(item, dict) or item.get("type") != "result":
                    continue
                usage = item.get("usage") or {}
                tokens_in = int(usage.get("input_tokens") or 0)
                tokens_out = int(usage.get("output_tokens") or 0)
                return tokens_in, tokens_out, parsed
            continue

        if isinstance(parsed, dict):
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
