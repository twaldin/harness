"""mini-swe-agent native CLI (`mini --task … --exit-immediately`).

Distinct from `swe-agent`, which drives mini-swe-agent through agentelo's
wrapper script. This adapter invokes upstream's own `mini` entry point and
reads the trajectory it writes to `<workdir>/.harness/mini-swe-agent.traj.json`.

Freshness gate: the artifact is parsed only when the run's stdout carries
upstream's completion line `Saved trajectory to '<path>'`. Rich wraps and
colors that line, so ANSI is stripped and CR/LF removed before the check. No
marker (interrupted run, provider exception, stale file from a previous run)
means every metric and `raw` is None; captured stdout/stderr still tell the
story. A complete run that stopped on LimitsExceeded or RepeatedFormatError can
exit 0 — `raw["info"]["exit_status"]` is kept verbatim and never conflated with
process success.

Permissions: `--yolo` is the only bypass. Under "upstream", mini's default
confirmation prompt reads a closed stdin and fails with EOF; nothing is ever
implicitly approved. Unattended runs need explicit bypass or a caller config
that whitelists/yolo-mode the agent. MSWEA_CONFIGURED=true only skips the
first-run wizard; it does not touch permissions.

Cancellation is bounded to the owned process group. Upstream's local
environment starts every shell command with `start_new_session=True`
(environments/local.py), so an in-flight shell survives group teardown; the
harness deliberately adds no global supervisor for it. Container/custom
environments selected through a config file are the caller's to manage.
"""
from __future__ import annotations

import json
import math
from pathlib import Path

from harness._subproc import SubprocOutcome
from harness.base import Adapter, BuildCommand, HarnessError, InstallMeta, ParsedOutput, RunSpec, absolute_workdir
from harness.util import strip_ansi

_TRAJECTORY_FORMAT = "mini-swe-agent-1.1"
_CONFIGURED_ENV = "MSWEA_CONFIGURED"
_MAX_SAFE_INTEGER = 9007199254740991


class MiniSweAgentAdapter(Adapter):
    name = "mini-swe-agent"
    instructions_filename = ""  # not file-based; folded into prompt
    DEFAULT_MODEL = ""  # Leave model selection to the caller's mini config/env.
    permission_bypass_args = ("--yolo",)
    config_home_env = "MSWEA_GLOBAL_CONFIG_DIR"
    config_file_flag = "--config"  # Replaces upstream's default config list entirely.
    install_meta = InstallMeta(
        package_manager="pip",
        install_command=("uv", "tool", "install", "mini-swe-agent"),
        update_command=("uv", "tool", "upgrade", "mini-swe-agent"),
        version_command=("python3", "-c", "from importlib.metadata import version; print(version('mini-swe-agent'))"),
    )

    def reported_model(self, spec: RunSpec) -> str | None:
        return spec.model or None

    def build_command(self, spec: RunSpec) -> BuildCommand:
        resolved = self.resolve_run_spec(spec)
        if not spec.prompt:
            raise HarnessError("mini-swe-agent requires a non-empty prompt for a headless run", code="invalid-options")
        if spec.env.get(_CONFIGURED_ENV) == "":
            raise HarnessError(
                f"env[{_CONFIGURED_ENV!r}] must be non-empty; an empty value re-enables mini's first-run config wizard",
                code="invalid-options",
            )
        prompt = spec.prompt
        if spec.instructions:
            prompt = f"{spec.instructions.rstrip()}\n\n---\n\n{prompt}"
        workdir = absolute_workdir(spec.workdir)
        traj_dir = workdir / ".harness"
        args = [
            # Equals form keeps leading '-' prompts as the value.
            f"--task={prompt}",
            "--exit-immediately",
            "--output", str(_trajectory_file(workdir)),
            *resolved.permission_args,
            *resolved.config_args,
        ]
        if resolved.model:
            args += ["--model", resolved.model]
        return self.finalize_command(spec, cmd="mini", args=args, env={_CONFIGURED_ENV: "true"}, directories=(traj_dir,))

    def parse_output(self, spec: RunSpec, outcome: SubprocOutcome) -> ParsedOutput:
        traj_file = _trajectory_file(absolute_workdir(spec.workdir))
        if outcome.exit_code != 0 or outcome.timed_out or not _saved_marker_present(outcome.stdout, traj_file):
            return {"cost_usd": None, "tokens_in": None, "tokens_out": None, "raw": None}
        traj = _read_trajectory(traj_file)
        if traj is None:
            return {"cost_usd": None, "tokens_in": None, "tokens_out": None, "raw": None}
        tokens_in, tokens_out = _usage_totals(traj.get("messages"))
        return {"cost_usd": _instance_cost(traj.get("info")), "tokens_in": tokens_in, "tokens_out": tokens_out, "raw": traj}


def _trajectory_file(workdir: Path) -> Path:
    return workdir / ".harness" / "mini-swe-agent.traj.json"


def _saved_marker_present(stdout: str, traj_file: Path) -> bool:
    """Upstream prints `Saved trajectory to '<path>'` through Rich, which wraps
    long paths across lines; compare after stripping ANSI and line breaks."""
    flat = strip_ansi(stdout).replace("\r", "").replace("\n", "").rstrip()
    return flat.endswith(f"Saved trajectory to '{traj_file}'")


def _read_trajectory(traj_file: Path) -> dict | None:
    """The artifact as a dict, or None when missing, unreadable, not strict
    UTF-8/JSON, not an object, or not the `mini-swe-agent-1.1` format."""
    try:
        text = traj_file.read_bytes().decode("utf-8")
        traj = json.loads(text, parse_constant=_reject_constant)
    except (OSError, ValueError):
        return None
    if not isinstance(traj, dict) or traj.get("trajectory_format") != _TRAJECTORY_FORMAT:
        return None
    return traj


def _reject_constant(name: str) -> object:
    raise ValueError(f"non-standard JSON constant {name!r}")


def _instance_cost(info: object) -> float | None:
    if not isinstance(info, dict):
        return None
    stats = info.get("model_stats")
    if not isinstance(stats, dict):
        return None
    value = stats.get("instance_cost")
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    try:
        cost = float(value)
    except OverflowError:
        return None
    return cost if cost >= 0 and math.isfinite(cost) else None


def _usage_totals(messages: object) -> tuple[int | None, int | None]:
    """Sum `extra.response.usage` over assistant messages only. Each dimension
    is None unless at least one valid count was seen, or when the sum exceeds
    the safe-integer range."""
    tokens_in: int | None = None
    tokens_out: int | None = None
    if not isinstance(messages, list):
        return None, None
    for msg in messages:
        if not isinstance(msg, dict) or msg.get("role") != "assistant":
            continue
        extra = msg.get("extra")
        response = extra.get("response") if isinstance(extra, dict) else None
        usage = response.get("usage") if isinstance(response, dict) else None
        if not isinstance(usage, dict):
            continue
        prompt = _usage_count(usage, "prompt_tokens", "input_tokens")
        if prompt is not None:
            tokens_in = prompt if tokens_in is None else tokens_in + prompt
        completion = _usage_count(usage, "completion_tokens", "output_tokens")
        if completion is not None:
            tokens_out = completion if tokens_out is None else tokens_out + completion
    if tokens_in is not None and tokens_in > _MAX_SAFE_INTEGER:
        tokens_in = None
    if tokens_out is not None and tokens_out > _MAX_SAFE_INTEGER:
        tokens_out = None
    return tokens_in, tokens_out


def _usage_count(usage: dict, primary: str, fallback: str) -> int | None:
    """`usage[primary]` validated, falling back to `usage[fallback]` only when
    the primary is absent or null. A present-but-invalid primary is not
    counted and does not fall through."""
    value = usage.get(primary)
    if value is None:
        value = usage.get(fallback)
    return _token_count(value)


def _token_count(value: object) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, float):
        if not math.isfinite(value) or not value.is_integer():
            return None
        value = int(value)
    if not isinstance(value, int) or value < 0 or value > _MAX_SAFE_INTEGER:
        return None
    return value
