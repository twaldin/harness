"""Factory Droid adapter — invokes `droid exec` in headless JSON mode."""
from __future__ import annotations

import json

from harness._subproc import SubprocOutcome, write_instructions
from harness.base import Adapter, BuildCommand, RunSpec
from harness.model_normalization import normalize_model_for_harness


class FactoryDroidAdapter(Adapter):
    name = "factory-droid"
    instructions_filename = "AGENTS.md"

    DEFAULT_MODEL = "gpt-5.4"

    def build_command(self, spec: RunSpec) -> BuildCommand:
        model = normalize_model_for_harness(self.name, spec.model or self.DEFAULT_MODEL, resolve=not spec.model_no_resolve)
        instructions_file = write_instructions(spec.workdir, self.instructions_filename, spec.instructions)

        # Keep strict same-model fairness by pinning spec generation to the
        # same model as execution.
        args = [
            "exec",
            "--output-format",
            "json",
            "--skip-permissions-unsafe",
            "--model",
            model,
            "--spec-model",
            model,
            spec.prompt,
        ]
        return BuildCommand(cmd="droid", args=args, cwd=spec.workdir, env={}, instructions_file=instructions_file)

    def parse_output(self, spec: RunSpec, outcome: SubprocOutcome) -> dict:
        raw = _parse_last_json_object(outcome.stdout)
        if not isinstance(raw, dict):
            return {"cost_usd": None, "tokens_in": None, "tokens_out": None, "raw": None}

        usage = raw.get("usage") if isinstance(raw.get("usage"), dict) else {}
        cost = _to_float(raw.get("total_cost_usd"))
        if cost is None:
            usage_cost = usage.get("cost")
            if isinstance(usage_cost, (int, float)):
                cost = float(usage_cost)
            elif isinstance(usage_cost, dict):
                cost = _to_float(usage_cost.get("total"))

        return {
            "cost_usd": cost,
            "tokens_in": _to_int(usage.get("input_tokens") or usage.get("input")),
            "tokens_out": _to_int(usage.get("output_tokens") or usage.get("output")),
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
