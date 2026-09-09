"""Caller-owned OpenHands Agent Server 1.45.0 HTTP/WebSocket sessions.

Startup verifies explicit profile/model/native identity, then waits for sync
and initial state. A turn appends with run=False, matches its durable user
echo, and calls /run; only a durable terminal plus final full_state completes
it. Interrupt waits for an accepted owned run and native paused evidence.

Close owns only client connections/tasks, never the remote server or history.
Provider credentials stay in the selected server profile. Callback exclusion
is a caller prerequisite, not a remotely inspectable client guarantee.
See SPEC.md's OpenHands contract for source pins and qualification limits.
"""
from __future__ import annotations

import asyncio
import json
import uuid
from dataclasses import dataclass
from math import isfinite
from typing import TYPE_CHECKING, Any

from harness.base import ErrorCode, HarnessError
from harness.sessions import (
    MAX_FRAME_BYTES,
    SUPPORTED_OPENHANDS_SERVER_VERSION,
    LiveSession,
    SessionEvent,
    SessionReference,
    SessionSpec,
    SessionTurn,
    SessionTurnStatus,
    _await_startup,
    _CONTROL_CHARS,
    _OPENHANDS_PROFILE_NAME,
    _OPENHANDS_UUID,
    _reject_constant,
    _TurnBase,
)

if TYPE_CHECKING:
    import httpx

_READ_SIZE = 65536
_MAX_SAFE_INTEGER = 9007199254740991
#: Seconds the closing handshake of the owned socket may take before it is
#: abandoned; the server side is never killed.
_CLOSE_BUDGET = 1.0
_VERSION_FIELDS = ("version", "sdk_version", "tools_version", "workspace_version")
_KNOWN_STATUSES = frozenset({"idle", "running", "paused", "waiting_for_confirmation", "finished", "error", "stuck", "deleting"})
#: Statuses under which nothing may be appended: another writer owns the run.
_BUSY_STATUSES = ("running", "waiting_for_confirmation", "deleting")
#: Native execution_status values that end the current run.
_TURN_END = ("finished", "error", "stuck", "paused", "waiting_for_confirmation")
_STATE_EVENT = "ConversationStateUpdateEvent"
_MESSAGE_EVENT = "MessageEvent"
#: Native error events whose message is kept as the turn's error detail.
_ERROR_EVENTS = ("AgentErrorEvent", "ConversationErrorEvent", "ServerErrorEvent")
_UNSUPPORTED_APPROVAL = (
    "conversation is waiting_for_confirmation: native approval is not supported on openhands sessions"
    " (approval capability false); nothing was confirmed, rejected or re-run"
)
#: WebSocket protocol/data violations, distinct from ordinary transport closure.
_PROTOCOL_CLOSE_CODES = {1002: "protocol violation", 1003: "unsupported frame data", 1007: "frame is not valid UTF-8", 1009: f"frame exceeds {MAX_FRAME_BYTES} bytes"}
#: Handle failure status recorded for a startup error of the given code.
_STARTUP_STATUS: dict[ErrorCode, SessionTurnStatus] = {"launch-failed": "disconnected", "session-closed": "closed"}


class _TransportError(Exception):
    """Connection, timeout or decoding failure; the message never carries body bytes."""


class _ProtocolError(Exception):
    """The server answered, but not with the pinned protocol."""


@dataclass
class _WsTurn(_TurnBase):
    prompt: str = ""
    #: Resolves when the durable user `MessageEvent` echoing `prompt` arrived.
    echo: asyncio.Future[None] | None = None
    #: `POST .../events` was issued (the message may be appended server-side).
    submitted: bool = False
    #: `POST .../run` was issued; terminal transitions count from here on.
    run_issued: bool = False
    run_accepted: bool = False
    abort_sent: bool = False
    #: Durable `execution_status` event ending the run, and its value.
    terminal: dict[str, object] | None = None
    terminal_status: str | None = None
    #: Transient `full_state` value published after `terminal`.
    state: dict[str, object] | None = None
    last_error: str | None = None
    abort_requested: bool = False
    abort_acknowledged: bool = False
    abort_timer: asyncio.TimerHandle | None = None


def _import_dependencies() -> tuple[Any, Any, Any]:
    try:
        import httpx
        from websockets import exceptions as ws_exceptions
        from websockets.asyncio import client as ws_client
    except ImportError as exc:
        raise HarnessError(
            f"openhands sessions need the optional httpx and websockets dependencies (missing {exc.name!r}): install 'harness-cli[openhands]'",
            code="launch-failed",
        ) from None
    return httpx, ws_client, ws_exceptions


def _safe_int(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= _MAX_SAFE_INTEGER


def _finite_float(value: str) -> float:
    number = float(value)
    if not isfinite(number):
        raise ValueError("non-finite JSON number")
    return number


def _short(text: object, limit: int = 200) -> str:
    """Bounded, control-character-free excerpt of a server-supplied string."""
    if not isinstance(text, str):
        return ""
    return _CONTROL_CHARS.sub("?", text)[:limit]


def _detail(body: object) -> str | None:
    """FastAPI `detail` string from an error body, bounded; never the body."""
    if isinstance(body, dict):
        detail = body.get("detail")
        if isinstance(detail, str) and detail:
            return _short(detail)
        if isinstance(detail, dict) and isinstance(detail.get("message"), str) and detail["message"]:
            return _short(detail["message"])
    return None


class _OpenHandsSession(LiveSession):
    """HTTP + session-socket session on a caller-owned OpenHands Agent Server."""

    _active: _WsTurn | None

    def __init__(self, spec: SessionSpec) -> None:
        super().__init__(spec)
        assert spec.openhands is not None and spec.model is not None
        self._options = spec.openhands
        self._model = spec.model
        self._directory = spec.workdir.as_posix()
        self._rt = spec.request_timeout_seconds
        self._httpx: Any = None
        self._ws_client: Any = None
        self._ws_exc: Any = None
        self._client: httpx.AsyncClient | None = None
        self._socket: Any = None
        self._synced: asyncio.Future[None] = self._loop.create_future()
        #: Next durable `seq` the socket must deliver; None until synced.
        self._next_seq: int | None = None
        self._profile_id = ""
        self._profile_revision = 0

    # ---- backend hooks ----------------------------------------------------

    def _begin_turn(self, handle: SessionTurn, prompt: str) -> _WsTurn:
        turn = _WsTurn(handle=handle, prompt=prompt, echo=self._loop.create_future())
        self._spawn(self._prompt(turn))
        return turn

    async def _abort(self, turn: _TurnBase) -> None:
        """`POST .../interrupt`; the native paused / terminal outcome must
        follow within `request_timeout_seconds`, else the handle fails explicitly."""
        assert isinstance(turn, _WsTurn)
        if turn.abort_requested:
            return
        turn.abort_requested = True
        turn.abort_timer = self._loop.call_later(self._rt, self._on_abort_timeout, turn)
        if turn.run_accepted:
            self._spawn(self._send_interrupt(turn))

    def _abandon(self) -> None:
        self._abandoned = True
        if self._client is not None:
            self._fail("closed", None)

    def _finish(self, turn: _TurnBase, status: SessionTurnStatus, raw: dict[str, object] | None, error: str | None) -> None:
        assert isinstance(turn, _WsTurn)
        if turn.abort_timer is not None:
            turn.abort_timer.cancel()
        if turn.echo is not None and not turn.echo.done():
            turn.echo.set_result(None)
        super()._finish(turn, status, raw, error)

    # ---- HTTP ---------------------------------------------------------------

    async def _exchange(self, method: str, path: str, *, body: object | None = None) -> tuple[int, bytes]:
        """One request bounded by `request_timeout_seconds`; `(status, body
        bytes)` with the body capped at `MAX_FRAME_BYTES`."""
        try:
            return await asyncio.wait_for(self._exchange_once(method, path, body), self._rt)
        except asyncio.TimeoutError:
            raise _TransportError(f"{method} {path} exceeded request_timeout_seconds={self._rt}") from None

    async def _exchange_once(self, method: str, path: str, body: object | None) -> tuple[int, bytes]:
        assert self._client is not None
        headers = {"accept": "application/json"}
        content: bytes | None = None
        if body is not None:
            content = json.dumps(body, ensure_ascii=False).encode("utf-8")
            headers["content-type"] = "application/json"
        request = self._client.build_request(method, path, content=content, headers=headers)
        try:
            response = await self._client.send(request, stream=True)
        except Exception as exc:
            raise _TransportError(f"{method} {path}: {type(exc).__name__}") from None
        try:
            if response.status_code in (200, 201) and response.headers.get("content-type", "").split(";", 1)[0].strip().lower() != "application/json":
                raise _ProtocolError(f"{method} {path} did not return application/json")
            data = await self._read_body(response, f"{method} {path}")
        finally:
            await response.aclose()
        return response.status_code, data

    async def _read_body(self, response: httpx.Response, what: str) -> bytes:
        data = bytearray()
        try:
            async for chunk in response.aiter_bytes(_READ_SIZE):
                data += chunk
                if len(data) > MAX_FRAME_BYTES:
                    raise _ProtocolError(f"{what} body exceeds {MAX_FRAME_BYTES} bytes")
        except _ProtocolError:
            raise
        except Exception as exc:
            raise _TransportError(f"{what}: {type(exc).__name__} while reading the response") from None
        return bytes(data)

    def _parse_json(self, data: bytes) -> object:
        """Parsed JSON, or None for an empty or non-JSON body."""
        if not data:
            return None
        try:
            return json.loads(data.decode("utf-8"), parse_constant=_reject_constant, parse_float=_finite_float)
        except (UnicodeDecodeError, ValueError, RecursionError):
            return None

    async def _probe(self, method: str, path: str) -> dict[str, object]:
        """Startup request: transport failure / non-200 is `launch-failed`,
        an unparseable success is `protocol-error`."""
        try:
            status, data = await self._exchange(method, path)
        except _TransportError as exc:
            raise HarnessError(f"cannot reach openhands server {self._options.endpoint}: {exc}", code="launch-failed") from None
        except _ProtocolError as exc:
            raise HarnessError(str(exc), code="protocol-error") from None
        return self._require_object(status, data, f"{method} {path}", 200)

    def _require_object(self, status: int, data: bytes, what: str, expected: int) -> dict[str, object]:
        if status != expected:
            detail = _detail(self._parse_json(data))
            raise HarnessError(f"{what} returned HTTP {status}" + (f": {detail}" if detail else ""), code="launch-failed")
        parsed = self._parse_json(data)
        if not isinstance(parsed, dict):
            raise HarnessError(f"{what} did not return a JSON object", code="protocol-error")
        return parsed

    # ---- turn ----------------------------------------------------------------

    async def _prompt(self, turn: _WsTurn) -> None:
        conversation = f"/api/conversations/{self.reference.session_id}"
        try:
            info = await self._fetch_conversation()
            if turn.finished or self._failure is not None:
                return
            status = self._validate_conversation(info, f"GET {conversation}")
            if status in _BUSY_STATUSES:
                self._finish(
                    turn,
                    "agent-error",
                    info,
                    f"conversation is {status!r} on the server; nothing was appended (another client owns the current run)",
                )
                return
            turn.submitted = True
            body = {"role": "user", "content": [{"type": "text", "text": turn.prompt}], "run": False}
            status_code, data = await self._exchange("POST", f"{conversation}/events", body=body)
            if turn.finished or self._failure is not None or not self._acknowledged(turn, f"POST {conversation}/events", status_code, data):
                return
            assert turn.echo is not None
            try:
                await asyncio.wait_for(asyncio.shield(turn.echo), self._rt)
            except asyncio.TimeoutError:
                raise _ProtocolError(f"the user message was not echoed on the session socket within request_timeout_seconds={self._rt}") from None
            if turn.finished or self._failure is not None:
                return
            turn.run_issued = True
            status_code, data = await self._exchange("POST", f"{conversation}/run")
            if turn.finished or self._failure is not None or not self._acknowledged(turn, f"POST {conversation}/run", status_code, data):
                return
            turn.run_accepted = True
        except _TransportError as exc:
            self._fail("disconnected", f"turn request failed: {exc}")
            return
        except _ProtocolError as exc:
            self._fail("protocol-error", str(exc))
            return
        self._maybe_finish(turn)
        if turn.abort_requested and not turn.finished and self._failure is None:
            self._spawn(self._send_interrupt(turn))

    async def _fetch_conversation(self) -> dict[str, object]:
        path = f"/api/conversations/{self.reference.session_id}"
        status, data = await self._exchange("GET", path)
        if status != 200:
            detail = _detail(self._parse_json(data))
            raise _ProtocolError(f"GET {path} returned HTTP {status}" + (f": {detail}" if detail else ""))
        parsed = self._parse_json(data)
        if not isinstance(parsed, dict):
            raise _ProtocolError(f"GET {path} did not return a JSON object")
        return parsed

    def _validate_conversation(self, info: dict[str, object], what: str) -> str:
        """Identity, workspace, launched-profile provenance, native agent and
        model of a `ConversationInfo`; returns its known `execution_status`."""
        expected = self.reference.session_id
        if info.get("id") != expected:
            raise _ProtocolError(f"{what} returned conversation {info.get('id')!r}, not {expected!r}")
        workspace = info.get("workspace")
        if not isinstance(workspace, dict) or workspace.get("kind") != "LocalWorkspace" or workspace.get("working_dir") != self._directory:
            raise _ProtocolError(f"{what} reports a workspace other than LocalWorkspace {self._directory!r}")
        launched = info.get("launched_agent_profile")
        if (
            not isinstance(launched, dict)
            or launched.get("agent_profile_id") != self._profile_id
            or not _safe_int(launched.get("revision"))
            or launched["revision"] != self._profile_revision
        ):
            raise _ProtocolError(
                f"{what} was not launched from agent profile {self._options.agent_profile!r} (id {self._profile_id}, revision {self._profile_revision})"
            )
        agent = info.get("agent")
        agent_kind = agent.get("kind") if isinstance(agent, dict) else None
        if not isinstance(agent, dict) or agent_kind != "Agent":
            raise _ProtocolError(f"{what} reports agent kind {agent_kind!r}, not the native 'Agent'")
        llm = agent.get("llm")
        model = llm.get("model") if isinstance(llm, dict) else None
        if model != self._model:
            raise _ProtocolError(f"{what} reports model {model!r}, not the requested {self._model!r}")
        status = info.get("execution_status")
        if not isinstance(status, str) or status not in _KNOWN_STATUSES:
            raise _ProtocolError(f"{what} reports unknown execution_status {status!r}")
        return status

    def _acknowledged(self, turn: _WsTurn, what: str, status: int, data: bytes) -> bool:
        """HTTP 200 `{"success": true}`. A rejection settles the turn as
        `agent-error` with the numeric status; a malformed 200 is a protocol failure."""
        parsed = self._parse_json(data)
        if status != 200:
            raw: dict[str, object] = {"http_status": status, "body": parsed if isinstance(parsed, dict) else None}
            detail = _detail(parsed)
            self._finish(turn, "agent-error", raw, f"{what} was rejected with HTTP {status}" + (f": {detail}" if detail else ""))
            return False
        if not isinstance(parsed, dict) or parsed.get("success") is not True:
            raise _ProtocolError(f'{what} did not acknowledge with {{"success": true}}')
        return True

    def _maybe_finish(self, turn: _WsTurn) -> None:
        if turn.finished or self._failure is not None:
            return
        if not turn.run_accepted or turn.terminal is None or turn.state is None:
            return
        if turn.abort_sent and not turn.abort_acknowledged:
            return
        status = turn.terminal_status
        raw: dict[str, object] = {"state": turn.state, "terminal_event": turn.terminal}
        if status == "finished":
            self._finish(turn, "completed", raw, None)
        elif status == "error":
            self._finish(turn, "agent-error", raw, turn.last_error or "conversation ended with execution_status 'error'")
        elif status == "stuck":
            self._finish(turn, "stuck", raw, "conversation ended with execution_status 'stuck' (native stuck detection)")
        elif status == "paused":
            self._finish(turn, "interrupted", raw, None if turn.abort_requested else "run paused on the server without a local interrupt")
        else:
            self._finish(turn, "agent-error", raw, _UNSUPPORTED_APPROVAL)
            self._fail("agent-error", _UNSUPPORTED_APPROVAL)

    async def _send_interrupt(self, turn: _WsTurn) -> None:
        if turn.finished or self._failure is not None or turn.abort_sent:
            return
        turn.abort_sent = True
        path = f"/api/conversations/{self.reference.session_id}/interrupt"
        try:
            status, data = await self._exchange("POST", path)
        except _TransportError as exc:
            self._fail("disconnected", f"interrupt request failed: {exc}")
            return
        except _ProtocolError as exc:
            self._fail("protocol-error", str(exc))
            return
        if turn.finished or self._failure is not None:
            return
        parsed = self._parse_json(data)
        if status != 200 or not isinstance(parsed, dict) or parsed.get("success") is not True:
            self._fail("protocol-error", f"interrupt was not acknowledged with HTTP 200 {{\"success\": true}} (HTTP {status})")
            return
        turn.abort_acknowledged = True
        self._maybe_finish(turn)

    def _on_abort_timeout(self, turn: _WsTurn) -> None:
        if turn.finished:
            return
        self._fail("protocol-error", f"turn {turn.handle.id} did not reach paused / a terminal execution_status within request_timeout_seconds={self._rt} after interrupt")

    # ---- events --------------------------------------------------------------

    async def _read_frames(self, socket: Any) -> None:
        exceptions = self._ws_exc
        try:
            while True:
                message = await socket.recv()
                if isinstance(message, bytes):
                    self._fail("protocol-error", "session socket sent a binary frame; only JSON text frames are valid")
                    return
                self._handle_frame(message)
                if self._failure is not None:
                    return
        except exceptions.ConnectionClosed as exc:
            if self._failure is not None:
                return
            sent, rcvd = exc.sent, exc.rcvd
            if sent is not None and sent.code in _PROTOCOL_CLOSE_CODES and (rcvd is None or exc.rcvd_then_sent is False):
                self._fail("protocol-error", f"session socket {_PROTOCOL_CLOSE_CODES[sent.code]}")
                return
            if rcvd is not None and rcvd.code in _PROTOCOL_CLOSE_CODES:
                self._fail("protocol-error", f"session socket peer reported a protocol/data violation (close code {rcvd.code})")
                return
            if rcvd is None:
                detail = "without a close frame"
            else:
                reason = _short(rcvd.reason)
                detail = f"code {rcvd.code}" + (f": {reason}" if reason else "")
            self._fail("disconnected", f"session socket closed by the server ({detail})")
        except Exception as exc:
            if self._failure is None:
                self._fail("disconnected", f"session socket failed: {type(exc).__name__}")

    def _handle_frame(self, text: str) -> None:
        try:
            envelope = json.loads(text, parse_constant=_reject_constant, parse_float=_finite_float)
        except (ValueError, RecursionError) as exc:
            self._fail("protocol-error", f"session socket frame is not valid JSON: {exc}")
            return
        if not isinstance(envelope, dict):
            self._fail("protocol-error", f"session socket frame is a JSON {type(envelope).__name__}, not an object")
            return
        kind = envelope.get("type")
        if not isinstance(kind, str) or not kind:
            self._fail("protocol-error", "session socket frame has no string 'type'")
            return
        turn = self._active if self._active is not None and not self._active.finished else None
        event: dict[str, object] | None = None
        try:
            if self._next_seq is None:
                if kind != "sync":
                    raise _ProtocolError(f"first session socket frame was {kind!r}, expected 'sync'")
                self._check_sync(envelope)
            elif kind == "sync":
                raise _ProtocolError("session socket sent a second 'sync' frame")
            elif kind == "durable":
                event = self._check_durable(envelope)
            elif kind == "transient":
                event = self._check_event(envelope.get("event"), "transient")
            elif kind == "error":
                code, detail = envelope.get("code"), envelope.get("detail")
                if not isinstance(code, str) or not isinstance(detail, str):
                    raise _ProtocolError("session socket 'error' frame has no string code / detail")
        except _ProtocolError as exc:
            self._fail("protocol-error", str(exc))
            return
        request_id = event.get("id") if event is not None else None
        self._enqueue(
            SessionEvent(
                backend="rpc",
                harness="openhands",
                session_id=self.reference.session_id,
                turn_id=None if turn is None else turn.handle.id,
                request_id=request_id if isinstance(request_id, str) else None,
                type=str(event["kind"]) if event is not None else kind,
                raw=envelope,
            ),
            turn,
            len(text.encode("utf-8")),
        )
        if self._failure is not None:
            return
        if kind == "sync":
            return
        if kind == "error":
            self._fail("protocol-error", f"session socket reported error {_short(envelope['code'], 64)!r}: {_short(envelope['detail'])}")
            return
        if event is None:
            return
        try:
            if kind == "durable":
                self._apply_durable(event, turn)
            else:
                self._apply_transient(event, turn)
        except _ProtocolError as exc:
            self._fail("protocol-error", str(exc))
            return
        if turn is not None and not turn.finished:
            self._maybe_finish(turn)

    def _check_sync(self, envelope: dict[str, object]) -> None:
        if envelope.get("from_seq") is not None:
            raise _ProtocolError("session socket sync frame echoes an after_seq replay that was never requested")
        through = envelope.get("through_seq")
        if through is None:
            self._next_seq = 0
        elif _safe_int(through):
            self._next_seq = through + 1
        else:
            raise _ProtocolError(f"session socket sync frame has an invalid through_seq {through!r}")

    def _check_durable(self, envelope: dict[str, object]) -> dict[str, object]:
        seq = envelope.get("seq")
        if not _safe_int(seq):
            raise _ProtocolError(f"durable frame has no safe non-negative integer seq ({seq!r})")
        expected = self._next_seq
        assert expected is not None and isinstance(seq, int)
        if seq != expected:
            problem = "duplicates or regresses" if seq < expected else "skips"
            raise _ProtocolError(f"durable seq {seq} {problem} the contiguous sequence (expected {expected}); the subscription is not lossless")
        self._next_seq = seq + 1
        return self._check_event(envelope.get("event"), "durable")

    def _check_event(self, event: object, kind: str) -> dict[str, object]:
        if not isinstance(event, dict):
            raise _ProtocolError(f"{kind} frame has no event object")
        if not isinstance(event.get("kind"), str) or not event["kind"]:
            raise _ProtocolError(f"{kind} event has no string 'kind'")
        if not isinstance(event.get("id"), str) or not event["id"]:
            raise _ProtocolError(f"{kind} {event['kind']} event has no string 'id'")
        if event["kind"] == _STATE_EVENT and not isinstance(event.get("key"), str):
            raise _ProtocolError(f"{kind} {_STATE_EVENT} has no string 'key'")
        if event["kind"] == _MESSAGE_EVENT and not isinstance(event.get("llm_message"), dict):
            raise _ProtocolError(f"{kind} {_MESSAGE_EVENT} has no llm_message object")
        return event

    def _apply_durable(self, event: dict[str, object], turn: _WsTurn | None) -> None:
        kind = event["kind"]
        if kind == _MESSAGE_EVENT:
            if turn is not None and turn.submitted and turn.echo is not None and not turn.echo.done() and _is_echo(event, turn.prompt):
                turn.echo.set_result(None)
            return
        if kind == _STATE_EVENT:
            if event.get("key") != "execution_status":
                return
            value = event.get("value")
            if not isinstance(value, str) or value not in _KNOWN_STATUSES:
                raise _ProtocolError(f"durable execution_status update carries unknown value {value!r}")
            if turn is not None and turn.run_issued and turn.state is None:
                if value in _TURN_END:
                    turn.terminal, turn.terminal_status = event, value
                else:
                    turn.terminal = turn.terminal_status = None
                turn.state = None
            return
        if kind in _ERROR_EVENTS and turn is not None:
            message = event.get("error") if kind == "AgentErrorEvent" else event.get("detail")
            code = event.get("code")
            text = _short(message, 2000)
            if isinstance(code, str) and code:
                text = f"{_short(code, 128)}: {text}" if text else _short(code, 128)
            if text:
                turn.last_error = f"{kind}: {text}"

    def _apply_transient(self, event: dict[str, object], turn: _WsTurn | None) -> None:
        if event["kind"] != _STATE_EVENT or event.get("key") != "full_state":
            return
        value = event.get("value")
        if not isinstance(value, dict):
            raise _ProtocolError("transient full_state snapshot is not an object")
        status = value.get("execution_status")
        if not isinstance(status, str) or status not in _KNOWN_STATUSES:
            raise _ProtocolError(f"transient full_state snapshot reports unknown execution_status {status!r}")
        if not self._synced.done():
            self._synced.set_result(None)
        if turn is None or turn.terminal is None or turn.state is not None:
            return
        if status == turn.terminal_status:
            turn.state = value
        else:
            turn.terminal = turn.terminal_status = turn.state = None

    # ---- startup -------------------------------------------------------------

    async def _startup(self) -> None:
        self._httpx, self._ws_client, self._ws_exc = _import_dependencies()
        self._client = self._httpx.AsyncClient(
            base_url=self._options.endpoint,
            headers={"accept": "application/json", "x-session-api-key": self._options.api_key},
            timeout=self._httpx.Timeout(self._rt),
            trust_env=False,
            follow_redirects=False,
        )
        if self._abandoned:
            self._fail("closed", None)
            await self._raise_startup_failure("session-closed")
        code: ErrorCode = "protocol-error"
        own_failure = False
        try:
            await self._handshake()
        except HarnessError as exc:
            code = exc.code
            if self._failure is None:
                own_failure = True
                self._fail(_STARTUP_STATUS.get(code, "protocol-error"), str(exc))
        if self._failure is not None:
            if not own_failure:
                # The socket failed underneath the handshake.
                code = "launch-failed" if self._failure.status == "disconnected" else "protocol-error"
            await self._raise_startup_failure(code)

    async def _handshake(self) -> None:
        spec = self._spec
        info = await self._probe("GET", "/server_info")
        versions: dict[str, object] = {}
        for name in _VERSION_FIELDS:
            version = info.get(name)
            if not isinstance(version, str):
                raise HarnessError(f"GET /server_info did not report a string {name}", code="protocol-error")
            versions[name] = version
        if any(version != SUPPORTED_OPENHANDS_SERVER_VERSION for version in versions.values()):
            reported = ", ".join(f"{name}={version!r}" for name, version in versions.items())
            raise HarnessError(
                f"openhands server reports {reported}; only {SUPPORTED_OPENHANDS_SERVER_VERSION} is qualified for every package",
                code="unsupported-backend",
            )
        name = self._options.agent_profile
        document = await self._probe("GET", f"/api/agent-profiles/{name}")
        profile = document.get("profile")
        if document.get("name") != name or not isinstance(profile, dict) or profile.get("name") != name:
            raise HarnessError(f"GET /api/agent-profiles/{name} returned a profile named {document.get('name')!r}", code="protocol-error")
        agent_kind = profile.get("agent_kind")
        if agent_kind == "acp":
            raise HarnessError(f"agent profile {name!r} is an ACP profile; only native 'openhands' agent profiles are supported", code="unsupported-capability")
        if agent_kind != "openhands":
            raise HarnessError(f"agent profile {name!r} has agent_kind {agent_kind!r}, expected 'openhands'", code="protocol-error")
        profile_id = profile.get("id")
        if not isinstance(profile_id, str) or _OPENHANDS_UUID.fullmatch(profile_id) is None:
            raise HarnessError(f"agent profile {name!r} has no canonical UUID id", code="protocol-error")
        revision = profile.get("revision")
        if not _safe_int(revision):
            raise HarnessError(f"agent profile {name!r} has no non-negative integer revision", code="protocol-error")
        llm_ref = profile.get("llm_profile_ref")
        if not isinstance(llm_ref, str) or _OPENHANDS_PROFILE_NAME.fullmatch(llm_ref) is None:
            raise HarnessError(f"agent profile {name!r} has no valid llm_profile_ref", code="protocol-error")
        llm_document = await self._probe("GET", f"/api/profiles/{llm_ref}")
        config = llm_document.get("config")
        if llm_document.get("name") != llm_ref or not isinstance(config, dict):
            raise HarnessError(f"GET /api/profiles/{llm_ref} returned a profile named {llm_document.get('name')!r}", code="protocol-error")
        if config.get("model") != self._model:
            raise HarnessError(
                f"LLM profile {llm_ref!r} (referenced by agent profile {name!r}) uses model {config.get('model')!r}, not the requested {self._model!r}",
                code="protocol-error",
            )
        assert isinstance(revision, int)
        self._profile_id, self._profile_revision = profile_id, revision
        if spec.resume is not None:
            session_id = spec.resume.session_id
            what = f"GET /api/conversations/{session_id}"
            conversation = await self._probe("GET", f"/api/conversations/{session_id}")
        else:
            session_id = str(uuid.uuid4())
            what = "POST /api/conversations"
            conversation = await self._create(session_id)
        self._reference = SessionReference(session_id=session_id, session_file=None, workdir=spec.workdir, endpoint=self._options.endpoint)
        try:
            self._validate_conversation(conversation, what)
        except _ProtocolError as exc:
            raise HarnessError(str(exc), code="protocol-error") from None
        self._socket = await self._subscribe()
        self._spawn(self._read_frames(self._socket))
        try:
            await asyncio.wait_for(asyncio.shield(self._synced), self._rt)
        except asyncio.TimeoutError:
            raise HarnessError(f"session socket sent no sync plus initial full_state within request_timeout_seconds={self._rt}", code="protocol-error") from None

    async def _create(self, session_id: str) -> dict[str, object]:
        body = {
            "conversation_id": session_id,
            "agent_profile_id": self._profile_id,
            "workspace": {"kind": "LocalWorkspace", "working_dir": self._directory},
            "worktree": False,
            "autotitle": False,
        }
        try:
            status, data = await self._exchange("POST", "/api/conversations", body=body)
        except _TransportError as exc:
            raise HarnessError(f"cannot reach openhands server {self._options.endpoint}: {exc}", code="launch-failed") from None
        except _ProtocolError as exc:
            raise HarnessError(str(exc), code="protocol-error") from None
        if status == 200:
            raise HarnessError(
                f"POST /api/conversations returned HTTP 200: conversation {session_id} already existed; a fresh identity is required and never reused",
                code="protocol-error",
            )
        return self._require_object(status, data, "POST /api/conversations", 201)

    async def _subscribe(self) -> Any:
        client, exceptions = self._ws_client, self._ws_exc
        endpoint = self._options.endpoint
        url = ("wss" if endpoint.startswith("https://") else "ws") + endpoint[endpoint.index("://"):] + f"/sockets/session/{self.reference.session_id}"

        class _Connect(client.connect):
            """`connect` that refuses every redirect: first-frame auth must
            reach the configured origin only."""

            def process_redirect(self, exc: Exception) -> Exception:
                return exc

        try:
            socket = await asyncio.wait_for(
                _Connect(
                    url,
                    compression=None,
                    proxy=None,
                    open_timeout=None,
                    ping_interval=None,
                    ping_timeout=None,
                    close_timeout=_CLOSE_BUDGET,
                    max_size=MAX_FRAME_BYTES,
                ),
                self._rt,
            )
        except asyncio.TimeoutError:
            raise HarnessError(f"session socket handshake did not complete within request_timeout_seconds={self._rt}", code="launch-failed") from None
        except exceptions.InvalidStatus as exc:
            response = getattr(exc, "response", None)
            raise HarnessError(f"session socket handshake returned HTTP {getattr(response, 'status_code', '?')}", code="launch-failed") from None
        except Exception as exc:
            raise HarnessError(f"cannot open the session socket: {type(exc).__name__}", code="launch-failed") from None
        try:
            await asyncio.wait_for(socket.send(json.dumps({"type": "auth", "session_api_key": self._options.api_key})), self._rt)
        except BaseException as exc:
            try:
                await socket.close()
            except Exception:
                pass
            if isinstance(exc, asyncio.CancelledError):
                raise
            raise HarnessError(f"cannot send the session socket auth frame: {type(exc).__name__}", code="launch-failed") from None
        return socket

    async def _raise_startup_failure(self, code: ErrorCode) -> None:
        assert self._failure is not None and self._teardown_task is not None
        failure = self._failure
        cleanup_error: BaseException | None = None
        try:
            await self._teardown_task
        except Exception as exc:
            cleanup_error = exc
        if failure.status == "closed":
            code = "session-closed"
        detail = f"openhands startup failed ({failure.status}" + (f": {failure.error})" if failure.error else ")")
        raise HarnessError(detail, code=code) from cleanup_error

    # ---- teardown ------------------------------------------------------------

    async def _teardown(self) -> None:
        failure = self._failure
        assert failure is not None
        turn = self._active
        if turn is not None:
            if turn.timer is not None:
                turn.timer.cancel()
            if turn.abort_timer is not None:
                turn.abort_timer.cancel()
        if not self._synced.done():
            self._synced.set_result(None)
        tasks = [task for task in self._tasks if not task.done()]
        for task in tasks:
            task.cancel()
        for task in tasks:
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass
        close_error: Exception | None = None
        if self._socket is not None:
            try:
                await self._socket.close()
            except Exception as exc:
                close_error = exc
        if self._client is not None:
            try:
                await self._client.aclose()
            except Exception as exc:
                close_error = close_error or exc
        if turn is not None and not turn.finished:
            raw = None if turn.terminal is None else {"state": turn.state, "terminal_event": turn.terminal}
            self._finish(turn, failure.status, raw, failure.error)
        self._idle._close()
        if close_error is not None:
            raise HarnessError(f"openhands transport did not close cleanly: {type(close_error).__name__}", code="adapter-error") from close_error


def _is_echo(event: dict[str, object], prompt: str) -> bool:
    """A durable user `MessageEvent` whose concatenated text content is
    exactly `prompt`; native extra fields are tolerated."""
    if event.get("source") != "user":
        return False
    message = event["llm_message"]
    assert isinstance(message, dict)
    if message.get("role") != "user":
        return False
    content = message.get("content")
    if not isinstance(content, list):
        raise _ProtocolError("user MessageEvent llm_message.content is not a list")
    parts: list[str] = []
    for item in content:
        if not isinstance(item, dict):
            raise _ProtocolError("user MessageEvent content item is not an object")
        if item.get("type") == "text":
            text = item.get("text")
            if not isinstance(text, str):
                raise _ProtocolError("user MessageEvent text content has no string text")
            parts.append(text)
    return "".join(parts) == prompt


async def open_openhands_session(spec: SessionSpec) -> LiveSession:
    """Open the validated OpenHands `spec` (see `open_session`)."""
    _import_dependencies()
    session = _OpenHandsSession(spec)
    await _await_startup(session, session._startup())
    return session


__all__ = ["open_openhands_session"]
