"""Shared utilities for session-aware adapter helpers (mirror of ts/src/util.ts)."""
from __future__ import annotations

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
