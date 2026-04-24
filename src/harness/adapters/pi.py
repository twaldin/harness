"""pi adapter — invokes the `pi` CLI from @mariozechner/pi-coding-agent.

pi's `--mode json` emits an event stream on stdout, one JSON object per line:
  - first line: `{"type":"session","version":...,"cwd":...}`
  - then: agent/turn/message events
  - `agent_end` carries the full `messages` array with per-message `usage`

Each AssistantMessage has:
    usage: {
        input, output, cacheRead, cacheWrite, totalTokens,
        cost: { input, output, cacheRead, cacheWrite, total }
    }

We sum usage across assistant messages in the `agent_end` event and report
aggregate tokens + cost. See
https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/json.md
"""
from __future__ import annotations

import json

from harness._subproc import SubprocOutcome, run_subprocess, write_instructions
from harness.base import Adapter, BuildCommand, RunResult, RunSpec
from harness.model_normalization import normalize_model_for_harness


class PiAdapter(Adapter):
    name = "pi"
    instructions_filename = "AGENTS.md"

    DEFAULT_MODEL = "sonnet"

    def build_command(self, spec: RunSpec) -> BuildCommand:
        model = normalize_model_for_harness(self.name, spec.model or self.DEFAULT_MODEL, resolve=not spec.model_no_resolve)
        instructions_file = write_instructions(spec.workdir, self.instructions_filename, spec.instructions)
        args = ["--mode", "json", "--no-session", "--model", model, spec.prompt]
        return BuildCommand(cmd="pi", args=args, cwd=spec.workdir, env={}, instructions_file=instructions_file)

    def parse_output(self, spec: RunSpec, outcome: SubprocOutcome) -> dict:
        tokens_in, tokens_out, cost, raw = _parse_pi_events(outcome.stdout)
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


def _parse_pi_events(stdout: str) -> tuple[int | None, int | None, float | None, list | None]:
    """Walk the JSON event stream and sum assistant-message usage.

    Prefers the `agent_end` event's full `messages` array (authoritative final
    state). Falls back to summing per-`turn_end` assistant messages if
    `agent_end` is absent (e.g., truncated / timed-out output).
    """
    events: list = []
    for line in stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(ev, dict):
            events.append(ev)

    if not events:
        return None, None, None, None

    # Preferred: agent_end.messages
    for ev in reversed(events):
        if ev.get("type") == "agent_end":
            tokens_in, tokens_out, cost = _sum_assistant_usage(ev.get("messages") or [])
            return tokens_in, tokens_out, cost, events

    # Fallback: sum usage from each turn_end's assistant message
    tokens_in = tokens_out = 0
    cost = 0.0
    any_assistant = False
    for ev in events:
        if ev.get("type") != "turn_end":
            continue
        msg = ev.get("message") or {}
        if msg.get("role") != "assistant":
            continue
        usage = msg.get("usage") or {}
        tokens_in += int(usage.get("input") or 0)
        tokens_out += int(usage.get("output") or 0)
        cost_obj = usage.get("cost") or {}
        cost += float(cost_obj.get("total") or 0.0)
        any_assistant = True

    if not any_assistant:
        return None, None, None, events
    return tokens_in, tokens_out, cost, events


def _sum_assistant_usage(messages: list) -> tuple[int, int, float]:
    tokens_in = tokens_out = 0
    cost = 0.0
    for msg in messages:
        if not isinstance(msg, dict) or msg.get("role") != "assistant":
            continue
        usage = msg.get("usage") or {}
        tokens_in += int(usage.get("input") or 0)
        tokens_out += int(usage.get("output") or 0)
        cost_obj = usage.get("cost") or {}
        cost += float(cost_obj.get("total") or 0.0)
    return tokens_in, tokens_out, cost
