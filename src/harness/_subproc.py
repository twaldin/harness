"""Shared subprocess runner — handles env merging, cwd, timeout, and timing.

Adapters call run_subprocess() instead of subprocess.run() directly so that
behavior (timeout enforcement, env merging, output capture) is consistent.
"""
from __future__ import annotations

import asyncio
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


@dataclass
class InstructionProjection:
    workdir: Path
    filename: str
    file_path: Path
    existed_before: bool
    backup_path: Path


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


async def run_subprocess_async(
    cmd: list[str],
    *,
    cwd: Path | str,
    timeout_seconds: int,
    extra_env: dict[str, str] | None = None,
) -> SubprocOutcome:
    """Async variant of run_subprocess using asyncio.create_subprocess_exec.

    Never raises on non-zero exit. On timeout, kills the process and returns timed_out=True.
    """
    env = os.environ.copy()
    if extra_env:
        env.update(extra_env)

    started = time.monotonic()
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        cwd=str(cwd),
        env=env,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        stdin=subprocess.DEVNULL,
    )

    try:
        stdout_bytes, stderr_bytes = await asyncio.wait_for(
            proc.communicate(), timeout=float(timeout_seconds)
        )
    except asyncio.TimeoutError:
        proc.kill()
        stdout_bytes, stderr_bytes = await proc.communicate()
        return SubprocOutcome(
            exit_code=-1,
            duration_seconds=time.monotonic() - started,
            stdout=stdout_bytes.decode("utf-8", "replace"),
            stderr=stderr_bytes.decode("utf-8", "replace"),
            timed_out=True,
        )

    return SubprocOutcome(
        exit_code=proc.returncode if proc.returncode is not None else -1,
        duration_seconds=time.monotonic() - started,
        stdout=stdout_bytes.decode("utf-8", "replace"),
        stderr=stderr_bytes.decode("utf-8", "replace"),
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
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return path


def project_instructions(
    workdir: Path,
    filename: str,
    content: str,
    *,
    mode: str = "replace",
    backup: bool = True,
) -> InstructionProjection:
    """Project instructions into a file, preserving enough metadata to restore.

    mode:
      - "replace": overwrite existing file content
      - "prepend": prepend with a blank line separator
    """
    workdir = Path(workdir)
    file_path = workdir / filename
    backup_path = workdir / f".harness-backup-{filename}"
    existed_before = file_path.exists()

    file_path.parent.mkdir(parents=True, exist_ok=True)

    if existed_before:
        existing = file_path.read_text(encoding="utf-8")
        if backup:
            backup_path.parent.mkdir(parents=True, exist_ok=True)
            backup_path.write_text(existing, encoding="utf-8")
        if mode == "prepend":
            file_path.write_text(f"{content}\n\n{existing}", encoding="utf-8")
        else:
            file_path.write_text(f"{content}\n", encoding="utf-8")
    else:
        file_path.write_text(f"{content}\n", encoding="utf-8")

    return InstructionProjection(
        workdir=workdir,
        filename=filename,
        file_path=file_path,
        existed_before=existed_before,
        backup_path=backup_path,
    )


def restore_projected_instructions(projection: InstructionProjection) -> None:
    """Undo project_instructions using returned projection metadata."""
    if projection.backup_path.exists():
        projection.file_path.parent.mkdir(parents=True, exist_ok=True)
        projection.file_path.write_text(projection.backup_path.read_text(encoding="utf-8"), encoding="utf-8")
        try:
            projection.backup_path.unlink()
        except OSError:
            pass
        return

    if not projection.existed_before and projection.file_path.exists():
        try:
            projection.file_path.unlink()
        except OSError:
            return
        _prune_empty_parents(projection.file_path.parent, projection.workdir)


def _prune_empty_parents(current: Path, root: Path) -> None:
    while current != root:
        try:
            if any(current.iterdir()):
                return
            current.rmdir()
            current = current.parent
        except OSError:
            return
