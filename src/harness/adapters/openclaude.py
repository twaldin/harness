"""OpenClaude adapter — invokes `openclaude` (`claude`) in print JSON mode."""
from __future__ import annotations

import json

from harness._subproc import SubprocOutcome, write_instructions
from harness.base import Adapter, BuildCommand, RunSpec
from harness.model_normalization import normalize_model_for_harness


class OpenClaudeAdapter(Adapter):
    name = "openclaude"
    instructions_filename = "CLAUDE.md"

    DEFAULT_MODEL = "gpt-5.4"

    def build_command(self, spec: RunSpec) -> BuildCommand:
        model = normalize_model_for_harness(self.name, spec.model or self.DEFAULT_MODEL, resolve=not spec.model_no_resolve)
        instructions_file = write_instructions(spec.workdir, self.instructions_filename, spec.instructions)

        args = [
            "-p",
            spec.prompt,
            "--output-format",
            "json",
            "--dangerously-skip-permissions",
        ]
        if spec.instructions:
            args += ["--append-system-prompt", spec.instructions]

        env: dict[str, str] = {}
        # OpenAI-compatible provider path: prefer env-based setup. openclaude's
        # README documents OPENAI_MODEL + CLAUDE_CODE_USE_OPENAI rather than an
        # explicit --model flag for custom OpenAI-compatible endpoints.
        if spec.env.get("OPENAI_API_KEY") or spec.env.get("OPENAI_BASE_URL"):
            env["CLAUDE_CODE_USE_OPENAI"] = "1"
            if "OPENAI_MODEL" not in spec.env:
                env["OPENAI_MODEL"] = model
        else:
            args += ["--model", model]

        return BuildCommand(
            cmd="openclaude",
            args=args,
            cwd=spec.workdir,
            env=env,
            instructions_file=instructions_file,
        )

    def parse_output(self, spec: RunSpec, outcome: SubprocOutcome) -> dict:
        raw = _parse_last_json_object(outcome.stdout)
        if not isinstance(raw, dict):
            return {"cost_usd": None, "tokens_in": None, "tokens_out": None, "raw": None}

        usage = raw.get("usage") if isinstance(raw.get("usage"), dict) else {}
        return {
            "cost_usd": _to_float(raw.get("total_cost_usd")),
            "tokens_in": _to_int(usage.get("input_tokens")),
            "tokens_out": _to_int(usage.get("output_tokens")),
            "raw": raw,
        }


def _parse_last_json_object(stdout: str) -> dict | None:
    blob = stdout.strip()
    if blob:
        try:
            parsed = json.loads(blob)
            if isinstance(parsed, dict):
                return parsed
        except json.JSONDecodeError:
            pass

    for line in reversed(stdout.splitlines()):
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            parsed = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict):
            return parsed

    return None


def _to_int(v: object) -> int | None:
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return int(v)
    return None


def _to_float(v: object) -> float | None:
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v)
    return None
