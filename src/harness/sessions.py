"""Live Pi RPC sessions — an owned `pi --mode rpc` child driven over JSONL.

`open_session(spec)` spawns Pi in its own POSIX process group, completes the
`get_state` handshake and returns a `LiveSession`. Each `start_turn(prompt)`
sends one `prompt` request; the native event stream is delivered through the
turn's bounded async iterator and the turn settles on `agent_settled` (plus the
prompt acknowledgement and any in-flight abort acknowledgement). Frames that
arrive while no turn is active flow through `LiveSession.events`.

Only the Pi RPC protocol shipped with @earendil-works/pi-coding-agent 0.85.1
(`agent_settled` terminal event) is supported. `agent_end` is retained as the
completion payload but never treated as the end of a turn: Pi may still retry,
compact or continue after it. Local extension / slash prompts and input-hook
interceptions have no guaranteed terminal event; `timeout_seconds` bounds them.

Transport or protocol failures invalidate the handle: the owned process group
receives SIGTERM, then SIGKILL after 500 ms, and pipes are drained for at most
one further second before the active turn settles with the failure status.
"""
from __future__ import annotations

import asyncio
import json
import math
import os
import signal
import sys
from collections import deque
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Coroutine, Literal

from harness._instructions import PreparedCommand, cleanup_command, prepare_command
from harness.base import (
    BACKENDS,
    PERMISSION_POLICIES,
    Backend,
    BuildCommand,
    ErrorCode,
    HarnessError,
    PermissionPolicy,
    absolute_workdir,
)
from harness.registry import _adapter_class

SessionTurnStatus = Literal[
    "completed",
    "agent-error",
    "interrupted",
    "protocol-error",
    "disconnected",
    "timed-out",
    "closed",
    "exited",
    "signaled",
]

#: Byte cap on queued-but-unconsumed events per turn / idle stream (1 MiB).
DEFAULT_MAX_BUFFER_BYTES = 1_048_576
#: Largest single JSONL frame (bytes, excluding the LF) accepted from Pi.
MAX_FRAME_BYTES = 1_048_576
#: Pi distribution whose RPC protocol this module is qualified against.
SUPPORTED_PI_DISTRIBUTION = "@earendil-works/pi-coding-agent 0.85.1"

_READ_SIZE = 65536
_TICK = 0.02
_TERM_GRACE = 0.5
_DRAIN_BUDGET = 1.0
_SESSION_HARNESS = "pi"


# ── public types ────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class SessionReference:
    """Native identity of a Pi session.

    `session_id`   — the full native session ID (never a prefix).
    `session_file` — absolute path of the native session log, or None while Pi
                     has not persisted the session yet.
    `workdir`      — absolute directory the session was opened in.
    """

    session_id: str
    session_file: Path | None
    workdir: Path


@dataclass
class SessionSpec:
    """Everything needed to open a live Pi RPC session.

    `harness`         — must be "pi"; other registered harnesses raise
                        `unsupported-backend`, unknown names `unknown-harness`.
    `workdir`         — cwd for the child (absolute against the process cwd).
    `backend`         — must be "rpc". "cli"/"sdk" raise `unsupported-backend`.
    `model`           — passed as `--model <model>` (trimmed); None keeps Pi's
                        own default. Empty after trimming is `invalid-options`.
    `env`             — additions layered over the inherited environment.
    `executable`      — bare binary name or absolute path; default "pi".
    `permission_policy` — only "upstream"; "bypass" raises `unsupported-capability`.
    `instructions`    — projected to `AGENTS.md` under the workdir lease for the
                        life of the process tree.
    `resume`          — existing session to continue. Requires `session_file`;
                        the file header is verified before spawn and the native
                        `get_state` ID after startup.
    `timeout_seconds` — wall-clock cap per turn (default 1800). None disables
                        it. Expiry tears the session down (`timed-out`).
    `request_timeout_seconds` — cap on every correlated request (default 30).
    `max_buffer_bytes` — cap on queued, unconsumed event bytes per turn and for
                        the idle stream (default 1 MiB). Overflow is never
                        silent: the session fails with `protocol-error`.
    """

    harness: str
    workdir: Path
    backend: Backend
    model: str | None = None
    env: dict[str, str] = field(default_factory=dict)
    executable: str | None = None
    permission_policy: PermissionPolicy = "upstream"
    instructions: str | None = None
    resume: SessionReference | None = None
    timeout_seconds: float | None = 1800
    request_timeout_seconds: float = 30
    max_buffer_bytes: int = DEFAULT_MAX_BUFFER_BYTES


@dataclass(frozen=True)
class SessionCapabilities:
    """Operations a (harness, backend) pair supports for live sessions."""

    backend: Backend
    events: bool
    interrupt: bool
    follow_up: bool
    resume: bool
    concurrent_turns: bool
    approval: bool


@dataclass(frozen=True)
class SessionEvent:
    """One native frame. `raw` is the parsed JSON object, untouched."""

    backend: Literal["rpc"]
    harness: Literal["pi"]
    session_id: str
    turn_id: str | None
    request_id: str | None
    type: str
    raw: dict[str, object]


@dataclass(frozen=True)
class SessionTurnResult:
    """Terminal outcome of one turn.

    `raw` is the last `agent_end` payload or the rejecting `response` frame.
    Usage inside it is Pi's own cumulative accounting; nothing is aggregated.
    `exit_code` / `signal` are the observed leader exit, None while it runs.
    """

    session_id: str
    turn_id: str
    status: SessionTurnStatus
    raw: dict[str, object] | None
    error: str | None
    exit_code: int | None
    signal: str | None
    stderr: str
    stderr_bytes: int
    stderr_truncated: bool
    events_truncated: bool


class _SessionEvents:
    """Single-consumer async iterator over `SessionEvent`s with a byte budget."""

    def __init__(self, cap: int) -> None:
        self._cap = cap
        self._items: deque[tuple[SessionEvent, int]] = deque()
        self._bytes = 0
        self._closed = False
        self._waiter: asyncio.Future[None] | None = None
        self._iterating = False
        self.truncated = False

    def _push(self, event: SessionEvent, size: int) -> bool:
        """Queue `event`; False when it would exceed the budget (not queued)."""
        if self._closed:
            return True
        # A waiting consumer already owns this delivery, as with a resolved
        # iterator promise in TypeScript; it does not occupy buffered capacity.
        if self._waiter is not None and not self._waiter.done() and not self._items:
            size = 0
        if self._bytes + size > self._cap:
            self.truncated = True
            return False
        self._items.append((event, size))
        self._bytes += size
        self._wake()
        return True

    def _close(self) -> None:
        self._closed = True
        self._wake()

    def _wake(self) -> None:
        if self._waiter is not None and not self._waiter.done():
            self._waiter.set_result(None)

    def __aiter__(self) -> _SessionEvents:
        if self._iterating:
            raise HarnessError("session events are single-consumer; the iterator is already in use", code="unsupported-capability")
        self._iterating = True
        return self

    async def __anext__(self) -> SessionEvent:
        while True:
            if self._items:
                event, size = self._items.popleft()
                self._bytes -= size
                return event
            if self._closed:
                raise StopAsyncIteration
            if self._waiter is not None:
                raise HarnessError("session events are single-consumer; another consumer is waiting", code="unsupported-capability")
            self._waiter = asyncio.get_running_loop().create_future()
            try:
                await self._waiter
            finally:
                self._waiter = None


@dataclass(frozen=True)
class SessionTurn:
    """Handle returned by `LiveSession.start_turn`."""

    id: str
    events: _SessionEvents
    _result: asyncio.Future[SessionTurnResult] = field(repr=False, compare=False)

    @property
    def result(self) -> asyncio.Future[SessionTurnResult]:
        """Settles exactly once with a `SessionTurnResult`; never raises.
        Cancelling the returned future does not disturb the turn."""
        return asyncio.shield(self._result)


# ── validation ──────────────────────────────────────────────────────────────


def get_session_capabilities(name: str, backend: Backend = "rpc") -> SessionCapabilities:
    """Live-session operations `name` supports on `backend`. Pure.

    Raises `unknown-harness` for unregistered names, `unsupported-backend` for
    registered harnesses without a session backend and for cli/sdk, and
    `invalid-options` for unknown backends.
    """
    _adapter_class(name)
    _validate_session_backend(name, backend)
    return SessionCapabilities(
        backend="rpc",
        events=True,
        interrupt=True,
        follow_up=True,
        resume=True,
        concurrent_turns=False,
        approval=False,
    )


def _validate_session_backend(name: str, backend: object) -> None:
    if backend not in BACKENDS:
        raise HarnessError(f"unknown backend {backend!r}; expected one of {', '.join(BACKENDS)}", code="invalid-options")
    if backend != "rpc":
        raise HarnessError(f"backend {backend!r} has no live session support; use 'rpc' with harness 'pi'", code="unsupported-backend")
    if name != _SESSION_HARNESS:
        raise HarnessError(f"harness {name!r} has no rpc session support; only 'pi' is qualified", code="unsupported-backend")


def _finite(name: str, value: object, *, minimum: float, exclusive: bool) -> None:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise HarnessError(f"{name} must be a finite number", code="invalid-options")
    if value < minimum or (exclusive and value == minimum):
        bound = "positive" if exclusive else "non-negative"
        raise HarnessError(f"{name} must be {bound}, got {value!r}", code="invalid-options")


def _validate_reference(reference: object) -> SessionReference:
    if not isinstance(reference, SessionReference):
        raise HarnessError("resume must be a SessionReference", code="invalid-options")
    if not isinstance(reference.session_id, str) or not reference.session_id:
        raise HarnessError("resume.session_id must be a non-empty native session ID", code="invalid-options")
    if reference.session_file is None:
        raise HarnessError("resume requires session_file; Pi has not persisted this session yet", code="invalid-options")
    file = reference.session_file
    if not isinstance(file, (str, os.PathLike)) or not os.fspath(file) or "\0" in os.fspath(file):
        raise HarnessError("resume.session_file must be a NUL-free path", code="invalid-options")
    if not os.path.isabs(os.fspath(file)):
        raise HarnessError(f"resume.session_file {os.fspath(file)!r} must be absolute", code="invalid-options")
    workdir = absolute_workdir(reference.workdir)
    if not os.path.isabs(os.fspath(reference.workdir)):
        raise HarnessError(f"resume.workdir {os.fspath(reference.workdir)!r} must be absolute", code="invalid-options")
    return SessionReference(session_id=reference.session_id, session_file=Path(file), workdir=workdir)


def _same_dir(a: str, b: Path) -> bool:
    if a == str(b):
        return True
    try:
        return os.path.realpath(a) == os.path.realpath(b)
    except OSError:
        return False


def _verify_session_header(reference: SessionReference) -> None:
    """The first line of a Pi session file is `{"type":"session","id":...,"cwd":...}`."""
    assert reference.session_file is not None
    path = reference.session_file
    try:
        with open(path, "rb") as fh:
            first = fh.readline(MAX_FRAME_BYTES + 1)
    except OSError as exc:
        raise HarnessError(f"cannot read resume.session_file {path}: {exc.strerror or exc}", code="invalid-options") from None
    try:
        header = json.loads(first.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise HarnessError(f"resume.session_file {path} does not start with a JSON session header", code="invalid-options") from None
    if not isinstance(header, dict) or header.get("type") != "session":
        raise HarnessError(f"resume.session_file {path} header is not type 'session'", code="invalid-options")
    if header.get("id") != reference.session_id:
        raise HarnessError(
            f"resume.session_file {path} belongs to session {header.get('id')!r}, not {reference.session_id!r}",
            code="invalid-options",
        )
    cwd = header.get("cwd")
    if not isinstance(cwd, str) or not _same_dir(cwd, reference.workdir):
        raise HarnessError(f"resume.session_file {path} was recorded in {cwd!r}, not {str(reference.workdir)!r}", code="invalid-options")


def _validate_session_spec(spec: SessionSpec) -> SessionSpec:
    """Validate and snapshot `spec` (absolute workdir, trimmed model, copied env)."""
    if not isinstance(spec, SessionSpec):
        raise HarnessError("open_session requires a SessionSpec", code="invalid-options")
    _adapter_class(spec.harness)
    _validate_session_backend(spec.harness, spec.backend)
    if spec.permission_policy not in PERMISSION_POLICIES:
        raise HarnessError(
            f"unknown permission_policy {spec.permission_policy!r}; expected one of {', '.join(PERMISSION_POLICIES)}",
            code="invalid-options",
        )
    if spec.permission_policy == "bypass":
        raise HarnessError("pi rpc sessions have no permission bypass mapping; use permission_policy='upstream'", code="unsupported-capability")
    model = spec.model
    if model is not None:
        if not isinstance(model, str):
            raise HarnessError("model must be None or a string", code="invalid-options")
        model = model.strip()
        if not model or "\0" in model:
            raise HarnessError("model must be a non-empty string without NUL bytes", code="invalid-options")
    if not isinstance(spec.env, dict) or any(
        not isinstance(k, str) or not isinstance(v, str) or "\0" in k or "\0" in v or "=" in k or not k for k, v in spec.env.items()
    ):
        raise HarnessError("env must map non-empty NUL-free names (without '=') to strings", code="invalid-options")
    executable = spec.executable
    if executable is not None:
        if not isinstance(executable, str) or not executable or "\0" in executable:
            raise HarnessError("executable must be a non-empty string without NUL bytes", code="invalid-options")
        separators = os.sep + (os.altsep or "")
        if not os.path.isabs(executable) and any(ch in executable for ch in separators):
            raise HarnessError(
                f"executable {executable!r} is a relative path; use a bare binary name or an absolute path",
                code="invalid-options",
            )
    if spec.instructions is not None and not isinstance(spec.instructions, str):
        raise HarnessError("instructions must be None or a string", code="invalid-options")
    if spec.timeout_seconds is not None:
        _finite("timeout_seconds", spec.timeout_seconds, minimum=0, exclusive=False)
    _finite("request_timeout_seconds", spec.request_timeout_seconds, minimum=0, exclusive=True)
    buffer = spec.max_buffer_bytes
    if isinstance(buffer, bool) or not isinstance(buffer, int) or not 0 <= buffer <= 9007199254740991:
        raise HarnessError(f"max_buffer_bytes must be a non-negative safe integer, got {buffer!r}", code="invalid-options")
    workdir = absolute_workdir(spec.workdir)
    resume = _validate_reference(spec.resume) if spec.resume is not None else None
    if resume is not None and not _same_dir(str(resume.workdir), workdir):
        raise HarnessError(
            f"resume.workdir {str(resume.workdir)!r} does not match the session workdir {str(workdir)!r}",
            code="invalid-options",
        )
    return replace(spec, workdir=workdir, model=model, env=dict(spec.env), resume=resume)


def _build(spec: SessionSpec) -> BuildCommand:
    adapter_cls = _adapter_class(spec.harness)
    args = ["--mode", "rpc"]
    if spec.model is not None:
        args += ["--model", spec.model]
    if spec.resume is not None:
        assert spec.resume.session_file is not None
        args += ["--session", str(spec.resume.session_file)]
    instructions_file = spec.workdir / adapter_cls.instructions_filename if spec.instructions is not None else None
    return BuildCommand(
        cmd=spec.executable or "pi",
        args=args,
        cwd=spec.workdir,
        env=dict(spec.env),
        instructions_file=instructions_file,
        instruction_content=spec.instructions if instructions_file is not None else None,
        model=spec.model,
    )


# ── internals ───────────────────────────────────────────────────────────────


class _Rejected(ValueError):
    pass


def _reject_constant(name: str) -> None:
    raise _Rejected(f"non-standard JSON constant {name}")


def _stringify(value: object) -> str:
    return value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)


@dataclass
class _Failure:
    status: SessionTurnStatus
    error: str | None


@dataclass
class _Pending:
    id: str
    command: str
    turn: _Turn | None
    future: asyncio.Future[dict[str, object] | None]
    timer: asyncio.TimerHandle


@dataclass
class _Turn:
    handle: SessionTurn
    prompt_id: str
    settled: bool = False
    prompt_response: dict[str, object] | None = None
    abort_id: str | None = None
    abort_response: dict[str, object] | None = None
    last_end: dict[str, object] | None = None
    finished: bool = False
    timer: asyncio.TimerHandle | None = None


class _Stderr:
    """Bounded prefix capture of the child's stderr."""

    def __init__(self, cap: int) -> None:
        self.cap = cap
        self.total = 0
        self.truncated = False
        self._prefix = bytearray()

    def feed(self, chunk: bytes) -> None:
        self.total += len(chunk)
        room = self.cap - len(self._prefix)
        if room >= len(chunk):
            self._prefix += chunk
        else:
            if room > 0:
                self._prefix += chunk[:room]
            self.truncated = True

    def text(self) -> str:
        return self._prefix.decode("utf-8", "replace")


class LiveSession:
    """An open `pi --mode rpc` child. Create with `open_session`.

    One turn at a time; the next `start_turn` after a settled result is a
    follow-up in the same native session. Use as an async context manager or
    call `close()`; both are idempotent and safe to call concurrently.
    """

    def __init__(self, spec: SessionSpec, prepared: PreparedCommand) -> None:
        self._spec = spec
        self._prepared = prepared
        self._loop = asyncio.get_running_loop()
        self._proc: asyncio.subprocess.Process | None = None
        self._reference: SessionReference | None = None
        self._stderr = _Stderr(spec.max_buffer_bytes)
        self._idle = _SessionEvents(spec.max_buffer_bytes)
        self._pending: dict[str, _Pending] = {}
        self._active: _Turn | None = None
        self._failure: _Failure | None = None
        self._teardown_task: asyncio.Task[None] | None = None
        self._tasks: list[asyncio.Task[None]] = []
        self._write_lock = asyncio.Lock()
        self._exited = asyncio.Event()
        self._returncode: int | None = None
        self._request_seq = 0
        self._turn_seq = 0
        self._prelude: list[tuple[dict[str, object], str, int]] = []
        self._prelude_bytes = 0
        self._abandoned = False

    # ---- public surface ---------------------------------------------------

    @property
    def spec(self) -> SessionSpec:
        """Validated snapshot of the opening spec (own env copy)."""
        return replace(self._spec, env=dict(self._spec.env))

    @property
    def reference(self) -> SessionReference:
        assert self._reference is not None
        return self._reference

    @property
    def events(self) -> _SessionEvents:
        """Frames that arrive while no turn is active (single consumer)."""
        return self._idle

    @property
    def closed(self) -> bool:
        return self._failure is not None

    @property
    def active(self) -> SessionTurn | None:
        return None if self._active is None or self._active.finished else self._active.handle

    async def __aenter__(self) -> LiveSession:
        return self

    async def __aexit__(self, *_exc: object) -> None:
        await self.close()

    def start_turn(self, prompt: str) -> SessionTurn:
        """Reserve the turn slot and send `prompt`. Synchronous: the slot is
        taken before this returns, the write happens on the event loop.

        Prompts are forwarded verbatim. Pi handles local extension / slash
        commands and input-hook interceptions without a guaranteed terminal
        event; such turns end only through `timeout_seconds` (`timed-out`).
        """
        if not isinstance(prompt, str) or "\0" in prompt:
            raise HarnessError("prompt must be a string without NUL bytes", code="invalid-options")
        if not prompt.strip():
            raise HarnessError("prompt must not be empty", code="invalid-options")
        self._check_open()
        if self._busy():
            raise HarnessError("a turn is already active; await its result before starting another", code="unsupported-capability")
        self._turn_seq += 1
        turn_id = f"turn-{self._turn_seq}"
        self._request_seq += 1
        request_id = f"req-{self._request_seq}"
        handle = SessionTurn(id=turn_id, events=_SessionEvents(self._spec.max_buffer_bytes), _result=self._loop.create_future())
        turn = _Turn(handle=handle, prompt_id=request_id)
        self._active = turn
        if self._spec.timeout_seconds is not None:
            turn.timer = self._loop.call_later(self._spec.timeout_seconds, self._on_turn_timeout, turn)
        self._register(request_id, "prompt", turn)
        self._spawn(self._send({"id": request_id, "type": "prompt", "message": prompt}))
        return handle

    async def interrupt(self) -> None:
        """Abort the active turn and wait for it to settle. The turn reports
        `interrupted` only when Pi confirms the abort (stopReason aborted or an
        acknowledged abort with no assistant message)."""
        self._check_open()
        turn = self._active
        if turn is None or turn.finished:
            raise HarnessError("no active turn to interrupt", code="unsupported-capability")
        try:
            if turn.abort_id is None:
                self._request_seq += 1
                turn.abort_id = f"req-{self._request_seq}"
                self._register(turn.abort_id, "abort", turn)
                await self._uncancellable(self._loop.create_task(self._send({"id": turn.abort_id, "type": "abort"})))
            await asyncio.shield(turn.handle._result)
        except asyncio.CancelledError:
            self._fail("closed", "interrupt caller cancelled")
            assert self._teardown_task is not None
            await self._uncancellable(self._teardown_task)
            raise

    async def close(self) -> None:
        """Stop the owned process group, settle the active turn as `closed`,
        release the instruction lease. Raises if teardown could not fully
        release resources; cancellation waits for teardown before propagating."""
        self._fail("closed", None)
        assert self._teardown_task is not None
        await self._uncancellable(self._teardown_task)

    # ---- helpers ----------------------------------------------------------

    def _check_open(self) -> None:
        if self._failure is not None:
            detail = self._failure.status if self._failure.error is None else f"{self._failure.status}: {self._failure.error}"
            raise HarnessError(f"session is closed ({detail})", code="session-closed")

    def _busy(self) -> bool:
        if self._active is not None and not self._active.finished:
            return True
        return any(p.turn is not None for p in self._pending.values())

    def _spawn(self, coro: Coroutine[object, object, None]) -> None:
        task = self._loop.create_task(coro)
        self._tasks.append(task)
        task.add_done_callback(self._tasks.remove)

    async def _uncancellable(self, task: asyncio.Task[None]) -> None:
        """Await `task` to completion even if this coroutine is cancelled;
        the cancellation propagates afterwards, chained to any task error."""
        cancelled: asyncio.CancelledError | None = None
        while not task.done():
            try:
                await asyncio.shield(task)
            except asyncio.CancelledError as exc:
                cancelled = exc
            except BaseException:
                pass  # task finished with an error; re-raised by result() below
        if cancelled is not None:
            raise cancelled from (None if task.cancelled() else task.exception())
        return task.result()

    def _abandon(self) -> None:
        """Caller gave up during open: tear down now or as soon as the child exists."""
        self._abandoned = True
        if self._proc is not None:
            self._fail("closed", None)

    # ---- requests ---------------------------------------------------------

    def _register(self, request_id: str, command: str, turn: _Turn | None) -> _Pending:
        timeout = self._spec.request_timeout_seconds
        pending = _Pending(
            id=request_id,
            command=command,
            turn=turn,
            future=self._loop.create_future(),
            timer=self._loop.call_later(timeout, self._on_request_timeout, request_id),
        )
        self._pending[request_id] = pending
        return pending

    def _on_request_timeout(self, request_id: str) -> None:
        pending = self._pending.get(request_id)
        if pending is None:
            return
        self._fail("protocol-error", f"{pending.command} request {request_id} received no response within {self._spec.request_timeout_seconds}s")

    def _on_turn_timeout(self, turn: _Turn) -> None:
        if turn.finished:
            return
        self._fail("timed-out", f"turn {turn.handle.id} exceeded timeout_seconds={self._spec.timeout_seconds}")

    async def _send(self, payload: dict[str, object]) -> None:
        data = json.dumps(payload).encode("utf-8") + b"\n"
        try:
            async with self._write_lock:
                if self._failure is not None:
                    return
                assert self._proc is not None and self._proc.stdin is not None
                self._proc.stdin.write(data)
                await self._proc.stdin.drain()
        except (BrokenPipeError, ConnectionResetError, OSError, RuntimeError) as exc:
            if self._failure is None:
                await self._classify_transport_loss(f"stdin write failed: {type(exc).__name__}: {exc}")

    # ---- frame handling ---------------------------------------------------

    def _handle_line(self, line: bytes) -> None:
        if self._failure is not None:
            return
        if len(line) > MAX_FRAME_BYTES:
            self._fail("protocol-error", f"frame of {len(line)} bytes exceeds {MAX_FRAME_BYTES}")
            return
        try:
            text = line.decode("utf-8")
        except UnicodeDecodeError as exc:
            self._fail("protocol-error", f"frame is not valid UTF-8: {exc.reason} at byte {exc.start}")
            return
        try:
            frame = json.loads(text, parse_constant=_reject_constant)
        except ValueError as exc:
            self._fail("protocol-error", f"frame is not valid JSON: {exc}")
            return
        if not isinstance(frame, dict):
            self._fail("protocol-error", f"frame is a JSON {type(frame).__name__}, not an object")
            return
        kind = frame.get("type")
        if not isinstance(kind, str) or not kind:
            self._fail("protocol-error", "frame has no string 'type'")
            return
        turn = self._active if self._active is not None and not self._active.finished else None
        pending: _Pending | None = None
        if kind == "response":
            pending = self._match_response(frame)
            if pending is None:
                return
            turn = pending.turn or turn
        if pending is None or pending.command != "get_state":
            self._deliver(frame, kind, turn, len(line))
        if pending is not None:
            self._resolve(pending, frame)
        elif turn is not None:
            self._observe(turn, frame, kind)

    def _match_response(self, frame: dict[str, object]) -> _Pending | None:
        request_id = frame.get("id")
        if not isinstance(request_id, str):
            self._fail("protocol-error", f"response without a string id (command {frame.get('command')!r}): {frame.get('error') or 'unexpected response'}")
            return None
        pending = self._pending.get(request_id)
        if pending is None:
            self._fail("protocol-error", f"unexpected or duplicate response for request {request_id!r}")
            return None
        if frame.get("command") != pending.command:
            self._fail("protocol-error", f"response for request {request_id!r} names command {frame.get('command')!r}, expected {pending.command!r}")
            return None
        if not isinstance(frame.get("success"), bool):
            self._fail("protocol-error", f"response for request {request_id!r} has no boolean 'success'")
            return None
        return pending

    def _deliver(self, frame: dict[str, object], kind: str, turn: _Turn | None, size: int) -> None:
        if self._reference is None:
            # Handshake in progress: idle frames wait for the native identity.
            if self._prelude_bytes + size > self._spec.max_buffer_bytes:
                self._fail("protocol-error", "events before session identity exceeded max_buffer_bytes")
                return
            self._prelude_bytes += size
            self._prelude.append((frame, kind, size))
            return
        request_id = frame.get("id")
        event = SessionEvent(
            backend="rpc",
            harness=_SESSION_HARNESS,
            session_id=self._reference.session_id,
            turn_id=None if turn is None else turn.handle.id,
            request_id=request_id if isinstance(request_id, str) else None,
            type=kind,
            raw=frame,
        )
        queue = self._idle if turn is None else turn.handle.events
        if not queue._push(event, size):
            where = "idle event stream" if turn is None else f"turn {turn.handle.id}"
            self._fail("protocol-error", f"{where} exceeded max_buffer_bytes={self._spec.max_buffer_bytes} of unconsumed events")

    def _resolve(self, pending: _Pending, frame: dict[str, object]) -> None:
        del self._pending[pending.id]
        pending.timer.cancel()
        if not pending.future.done():
            pending.future.set_result(frame)
        turn = pending.turn
        if turn is None or turn.finished:
            return
        if pending.id == turn.prompt_id:
            turn.prompt_response = frame
        elif pending.id == turn.abort_id:
            turn.abort_response = frame
        self._maybe_finish(turn)

    def _observe(self, turn: _Turn, frame: dict[str, object], kind: str) -> None:
        if kind == "agent_end":
            turn.last_end = frame
        elif kind == "agent_settled":
            turn.settled = True
            self._maybe_finish(turn)

    def _maybe_finish(self, turn: _Turn) -> None:
        if turn.finished or self._failure is not None:
            return
        response = turn.prompt_response
        if response is None:
            return
        if turn.abort_id is not None and turn.abort_response is None:
            return
        if response["success"] is False:
            self._finish(turn, "agent-error", response, f"prompt rejected: {_stringify(response.get('error') or 'no error given')}")
            return
        if not turn.settled:
            return
        status, error = self._classify(turn)
        self._finish(turn, status, turn.last_end, error)

    def _classify(self, turn: _Turn) -> tuple[SessionTurnStatus, str | None]:
        message = _last_assistant(turn.last_end)
        if message is None:
            aborted = turn.abort_response is not None and turn.abort_response.get("success") is True
            return ("interrupted", None) if aborted else ("completed", None)
        reason = message.get("stopReason")
        if reason == "error":
            detail = message.get("errorMessage")
            return "agent-error", detail if isinstance(detail, str) and detail else "assistant stopReason error"
        if reason == "aborted":
            return "interrupted", None
        return "completed", None

    def _finish(self, turn: _Turn, status: SessionTurnStatus, raw: dict[str, object] | None, error: str | None) -> None:
        turn.finished = True
        if turn.timer is not None:
            turn.timer.cancel()
        result = SessionTurnResult(
            session_id=self.reference.session_id,
            turn_id=turn.handle.id,
            status=status,
            raw=raw,
            error=error,
            exit_code=self._returncode,
            signal=_signal_name(self._returncode),
            stderr=self._stderr.text(),
            stderr_bytes=self._stderr.total,
            stderr_truncated=self._stderr.truncated,
            events_truncated=turn.handle.events.truncated,
        )
        if not turn.handle._result.done():
            turn.handle._result.set_result(result)
        turn.handle.events._close()

    # ---- child I/O --------------------------------------------------------

    async def _read_stdout(self) -> None:
        assert self._proc is not None and self._proc.stdout is not None
        stream = self._proc.stdout
        buffer = bytearray()
        while True:
            try:
                chunk = await stream.read(_READ_SIZE)
            except Exception as exc:
                self._fail("protocol-error", f"stdout read failed: {type(exc).__name__}: {exc}")
                return
            if not chunk:
                break
            buffer += chunk
            start = 0
            while True:
                newline = buffer.find(b"\n", start)
                if newline < 0:
                    break
                end = newline - 1 if newline > start and buffer[newline - 1] == 0x0D else newline
                if end > start:
                    self._handle_line(bytes(buffer[start:end]))
                start = newline + 1
            del buffer[:start]
            if len(buffer) > MAX_FRAME_BYTES:
                self._fail("protocol-error", f"frame exceeds {MAX_FRAME_BYTES} bytes without a newline")
                buffer.clear()
        if self._failure is not None:
            return
        if buffer.strip(b"\r"):
            self._fail("protocol-error", "stdout ended inside an incomplete JSON frame")
            return
        await self._classify_transport_loss("stdout closed")

    async def _classify_transport_loss(self, detail: str) -> None:
        """Unexpected EOF/EPIPE: a natural exit within the grace window is
        `exited`/`signaled`; a live child that stopped talking is `disconnected`."""
        if not self._exited.is_set():
            try:
                await asyncio.wait_for(self._exited.wait(), _TERM_GRACE)
            except asyncio.TimeoutError:
                pass
        if self._failure is not None:
            return
        code = self._returncode
        if code is None:
            self._fail("disconnected", f"{detail} while pi kept running")
        elif code < 0:
            self._fail("signaled", f"pi was killed by {_signal_name(code)}")
        else:
            self._fail("exited", f"pi exited with code {code}")

    async def _read_stderr(self) -> None:
        assert self._proc is not None and self._proc.stderr is not None
        stream = self._proc.stderr
        while True:
            try:
                chunk = await stream.read(_READ_SIZE)
            except Exception:
                return
            if not chunk:
                return
            self._stderr.feed(chunk)

    async def _watch_exit(self) -> None:
        assert self._proc is not None
        self._returncode = await self._proc.wait()
        self._exited.set()

    # ---- failure and teardown ---------------------------------------------

    def _fail(self, status: SessionTurnStatus, error: str | None) -> None:
        if self._failure is not None:
            return
        self._failure = _Failure(status, error)
        self._teardown_task = self._loop.create_task(self._teardown())

    def _signal_group(self, sig: int) -> tuple[bool, PermissionError | None]:
        """(group still exists, EPERM seen). macOS can report EPERM for a
        group whose leader is mid-exit; treat it as alive and retry."""
        assert self._proc is not None
        try:
            os.killpg(self._proc.pid, sig)
        except ProcessLookupError:
            return False, None
        except PermissionError as exc:
            return True, exc
        return True, None

    async def _teardown(self) -> None:
        failure = self._failure
        assert failure is not None and self._proc is not None
        proc = self._proc
        for pending in self._pending.values():
            pending.timer.cancel()
        if self._active is not None and self._active.timer is not None:
            self._active.timer.cancel()
        stdin_error: Exception | None = None
        try:
            if proc.stdin is not None:
                proc.stdin.close()
        except Exception as exc:
            stdin_error = exc
        group_exists, group_error = self._signal_group(signal.SIGTERM)
        grace_end = self._loop.time() + _TERM_GRACE
        drain_end = grace_end + _DRAIN_BUDGET
        escalated = False
        readers = [t for t in self._tasks if not t.done()]
        while True:
            now = self._loop.time()
            if group_exists and not escalated and now >= grace_end:
                group_exists, group_error = self._signal_group(signal.SIGKILL)
                escalated = group_error is None
            readers = [t for t in readers if not t.done()]
            if not group_exists and self._exited.is_set() and not readers:
                break
            if now >= drain_end:
                break
            await asyncio.sleep(min(_TICK, drain_end - now))
            group_exists, group_error = self._signal_group(0)
        for task in readers:
            # A pipe still open past the drain budget is held by something
            # outside our group; stop waiting for its EOF.
            task.cancel()
        if not self._exited.is_set():
            try:
                await asyncio.wait_for(self._exited.wait(), max(0.0, drain_end - self._loop.time()))
            except asyncio.TimeoutError:
                pass
        for task in list(self._tasks):
            if task.done():
                continue
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass
        for pending in list(self._pending.values()):
            if not pending.future.done():
                pending.future.set_result(None)
        self._pending.clear()
        turn = self._active
        if turn is not None and not turn.finished:
            self._finish(turn, failure.status, turn.last_end, failure.error)
        self._idle._close()
        # Preserve the lease when live resources could not be released safely.
        if group_error is not None:
            raise group_error
        if not self._exited.is_set():
            raise HarnessError(f"pi process {proc.pid} could not be reaped within the teardown budget", code="adapter-error")
        cleanup_command(self._prepared)
        if stdin_error is not None:
            raise stdin_error

    # ---- startup ----------------------------------------------------------

    async def _startup(self, argv: list[str], env: dict[str, str]) -> None:
        try:
            self._proc = await asyncio.create_subprocess_exec(
                *argv,
                cwd=str(self._spec.workdir),
                env=env,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                start_new_session=True,
            )
        except OSError as exc:
            cleanup_command(self._prepared)
            raise HarnessError(f"failed to launch {argv[0]!r}: {exc.strerror or exc}", code="launch-failed") from None
        self._spawn(self._watch_exit())
        self._spawn(self._read_stdout())
        self._spawn(self._read_stderr())
        if self._abandoned:
            self._fail("closed", None)
        self._request_seq += 1
        request_id = f"req-{self._request_seq}"
        pending = self._register(request_id, "get_state", None)
        await self._send({"id": request_id, "type": "get_state"})
        response = await asyncio.shield(pending.future)
        if response is None:
            await self._raise_startup_failure()
        assert response is not None
        try:
            self._reference = self._reference_from_state(response)
        except HarnessError as exc:
            self._fail("protocol-error", str(exc))
            await self._raise_startup_failure()
        # The handshake response is consumed here (it became `reference`);
        # any other frame that arrived meanwhile is an idle event.
        prelude, self._prelude = self._prelude, []
        self._prelude_bytes = 0
        for frame, kind, size in prelude:
            if frame is not response:
                self._deliver(frame, kind, None, size)

    async def _raise_startup_failure(self) -> None:
        assert self._failure is not None and self._teardown_task is not None
        failure = self._failure
        cleanup_error: BaseException | None = None
        try:
            await self._teardown_task
        except Exception as exc:
            cleanup_error = exc
        code: ErrorCode
        if failure.status == "closed":
            code = "session-closed"
        elif failure.status in ("exited", "signaled", "disconnected"):
            code = "launch-failed"
        else:
            code = "protocol-error"
        detail = f"pi rpc startup failed ({failure.status}" + (f": {failure.error})" if failure.error else ")")
        if self._returncode is not None:
            detail += f"; exit code {self._returncode}"
        stderr = self._stderr.text().strip()
        if stderr:
            detail += f"; stderr: {stderr[:2000]}"
        raise HarnessError(detail, code=code) from cleanup_error

    def _reference_from_state(self, response: dict[str, object]) -> SessionReference:
        if response.get("success") is not True:
            raise HarnessError(f"get_state failed: {_stringify(response.get('error') or 'no error given')}")
        data = response.get("data")
        if not isinstance(data, dict):
            raise HarnessError("get_state response has no data object")
        session_id = data.get("sessionId")
        if not isinstance(session_id, str) or not session_id:
            raise HarnessError("get_state reported no sessionId")
        session_file = data.get("sessionFile")
        if session_file is not None and (
            not isinstance(session_file, str) or not Path(session_file).is_absolute() or "\0" in session_file
        ):
            raise HarnessError("get_state sessionFile must be an absolute path or null")
        if data.get("isStreaming") is not False:
            raise HarnessError("get_state reported isStreaming != false at startup")
        resume = self._spec.resume
        if resume is not None and session_id != resume.session_id:
            raise HarnessError(f"pi resumed session {session_id!r}, expected {resume.session_id!r}")
        return SessionReference(
            session_id=session_id,
            session_file=Path(session_file) if session_file else None,
            workdir=self._spec.workdir,
        )


def _last_assistant(end: dict[str, object] | None) -> dict[str, object] | None:
    if end is None:
        return None
    messages = end.get("messages")
    if not isinstance(messages, list):
        return None
    for message in reversed(messages):
        if isinstance(message, dict) and message.get("role") == "assistant":
            return message
    return None


def _signal_name(returncode: int | None) -> str | None:
    if returncode is None or returncode >= 0:
        return None
    try:
        return signal.Signals(-returncode).name
    except ValueError:
        return f"SIG{-returncode}"


async def open_session(spec: SessionSpec) -> LiveSession:
    """Spawn `pi --mode rpc` for `spec` and complete the `get_state` handshake.

    Validation (harness, backend, options, resume header) happens before any
    filesystem or process side effect. Instructions are projected under the
    workdir lease and restored when the session closes. Cancellation while
    opening tears the child down before `CancelledError` propagates.
    """
    spec = _validate_session_spec(spec)
    if sys.platform not in ("darwin", "linux"):
        raise NotImplementedError("Owned subprocess groups require macOS or Linux")
    if spec.resume is not None:
        _verify_session_header(spec.resume)
    built = _build(spec)
    prepared = prepare_command(built)
    session = LiveSession(spec, prepared)
    env = os.environ.copy()
    env.update(built.env)
    startup = asyncio.get_running_loop().create_task(session._startup([built.cmd] + built.args, env))
    try:
        await asyncio.shield(startup)
    except asyncio.CancelledError as cancelled:
        # Startup keeps running (shielded) so the child is never orphaned;
        # abandoning it tears the child down as soon as it exists.
        session._abandon()
        try:
            await session._uncancellable(startup)
        except BaseException:
            pass  # repeated cancellation or startup error; teardown decides below
        teardown = session._teardown_task
        if teardown is not None:
            try:
                await session._uncancellable(teardown)
            except BaseException:
                pass
            if teardown.exception() is not None:
                raise cancelled from teardown.exception()
        raise
    return session


__all__ = [
    "LiveSession",
    "SessionCapabilities",
    "SessionEvent",
    "SessionReference",
    "SessionSpec",
    "SessionTurn",
    "SessionTurnResult",
    "SessionTurnStatus",
    "get_session_capabilities",
    "open_session",
]
