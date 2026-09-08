"""Cline standalone CLI adapter — `cline --json` headless run.

Qualified against cline 3.0.61 (pinned upstream tag cli-v3.0.61). `--json`
emits one JSON object per stdout line: `hook_event`, `agent_event` (streaming
partials, per-iteration `usage`, `done`) and finally one `run_result`:

    { "type": "run_result", "finishReason": "completed" | "error" | ...,
      "usage": { "inputTokens", "outputTokens", "cacheReadTokens",
                 "cacheWriteTokens", "totalCost" },
      "aggregateUsage": {...}, "durationMs", "text", "model": {...} }

`run_result.usage` is the run's accumulated total, so only the last such
record feeds the metrics; per-iteration `usage` / `done` records are never
summed. A run cut before its terminal record reports null metrics while the
partial records stay in `raw`. The process status is the real one: cline
reports provider failures through `finishReason` inside the stream.

Environment (upstream sources under apps/cli/src):
  - CLINE_SESSION_BACKEND_MODE=local  documented; keeps the session in-process
    instead of the shared hub daemon (session/session.ts).
  - CLINE_NO_AUTO_UPDATE=1            disables the detached npm self-updater
    spawned at startup (commands/update.ts).
  - CLINE_RUN_AS_HUB_DAEMON=0         entry sentinel; never run as the daemon.
  - CLINE_TOOL_APPROVAL_MODE=desktop  routes approvals to the desktop app's IPC
    (utils/approval.ts); rejected because that is not headless.
  - CLINE_DIR                         config root (`config_home`).

`instructions` are projected to CLINE.md and referenced through cline's native
file mention (`@./CLINE.md`, runtime/prompt.ts) rather than relying on
git-root auto-discovery; the explicit relative mention also sidesteps
whitespace/quote issues in absolute workdir paths.
"""
from __future__ import annotations

import json
import math
import os

from harness._subproc import SubprocOutcome
from harness.base import Adapter, BuildCommand, HarnessError, InstallMeta, ParsedOutput, RunSpec, absolute_workdir

#: Per-run env the adapter requires; an explicit `spec.env` disagreement is rejected.
REQUIRED_ENV: dict[str, str] = {
    "CLINE_SESSION_BACKEND_MODE": "local",
    "CLINE_NO_AUTO_UPDATE": "1",
    "CLINE_RUN_AS_HUB_DAEMON": "0",
}
_APPROVAL_MODE_ENV = "CLINE_TOOL_APPROVAL_MODE"
_INSTRUCTIONS_MENTION = "Follow the instructions in @./CLINE.md\n\n"
_MAX_SAFE_INTEGER = 2**53 - 1


class ClineAdapter(Adapter):
    name = "cline"
    instructions_filename = "CLINE.md"
    DEFAULT_MODEL = ""  # Leave provider/model selection to the caller's cline config.
    permission_bypass_args = ("--auto-approve", "true")
    native_options_kind = "cline"
    config_home_env = "CLINE_DIR"
    #: First SIGINT stops a local-mode run and its shell tool child; SIGTERM
    #: leaves that child alive in its own process group (see ticket probes).
    graceful_signal = "SIGINT"
    install_meta = InstallMeta(
        package_manager="npm",
        install_command=("npm", "install", "-g", "cline"),
        update_command=("npm", "install", "-g", "cline@latest"),
        version_command=("cline", "--version"),
    )

    def reported_model(self, spec: RunSpec) -> str | None:
        return spec.model or None

    def build_command(self, spec: RunSpec) -> BuildCommand:
        resolved = self.resolve_run_spec(spec)
        if not spec.prompt.strip():
            # A missing prompt makes cline fall back to its interactive session.
            raise HarnessError("cline requires a non-empty prompt for a headless run", code="invalid-options")
        for key, value in REQUIRED_ENV.items():
            explicit = spec.env.get(key)
            if explicit is not None and explicit != value:
                raise HarnessError(
                    f"env[{key!r}]={explicit!r} conflicts with the {value!r} cline headless runs require; unset it",
                    code="invalid-options",
                )
        approval_mode = spec.env.get(_APPROVAL_MODE_ENV, os.environ.get(_APPROVAL_MODE_ENV))
        if approval_mode is not None and approval_mode.strip().lower() == "desktop":
            raise HarnessError(
                f"{_APPROVAL_MODE_ENV}=desktop delegates tool approval to the Cline desktop app; unset it for headless runs",
                code="unsupported-capability",
            )

        args = ["--json", "--cwd", str(absolute_workdir(spec.workdir))]
        if resolved.model:
            args += ["--model", resolved.model]
        args += [*resolved.native_args, *resolved.permission_args]
        prompt = spec.prompt if spec.instructions is None else _INSTRUCTIONS_MENTION + spec.prompt
        args += ["--", prompt]
        return self.finalize_command(spec, cmd="cline", args=args, env=dict(REQUIRED_ENV))

    def parse_output(self, spec: RunSpec, outcome: SubprocOutcome) -> ParsedOutput:
        records = _parse_records(outcome.stdout)
        tokens_in = tokens_out = cost = None
        for record in reversed(records):
            if record.get("type") == "run_result":
                usage = record.get("usage")
                if isinstance(usage, dict):
                    tokens_in = _token_count(usage.get("inputTokens"))
                    tokens_out = _token_count(usage.get("outputTokens"))
                    cost = _cost(usage.get("totalCost"))
                break
        return {"cost_usd": cost, "tokens_in": tokens_in, "tokens_out": tokens_out, "raw": records or None}


def _reject_constant(name: str) -> None:
    # `NaN` / `Infinity` are not JSON; treat the line as malformed like JSON.parse does.
    raise ValueError(name)


def _parse_records(stdout: str) -> list[dict]:
    records: list[dict] = []
    for line in stdout.split("\n"):
        line = line.strip()
        if not line:
            continue
        try:
            record = json.loads(line, parse_constant=_reject_constant)
        except ValueError:
            continue
        if isinstance(record, dict):
            records.append(record)
    return records


def _token_count(value: object) -> int | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if isinstance(value, float) and (not math.isfinite(value) or not value.is_integer()):
        return None
    if value < 0 or value > _MAX_SAFE_INTEGER:
        return None
    return int(value)


def _cost(value: object) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if value < 0 or not math.isfinite(value):
        return None
    return float(value)
