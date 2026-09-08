"""aider adapter — invokes `aider --message PROMPT`.

aider doesn't ship structured output. Its log line `Tokens: N sent, M received`
is the canonical token source. We scrape it from stdout/stderr.

`instructions` are treated as text: they are projected to
`<workdir>/.harness-aider-instructions.md` and passed with `--read` so aider
loads them as a read-only chat file. aider's own config (`.aider.conf.yml`,
`~/.aider.conf.yml`) is left to upstream unless `RunSpec.config_file` selects
one explicitly (`--config`). Chat/input history is sent to the null device.
"""
from __future__ import annotations

import os
import re

from harness._subproc import SubprocOutcome
from harness.base import Adapter, BuildCommand, ParsedOutput, RunSpec


class AiderAdapter(Adapter):
    name = "aider"
    instructions_filename = ".harness-aider-instructions.md"
    permission_bypass_args = ("--yes-always",)
    config_file_flag = "--config"

    DEFAULT_MODEL = "openrouter/anthropic/claude-sonnet-4.6"

    TOKEN_RE = re.compile(r"Tokens:\s+([\d,.]+k?)\s+sent,\s+([\d,.]+k?)\s+received", re.IGNORECASE)

    def build_command(self, spec: RunSpec) -> BuildCommand:
        resolved = self.resolve_run_spec(spec)
        instructions_file = self.planned_instructions_file(spec)
        args = [
            *resolved.config_args,
            *(("--read", str(instructions_file)) if instructions_file is not None else ()),
            "--no-restore-chat-history",
            "--chat-history-file", os.devnull,
            "--input-history-file", os.devnull,
            "--model", resolved.model,
            "--message", spec.prompt,
            *resolved.permission_args,
            "--no-auto-commits",
            "--no-analytics",
            "--no-show-model-warnings",
        ]
        return self.finalize_command(spec, cmd="aider", args=args)

    def parse_output(self, spec: RunSpec, outcome: SubprocOutcome) -> ParsedOutput:
        tokens_in, tokens_out = _scrape_aider_tokens(outcome.stdout + "\n" + outcome.stderr, self.TOKEN_RE)
        return {"cost_usd": None, "tokens_in": tokens_in, "tokens_out": tokens_out, "raw": None}


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
