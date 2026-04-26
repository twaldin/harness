"""claude-code adapter — invokes the `claude` CLI in print mode.

Output format: --output-format json gives a structured envelope:
    { "type": "result", "result": "...", "usage": {...}, "total_cost_usd": ... }
"""
from __future__ import annotations

import json
from pathlib import Path

from harness._subproc import SubprocOutcome, run_subprocess, write_instructions
from harness.base import Adapter, BuildCommand, RunResult, RunSpec, SessionTelemetry
from harness.model_normalization import normalize_model_for_harness
from harness.pricing import derive_cost


class ClaudeCodeAdapter(Adapter):
    name = "claude-code"
    instructions_filename = "CLAUDE.md"

    DEFAULT_MODEL = "sonnet"

    def build_command(self, spec: RunSpec) -> BuildCommand:
        model = normalize_model_for_harness(self.name, spec.model or self.DEFAULT_MODEL, resolve=not spec.model_no_resolve)
        instructions_file = write_instructions(spec.workdir, self.instructions_filename, spec.instructions)
        args = [
            "-p", spec.prompt,
            "--model", model,
            "--output-format", "json",
            "--dangerously-skip-permissions",
        ]
        if spec.instructions:
            args += ["--append-system-prompt", spec.instructions]
        return BuildCommand(cmd="claude", args=args, cwd=spec.workdir, env={}, instructions_file=instructions_file)

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

    def session_log_path(self, workdir: Path, session_started_after: float | None = None) -> str | None:
        home = Path.home()
        try:
            real = workdir.resolve()
        except OSError:
            real = workdir
        encoded = str(real).replace("/", "-").replace("_", "-")
        d = home / ".claude" / "projects" / encoded
        if not d.exists() or not d.is_dir():
            return None
        files = sorted((p for p in d.glob("*.jsonl") if p.is_file()), key=lambda p: p.stat().st_mtime, reverse=True)
        if session_started_after is not None:
            files = [p for p in files if p.stat().st_mtime >= session_started_after]
        return str(files[0]) if files else None

    def parse_session_log(self, path: str) -> SessionTelemetry:
        p = Path(path)
        if not p.exists():
            return SessionTelemetry(path, None, None, None, None, None)

        tokens_in = 0
        tokens_out = 0
        cost_usd = 0.0
        model_name: str | None = None
        saw_usage = False
        saw_cost = False

        try:
            for line in p.read_text(encoding="utf-8").splitlines():
                t = line.strip()
                if not t:
                    continue
                try:
                    event = json.loads(t)
                except json.JSONDecodeError:
                    continue
                if not isinstance(event, dict):
                    continue
                msg = event.get("message") if isinstance(event.get("message"), dict) else {}
                usage = msg.get("usage") if isinstance(msg.get("usage"), dict) else {}
                if usage:
                    saw_usage = True
                    tokens_in += int(usage.get("input_tokens") or 0)
                    tokens_out += int(usage.get("output_tokens") or 0)
                event_cost = event.get("costUSD")
                if not isinstance(event_cost, (int, float)):
                    event_cost = event.get("total_cost_usd")
                if isinstance(event_cost, (int, float)):
                    saw_cost = True
                    cost_usd += float(event_cost)
                if model_name is None and isinstance(msg.get("model"), str):
                    model_name = msg.get("model")
        except OSError:
            return SessionTelemetry(path, None, None, None, None, None)

        final_in = tokens_in if saw_usage else None
        final_out = tokens_out if saw_usage else None
        final_cost = cost_usd if saw_cost else derive_cost(model_name, final_in, final_out)
        return SessionTelemetry(path, final_in, final_out, final_cost, model_name, None)

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
