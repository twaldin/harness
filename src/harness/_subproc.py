"""Shared subprocess runner — handles env merging, cwd, timeout, and timing.

Adapters call run_subprocess() instead of subprocess.run() directly so that
behavior (timeout enforcement, env merging, output capture) is consistent.
"""
from __future__ import annotations

import asyncio
import errno
import math
import os
import selectors
import signal
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from threading import Event

from harness.base import Termination


@dataclass
class SubprocOutcome:
    exit_code: int
    duration_seconds: float
    stdout: str
    stderr: str
    timed_out: bool
    termination: Termination | None = None
    signal: str | None = None
    launch_error: str | None = None


def run_subprocess(
    cmd: list[str],
    *,
    cwd: Path | str,
    timeout_seconds: float,
    extra_env: dict[str, str] | None = None,
    stdin_close: bool = True,
    cancel: Event | None = None,
) -> SubprocOutcome:
    """Run in an owned POSIX group; stop leftovers before returning.

    Cancellation via Event returns an outcome. KeyboardInterrupt propagates
    after the same bounded cleanup. Output is UTF-8 with replacement.
    """
    return _run_subprocess(cmd, cwd, timeout_seconds, extra_env, stdin_close, cancel, None)


def _run_subprocess(
    cmd: list[str],
    cwd: Path | str,
    timeout_seconds: float,
    extra_env: dict[str, str] | None,
    stdin_close: bool,
    cancel: Event | None,
    interrupted: Event | None,
) -> SubprocOutcome:
    if sys.platform not in ("darwin", "linux"):
        raise NotImplementedError("Owned subprocess groups require macOS or Linux")
    if not math.isfinite(timeout_seconds) or timeout_seconds < 0:
        raise ValueError("timeout_seconds must be finite and non-negative")
    if not cmd:
        raise ValueError("cmd must not be empty")
    started = time.monotonic()

    def cancelled() -> bool:
        return (cancel is not None and cancel.is_set()) or (
            interrupted is not None and interrupted.is_set()
        )

    if cancelled():
        return SubprocOutcome(-1, 0, "", "", False, "cancelled")
    env = os.environ.copy()
    if extra_env:
        env.update(extra_env)
    try:
        proc = subprocess.Popen(
            cmd, cwd=str(cwd), env=env, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, stdin=subprocess.DEVNULL if stdin_close else None,
            start_new_session=True,
        )
    except OSError as exc:
        return SubprocOutcome(
            -1, time.monotonic() - started, "", "", False, "launch-failed",
            launch_error=errno.errorcode.get(exc.errno, "UNKNOWN"),
        )

    stdout = bytearray()
    stderr = bytearray()
    termination: Termination = "exited"
    selector = selectors.DefaultSelector()
    group_error: PermissionError | None = None

    def pump(wait: float) -> None:
        for key, _ in selector.select(wait):
            try:
                chunk = os.read(key.fd, 65536)
            except BlockingIOError:
                continue
            if chunk:
                key.data.extend(chunk)
            else:
                selector.unregister(key.fileobj)

    def signal_group(sig: int) -> bool:
        nonlocal group_error
        # macOS can return EPERM during exit before waitpid reports a
        # waitable zombie. Retry on later cleanup ticks, never call it gone.
        proc.poll()
        try:
            os.killpg(proc.pid, sig)
            group_error = None
            return True
        except ProcessLookupError:
            group_error = None
            return False
        except PermissionError as exc:
            group_error = exc
            return True

    def cleanup() -> None:
        # Keep the group ID even after the leader exits: descendants may still
        # own pipes or keep working without any inherited pipe.
        group_exists = signal_group(signal.SIGTERM)
        grace_end = time.monotonic() + 0.5
        drain_end = grace_end + 1.0
        escalated = False
        while True:
            now = time.monotonic()
            if group_exists and not escalated and now >= grace_end:
                group_exists = signal_group(signal.SIGKILL)
                escalated = group_error is None
            proc.poll()
            if not group_exists and proc.returncode is not None and not selector.get_map():
                break
            if now >= drain_end:
                break
            pump(min(0.02, drain_end - now))
            group_exists = signal_group(0)
        # Pipes can be held by a deliberately detached process outside our
        # group. Closing our endpoints is bounded; waiting for its EOF isn't.
        if proc.returncode is None:
            # Preserve TimeoutExpired if the leader cannot be reaped within
            # the existing budget; never manufacture a completed outcome.
            proc.wait(timeout=max(0, drain_end - time.monotonic()))
        if group_error is not None:
            raise group_error

    try:
        try:
            assert proc.stdout is not None and proc.stderr is not None
            for stream, buffer in ((proc.stdout, stdout), (proc.stderr, stderr)):
                os.set_blocking(stream.fileno(), False)
                selector.register(stream, selectors.EVENT_READ, buffer)
            while True:
                if proc.poll() is not None:
                    termination = "signaled" if proc.returncode < 0 else "exited"
                    break
                if cancelled():
                    termination = "cancelled"
                    break
                remaining = started + timeout_seconds - time.monotonic()
                if remaining <= 0:
                    termination = "timed-out"
                    break
                pump(min(0.02, remaining))
        finally:
            cleanup()
    finally:
        selector.close()
        if proc.stdout is not None:
            proc.stdout.close()
        if proc.stderr is not None:
            proc.stderr.close()
    returncode = proc.returncode
    assert returncode is not None
    signal_name = None
    if returncode < 0:
        try:
            signal_name = signal.Signals(-returncode).name
        except ValueError:
            signal_name = f"SIG{-returncode}"
    return SubprocOutcome(
        exit_code=-1 if termination in ("timed-out", "cancelled") else returncode,
        duration_seconds=time.monotonic() - started,
        stdout=stdout.decode("utf-8", "replace"),
        stderr=stderr.decode("utf-8", "replace"),
        timed_out=termination == "timed-out",
        termination=termination,
        signal=signal_name,
    )


async def run_subprocess_async(
    cmd: list[str],
    *,
    cwd: Path | str,
    timeout_seconds: float,
    extra_env: dict[str, str] | None = None,
    cancel: Event | None = None,
) -> SubprocOutcome:
    """Use the same ownership engine without blocking the event loop.

    Shielding the worker preserves its process handle even when cancellation
    arrives during Popen. Repeated Task.cancel calls cannot abandon cleanup.
    """
    interrupted = Event()
    worker = asyncio.create_task(asyncio.to_thread(
        _run_subprocess, cmd, cwd, timeout_seconds, extra_env, True, cancel, interrupted,
    ))
    try:
        return await asyncio.shield(worker)
    except asyncio.CancelledError as cancelled_error:
        interrupted.set()
        try:
            while not worker.done():
                try:
                    await asyncio.shield(worker)
                except asyncio.CancelledError:
                    continue
            worker.result()
        except Exception as cleanup_error:
            raise cancelled_error from cleanup_error
        raise

