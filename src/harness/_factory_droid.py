"""Factory Droid live sessions: the published `droid_sdk.client.DroidClient`
over a Harness-owned stdio transport to one owned `droid exec` child.

Pinned to droid-sdk `SUPPORTED_DROID_SDK_VERSION` (0.4.0) and qualified against
Droid CLI `QUALIFIED_DROID_CLI_VERSION` (0.213.0). The SDK is imported only
here, when a `factory-droid` / `sdk` spec is opened; it owns the JSON-RPC
requests, request / response correlation, result schemas and the server →
client permission / question dispatch. Nothing high-level (`Session`,
`RunStream`) is used: those layers fall back to the caller's cwd on resume
and to cumulative usage snapshots, both of which this backend refuses.

Ownership: `_StdioTransport` is the `DroidClientTransport` the client is
constructed with. It is connected before the client, wraps the shared
`_OwnedChild` (fresh POSIX process group, piped stdio, bounded stderr prefix)
and records the id / method of every request the SDK sends so that incoming
responses can be correlated independently: an unknown or duplicate response
id is `protocol-error`, not a logged warning. Every incoming line is parsed
strictly (UTF-8, LF, JSON object, `jsonrpc` 2.0, bounded 1 MiB) and observed
before the SDK sees it, so unknown notifications are retained as events even
when the SDK ignores them.

Startup: `initialize_session` (new) or `load_session` (resume), both bounded
by `request_timeout_seconds`. A new session takes its ID from the typed result
and then verifies the native session log the CLI wrote at
`<FACTORY_HOME_OVERRIDE or HOME>/.factory/sessions/<encoded workdir>/<id>.jsonl`
(`session_start` header with that id and cwd) — the initialize result carries
no cwd, the saved header does. A resumed session verifies that same header
before spawn (`invalid-options`), then the typed `load_session.cwd` and the
client's session ID after (`protocol-error` on mismatch), and rejects a
session whose agent loop is still in progress.

Turn: `add_user_message` with a fresh UUID `messageId` and a fresh request id.
The turn settles once the request is acknowledged AND the native
`agent_turn_completed` notification for that `messageId` (its `turnId`, when
present) has arrived; `completed` maps to `completed`, `cancelled` /
`permission_rejected` to `interrupted`, every other reason to `agent-error`
with the reason (and the last native `error` message) preserved. The
complete notification is `result.raw`; `tokenUsage` is this turn only,
`cumulativeTokenUsage` the session, and `factoryCredits` are never money. A
rejected prompt is `agent-error` with the rejecting response envelope as raw.
`interrupt` is `interrupt_session`: its acknowledgement plus the terminal
notification settle the turn; a normal completion that races it stays
`completed`. Breaking out of a turn's event iterator never interrupts the
agent: frames keep flowing into the bounded queue until an explicit
interrupt or close.

Callbacks: `FactoryDroidOptions.on_permission` / `on_question` receive the
native request params and answer natively, bounded by
`request_timeout_seconds`. A reply is checked against the SDK's own response
schema and against what the request offered (option values / question
indexes); anything else, an exception or a timeout fails the session closed
(`agent-error`, cause retained) followed by the owned teardown. Without a
callback the SDK default applies (`cancel` / `cancelled`); nothing here ever
escalates to an `always` outcome on its own.

Close: on a caller-initiated close a best-effort `close_session` is given
`_TERM_GRACE`; then the transport closes the group (stdin EOF, SIGTERM, SIGKILL
after 500 ms, at most 1 s more to reap and drain) and the SDK client is closed
within the same drain budget. Saved session logs are never deleted.
"""
from __future__ import annotations

import asyncio
import inspect
import json
import os
import uuid
from collections.abc import AsyncIterator
from copy import deepcopy
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable

from harness._instructions import PreparedCommand, cleanup_command, prepare_command
from harness.adapters.factory_droid import encode_project_dir
from harness.base import HarnessError
from harness.sessions import (
    MAX_FRAME_BYTES,
    SUPPORTED_DROID_SDK_VERSION,
    FactoryDroidCallback,
    FactoryDroidOptions,
    LiveSession,
    SessionReference,
    SessionSpec,
    SessionTurn,
    SessionTurnStatus,
    _DRAIN_BUDGET,
    _FACTORY_OWNED_ENV,
    _TERM_GRACE,
    _OwnedChild,
    _TurnBase,
    _await_startup,
    _build,
    _reject_constant,
    _same_dir,
    _verify_session_header,
)

if TYPE_CHECKING:
    from droid_sdk.client import DroidClient

_CHILD = "droid"
_CLI_PROTOCOL = "1.204.0"
_HEADER = "session_start"
_HANDSHAKE_METHODS = ("droid.initialize_session", "droid.load_session")
_SESSION_NOTIFICATION = "droid.session_notification"
_TERMINAL = "agent_turn_completed"
_INTERRUPTED_REASONS = ("cancelled", "permission_rejected")
#: `machine_id` the SDK's own high-level session sends when none is configured.
_MACHINE_ID = "default"
_FRAME_TYPES = ("request", "notification", "response")


@dataclass(frozen=True)
class _Sdk:
    """The public droid_sdk symbols this backend uses, imported lazily."""

    DroidClient: type[Any]
    DroidConnectionError: type[Exception]
    DroidProtocolError: type[Exception]
    RequestPermissionResult: type[Any]
    AskUserResult: type[Any]
    AutonomyLevel: type[Any]
    attribution: dict[str, str]


def _import_sdk() -> _Sdk:
    try:
        import droid_sdk
        from droid_sdk.client import DroidClient
        from droid_sdk.errors import DroidConnectionError, DroidProtocolError
        from droid_sdk.schemas.cli import AskUserResult, RequestPermissionResult
        from droid_sdk.schemas.enums import AutonomyLevel, ClientType
    except ImportError:
        raise HarnessError(
            "factory-droid sdk sessions need the optional droid-sdk dependency: install 'harness-cli[factory-droid]'",
            code="launch-failed",
        ) from None
    version = getattr(droid_sdk, "__version__", None)
    if version != SUPPORTED_DROID_SDK_VERSION:
        raise HarnessError(
            f"droid-sdk {version!r} is installed; factory-droid sdk sessions are qualified against droid-sdk {SUPPORTED_DROID_SDK_VERSION} only",
            code="launch-failed",
        )
    # The same producer-owned attribution the SDK's own ProcessTransport
    # stamps on the child (client type plus `language/version` identity).
    attribution = {_FACTORY_OWNED_ENV[0]: ClientType.SDK.value, _FACTORY_OWNED_ENV[1]: f"python/{version}"}
    return _Sdk(
        DroidClient=DroidClient,
        DroidConnectionError=DroidConnectionError,
        DroidProtocolError=DroidProtocolError,
        RequestPermissionResult=RequestPermissionResult,
        AskUserResult=AskUserResult,
        AutonomyLevel=AutonomyLevel,
        attribution=attribution,
    )


def _sessions_root(env: dict[str, str]) -> Path | None:
    """`<FACTORY_HOME_OVERRIDE or HOME>/.factory/sessions` from the effective
    child environment (the override replaces `~`, not `~/.factory`)."""
    home = env.get("FACTORY_HOME_OVERRIDE") or env.get("HOME")
    return Path(home) / ".factory" / "sessions" if home else None


def _session_file(root: Path | None, session_id: str, workdir: Path) -> Path | None:
    """Native session log path for `session_id`; the CLI encodes the physical
    working directory, so symlinks are resolved first."""
    if root is None:
        return None
    return root / encode_project_dir(os.path.realpath(workdir)) / f"{session_id}.jsonl"


def _envelope_id(value: object) -> str | None:
    if isinstance(value, str):
        return value
    if isinstance(value, int) and not isinstance(value, bool):
        return str(value)
    return None


def _describe(exc: BaseException) -> str:
    text = " ".join(str(exc).split())
    return f"{type(exc).__name__}: {text[:500]}" if text else type(exc).__name__


class _Invalid(Exception):
    """A callback reply that must not reach the agent."""


class _CallbackFailed(Exception):
    """Raised back into the SDK so it answers the request with an error;
    the session is already failing closed."""


@dataclass
class _DroidTurn(_TurnBase):
    message_id: str = ""
    request_id: str = ""
    #: `add_user_message` returned: accepted, or rejected with `rejection`.
    acked: bool = False
    rejection: str | None = None
    #: Observed response envelope for `request_id` (raw of a rejected prompt).
    prompt_response: dict[str, object] | None = None
    interrupting: bool = False
    interrupt_acked: bool = False
    #: The native `agent_turn_completed` notification for `message_id`.
    terminal: dict[str, object] | None = None
    #: Message of the last native `error` notification seen during the turn.
    last_error: str | None = None


class _StdioTransport:
    """`droid_sdk.types.DroidClientTransport` over the session's owned child.

    Connected before the client exists (the child is spawned by the session),
    it serializes writes, records outgoing request ids and feeds the SDK the
    frames the session has already validated and observed.
    """

    def __init__(self, session: _FactoryDroidSession) -> None:
        self._session = session
        self._queue: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()
        self._write_lock = asyncio.Lock()
        self._closed = False
        #: Outgoing request id → method, until the response arrives.
        self.sent: dict[str, str] = {}

    @property
    def is_connected(self) -> bool:
        return self._session._child.proc is not None and not self._closed

    async def connect(self) -> None:
        if not self.is_connected:
            raise self._session._sdk.DroidConnectionError("the Harness-owned droid child is spawned before the client connects")

    async def send(self, message: str) -> None:
        session = self._session
        sdk = session._sdk
        failure = session._failure
        if self._closed or (failure is not None and failure.status != "closed"):
            # Only the graceful `close_session` of a caller-initiated close may
            # still write; every other failure has the group going down.
            raise sdk.DroidConnectionError("droid transport is closed")
        try:
            frame = json.loads(message)
        except ValueError:
            frame = None
        if isinstance(frame, dict) and frame.get("type") == "request" and isinstance(frame.get("id"), str) and isinstance(frame.get("method"), str):
            self.sent[frame["id"]] = frame["method"]
        data = message.encode("utf-8") + b"\n"
        try:
            async with self._write_lock:
                proc = session._child.proc
                assert proc is not None and proc.stdin is not None
                proc.stdin.write(data)
                await proc.stdin.drain()
        except (BrokenPipeError, ConnectionResetError, OSError, RuntimeError) as exc:
            if session._failure is None:
                session._spawn(session._classify_transport_loss(f"stdin write failed: {type(exc).__name__}: {exc}"))
            raise sdk.DroidConnectionError(f"stdin write failed: {type(exc).__name__}") from exc

    def push(self, frame: dict[str, Any]) -> None:
        if not self._closed:
            self._queue.put_nowait(frame)

    def end(self) -> None:
        """Stop feeding the SDK; its pending requests fail promptly."""
        if not self._closed:
            self._closed = True
            self._queue.put_nowait(None)

    async def read_messages(self) -> AsyncIterator[dict[str, Any]]:
        while True:
            frame = await self._queue.get()
            if frame is None:
                raise self._session._sdk.DroidConnectionError("droid transport is closed")
            yield frame

    async def close(self) -> None:
        """Idempotent. Called by the SDK's own `DroidClient.close`; when that
        happens outside the session's teardown the session closes with it."""
        if self._closed:
            return
        self.end()
        session = self._session
        session._fail("closed", None)
        teardown = session._teardown_task
        assert teardown is not None
        if teardown is not asyncio.current_task():
            await session._uncancellable(teardown)


class _FactoryDroidSession(LiveSession):
    """One `droid exec` child driven through the public DroidClient."""

    _active: _DroidTurn | None

    def __init__(self, spec: SessionSpec, prepared: PreparedCommand, sdk: _Sdk, sessions_root: Path | None) -> None:
        super().__init__(spec)
        assert spec.factory_droid is not None
        self._options: FactoryDroidOptions = spec.factory_droid
        self._prepared = prepared
        self._sdk = sdk
        self._sessions_root = sessions_root
        self._rt = spec.request_timeout_seconds
        self._child = _OwnedChild(_CHILD, self._loop, self._stderr, self._record_exit)
        self._transport = _StdioTransport(self)
        self._client: DroidClient | None = None
        #: The observed initialize / load response envelope.
        self._handshake: dict[str, object] | None = None
        self._notification_session_id: str | None = None

    def _record_exit(self, code: int) -> None:
        self._returncode = code

    # ---- backend hooks ----------------------------------------------------

    def _begin_turn(self, handle: SessionTurn, prompt: str) -> _DroidTurn:
        turn = _DroidTurn(handle=handle, message_id=str(uuid.uuid4()), request_id=str(uuid.uuid4()))
        self._spawn(self._submit(turn, prompt))
        return turn

    async def _abort(self, turn: _TurnBase) -> None:
        assert isinstance(turn, _DroidTurn)
        if not turn.interrupting:
            turn.interrupting = True
            await self._uncancellable(self._spawn(self._interrupt(turn)))

    def _abandon(self) -> None:
        self._abandoned = True
        if self._child.proc is not None:
            self._fail("closed", None)

    # ---- requests ---------------------------------------------------------

    async def _submit(self, turn: _DroidTurn, prompt: str) -> None:
        assert self._client is not None
        try:
            await asyncio.wait_for(
                self._client.add_user_message(text=prompt, message_id=turn.message_id, request_id=turn.request_id),
                self._rt,
            )
        except asyncio.TimeoutError:
            self._fail("protocol-error", f"add_user_message request {turn.request_id} received no response within {self._rt}s")
            return
        except self._sdk.DroidProtocolError as exc:
            turn.rejection = getattr(exc, "message", None) or str(exc)
        except Exception as exc:
            if self._failure is None:
                self._fail("protocol-error", f"add_user_message failed: {_describe(exc)}")
            return
        turn.acked = True
        self._maybe_finish(turn)

    async def _interrupt(self, turn: _DroidTurn) -> None:
        assert self._client is not None
        try:
            await asyncio.wait_for(self._client.interrupt_session(), self._rt)
        except asyncio.TimeoutError:
            self._fail("protocol-error", f"interrupt_session received no response within {self._rt}s")
            return
        except Exception as exc:
            if self._failure is None:
                self._fail("protocol-error", f"interrupt_session failed: {_describe(exc)}")
            return
        turn.interrupt_acked = True
        self._maybe_finish(turn)

    def _maybe_finish(self, turn: _DroidTurn) -> None:
        if turn.finished or self._failure is not None or not turn.acked:
            return
        if turn.rejection is not None:
            self._finish(turn, "agent-error", turn.prompt_response, f"prompt rejected: {turn.rejection}")
            return
        if turn.interrupting and not turn.interrupt_acked:
            return
        terminal = turn.terminal
        if terminal is None:
            return
        reason = terminal["reason"]
        status: SessionTurnStatus
        error: str | None
        if reason == "completed":
            status, error = "completed", None
        elif reason in _INTERRUPTED_REASONS:
            status, error = "interrupted", None
        else:
            status = "agent-error"
            error = f"agent turn ended with reason {reason!r}" + (f": {turn.last_error}" if turn.last_error else "")
        self._finish(turn, status, terminal, error)

    # ---- callbacks --------------------------------------------------------

    def _permission_handler(self, params: dict[str, Any]) -> Any:
        assert self._options.on_permission is not None
        return self._answer("on_permission", self._options.on_permission, params, self._check_permission)

    def _question_handler(self, params: dict[str, Any]) -> Any:
        assert self._options.on_question is not None
        return self._answer("on_question", self._options.on_question, params, self._check_question)

    async def _answer(
        self,
        name: str,
        callback: FactoryDroidCallback,
        params: dict[str, Any],
        check: Callable[[dict[str, Any], object], dict[str, Any]],
    ) -> dict[str, Any]:
        if self._failure is not None:
            raise _CallbackFailed("session is closed")
        try:
            reply = callback(deepcopy(params))
            if inspect.isawaitable(reply):
                reply = await asyncio.wait_for(asyncio.ensure_future(reply), self._rt)
            return check(params, reply)
        except asyncio.CancelledError:
            raise
        except asyncio.TimeoutError:
            cause = f"did not answer within request_timeout_seconds={self._rt}"
        except _Invalid as exc:
            cause = str(exc)
        except Exception as exc:
            cause = f"raised {_describe(exc)}"
        self._fail("agent-error", f"{name} {cause}")
        raise _CallbackFailed(cause)

    def _check_permission(self, params: dict[str, Any], reply: object) -> dict[str, Any]:
        if not isinstance(reply, dict):
            raise _Invalid(f"returned {type(reply).__name__}, not a permission response object")
        try:
            result = self._sdk.RequestPermissionResult.model_validate(reply)
        except Exception as exc:
            raise _Invalid(f"returned an invalid permission response: {_describe(exc)}") from None
        options = params.get("options")
        offered = [o["value"] for o in options if isinstance(o, dict) and isinstance(o.get("value"), str)] if isinstance(options, list) else []
        selected = result.selected_option
        selected = getattr(selected, "value", selected)
        if selected not in offered:
            raise _Invalid(f"selected {selected!r}, which the request did not offer (offered: {offered})")
        return result.model_dump(mode="json", by_alias=True, exclude_none=True)

    def _check_question(self, params: dict[str, Any], reply: object) -> dict[str, Any]:
        if not isinstance(reply, dict):
            raise _Invalid(f"returned {type(reply).__name__}, not a question response object")
        if not isinstance(reply.get("cancelled"), bool):
            raise _Invalid("returned a question response without a boolean 'cancelled'")
        payload = dict(reply)
        payload.setdefault("answers", [])
        try:
            result = self._sdk.AskUserResult.model_validate(payload)
        except Exception as exc:
            raise _Invalid(f"returned an invalid question response: {_describe(exc)}") from None
        questions = params.get("questions")
        offered = {q["index"] for q in questions if isinstance(q, dict) and isinstance(q.get("index"), int)} if isinstance(questions, list) else set()
        for answer in result.answers:
            if answer.index not in offered:
                raise _Invalid(f"answered question index {answer.index!r}, which the request did not offer (offered: {sorted(offered)})")
        return result.model_dump(mode="json", by_alias=True, exclude_none=True)

    # ---- frame handling ---------------------------------------------------

    def _handle_line(self, line: bytes) -> None:
        """Validate one incoming frame, observe it for events / turn state,
        then hand it to the SDK. After a failure frames still reach the SDK
        (the graceful `close_session` needs its response) but no longer
        become events."""
        if self._transport._closed:
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
        if frame.get("jsonrpc") != "2.0":
            self._fail("protocol-error", "frame is not a JSON-RPC 2.0 envelope")
            return
        kind = frame.get("type")
        if kind not in _FRAME_TYPES:
            self._fail("protocol-error", f"frame has unsupported type {kind!r}")
            return
        turn = self._active if self._active is not None and not self._active.finished else None
        size = len(line)
        if kind == "response":
            request_id = frame.get("id")
            if not isinstance(request_id, str):
                self._fail("protocol-error", "response without a string id")
                return
            method = self._transport.sent.pop(request_id, None)
            if method is None:
                self._fail("protocol-error", f"unexpected or duplicate response for request {request_id!r}")
                return
            if "result" not in frame and "error" not in frame:
                self._fail("protocol-error", f"response for request {request_id!r} has neither result nor error")
                return
            if method in _HANDSHAKE_METHODS:
                self._handshake = frame  # consumed by the identity handshake, never an event
            elif self._failure is None:
                if turn is not None and request_id == turn.request_id:
                    turn.prompt_response = frame
                self._emit("response", frame, request_id, turn, size)
        elif kind == "request":
            if not isinstance(frame.get("method"), str):
                self._fail("protocol-error", "request without a string method")
                return
            if self._failure is None:
                self._emit("request", frame, _envelope_id(frame.get("id")), turn, size)
        else:
            method = frame.get("method")
            if not isinstance(method, str) or not method:
                self._fail("protocol-error", "notification without a string method")
                return
            if method != _SESSION_NOTIFICATION:
                if self._failure is None:
                    self._emit(method, frame, None, turn, size)
            else:
                params = frame.get("params")
                inner = params.get("notification") if isinstance(params, dict) else None
                if not isinstance(inner, dict) or not isinstance(inner.get("type"), str) or not inner["type"]:
                    self._fail("protocol-error", "session notification has no notification object with a string type")
                    return
                if "sessionId" in params:
                    session_id = params["sessionId"]
                    if not isinstance(session_id, str) or not session_id:
                        self._fail("protocol-error", "session notification has no non-empty string sessionId")
                        return
                    expected = self._reference.session_id if self._reference else self._notification_session_id
                    if expected is not None and session_id != expected:
                        self._fail("protocol-error", f"notification names session {session_id!r}, expected {expected!r}")
                        return
                    self._notification_session_id = session_id
                if turn is not None and inner["type"] == _TERMINAL:
                    if "turnId" in inner and inner["turnId"] != turn.message_id:
                        self._fail("protocol-error", "agent_turn_completed does not match the submitted message")
                        return
                    if not isinstance(inner.get("reason"), str) or not inner["reason"]:
                        self._fail("protocol-error", "agent_turn_completed has no non-empty string reason")
                        return
                if self._failure is None:
                    self._emit(inner["type"], inner, None, turn, size)
                    if turn is not None:
                        self._observe(turn, inner)
        self._transport.push(frame)

    def _observe(self, turn: _DroidTurn, inner: dict[str, Any]) -> None:
        kind = inner["type"]
        if kind == "error":
            message = inner.get("message")
            if isinstance(message, str) and message:
                turn.last_error = message
            return
        if kind != _TERMINAL:
            return
        turn.terminal = inner
        self._maybe_finish(turn)

    # ---- child I/O --------------------------------------------------------

    async def _read_stdout(self, stream: asyncio.StreamReader) -> None:
        incomplete = await self._child.read_frames(stream, self._handle_line, lambda detail: self._fail("protocol-error", detail))
        if self._failure is not None:
            return
        if incomplete:
            self._fail("protocol-error", "stdout ended inside an incomplete JSON frame")
            return
        await self._classify_transport_loss("stdout closed")

    async def _classify_transport_loss(self, detail: str) -> None:
        status, error = await self._child.loss(detail)
        if self._failure is None:
            self._fail(status, error)

    # ---- teardown ---------------------------------------------------------

    async def _teardown(self) -> None:
        failure = self._failure
        child = self._child
        assert failure is not None and child.proc is not None
        turn = self._active
        if turn is not None and turn.timer is not None:
            turn.timer.cancel()
        client = self._client
        if failure.status == "closed" and client is not None and client.session_id is not None and not child.exited.is_set():
            # Best effort, inside the same deadline the group gets anyway.
            try:
                await asyncio.wait_for(client.close_session(reason="other"), _TERM_GRACE)
            except (asyncio.TimeoutError, Exception):
                pass
        self._transport.end()
        disposal = await child.dispose()
        if client is not None:
            try:
                await asyncio.wait_for(client.close(), _DRAIN_BUDGET)
            except (asyncio.TimeoutError, Exception):
                pass
        for task in list(self._tasks):
            if task.done():
                continue
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass
        if turn is not None and not turn.finished:
            self._finish(turn, failure.status, turn.terminal, failure.error)
        self._idle._close()
        # Preserve the lease when live resources could not be released safely.
        if disposal.group_error is not None:
            raise disposal.group_error
        if not child.exited.is_set():
            raise HarnessError(f"{_CHILD} process {child.proc.pid} could not be reaped within the teardown budget", code="adapter-error")
        cleanup_command(self._prepared)
        if disposal.stdin_error is not None:
            raise disposal.stdin_error

    # ---- startup ----------------------------------------------------------

    async def _startup(self, argv: list[str], env: dict[str, str]) -> None:
        try:
            await self._child.spawn(argv, self._spec.workdir, env, self._read_stdout)
        except OSError as exc:
            cleanup_command(self._prepared)
            raise HarnessError(f"failed to launch {argv[0]!r}: {exc.strerror or exc}", code="launch-failed") from None
        if self._abandoned:
            self._fail("closed", None)
        client = self._sdk.DroidClient(transport=self._transport)
        self._client = client
        if self._options.on_permission is not None:
            client.set_permission_handler(self._permission_handler)
        if self._options.on_question is not None:
            client.set_ask_user_handler(self._question_handler)
        method = _HANDSHAKE_METHODS[1 if self._spec.resume is not None else 0]
        typed: Any = None
        try:
            await client.connect()  # the transport is already connected: this only wires the SDK engine
            if self._failure is None:
                typed = await asyncio.wait_for(self._initialize(client), self._rt)
        except asyncio.TimeoutError:
            self._fail("protocol-error", f"{method} received no response within {self._rt}s")
        except Exception as exc:
            if self._failure is None:
                self._fail("protocol-error", f"{method} failed: {_describe(exc)}")
        if self._failure is not None:
            await self._raise_startup_failure(_CHILD)
        try:
            reference = self._identity(client, typed)
        except HarnessError as exc:
            self._fail("protocol-error", str(exc))
            await self._raise_startup_failure(_CHILD)
        self._reference = reference
        self._flush_prelude(None)

    async def _initialize(self, client: DroidClient) -> Any:
        spec = self._spec
        options = self._options
        tools = None if options.disabled_tools is None else list(options.disabled_tools)
        if spec.resume is not None:
            return await client.load_session(
                session_id=spec.resume.session_id,
                disabled_tool_ids=tools,
                auto_reject_permission_requests=options.auto_reject_permission_requests,
                disable_builtin_skills=options.disable_builtin_skills,
            )
        return await client.initialize_session(
            machine_id=_MACHINE_ID,
            cwd=str(spec.workdir),
            autonomy_level=None if options.autonomy is None else self._sdk.AutonomyLevel(options.autonomy),
            model_id=spec.model,
            disabled_tool_ids=tools,
            auto_reject_permission_requests=options.auto_reject_permission_requests,
            disable_builtin_skills=options.disable_builtin_skills,
        )

    def _identity(self, client: DroidClient, typed: Any) -> SessionReference:
        """Native identity from the typed result, the observed response
        envelope and the saved session log; any inconsistency is an error."""
        spec = self._spec
        envelope = self._handshake
        if envelope is None:
            raise HarnessError("the handshake response was not observed on the transport")
        version = envelope.get("factoryProtocolVersion")
        if version != _CLI_PROTOCOL:
            raise HarnessError(f"Droid CLI 0.213.0 uses protocol {_CLI_PROTOCOL}; received {version!r}")
        api = envelope.get("factoryApiVersion")
        if api != "1.0.0":
            raise HarnessError(f"handshake response carries unsupported factoryApiVersion {api!r}")
        result = envelope.get("result")
        if not isinstance(result, dict):
            raise HarnessError("handshake response has no result object")
        session = result.get("session")
        echoed = session.get("id") if isinstance(session, dict) else None
        session_id = typed.session_id if spec.resume is None else spec.resume.session_id
        if self._notification_session_id is not None and self._notification_session_id != session_id:
            raise HarnessError("notifications before the handshake named a different native session")
        if spec.resume is None:
            if not isinstance(session_id, str) or not session_id:
                raise HarnessError("initialize_session reported no sessionId")
            if echoed is not None and echoed != session_id:
                raise HarnessError(f"initialize_session result names session {echoed!r} but sessionId {session_id!r}")
            path = _session_file(self._sessions_root, session_id, spec.workdir)
            if path is None:
                raise HarnessError("neither FACTORY_HOME_OVERRIDE nor HOME is set; the native session log cannot be located")
            _verify_session_header(
                SessionReference(session_id=session_id, session_file=path, workdir=spec.workdir),
                header_type=_HEADER,
                label="native session log",
            )
            return SessionReference(session_id=session_id, session_file=path, workdir=spec.workdir)
        if client.session_id != session_id:
            raise HarnessError(f"load_session left the client on session {client.session_id!r}, expected {session_id!r}")
        for name, value in (("sessionId", result.get("sessionId")), ("session.id", echoed)):
            if value is not None and value != session_id:
                raise HarnessError(f"load_session result {name} is {value!r}, expected {session_id!r}")
        cwd = typed.cwd
        if not isinstance(cwd, str) or not cwd:
            raise HarnessError("load_session reported no cwd; the restored working directory cannot be verified")
        if not _same_dir(cwd, spec.workdir):
            raise HarnessError(f"load_session restored cwd {cwd!r}, not {str(spec.workdir)!r}")
        if typed.is_agent_loop_in_progress is True:
            raise HarnessError("loaded session still has an agent loop in progress")
        return SessionReference(session_id=session_id, session_file=spec.resume.session_file, workdir=spec.workdir)


async def open_factory_droid_session(spec: SessionSpec) -> LiveSession:
    """Open the validated factory-droid `spec` (see `open_session`): resume
    identity, environment API key and SDK version are checked before any
    filesystem preparation or child."""
    env = os.environ.copy()
    env.update(spec.env)
    root = _sessions_root(env)
    if spec.resume is not None:
        expected = _session_file(root, spec.resume.session_id, spec.workdir)
        if expected is None:
            raise HarnessError("neither FACTORY_HOME_OVERRIDE nor HOME is set; resume.session_file cannot be verified", code="invalid-options")
        if spec.resume.session_file != expected:
            raise HarnessError(
                f"resume.session_file {str(spec.resume.session_file)!r} is not the native session log for {spec.resume.session_id!r} under the effective HOME ({str(expected)!r})",
                code="invalid-options",
            )
        _verify_session_header(spec.resume, header_type=_HEADER)
    if not env.get("FACTORY_API_KEY"):
        raise HarnessError(
            "FACTORY_API_KEY is not set in the effective environment; factory-droid sdk sessions authenticate with an environment API key only",
            code="launch-failed",
        )
    sdk = _import_sdk()
    built = _build(spec)
    env.update(sdk.attribution)
    prepared = prepare_command(built)
    session = _FactoryDroidSession(spec, prepared, sdk, root)
    await _await_startup(session, session._startup([built.cmd] + built.args, env))
    return session


__all__ = ["open_factory_droid_session"]
