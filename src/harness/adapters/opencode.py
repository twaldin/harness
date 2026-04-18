"""opencode adapter — invokes the `opencode run` CLI.

Token/cost extraction from opencode's session metadata. Mirrors the parsing
logic in agentelo/bin/agentelo (line ~1491) but keeps it thin: we look in
`<workdir>/.opencode/session/*.json` for the latest session and pull the
totals if present.
"""
from __future__ import annotations

import json
from pathlib import Path

from harness._subproc import run_subprocess, write_instructions
from harness.base import Adapter, RunResult, RunSpec


class OpenCodeAdapter(Adapter):
    name = "opencode"
    instructions_filename = "AGENTS.md"

    DEFAULT_MODEL = "openai/gpt-5.4"

    def run(self, spec: RunSpec) -> RunResult:
        model = spec.model or self.DEFAULT_MODEL
        write_instructions(spec.workdir, self.instructions_filename, spec.instructions)

        cmd = [
            "opencode",
            "run",
            "--dir",
            str(spec.workdir),
            "--model",
            model,
            spec.prompt,
        ]
        outcome = run_subprocess(
            cmd,
            cwd=spec.workdir,
            timeout_seconds=spec.timeout_seconds,
            extra_env=spec.env,
        )

        tokens_in, tokens_out, cost, raw = _read_session_totals(Path(spec.workdir))

        return RunResult(
            harness=self.name,
            model=model,
            exit_code=outcome.exit_code,
            duration_seconds=outcome.duration_seconds,
            stdout=outcome.stdout,
            stderr=outcome.stderr,
            timed_out=outcome.timed_out,
            cost_usd=cost,
            tokens_in=tokens_in,
            tokens_out=tokens_out,
            raw=raw,
        )


def _read_session_totals(workdir: Path) -> tuple[int | None, int | None, float | None, dict | None]:
    """Best-effort: read latest opencode session JSON for token/cost totals.

    Returns (tokens_in, tokens_out, cost_usd, raw_session).
    """
    session_dir = workdir / ".opencode" / "session"
    if not session_dir.is_dir():
        return None, None, None, None

    sessions = sorted(session_dir.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)
    if not sessions:
        return None, None, None, None

    try:
        raw = json.loads(sessions[0].read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None, None, None, None

    # opencode session JSON has nested structure; tolerate missing keys.
    tokens_in = _coerce_int(raw.get("tokensInput") or raw.get("tokens_in"))
    tokens_out = _coerce_int(raw.get("tokensOutput") or raw.get("tokens_out"))
    cost = _coerce_float(raw.get("cost") or raw.get("totalCost"))

    return tokens_in, tokens_out, cost, raw


def _coerce_int(v: object) -> int | None:
    if isinstance(v, int):
        return v
    if isinstance(v, float):
        return int(v)
    return None


def _coerce_float(v: object) -> float | None:
    if isinstance(v, (int, float)):
        return float(v)
    return None
