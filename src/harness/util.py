"""Shared utilities for adapter helpers (mirror of ts/src/util.ts)."""
from __future__ import annotations

import json
import re

_ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")


def strip_ansi(s: str) -> str:
    return _ANSI_RE.sub("", s)


def last_lines(s: str, n: int) -> list[str]:
    """Last `n` lines of the ANSI-stripped text, right-trimmed. `n == 0` returns every line."""
    return [line.rstrip() for line in strip_ansi(s).split("\n")][-n:]


def last_non_empty_join(s: str, n: int) -> str:
    """Last `n` non-blank lines of the ANSI-stripped text, trimmed and newline-joined."""
    lines = [line for line in (line.strip() for line in strip_ansi(s).split("\n")) if line]
    return "\n".join(lines[-n:])


def _reject_constant(value: str) -> None:
    raise ValueError(f"non-JSON constant: {value}")


def json_object_events(stdout: str) -> list[dict] | None:
    """Every complete JSON object line, in order; malformed, truncated and
    non-object lines are skipped. A final line without a newline still counts."""
    events: list[dict] = []
    for line in stdout.split("\n"):
        line = line.strip()
        if not line:
            continue
        try:
            event = json.loads(line, parse_constant=_reject_constant)
        except (ValueError, RecursionError):
            continue
        if isinstance(event, dict):
            events.append(event)
    return events or None
