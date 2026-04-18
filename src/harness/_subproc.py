"""Shared subprocess runner — handles env merging, cwd, timeout, and timing.

Adapters call run_subprocess() instead of subprocess.run() directly so that
behavior (timeout enforcement, env merging, output capture) is consistent.
"""
from __future__ import annotations

import os
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path


@dataclass
class SubprocOutcome:
    exit_code: int
    duration_seconds: float
    stdout: str
    stderr: str
    timed_out: bool


def run_subprocess(
    cmd: list[str],
    *,
    cwd: Path | str,
    timeout_seconds: int,
    extra_env: dict[str, str] | None = None,
    stdin_close: bool = True,
) -> SubprocOutcome:
    """Run cmd, return outcome. Never raises on non-zero exit.

    On timeout, kills the process group and returns timed_out=True.
    """
    env = os.environ.copy()
    if extra_env:
        env.update(extra_env)

    started = time.monotonic()
    try:
        proc = subprocess.run(  # noqa: S603 — cmd is constructed by adapter
            cmd,
            cwd=str(cwd),
            env=env,
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
            check=False,
            stdin=subprocess.DEVNULL if stdin_close else None,
        )
    except subprocess.TimeoutExpired as e:
        return SubprocOutcome(
            exit_code=-1,
            duration_seconds=time.monotonic() - started,
            stdout=(e.stdout.decode("utf-8", "replace") if isinstance(e.stdout, bytes) else (e.stdout or "")),
            stderr=(e.stderr.decode("utf-8", "replace") if isinstance(e.stderr, bytes) else (e.stderr or "")),
            timed_out=True,
        )

    return SubprocOutcome(
        exit_code=proc.returncode,
        duration_seconds=time.monotonic() - started,
        stdout=proc.stdout,
        stderr=proc.stderr,
        timed_out=False,
    )


def write_instructions(workdir: Path, filename: str, content: str | None) -> Path | None:
    """Write `content` to `workdir/filename`. Returns the path or None if no content.

    Idempotent — overwrites if exists. Adapter is responsible for choosing filename.
    """
    if content is None:
        return None
    workdir = Path(workdir)
    workdir.mkdir(parents=True, exist_ok=True)
    path = workdir / filename
    path.write_text(content, encoding="utf-8")
    return path
