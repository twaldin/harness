"""OpenClaude adapter — invokes `openclaude` (`claude`) in print JSON mode."""
from __future__ import annotations

import json
from pathlib import Path

from harness._subproc import SubprocOutcome, write_instructions
from harness.base import Adapter, BuildCommand, RunSpec, SessionTelemetry
from harness.model_normalization import normalize_model_for_harness
from harness.pricing import derive_cost


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

    def session_log_path(self, workdir: Path, session_started_after: float | None = None) -> str | None:
        try:
            real = workdir.resolve()
        except OSError:
            real = workdir
        encoded = str(real).replace("/", "-").replace("_", "-")
        d = Path.home() / ".claude" / "projects" / encoded
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
