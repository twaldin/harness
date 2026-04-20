"""swe-agent adapter — invokes mini-swe-agent's headless Python entry point.

mini-swe-agent doesn't have a stable native CLI; agentelo wraps it via
`bin/run-mini-swe.py` which calls the minisweagent Python API and writes a
trajectory JSON. We require the wrapper script path via `env["SWE_WRAPPER"]`
or fall back to the bundled agentelo wrapper at `~/agentelo/bin/run-mini-swe.py`
if present.

Token/cost is read from `<workdir>/.harness/swe-traj.json` after the run.

NOTE: swe-agent has no per-harness instructions file in agentelo's mapping —
the convention is to put system-style guidance directly into `prompt`. If
`instructions` is set, we prepend it to the prompt (best-effort).
"""
from __future__ import annotations

import json
import os
from pathlib import Path

from harness._subproc import SubprocOutcome, run_subprocess
from harness.base import Adapter, BuildCommand, HarnessError, RunResult, RunSpec


class SweAgentAdapter(Adapter):
    name = "swe-agent"
    instructions_filename = ""  # not file-based; folded into prompt

    DEFAULT_MODEL = "openai/gpt-5.4"
    DEFAULT_COST_LIMIT_USD = 10.0

    def build_command(self, spec: RunSpec) -> BuildCommand:
        model = spec.model or self.DEFAULT_MODEL
        wrapper = _resolve_wrapper(spec.env)

        workdir = Path(spec.workdir)
        traj_dir = workdir / ".harness"
        traj_dir.mkdir(parents=True, exist_ok=True)
        traj_file = traj_dir / "swe-traj.json"

        prompt = spec.prompt
        if spec.instructions:
            prompt = f"{spec.instructions.rstrip()}\n\n---\n\n{prompt}"

        args = [
            str(wrapper),
            "--model", model,
            "--task", prompt,
            "--cwd", str(workdir),
            "--cost-limit", str(self.DEFAULT_COST_LIMIT_USD),
            "--output", str(traj_file),
        ]
        return BuildCommand(cmd="python3", args=args, cwd=workdir, env={}, instructions_file=None)

    def parse_output(self, spec: RunSpec, outcome: SubprocOutcome) -> dict:
        traj_file = Path(spec.workdir) / ".harness" / "swe-traj.json"
        tokens_in, tokens_out, cost, raw = _read_swe_trajectory(traj_file)
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


def _resolve_wrapper(env: dict[str, str]) -> Path:
    explicit = env.get("SWE_WRAPPER") or os.environ.get("SWE_WRAPPER")
    if explicit:
        path = Path(explicit).expanduser()
        if not path.exists():
            raise HarnessError(f"SWE_WRAPPER does not exist: {path}")
        return path

    fallback = Path.home() / "agentelo" / "bin" / "run-mini-swe.py"
    if fallback.exists():
        return fallback

    raise HarnessError(
        "swe-agent wrapper not found. Set SWE_WRAPPER env var to your "
        "headless mini-swe-agent runner script, or install agentelo at ~/agentelo."
    )


def _read_swe_trajectory(traj_file: Path) -> tuple[int | None, int | None, float | None, dict | None]:
    if not traj_file.exists():
        return None, None, None, None
    try:
        traj = json.loads(traj_file.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None, None, None, None

    stats = (traj.get("info") or {}).get("model_stats") or {}
    cost = stats.get("instance_cost")
    cost = float(cost) if isinstance(cost, (int, float)) else None

    tokens_in = tokens_out = 0
    saw_usage = False
    for msg in traj.get("messages") or []:
        usage = ((msg.get("extra") or {}).get("response") or {}).get("usage")
        if not isinstance(usage, dict):
            continue
        saw_usage = True
        tokens_in += int(usage.get("prompt_tokens") or usage.get("input_tokens") or 0)
        tokens_out += int(usage.get("completion_tokens") or usage.get("output_tokens") or 0)

    return (tokens_in if saw_usage else None), (tokens_out if saw_usage else None), cost, traj
