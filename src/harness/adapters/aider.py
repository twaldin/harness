"""aider adapter — invokes `aider --message PROMPT`.

aider doesn't ship structured output. Its log line `Tokens: N sent, M received`
is the canonical token source. We scrape it from stdout/stderr.

Aider ALSO uses `.aider.conf.yml` for config; agentelo's --instructions flag
writes the user instructions to that file. We mirror that — but be aware:
aider treats this as YAML config, not free-form prompt text. Consumers that
want to inject system-style instructions to aider should put them inline
(in `prompt`) rather than via `instructions`.
"""
from __future__ import annotations

import re

from harness._subproc import run_subprocess, write_instructions
from harness.base import Adapter, RunResult, RunSpec


class AiderAdapter(Adapter):
    name = "aider"
    instructions_filename = ".aider.conf.yml"

    DEFAULT_MODEL = "openrouter/anthropic/claude-sonnet-4.6"

    TOKEN_RE = re.compile(r"Tokens:\s+([\d,.]+k?)\s+sent,\s+([\d,.]+k?)\s+received", re.IGNORECASE)

    def run(self, spec: RunSpec) -> RunResult:
        model = spec.model or self.DEFAULT_MODEL
        write_instructions(spec.workdir, self.instructions_filename, spec.instructions)

        config_path = spec.workdir / ".agentelo-aider.yml"
        # Empty config → aider uses pure CLI flags. Keeps state isolated.
        config_path.write_text("{}\n", encoding="utf-8")

        cmd = [
            "aider",
            "--config",
            str(config_path),
            "--no-restore-chat-history",
            "--chat-history-file",
            str(spec.workdir / ".agentelo-aider-chat.history.md"),
            "--input-history-file",
            str(spec.workdir / ".agentelo-aider-input.history"),
            "--model",
            model,
            "--message",
            spec.prompt,
            "--yes-always",
            "--no-auto-commits",
            "--no-analytics",
            "--no-show-model-warnings",
        ]
        outcome = run_subprocess(
            cmd,
            cwd=spec.workdir,
            timeout_seconds=spec.timeout_seconds,
            extra_env=spec.env,
        )

        tokens_in, tokens_out = _scrape_aider_tokens(outcome.stdout + "\n" + outcome.stderr, self.TOKEN_RE)

        return RunResult(
            harness=self.name,
            model=model,
            exit_code=outcome.exit_code,
            duration_seconds=outcome.duration_seconds,
            stdout=outcome.stdout,
            stderr=outcome.stderr,
            timed_out=outcome.timed_out,
            cost_usd=None,
            tokens_in=tokens_in,
            tokens_out=tokens_out,
            raw=None,
        )


def _scrape_aider_tokens(text: str, pattern: re.Pattern) -> tuple[int | None, int | None]:
    match = pattern.search(text)
    if not match:
        return None, None
    return _parse_aider_num(match.group(1)), _parse_aider_num(match.group(2))


def _parse_aider_num(s: str) -> int | None:
    s = s.replace(",", "").strip()
    if not s:
        return None
    try:
        if s.endswith("k"):
            return round(float(s[:-1]) * 1000)
        return int(float(s))
    except ValueError:
        return None
