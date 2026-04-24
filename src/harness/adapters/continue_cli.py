"""continue-cli adapter — invokes the `cn` CLI (Continue) in print mode.

When OPENAI-style env vars are present, this adapter writes a minimal Continue
config YAML and runs `cn -p --config <file> --format json ...` so bare model
IDs like `gpt-5.4` work against an OpenAI-compatible endpoint.
"""
from __future__ import annotations

import json
from pathlib import Path

from harness._subproc import SubprocOutcome, run_subprocess, write_instructions
from harness.base import Adapter, BuildCommand, RunResult, RunSpec
from harness.model_normalization import normalize_model_for_harness


class ContinueCliAdapter(Adapter):
    name = "continue-cli"
    instructions_filename = "CONTINUE.md"

    DEFAULT_MODEL = "claude-sonnet-4-6"

    def build_command(self, spec: RunSpec) -> BuildCommand:
        model = normalize_model_for_harness(self.name, spec.model or self.DEFAULT_MODEL, resolve=not spec.model_no_resolve)
        instructions_file = write_instructions(spec.workdir, self.instructions_filename, spec.instructions)

        openai_key = spec.env.get("OPENAI_API_KEY")
        openai_base = spec.env.get("OPENAI_BASE_URL")
        if openai_key or openai_base:
            config_path = _write_continue_config(Path(spec.workdir), model, openai_key or "dummy", openai_base, spec.instructions)
            args = ["-p", "--config", str(config_path), "--format", "json", spec.prompt]
            return BuildCommand(cmd="cn", args=args, cwd=spec.workdir, env={}, instructions_file=instructions_file)

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


def _write_continue_config(workdir: Path, model: str, api_key: str, api_base: str | None, instructions: str | None) -> Path:
    continue_dir = workdir / ".harness" / "continue"
    continue_dir.mkdir(parents=True, exist_ok=True)
    config_path = continue_dir / "config.yaml"
    lines = [
        "name: Harness Continue",
        "version: 1.0.0",
        "schema: v1",
        "models:",
        "  - name: harness-model",
        f"    model: {model}",
        "    provider: openai",
        f"    apiKey: {api_key}",
    ]
    if api_base:
        lines.append(f"    apiBase: {api_base}")
    lines += [
        "    roles:",
        "      - chat",
        "      - edit",
        "      - apply",
    ]
    if instructions:
        escaped = instructions.rstrip().replace("\n", "\\n")
        lines += ["rules:", f"  - '{escaped}'"]
    config_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return config_path
