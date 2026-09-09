"""Amp live sessions through the pinned `@ampcode/sdk` worker.

One Amp thread per `LiveSession`, driven by finite Node workers: `open` runs
one worker that verifies the CLI version and creates (or verifies) the thread,
and every `start_turn` runs one more worker that sends a single prompt to the
same thread and streams the native events. Each worker is one owned POSIX
process group under the shared subprocess runner (`run_subprocess_async`),
which supplies bounded capture, cancellation, descendant cleanup and reaping;
nothing here supervises processes on its own.

Worker launch is `[spec.executable or "node", _amp_sdk.mjs]` with no CLI
arguments or secrets on argv. The single request is one JSON line on stdin:
`{operation, packageRoot, cliPath, executor, mode, effort?, visibility?,
settingsFile?, cwd, endpoint, sessionId, prompt?, maxBufferBytes}`. The
worker answers with strict JSONL envelopes on stdout:

- `{"type": "amp_open", "sessionId", "workdir", "endpoint"}` once the native
  identity is established (thread created / verified, local cwd verified);
- `{"type": "amp_event", "event": {...}}` for each unmodified native event;
- exactly one `{"type": "amp_done", "status", "raw", "error", "exitCode",
  "signal"}` carrying the native CLI's last result and exit metadata;
- `{"type": "amp_error", "code", "error"}` as the sole frame when a startup
  prerequisite (SDK import, CLI version, options) fails.

The worker itself exits 0 after `amp_done`; its stderr is captured by the
runner. A turn completes only after `amp_done` AND the worker's exit plus the
runner's owned cleanup, so `SessionTurnResult.exit_code` / `signal` are the
native CLI's (from `amp_done`), never the worker's. `interrupt` cancels the
current worker group; a turn whose `amp_done` was already observed keeps
that status, otherwise it settles `interrupted` and the session stays usable.
Per-turn timeouts, `close()` and any protocol violation invalidate the
session; the instruction lease taken at open is held until teardown.
"""
from __future__ import annotations

import asyncio
import json
import subprocess
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

from harness._instructions import PreparedCommand, cleanup_command, prepare_command
from harness._subproc import SubprocOutcome, run_subprocess_async
from harness.base import BuildCommand, ErrorCode, HarnessError, OutputStream
from harness.registry import _adapter_class
from harness.sessions import (
    MAX_FRAME_BYTES,
    LiveSession,
    SessionEvent,
    SessionReference,
    SessionSpec,
    SessionTurn,
    SessionTurnResult,
    SessionTurnStatus,
    _AMP_SESSION_ID,
    _amp_endpoint,
    _await_startup,
    _reject_constant,
    _same_dir,
    _TurnBase,
)

_WORKER = Path(__file__).with_name("_amp_sdk.mjs")
_DONE_STATUSES: tuple[SessionTurnStatus, ...] = ("completed", "agent-error", "protocol-error", "exited", "signaled")
_ERROR_CODES: tuple[ErrorCode, ...] = ("launch-failed", "invalid-options", "unsupported-capability")
#: Startup error code for a session failure status recorded during `open`.
_STARTUP_CODES: dict[SessionTurnStatus, ErrorCode] = {
    "closed": "session-closed",
    "disconnected": "launch-failed",
    "exited": "launch-failed",
    "signaled": "launch-failed",
    "agent-error": "launch-failed",
}
#: Session failure status for a worker `amp_error` code.
_ERROR_STATUS: dict[str, SessionTurnStatus] = {"launch-failed": "disconnected"}


@dataclass
class _Operation:
    """One finite worker run: `open`, or one turn."""

    kind: Literal["open", "turn"]
    turn: _AmpTurn | None
    finished: asyncio.Future[None]
    cancel: threading.Event = field(default_factory=threading.Event)
    buffer: str = ""
    opened: bool = False
    #: Set once a terminal envelope (`amp_done` / `amp_error`) arrived.
    done: dict[str, object] | None = None
    error: dict[str, object] | None = None
    outcome: SubprocOutcome | None = None
    runner_error: BaseException | None = None


@dataclass
class _AmpTurn(_TurnBase):
    op: _Operation | None = None
    init_timer: asyncio.TimerHandle | None = None
    abort_requested: bool = False
    #: Native CLI exit metadata and the worker's stderr for this turn.
    exit_code: int | None = None
    signal: str | None = None
    stderr: str = ""
    stderr_bytes: int = 0
    stderr_truncated: bool = False


class _AmpSession(LiveSession):
    """Amp thread driven by one worker process group per operation."""

    _active: _AmpTurn | None

    def __init__(self, spec: SessionSpec, prepared: PreparedCommand, endpoint: str) -> None:
        super().__init__(spec)
        assert spec.amp_sdk is not None
        self._prepared = prepared
        self._options = spec.amp_sdk
        self._endpoint = endpoint
        self._argv = [spec.executable or "node", str(_WORKER)]
        self._operation: _Operation | None = None
        self._runner_error: BaseException | None = None
        self._startup_code: ErrorCode = "protocol-error"

    # ---- backend hooks ----------------------------------------------------

    def _begin_turn(self, handle: SessionTurn, prompt: str) -> _AmpTurn:
        turn = _AmpTurn(handle=handle)
        op = _Operation("turn", turn, self._loop.create_future())
        turn.op = op
        self._operation = op
        turn.init_timer = self._loop.call_later(self._spec.request_timeout_seconds, self._on_init_timeout, turn)
        self._spawn(self._run(op, self._request("turn", prompt)))
        return turn

    async def _abort(self, turn: _TurnBase) -> None:
        """Cancel the turn's worker group; the runner terminates it and the
        turn settles once the outcome is in (idempotent, never blocks)."""
        assert isinstance(turn, _AmpTurn)
        if turn.abort_requested:
            return
        turn.abort_requested = True
        if turn.op is not None:
            turn.op.cancel.set()

    def _abandon(self) -> None:
        self._abandoned = True
        if self._operation is not None:
            self._fail("closed", None)

    def _finish(self, turn: _TurnBase, status: SessionTurnStatus, raw: dict[str, object] | None, error: str | None) -> None:
        """Exit metadata is the native CLI's from `amp_done` (independent
        `exit_code` / `signal`) and stderr is this turn's worker capture, so
        the result is assembled here rather than from the session-wide fields."""
        assert isinstance(turn, _AmpTurn)
        turn.finished = True
        if turn.timer is not None:
            turn.timer.cancel()
        if turn.init_timer is not None:
            turn.init_timer.cancel()
        result = SessionTurnResult(
            session_id=self.reference.session_id,
            turn_id=turn.handle.id,
            status=status,
            raw=raw,
            error=error,
            exit_code=turn.exit_code,
            signal=turn.signal,
            stderr=turn.stderr,
            stderr_bytes=turn.stderr_bytes,
            stderr_truncated=turn.stderr_truncated,
            events_truncated=turn.handle.events.truncated,
        )
        if not turn.handle._result.done():
            turn.handle._result.set_result(result)
        turn.handle.events._close()

    # ---- worker runs ------------------------------------------------------

    def _request(self, operation: str, prompt: str | None = None) -> str:
        options = self._options
        session_id = self._reference.session_id if self._reference is not None else (self._spec.resume.session_id if self._spec.resume is not None else None)
        request: dict[str, object] = {
            "operation": operation,
            "packageRoot": str(options.package_root),
            "cliPath": str(options.cli_path),
            "executor": options.executor,
            "mode": options.mode,
            "cwd": str(self._spec.workdir),
            "endpoint": self._endpoint,
            "sessionId": session_id,
            "maxBufferBytes": self._spec.max_buffer_bytes,
        }
        if options.effort is not None:
            request["effort"] = options.effort
        if options.visibility is not None and operation == "open":
            request["visibility"] = options.visibility
        if options.settings_file is not None:
            request["settingsFile"] = str(options.settings_file)
        if prompt is not None:
            request["prompt"] = prompt
        return json.dumps(request) + "\n"

    async def _run(self, op: _Operation, request: str) -> None:
        """One worker under the shared runner; the outcome (or its failure)
        settles the operation only after the runner's owned teardown."""
        try:
            op.outcome = await run_subprocess_async(
                self._argv,
                cwd=self._spec.workdir,
                timeout_seconds=self._spec.request_timeout_seconds if op.kind == "open" else None,
                extra_env=dict(self._spec.env),
                stdin=request,
                on_output=lambda text, stream: self._on_output(op, text, stream),
                max_output_bytes=self._spec.max_buffer_bytes,
                cancel=op.cancel,
            )
        except asyncio.CancelledError as exc:
            op.runner_error = exc
        except Exception as exc:
            op.runner_error = exc
        finally:
            if self._operation is op:
                self._operation = None
            self._record(op)
            if op.kind == "open":
                self._settle_open(op)
            else:
                self._settle_turn(op)
            if not op.finished.done():
                op.finished.set_result(None)

    def _record(self, op: _Operation) -> None:
        turn = op.turn
        if turn is None:
            return
        outcome = op.outcome
        if outcome is not None:
            turn.stderr = outcome.stderr
            turn.stderr_bytes = outcome.stderr_bytes
            turn.stderr_truncated = outcome.stderr_truncated
        done = op.done
        if done is not None:
            exit_code = done.get("exitCode")
            signal = done.get("signal")
            turn.exit_code = exit_code if isinstance(exit_code, int) else None
            turn.signal = signal if isinstance(signal, str) else None

    def _on_output(self, op: _Operation, text: str, stream: OutputStream) -> None:
        if stream != "stdout" or self._failure is not None:
            return  # stderr is captured (bounded) by the runner; see `_record`
        buffer = op.buffer + text
        start = 0
        while True:
            newline = buffer.find("\n", start)
            if newline < 0:
                break
            end = newline - 1 if newline > start and buffer[newline - 1] == "\r" else newline
            if end > start:
                self._handle_frame(op, buffer[start:end])
            start = newline + 1
            if self._failure is not None:
                break
        op.buffer = buffer[start:]
        if self._failure is None and len(op.buffer) > MAX_FRAME_BYTES // 4 and len(op.buffer.encode("utf-8")) > MAX_FRAME_BYTES:
            self._fail("protocol-error", f"amp worker frame exceeds {MAX_FRAME_BYTES} bytes without a newline")

    # ---- envelopes --------------------------------------------------------

    def _handle_frame(self, op: _Operation, line: str) -> None:
        size = len(line.encode("utf-8"))
        if size > MAX_FRAME_BYTES:
            self._fail("protocol-error", f"amp worker frame of {size} bytes exceeds {MAX_FRAME_BYTES}")
            return
        try:
            frame = json.loads(line, parse_constant=_reject_constant)
        except ValueError as exc:
            self._fail("protocol-error", f"amp worker frame is not valid JSON: {exc}")
            return
        if not isinstance(frame, dict):
            self._fail("protocol-error", f"amp worker frame is a JSON {type(frame).__name__}, not an object")
            return
        kind = frame.get("type")
        if not isinstance(kind, str) or not kind:
            self._fail("protocol-error", "amp worker frame has no string 'type'")
            return
        if op.done is not None or op.error is not None:
            terminal = "amp_done" if op.done is not None else "amp_error"
            self._fail("protocol-error", f"{kind!r} frame after the terminal {terminal} envelope")
            return
        if kind == "amp_open":
            self._handle_open(op, frame)
        elif kind == "amp_event":
            self._handle_event(op, frame, size)
        elif kind == "amp_done":
            self._handle_done(op, frame)
        elif kind == "amp_error":
            self._handle_error(op, frame)
        else:
            self._fail("protocol-error", f"unexpected {kind!r} frame from the amp worker")

    def _handle_open(self, op: _Operation, frame: dict[str, object]) -> None:
        if op.opened:
            self._fail("protocol-error", "duplicate amp_open envelope")
            return
        session_id = frame.get("sessionId")
        if not isinstance(session_id, str) or _AMP_SESSION_ID.fullmatch(session_id) is None:
            self._fail("protocol-error", f"amp_open reported no full Amp thread ID: {session_id!r}")
            return
        expected = self._reference.session_id if self._reference is not None else (self._spec.resume.session_id if self._spec.resume is not None else None)
        if expected is not None and session_id != expected:
            self._fail("protocol-error", f"amp worker opened thread {session_id!r}, expected {expected!r}")
            return
        workdir = frame.get("workdir")
        if not isinstance(workdir, str) or not _same_dir(workdir, self._spec.workdir):
            self._fail("protocol-error", f"amp_open reported workdir {workdir!r}, expected {str(self._spec.workdir)!r}")
            return
        endpoint = frame.get("endpoint")
        if endpoint != self._endpoint:
            self._fail("protocol-error", f"amp_open reported endpoint {endpoint!r}, expected {self._endpoint!r}")
            return
        op.opened = True
        if op.kind == "open":
            self._reference = SessionReference(session_id=session_id, session_file=None, workdir=self._spec.workdir, endpoint=self._endpoint)
        elif op.turn is not None and op.turn.init_timer is not None:
            op.turn.init_timer.cancel()

    def _handle_event(self, op: _Operation, frame: dict[str, object], size: int) -> None:
        event = frame.get("event")
        if not isinstance(event, dict) or not isinstance(event.get("type"), str) or not event["type"]:
            self._fail("protocol-error", "amp_event frame has no event object with a non-empty string 'type'")
            return
        turn = op.turn
        if self._reference is None or turn is None:
            self._fail("protocol-error", "amp_event envelope during the open operation")
            return
        # The turn outlives its worker: it settles only after the runner
        # returns, so every event of this operation belongs to it.
        self._enqueue(
            SessionEvent(
                backend="sdk",
                harness="amp",
                session_id=self._reference.session_id,
                turn_id=turn.handle.id,
                request_id=None,
                type=event["type"],
                raw=event,
            ),
            turn,
            size,
        )

    def _handle_done(self, op: _Operation, frame: dict[str, object]) -> None:
        status = frame.get("status")
        if status not in _DONE_STATUSES:
            self._fail("protocol-error", f"amp_done status {status!r} is not one of {', '.join(_DONE_STATUSES)}")
            return
        raw = frame.get("raw")
        if raw is not None and not isinstance(raw, dict):
            self._fail("protocol-error", "amp_done 'raw' must be the native result object or null")
            return
        error = frame.get("error")
        if error is not None and (not isinstance(error, str) or not error):
            self._fail("protocol-error", "amp_done 'error' must be a non-empty string or null")
            return
        exit_code = frame.get("exitCode")
        if exit_code is not None and (isinstance(exit_code, bool) or not isinstance(exit_code, int)):
            self._fail("protocol-error", "amp_done 'exitCode' must be an integer or null")
            return
        signal = frame.get("signal")
        if signal is not None and (not isinstance(signal, str) or not signal):
            self._fail("protocol-error", "amp_done 'signal' must be a non-empty string or null")
            return
        if status == "completed" and not op.opened:
            self._fail("protocol-error", "amp_done reported completion without an amp_open envelope")
            return
        op.done = frame
        if op.turn is not None and op.turn.init_timer is not None:
            op.turn.init_timer.cancel()

    def _handle_error(self, op: _Operation, frame: dict[str, object]) -> None:
        code = frame.get("code")
        error = frame.get("error")
        if code not in _ERROR_CODES or not isinstance(error, str) or not error:
            self._fail("protocol-error", "amp_error frame needs a known 'code' and a non-empty string 'error'")
            return
        op.error = frame
        if op.kind == "turn":
            # A per-turn worker that cannot reach its prerequisites (SDK,
            # CLI version) leaves nothing to continue on.
            self._fail(_ERROR_STATUS.get(code, "protocol-error"), f"amp worker {code}: {error}")

    # ---- settlement -------------------------------------------------------

    def _settle_open(self, op: _Operation) -> None:
        if self._failure is not None:
            return
        if op.runner_error is not None:
            self._runner_error = op.runner_error
            self._startup_failed("disconnected", f"worker runner failed: {type(op.runner_error).__name__}: {op.runner_error}")
            return
        outcome = op.outcome
        assert outcome is not None
        termination = outcome.termination
        if termination == "launch-failed":
            self._startup_failed("disconnected", f"failed to launch {self._argv[0]!r}: {outcome.launch_error}")
        elif termination == "timed-out":
            self._startup_failed("timed-out", f"open received no amp_done within request_timeout_seconds={self._spec.request_timeout_seconds}")
        elif termination == "callback-error":
            self._startup_failed("protocol-error", f"stdout handling failed: {outcome.callback_error}")
        elif termination == "cancelled":
            self._startup_failed("protocol-error", "open worker was cancelled without a recorded failure")
        elif op.buffer:
            self._startup_failed("protocol-error", "stdout ended inside an incomplete JSON frame")
        elif op.error is not None:
            code = op.error["code"]
            assert isinstance(code, str)
            self._startup_failed(_ERROR_STATUS.get(code, "protocol-error"), str(op.error["error"]), code)  # type: ignore[arg-type]
        elif op.done is None:
            if outcome.exit_code != 0 or termination == "signaled":
                self._startup_failed(*self._worker_exit(outcome))
            else:
                self._startup_failed("protocol-error", "amp worker exited without an amp_done envelope")
        elif outcome.exit_code != 0 or termination == "signaled":
            self._startup_failed("protocol-error", f"{self._worker_exit(outcome)[1]} after amp_done")
        elif op.done["status"] != "completed":
            status = op.done["status"]
            assert isinstance(status, str)
            error = op.done.get("error")
            self._startup_failed(status, error if isinstance(error, str) else f"native open reported {status}")  # type: ignore[arg-type]
        else:
            assert self._reference is not None  # amp_done completed requires amp_open

    def _startup_failed(self, status: SessionTurnStatus, detail: str, code: ErrorCode | None = None) -> None:
        self._startup_code = code or _STARTUP_CODES.get(status, "protocol-error")
        self._fail(status, detail)

    def _settle_turn(self, op: _Operation) -> None:
        turn = op.turn
        assert turn is not None
        if self._failure is not None or turn.finished:
            return
        if op.runner_error is not None:
            self._runner_error = op.runner_error
            self._fail("disconnected", f"worker runner failed: {type(op.runner_error).__name__}: {op.runner_error}")
            return
        outcome = op.outcome
        assert outcome is not None
        termination = outcome.termination
        done = op.done
        if termination == "cancelled":
            if not turn.abort_requested:
                self._fail("protocol-error", "turn worker was cancelled without a recorded failure")
            elif done is not None:
                # Native completion observed before the interrupt landed.
                self._finish_done(turn, done)
            else:
                self._finish(turn, "interrupted", None, None)
            return
        if termination == "launch-failed":
            self._fail("disconnected", f"failed to launch {self._argv[0]!r}: {outcome.launch_error}")
        elif termination == "timed-out":
            self._fail("timed-out", f"turn {turn.handle.id} exceeded the worker deadline")
        elif termination == "callback-error":
            self._fail("protocol-error", f"stdout handling failed: {outcome.callback_error}")
        elif op.buffer:
            self._fail("protocol-error", "stdout ended inside an incomplete JSON frame")
        elif done is None:
            if outcome.exit_code != 0 or termination == "signaled":
                self._fail(*self._worker_exit(outcome))
            else:
                self._fail("protocol-error", "amp worker exited without an amp_done envelope")
        elif outcome.exit_code != 0 or termination == "signaled":
            _, detail = self._worker_exit(outcome)
            self._fail("protocol-error", f"{detail} after amp_done")
        else:
            self._finish_done(turn, done)

    def _finish_done(self, turn: _AmpTurn, done: dict[str, object]) -> None:
        status = done["status"]
        assert isinstance(status, str)
        raw = done.get("raw")
        raw = raw if isinstance(raw, dict) else None
        error = done.get("error")
        error = error if isinstance(error, str) else None
        if status == "protocol-error":
            # The worker saw the native protocol break; nothing after it is
            # trustworthy, so the session goes down with the turn.
            self._fail("protocol-error", error or "amp worker reported a native protocol error")
            return
        self._finish(turn, status, raw, error)  # type: ignore[arg-type]  # validated: _DONE_STATUSES

    def _worker_exit(self, outcome: SubprocOutcome) -> tuple[SessionTurnStatus, str]:
        if outcome.termination == "signaled":
            return "signaled", f"amp worker was killed by {outcome.signal}"
        return "exited", f"amp worker exited with code {outcome.exit_code}"

    def _on_init_timeout(self, turn: _AmpTurn) -> None:
        if turn.finished or (turn.op is not None and (turn.op.opened or turn.op.done is not None)):
            return
        self._fail("protocol-error", f"turn {turn.handle.id} received no amp_open within request_timeout_seconds={self._spec.request_timeout_seconds}")

    # ---- startup ----------------------------------------------------------

    async def _startup(self) -> None:
        if self._abandoned:
            self._fail("closed", None)
            await self._raise_startup_failure()
        op = _Operation("open", None, self._loop.create_future())
        self._operation = op
        self._spawn(self._run(op, self._request("open")))
        await op.finished
        if self._failure is not None:
            await self._raise_startup_failure(op)
        assert self._reference is not None

    async def _raise_startup_failure(self, op: _Operation | None = None) -> None:
        assert self._failure is not None and self._teardown_task is not None
        failure = self._failure
        cleanup_error: BaseException | None = None
        try:
            await self._teardown_task
        except Exception as exc:
            cleanup_error = exc
        code: ErrorCode = "session-closed" if failure.status == "closed" else self._startup_code
        detail = f"amp worker startup failed ({failure.status}" + (f": {failure.error})" if failure.error else ")")
        outcome = None if op is None else op.outcome
        if outcome is not None:
            if outcome.termination in ("exited", "signaled"):
                detail += f"; worker exit code {outcome.exit_code}" if outcome.signal is None else f"; worker killed by {outcome.signal}"
            stderr = outcome.stderr.strip()
            if stderr:
                detail += f"; stderr: {stderr[:2000]}"
        raise HarnessError(detail, code=code) from cleanup_error

    # ---- teardown ---------------------------------------------------------

    async def _teardown(self) -> None:
        failure = self._failure
        assert failure is not None
        turn = self._active
        if turn is not None:
            if turn.timer is not None:
                turn.timer.cancel()
            if turn.init_timer is not None:
                turn.init_timer.cancel()
        op = self._operation
        if op is not None:
            op.cancel.set()
        for task in list(self._tasks):
            if task.done():
                continue
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass
        if turn is not None and not turn.finished:
            raw = turn.op.done.get("raw") if turn.op is not None and turn.op.done is not None else None
            self._finish(turn, failure.status, raw if isinstance(raw, dict) else None, failure.error)
        self._idle._close()
        error = self._runner_error
        if isinstance(error, (PermissionError, subprocess.TimeoutExpired)):
            # The runner could not stop or reap the worker group; keep the
            # lease rather than restoring the workdir under a live child.
            raise HarnessError(f"amp worker process group could not be released: {type(error).__name__}: {error}", code="adapter-error") from error
        cleanup_command(self._prepared)
        if error is not None:
            raise HarnessError(f"amp worker runner failed: {type(error).__name__}: {error}", code="adapter-error") from error


async def open_amp_session(spec: SessionSpec) -> LiveSession:
    """Open the validated Amp `spec` (see `open_session`): take the workdir
    lease, run the `open` worker and keep the lease until `close()`."""
    assert spec.amp_sdk is not None
    endpoint = spec.resume.endpoint if spec.resume is not None and spec.resume.endpoint is not None else _amp_endpoint(spec.env)
    instructions_file = spec.workdir / _adapter_class("amp").instructions_filename if spec.instructions is not None else None
    built = BuildCommand(
        cmd=spec.executable or "node",
        args=[str(_WORKER)],
        cwd=spec.workdir,
        env=dict(spec.env),
        instructions_file=instructions_file,
        instruction_content=spec.instructions if instructions_file is not None else None,
        model=None,
    )
    prepared = prepare_command(built)
    session = _AmpSession(spec, prepared, endpoint)
    await _await_startup(session, session._startup())
    return session


__all__ = ["open_amp_session"]
