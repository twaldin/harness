"""Shared subprocess runner — env merging, cwd, timeouts, stdin, streaming and timing.

Adapters call run_subprocess() instead of subprocess.run() directly so that
behavior (timeout enforcement, env merging, bounded capture, output
callbacks, process-group teardown) is consistent.
"""
from __future__ import annotations

import asyncio
import codecs
import concurrent.futures
import errno
import inspect
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

from harness.base import DEFAULT_MAX_OUTPUT_BYTES, OutputCallback, OutputStream, Termination, TimeoutKind

_READ_SIZE = 65536
_TICK = 0.02
_CALLBACK_INTERRUPTED = "on_output callback did not complete before teardown finished"


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
    #: Raw bytes the child wrote per stream, including bytes beyond the capture cap.
    stdout_bytes: int = 0
    stderr_bytes: int = 0
    #: Capture cap exceeded, or output lost when a still-open pipe was force-closed.
    stdout_truncated: bool = False
    stderr_truncated: bool = False
    #: `on_output` raised (termination "callback-error" while the leader was
    #: alive) or was still pending when teardown finished.
    callback_error: str | None = None
    #: Which timeout fired; only set with termination "timed-out".
    timeout_kind: TimeoutKind | None = None


# ── validation (shared with Adapter.validate_run_spec) ──────────────────────


def _number(name: str, value: object, *, minimum: float, exclusive: bool) -> None:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f"{name} must be None or a finite number")
    if value < minimum or (exclusive and value == minimum):
        bound = "positive" if exclusive else "non-negative"
        raise ValueError(f"{name} must be {bound}, got {value!r}")


def validate_io_options(
    *,
    timeout_seconds: float | None,
    inactivity_timeout_seconds: float | None,
    max_output_bytes: int,
    stdin: str | None,
    on_output: OutputCallback | None,
) -> None:
    """Reject invalid run I/O options with ValueError / TypeError.

    The single rule set for the low-level runners and `RunSpec` validation
    (which re-raises as `HarnessError("invalid-options")`).
    """
    if timeout_seconds is not None:
        _number("timeout_seconds", timeout_seconds, minimum=0, exclusive=False)
    if inactivity_timeout_seconds is not None:
        _number("inactivity_timeout_seconds", inactivity_timeout_seconds, minimum=0, exclusive=True)
    if isinstance(max_output_bytes, bool) or not isinstance(max_output_bytes, int) or not 0 <= max_output_bytes <= 9007199254740991:
        raise ValueError(f"max_output_bytes must be a non-negative safe integer, got {max_output_bytes!r}")
    if stdin is not None and not isinstance(stdin, str):
        raise TypeError(f"stdin must be None or str, got {type(stdin).__name__}")
    if on_output is not None and not callable(on_output):
        raise TypeError(f"on_output must be callable, got {type(on_output).__name__}")


def require_sync_callback(on_output: OutputCallback | None) -> None:
    """Blocking entry points cannot await: refuse `async def` callbacks before launch."""
    if on_output is None:
        return
    if inspect.iscoroutinefunction(on_output) or inspect.iscoroutinefunction(getattr(on_output, "__call__", None)):
        raise ValueError("on_output is an async callable; run_subprocess/run cannot await it, use run_subprocess_async/run_async")


def _describe(exc: BaseException) -> str:
    return f"{type(exc).__name__}: {exc}"


def _check_return(result: object) -> None:
    if result is not None:
        raise TypeError(f"on_output must return None, got {type(result).__name__}")


# ── callback sinks ──────────────────────────────────────────────────────────


class _Sink:
    """No callback: capture only."""

    enabled = False
    pending = False
    error: str | None = None

    def submit(self, text: str, stream: OutputStream) -> None:
        raise AssertionError("submit on a disabled sink")

    def wait(self, timeout: float) -> None:
        pass

    def abandon(self) -> None:
        pass


class _SyncSink(_Sink):
    """Runs the callback inline on the reading thread. Never pending."""

    def __init__(self, callback: OutputCallback) -> None:
        self.callback = callback
        self.enabled = True

    def submit(self, text: str, stream: OutputStream) -> None:
        try:
            result = self.callback(text, stream)
            if inspect.isawaitable(result):
                if inspect.iscoroutine(result):
                    result.close()
                raise TypeError("on_output returned an awaitable; run_subprocess/run cannot await it, use run_async")
            _check_return(result)
        except Exception as exc:
            self.error = _describe(exc)
            self.enabled = False


class _LoopSink(_Sink):
    """Runs the callback on the caller's event loop, one invocation outstanding.

    The reading thread submits and polls with bounded waits so lifecycle
    timers and cancellation keep running while the consumer backpressures.
    """

    def __init__(self, callback: OutputCallback, loop: asyncio.AbstractEventLoop) -> None:
        self.callback = callback
        self.loop = loop
        self.enabled = True
        self.future: concurrent.futures.Future[None] | None = None

    @property
    def pending(self) -> bool:  # type: ignore[override]
        # Completed futures still own delivery until wait() collects their result.
        return self.future is not None

    async def _invoke(self, text: str, stream: OutputStream) -> None:
        result = self.callback(text, stream)
        if inspect.isawaitable(result):
            await result
        else:
            _check_return(result)

    def submit(self, text: str, stream: OutputStream) -> None:
        assert self.future is None
        try:
            self.future = asyncio.run_coroutine_threadsafe(self._invoke(text, stream), self.loop)
        except RuntimeError as exc:  # loop closed underneath the run
            self.error = _describe(exc)
            self.enabled = False

    def _collect(self, future: concurrent.futures.Future[None]) -> None:
        self.future = None
        if future.cancelled():
            self.error = self.error or _CALLBACK_INTERRUPTED
            self.enabled = False
            return
        exc = future.exception()
        if exc is not None:
            self.error = _describe(exc)
            self.enabled = False

    def wait(self, timeout: float) -> None:
        future = self.future
        if future is None:
            return
        concurrent.futures.wait((future,), timeout=max(timeout, 0))
        if future.done():
            self._collect(future)

    def abandon(self) -> None:
        """Teardown finished: stop waiting; cancel the loop-side task and record the gap."""
        future = self.future
        if future is None:
            return
        # Chained to the loop task, so cancelling here cancels the coroutine;
        # a late rejection is consumed by the chain, never left unretrieved.
        future.cancel()
        self._collect(future)


# ── stream bookkeeping ──────────────────────────────────────────────────────


class _Reader:
    """One output pipe: bounded capture plus an independent streaming decoder."""

    def __init__(self, name: OutputStream, cap: int) -> None:
        self.name = name
        self.cap = cap
        self.total = 0
        self.captured = 0
        self.cap_hit = False
        self.truncated = False
        self.eof = False
        self._capture = codecs.getincrementaldecoder("utf-8")("replace")
        self._stream = codecs.getincrementaldecoder("utf-8")("replace")
        self._parts: list[str] = []

    def feed(self, chunk: bytes, streaming: bool) -> str:
        """Record `chunk`; return the decoded text to stream (empty when not streaming)."""
        self.total += len(chunk)
        room = self.cap - self.captured
        if room >= len(chunk):
            self._parts.append(self._capture.decode(chunk))
            self.captured += len(chunk)
        else:
            if room > 0:
                self._parts.append(self._capture.decode(chunk[:room]))
                self.captured = self.cap
            self.cap_hit = self.truncated = True
        return self._stream.decode(chunk) if streaming else ""

    def finish(self, streaming: bool) -> str:
        self.eof = True
        return self._stream.decode(b"", final=True) if streaming else ""

    def text(self) -> str:
        # A cap cut mid-sequence drops the partial code point instead of
        # manufacturing U+FFFD; a real EOF/forced closure keeps replacement.
        if not self.cap_hit:
            self._parts.append(self._capture.decode(b"", final=True))
        return "".join(self._parts)


class _Writer:
    """Feeds the stdin payload without blocking; EPIPE simply ends the feed."""

    def __init__(self, payload: bytes) -> None:
        self.view = memoryview(payload)
        self.offset = 0

    def write(self, fd: int) -> bool:
        """Write what the pipe accepts; True once everything is written or the reader is gone."""
        try:
            self.offset += os.write(fd, self.view[self.offset : self.offset + _READ_SIZE])
        except BlockingIOError:
            return False
        except BrokenPipeError:
            return True
        return self.offset >= len(self.view)


# ── entry points ────────────────────────────────────────────────────────────


def run_subprocess(
    cmd: list[str],
    *,
    cwd: Path | str,
    timeout_seconds: float | None,
    extra_env: dict[str, str] | None = None,
    stdin_close: bool = True,
    stdin: str | None = None,
    on_output: OutputCallback | None = None,
    inactivity_timeout_seconds: float | None = None,
    max_output_bytes: int = DEFAULT_MAX_OUTPUT_BYTES,
    cancel: Event | None = None,
) -> SubprocOutcome:
    """Run in an owned POSIX group; stop leftovers before returning.

    Cancellation via Event returns an outcome. KeyboardInterrupt propagates
    after the same bounded cleanup. Capture is UTF-8 with replacement,
    bounded per stream by `max_output_bytes`. `stdin` text is written then
    closed (None/"" closes immediately); `stdin_close=False` inherits the
    parent's stdin and cannot be combined with `stdin`.

    `on_output` must be a synchronous callable returning None; it runs on
    this thread between reads, so a slow callback delays capture and
    lifecycle checks. Async callbacks are rejected before launch.
    """
    validate_io_options(
        timeout_seconds=timeout_seconds, inactivity_timeout_seconds=inactivity_timeout_seconds,
        max_output_bytes=max_output_bytes, stdin=stdin, on_output=on_output,
    )
    require_sync_callback(on_output)
    return _run_subprocess(
        cmd, cwd, timeout_seconds=timeout_seconds, extra_env=extra_env, stdin=stdin, stdin_close=stdin_close,
        sink=_SyncSink(on_output) if on_output is not None else _Sink(),
        inactivity_timeout_seconds=inactivity_timeout_seconds, max_output_bytes=max_output_bytes,
        cancel=cancel, interrupted=None,
    )


async def run_subprocess_async(
    cmd: list[str],
    *,
    cwd: Path | str,
    timeout_seconds: float | None,
    extra_env: dict[str, str] | None = None,
    stdin: str | None = None,
    on_output: OutputCallback | None = None,
    inactivity_timeout_seconds: float | None = None,
    max_output_bytes: int = DEFAULT_MAX_OUTPUT_BYTES,
    cancel: Event | None = None,
) -> SubprocOutcome:
    """Use the same ownership engine without blocking the event loop.

    `on_output` (sync or async) runs on this event loop, one invocation at a
    time; reading pauses while an async callback is awaited. Shielding the
    worker preserves its process handle even when cancellation arrives during
    Popen. Repeated Task.cancel calls cannot abandon cleanup.
    """
    validate_io_options(
        timeout_seconds=timeout_seconds, inactivity_timeout_seconds=inactivity_timeout_seconds,
        max_output_bytes=max_output_bytes, stdin=stdin, on_output=on_output,
    )
    sink: _Sink = _LoopSink(on_output, asyncio.get_running_loop()) if on_output is not None else _Sink()
    interrupted = Event()
    worker = asyncio.create_task(asyncio.to_thread(
        _run_subprocess, cmd, cwd, timeout_seconds=timeout_seconds, extra_env=extra_env, stdin=stdin,
        stdin_close=True, sink=sink, inactivity_timeout_seconds=inactivity_timeout_seconds,
        max_output_bytes=max_output_bytes, cancel=cancel, interrupted=interrupted,
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


# ── engine ──────────────────────────────────────────────────────────────────


def _run_subprocess(
    cmd: list[str],
    cwd: Path | str,
    *,
    timeout_seconds: float | None,
    extra_env: dict[str, str] | None,
    stdin: str | None,
    stdin_close: bool,
    sink: _Sink,
    inactivity_timeout_seconds: float | None,
    max_output_bytes: int,
    cancel: Event | None,
    interrupted: Event | None,
) -> SubprocOutcome:
    if sys.platform not in ("darwin", "linux"):
        raise NotImplementedError("Owned subprocess groups require macOS or Linux")
    # I/O options were validated by the public entry point.
    if stdin is not None and not stdin_close:
        raise ValueError("stdin conflicts with stdin_close=False; pass one of them")
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
    payload = stdin.encode("utf-8") if stdin else b""
    try:
        proc = subprocess.Popen(
            cmd, cwd=str(cwd), env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            stdin=subprocess.PIPE if payload else (subprocess.DEVNULL if stdin_close else None),
            start_new_session=True,
        )
    except OSError as exc:
        return SubprocOutcome(
            -1, time.monotonic() - started, "", "", False, "launch-failed",
            launch_error=errno.errorcode.get(exc.errno, "UNKNOWN"),
        )

    readers = (_Reader("stdout", max_output_bytes), _Reader("stderr", max_output_bytes))
    termination: Termination = "exited"
    timeout_kind: TimeoutKind | None = None
    last_activity = started
    paused_since: float | None = None
    selector = selectors.DefaultSelector()
    group_error: PermissionError | None = None

    def close_stdin() -> None:
        if proc.stdin is not None and not proc.stdin.closed:
            if proc.stdin.fileno() in selector.get_map():
                selector.unregister(proc.stdin)
            proc.stdin.close()

    def pump(wait: float) -> None:
        """One selector pass. Stops early once a callback is outstanding."""
        nonlocal last_activity
        for key, _ in selector.select(wait):
            data = key.data
            if isinstance(data, _Writer):
                if data.write(key.fd):
                    close_stdin()
                continue
            try:
                chunk = os.read(key.fd, _READ_SIZE)
            except BlockingIOError:
                continue
            if chunk:
                last_activity = time.monotonic()
                text = data.feed(chunk, sink.enabled)
            else:
                selector.unregister(key.fileobj)
                text = data.finish(sink.enabled)
            if text:
                sink.submit(text, data.name)
                if sink.pending:
                    return

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

    def force_close() -> None:
        """Pipes still open at the drain deadline: capture what the kernel
        buffered (no callbacks); a stream that is not at EOF loses the rest."""
        for key in list(selector.get_map().values()):
            reader = key.data
            for _ in range(16):
                try:
                    chunk = os.read(key.fd, _READ_SIZE)
                except OSError:
                    reader.truncated = True
                    break
                if not chunk:
                    break
                reader.feed(chunk, False)
            else:
                reader.truncated = True

    def cleanup() -> None:
        # Keep the group ID even after the leader exits: descendants may still
        # own pipes or keep working without any inherited pipe. Callbacks keep
        # flowing for whatever drains within the budget; capture continues
        # regardless.
        stdin_error: Exception | None = None
        try:
            close_stdin()
        except Exception as exc:
            # A local descriptor error must not bypass group escalation/reaping.
            stdin_error = exc
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
            if not group_exists and proc.returncode is not None and not selector.get_map() and not sink.pending:
                break
            if now >= drain_end:
                break
            if sink.pending:
                sink.wait(min(_TICK, drain_end - now))
            else:
                pump(min(_TICK, drain_end - now))
            group_exists = signal_group(0)
        sink.abandon()
        # Pipes can be held by a deliberately detached process outside our
        # group. Closing our endpoints is bounded; waiting for its EOF isn't.
        force_close()
        if proc.returncode is None:
            # Preserve TimeoutExpired if the leader cannot be reaped within
            # the existing budget; never manufacture a completed outcome.
            proc.wait(timeout=max(0, drain_end - time.monotonic()))
        if group_error is not None:
            raise group_error
        if stdin_error is not None:
            raise stdin_error

    try:
        try:
            assert proc.stdout is not None and proc.stderr is not None
            for stream, reader in ((proc.stdout, readers[0]), (proc.stderr, readers[1])):
                os.set_blocking(stream.fileno(), False)
                selector.register(stream, selectors.EVENT_READ, reader)
            if proc.stdin is not None:
                os.set_blocking(proc.stdin.fileno(), False)
                selector.register(proc.stdin, selectors.EVENT_WRITE, _Writer(payload))
            wall_deadline = None if timeout_seconds is None else started + timeout_seconds
            while True:
                if proc.poll() is not None:
                    termination = "signaled" if proc.returncode < 0 else "exited"
                    break
                if sink.error is not None:
                    termination = "callback-error"
                    break
                if cancelled():
                    termination = "cancelled"
                    break
                now = time.monotonic()
                wait = _TICK
                if wall_deadline is not None:
                    remaining = wall_deadline - now
                    if remaining <= 0:
                        termination, timeout_kind = "timed-out", "wall"
                        break
                    wait = min(wait, remaining)
                if sink.pending:
                    # Backpressure: no reads, inactivity suspended, wall clock and cancellation live.
                    if paused_since is None:
                        paused_since = now
                    sink.wait(wait)
                    continue
                if paused_since is not None:
                    last_activity += now - paused_since
                    paused_since = None
                if inactivity_timeout_seconds is not None:
                    remaining = last_activity + inactivity_timeout_seconds - now
                    if remaining <= 0:
                        termination, timeout_kind = "timed-out", "inactivity"
                        break
                    wait = min(wait, remaining)
                pump(wait)
        finally:
            cleanup()
    finally:
        selector.close()
        for stream in (proc.stdin, proc.stdout, proc.stderr):
            if stream is not None:
                stream.close()
    returncode = proc.returncode
    assert returncode is not None
    signal_name = None
    if returncode < 0:
        try:
            signal_name = signal.Signals(-returncode).name
        except ValueError:
            signal_name = f"SIG{-returncode}"
    stdout, stderr = readers
    return SubprocOutcome(
        exit_code=-1 if termination in ("timed-out", "cancelled", "callback-error") else returncode,
        duration_seconds=time.monotonic() - started,
        stdout=stdout.text(),
        stderr=stderr.text(),
        timed_out=termination == "timed-out",
        termination=termination,
        signal=signal_name,
        stdout_bytes=stdout.total,
        stderr_bytes=stderr.total,
        stdout_truncated=stdout.truncated,
        stderr_truncated=stderr.truncated,
        callback_error=sink.error,
        timeout_kind=timeout_kind,
    )
