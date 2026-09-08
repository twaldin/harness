"""OpenCode live sessions over a caller-owned `opencode serve` instance.

Direct HTTP requests plus the `GET /event` SSE stream of the pinned server
(anomalyco/opencode v1.18.29; `SUPPORTED_OPENCODE_SERVER_VERSION`). Nothing
is spawned: the caller runs the server, owns it and keeps owning it. This
module opens and closes only its own client connections, tasks and stream.
It never calls instance / global dispose, session delete or share, config,
provider, auth or TUI routes, and never aborts a run it did not start.

Open: `GET /global/health` (exact version), `GET /path?directory=` (the server
must retain the requested directory literally), `GET /session/{id}` (resume)
or `POST /session` (new), then `GET /event?directory=` and the native
`server.connected` frame; a resumed session must also be idle in
`GET /session/status`. Every scoped request carries `directory=<workdir>`.

Turn: `POST /session/{id}/message` with an explicit `msg_` message ID and one
text part. The documented synchronous route returns HTTP 200 with the final
assistant message only after the native run loop finished; the server
publishes `session.status` idle before answering. The turn settles once BOTH
the validated response (assistant, selected session, `parentID` equal to the
submitted message ID) AND an SSE idle observed after the echo of our own user
message have arrived, so queued events drain first. HTTP 204, headers, an
earlier idle or any assistant step never complete a turn. `interrupt` is
`POST /session/{id}/abort` (boolean acknowledgement) followed by the same
settlement, bounded by `request_timeout_seconds`.

Ownership: the caller must be the only writer of the selected session while
the handle lives. Upstream offers no lease; `session.status` busy / retry
while no local turn is active is the only foreign-writer proof and fails the
handle (`protocol-error`) without aborting the other client's run. Message
events whose IDs are not the current turn's (summary / prune of old messages,
compaction or subtask synthesized users) stay visible on `LiveSession.events`
with `turn_id=None`; a final response whose `parentID` is not the submitted
message ID fails the turn with `protocol-error` rather than claiming it.

Close only tears down the client side: local requests and the stream are
cancelled and the active turn settles `closed`; a prompt still running on the
server keeps running and its history is untouched. No process exit is ever
observed: `exit_code` / `signal` are None and stderr is empty with byte count 0.
"""
from __future__ import annotations

import asyncio
import base64
import json
import math
import re
import secrets
import time
from collections.abc import Iterator
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from harness.base import ErrorCode, HarnessError
from harness.sessions import (
    MAX_FRAME_BYTES,
    SUPPORTED_OPENCODE_SERVER_VERSION,
    LiveSession,
    OpenCodeApprovalResponse,
    SessionEvent,
    SessionReference,
    SessionSpec,
    SessionTurn,
    SessionTurnStatus,
    _OPENCODE_SESSION_ID,
    _await_startup,
    _CONTROL_CHARS,
    _reject_constant,
    _TurnBase,
)

if TYPE_CHECKING:
    import httpx

_READ_SIZE = 65536
#: Assistant message IDs the current turn may own (one per native step);
#: overflow is a protocol failure, never silent growth.
_MAX_OWN_MESSAGES = 4096
#: Outstanding `permission.asked` requests tracked for `respond_approval`.
_MAX_PERMISSIONS = 1024
_BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
_ABORTED = "MessageAbortedError"
#: `info.finish` values that are not a final answer.
_UNFINISHED = ("tool-calls", "unknown")
_APPROVAL_RESPONSES = ("once", "reject")
#: Handle failure status recorded for a startup error of the given code.
_STARTUP_STATUS: dict[ErrorCode, SessionTurnStatus] = {"launch-failed": "disconnected", "session-closed": "closed"}


class _TransportError(Exception):
    """Connection, timeout or decoding failure; the message never carries body bytes."""


class _ProtocolError(Exception):
    """The server answered, but not with the pinned protocol."""


@dataclass
class _HttpTurn(_TurnBase):
    message_id: str = ""
    #: Message IDs of this turn: the submitted user message and every
    #: assistant message whose `parentID` is it. Cleared on settlement.
    own: set[str] = field(default_factory=set)
    user_seen: bool = False
    idle_seen: bool = False
    #: Validated HTTP 200 payload (`{"info": assistant, "parts": [...]}`).
    response: dict[str, object] | None = None
    abort_requested: bool = False
    abort_acknowledged: bool = False
    abort_timer: asyncio.TimerHandle | None = None


class _MessageIds:
    """`msg_` IDs in the server's own ascending shape: 48 bits of
    `(unix_ms << 12) + counter` as 12 hex digits plus 14 random base62."""

    def __init__(self) -> None:
        self._last_ms = 0
        self._counter = 0

    def next(self) -> str:
        now_ms = int(time.time() * 1000)
        if now_ms != self._last_ms:
            self._last_ms = now_ms
            self._counter = 0
        self._counter += 1
        stamp = ((now_ms << 12) + self._counter) & ((1 << 48) - 1)
        return "msg_" + format(stamp, "012x") + "".join(secrets.choice(_BASE62) for _ in range(14))


class _SseParser:
    """Incremental `text/event-stream` parser: LF / CR / CRLF line ends,
    comments, `data:` accumulation, other fields ignored. The unprocessed
    tail plus the data of the event under construction never exceed `cap`."""

    def __init__(self, cap: int) -> None:
        self._cap = cap
        self._buffer = bytearray()
        self._data: list[bytes] = []
        self._data_bytes = 0
        self._frame_bytes = 0
        self._skip_lf = False

    @property
    def partial(self) -> bool:
        return bool(self._buffer) or bool(self._data)

    def feed(self, chunk: bytes) -> Iterator[bytes]:
        buffer = self._buffer
        if self._skip_lf:
            self._skip_lf = False
            if chunk[:1] == b"\n":
                chunk = chunk[1:]
        buffer += chunk
        start = 0
        while True:
            cr = buffer.find(b"\r", start)
            lf = buffer.find(b"\n", start)
            if cr < 0 and lf < 0:
                break
            end = min(e for e in (cr, lf) if e >= 0)
            consumed = end + 1
            if end == cr:
                if consumed == len(buffer):
                    self._skip_lf = True
                elif buffer[consumed] == 0x0A:
                    consumed += 1
            line = bytes(buffer[start:end])
            self._frame_bytes += consumed - start
            if self._frame_bytes > self._cap:
                raise _ProtocolError(f"SSE frame exceeds {self._cap} bytes")
            start = consumed
            if not line:
                self._frame_bytes = 0
                if self._data:
                    yield b"\n".join(self._data)
                    self._data = []
                    self._data_bytes = 0
                continue
            if line[:1] == b":":
                continue
            name, sep, value = line.partition(b":")
            if sep and value[:1] == b" ":
                value = value[1:]
            if name == b"data":
                self._data_bytes += len(value) + 1
                if self._data_bytes > self._cap:
                    raise _ProtocolError(f"SSE event exceeds {self._cap} bytes")
                self._data.append(value)
        del buffer[:start]
        if len(buffer) + self._frame_bytes > self._cap:
            raise _ProtocolError(f"SSE line exceeds {self._cap} bytes without a line end")


def _import_httpx() -> Any:
    try:
        import httpx
    except ImportError:
        raise HarnessError(
            "opencode sessions need the optional httpx dependency: install 'harness-cli[opencode]'",
            code="launch-failed",
        ) from None
    return httpx


def _event_session(kind: str, props: dict[str, object]) -> str | None:
    sid = props.get("sessionID")
    if isinstance(sid, str):
        return sid
    for key in ("info", "part"):
        nested = props.get(key)
        if isinstance(nested, dict) and isinstance(nested.get("sessionID"), str):
            return nested["sessionID"]
    if kind.startswith("session."):
        info = props.get("info")
        if isinstance(info, dict) and isinstance(info.get("id"), str):
            return info["id"]
    return None


def _event_message(kind: str, props: dict[str, object]) -> str | None:
    """Message ID a `message.*` event belongs to, if it names one."""
    if not kind.startswith("message."):
        return None
    info = props.get("info")
    if isinstance(info, dict) and isinstance(info.get("id"), str):
        return info["id"]
    part = props.get("part")
    if isinstance(part, dict) and isinstance(part.get("messageID"), str):
        return part["messageID"]
    message_id = props.get("messageID")
    return message_id if isinstance(message_id, str) else None


def _native_request_id(kind: str, props: dict[str, object]) -> str | None:
    """Native message or permission ID an event reflects; never fabricated."""
    if kind.startswith("permission."):
        for key in ("id", "requestID"):
            value = props.get(key)
            if isinstance(value, str):
                return value
        return None
    return _event_message(kind, props)


def _error_name(body: object) -> str | None:
    """Short native error name plus `ref` from a non-200 body; never the body itself."""
    if not isinstance(body, dict):
        return None
    for key in ("name", "_tag"):
        value = body.get(key)
        if isinstance(value, str) and value and len(value) <= 128 and _CONTROL_CHARS.search(value) is None:
            ref = body.get("ref")
            if isinstance(ref, str) and ref.startswith("err_") and len(ref) <= 64 and _CONTROL_CHARS.search(ref) is None:
                return f"{value} ({ref})"
            return value
    return None


class _OpenCodeSession(LiveSession):
    """HTTP + SSE session on a caller-owned OpenCode server."""

    _active: _HttpTurn | None

    def __init__(self, spec: SessionSpec) -> None:
        super().__init__(spec)
        assert spec.opencode is not None
        self._options = spec.opencode
        self._directory = spec.workdir.as_posix()
        self._rt = spec.request_timeout_seconds
        self._httpx: Any = None
        self._client: httpx.AsyncClient | None = None
        self._stream: httpx.Response | None = None
        self._connected: asyncio.Future[None] = self._loop.create_future()
        self._parser = _SseParser(MAX_FRAME_BYTES)
        self._ids = _MessageIds()
        self._permissions: set[str] = set()
        model: dict[str, str] | None = None
        if spec.model is not None:
            provider, _, model_id = spec.model.partition("/")
            model = {"providerID": provider, "modelID": model_id}
        self._model = model

    # ---- public surface ---------------------------------------------------

    async def respond_approval(self, request_id: str, response: OpenCodeApprovalResponse) -> None:
        """Answer an outstanding `permission.asked` request of this session with
        `POST /permission/{id}/reply`. `once` allows this call, `reject`
        refuses it (upstream also rejects every other pending request of the
        session). `always` is refused before any request: it mutates the
        instance-wide approved rules shared by every client of the server."""
        if not isinstance(request_id, str) or re.fullmatch(r"per_[0-9A-Za-z]+", request_id) is None:
            raise HarnessError("request_id must be a non-empty native permission ID", code="invalid-options")
        if response == "always":
            raise HarnessError(
                "approval response 'always' would install an instance-wide rule on the caller-owned server; only 'once' and 'reject' are supported",
                code="unsupported-capability",
            )
        if response not in _APPROVAL_RESPONSES:
            raise HarnessError(f"approval response must be 'once' or 'reject', got {response!r}", code="invalid-options")
        self._check_open()
        if request_id not in self._permissions:
            raise HarnessError(f"no outstanding permission request {request_id!r} on session {self.reference.session_id}", code="invalid-options")
        # Reserve before yielding; concurrent callers cannot reply twice.
        self._permissions.remove(request_id)
        try:
            status, body = await self._exchange("POST", f"/permission/{request_id}/reply", body={"reply": response})
        except asyncio.CancelledError:
            self._fail("closed", "approval caller cancelled")
            assert self._teardown_task is not None
            await self._uncancellable(self._teardown_task)
            raise
        except _TransportError as exc:
            self._fail("disconnected", f"permission reply failed: {exc}")
            raise HarnessError(f"permission reply {request_id!r} failed: {exc}", code="protocol-error") from None
        except _ProtocolError as exc:
            self._fail("protocol-error", str(exc))
            raise HarnessError(str(exc), code="protocol-error") from None
        if status == 404:
            raise HarnessError(f"permission request {request_id!r} is no longer outstanding on the server", code="invalid-options")
        if status != 200:
            detail = _error_name(self._parse_json(body))
            self._fail("protocol-error", f"permission reply was not acknowledged (HTTP {status})")
            raise HarnessError(
                f"permission reply {request_id!r} was refused with HTTP {status}" + (f" {detail}" if detail else ""),
                code="protocol-error",
            )
        if self._parse_json(body) is not True:
            self._fail("protocol-error", f"POST /permission/{request_id}/reply did not return boolean true")
            raise HarnessError(f"permission reply {request_id!r} was not acknowledged with true", code="protocol-error")

    # ---- backend hooks ----------------------------------------------------

    def _begin_turn(self, handle: SessionTurn, prompt: str) -> _HttpTurn:
        turn = _HttpTurn(handle=handle, message_id=self._ids.next())
        turn.own.add(turn.message_id)
        self._spawn(self._prompt(turn, prompt))
        return turn

    async def _abort(self, turn: _TurnBase) -> None:
        """`POST /session/{id}/abort`; settlement (response + idle) must follow
        within `request_timeout_seconds`, else the handle fails explicitly."""
        assert isinstance(turn, _HttpTurn)
        if turn.abort_requested:
            return
        turn.abort_requested = True
        turn.abort_timer = self._loop.call_later(self._rt, self._on_abort_timeout, turn)
        await self._uncancellable(self._spawn(self._send_abort(turn)))

    def _abandon(self) -> None:
        self._abandoned = True
        if self._client is not None:
            self._fail("closed", None)

    def _finish(self, turn: _TurnBase, status: SessionTurnStatus, raw: dict[str, object] | None, error: str | None) -> None:
        assert isinstance(turn, _HttpTurn)
        if turn.abort_timer is not None:
            turn.abort_timer.cancel()
        turn.own.clear()
        super()._finish(turn, status, raw, error)

    # ---- HTTP ---------------------------------------------------------------

    async def _exchange(
        self,
        method: str,
        path: str,
        *,
        body: object | None = None,
        directory: bool = True,
        bounded: bool = True,
    ) -> tuple[int, bytes]:
        """One request; `(status, body bytes)` with the body capped at
        `MAX_FRAME_BYTES`. `bounded` wraps the whole exchange in
        `request_timeout_seconds`; otherwise only connect / write / pool are
        bounded and the read waits for the server (the prompt route)."""
        coro = self._exchange_once(method, path, body, directory, bounded)
        if not bounded:
            return await coro
        try:
            return await asyncio.wait_for(coro, self._rt)
        except asyncio.TimeoutError:
            raise _TransportError(f"{method} {path} exceeded request_timeout_seconds={self._rt}") from None

    async def _exchange_once(self, method: str, path: str, body: object | None, directory: bool, bounded: bool) -> tuple[int, bytes]:
        assert self._client is not None
        httpx = self._httpx
        headers = {"accept": "application/json"}
        content: bytes | None = None
        if body is not None:
            content = json.dumps(body, ensure_ascii=False).encode("utf-8")
            headers["content-type"] = "application/json"
        request = self._client.build_request(
            method,
            path,
            params={"directory": self._directory} if directory else None,
            content=content,
            headers=headers,
            timeout=httpx.Timeout(self._rt) if bounded else httpx.Timeout(self._rt, read=None),
        )
        try:
            response = await self._client.send(request, stream=True)
        except Exception as exc:
            raise _TransportError(f"{method} {path}: {type(exc).__name__}") from None
        try:
            if response.status_code == 200 and response.headers.get("content-type", "").split(";", 1)[0].strip().lower() != "application/json":
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
            return json.loads(data.decode("utf-8"), parse_constant=_reject_constant)
        except (UnicodeDecodeError, ValueError):
            return None

    def _require_object(self, status: int, data: bytes, what: str) -> dict[str, object]:
        """HTTP 200 JSON object, else the startup error the status maps to."""
        if status != 200:
            detail = _error_name(self._parse_json(data))
            raise HarnessError(f"{what} returned HTTP {status}" + (f" {detail}" if detail else ""), code="launch-failed")
        parsed = self._parse_json(data)
        if not isinstance(parsed, dict):
            raise HarnessError(f"{what} did not return a JSON object", code="protocol-error")
        return parsed

    # ---- turn ----------------------------------------------------------------

    async def _prompt(self, turn: _HttpTurn, prompt: str) -> None:
        session_id = self.reference.session_id
        body: dict[str, object] = {"messageID": turn.message_id, "parts": [{"type": "text", "text": prompt}]}
        if self._model is not None:
            body["model"] = self._model
        # The server joins an existing runner instead of rejecting concurrent
        # prompts. This check is advisory; parentID remains the final proof.
        try:
            state_status, state_data = await self._exchange("GET", "/session/status")
            states = self._parse_json(state_data)
            if state_status != 200 or not isinstance(states, dict):
                raise _ProtocolError("GET /session/status did not return a status object")
            state = states.get(session_id)
            if state is not None and (not isinstance(state, dict) or state.get("type") != "idle"):
                raise _ProtocolError("session is already active on the server; exclusive session access is required")
            status, data = await self._exchange("POST", f"/session/{session_id}/message", body=body, bounded=False)
        except _TransportError as exc:
            self._fail("disconnected", f"prompt request failed: {exc}")
            return
        except _ProtocolError as exc:
            self._fail("protocol-error", str(exc))
            return
        if turn.finished or self._failure is not None:
            return
        if status == 204 or 300 <= status < 400:
            self._fail("protocol-error", f"prompt returned HTTP {status} without an assistant message; the turn cannot be settled")
            return
        parsed = self._parse_json(data)
        if isinstance(parsed, dict):
            turn.response = parsed
        if status != 200:
            detail = _error_name(parsed)
            raw = parsed if isinstance(parsed, dict) else None
            self._finish(turn, "agent-error", raw, f"prompt rejected: HTTP {status}" + (f" {detail}" if detail else ""))
            return
        try:
            turn.response = self._validate_response(turn, parsed)
        except _ProtocolError as exc:
            self._fail("protocol-error", str(exc))
            return
        self._maybe_finish(turn)

    def _validate_response(self, turn: _HttpTurn, payload: object) -> dict[str, object]:
        if not isinstance(payload, dict):
            raise _ProtocolError("prompt response is not a JSON object")
        info = payload.get("info")
        if not isinstance(info, dict):
            raise _ProtocolError("prompt response has no 'info' message object")
        if info.get("role") != "assistant":
            raise _ProtocolError(f"prompt response info.role is {info.get('role')!r}, expected 'assistant'")
        if info.get("sessionID") != self.reference.session_id:
            raise _ProtocolError(f"prompt response belongs to session {info.get('sessionID')!r}, not {self.reference.session_id!r}")
        parent = info.get("parentID")
        if parent != turn.message_id:
            raise _ProtocolError(
                f"prompt response assistant {info.get('id')!r} answers message {parent!r}, not the submitted {turn.message_id!r};"
                " correlation with this turn cannot be claimed (foreign writer, compaction or subtask)"
            )
        message_id = info.get("id")
        if not isinstance(message_id, str) or not message_id.startswith("msg_"):
            raise _ProtocolError("prompt response assistant has no 'msg_' id")
        if not isinstance(payload.get("parts"), list):
            raise _ProtocolError("prompt response has no 'parts' list")
        error = info.get("error")
        if error is not None and (not isinstance(error, dict) or not isinstance(error.get("name"), str) or not error["name"]):
            raise _ProtocolError("prompt response info.error is not an object with a string 'name'")
        finish = info.get("finish")
        if finish is not None and not isinstance(finish, str):
            raise _ProtocolError("prompt response info.finish is not a string")
        completed = info.get("time")
        if not isinstance(completed, dict) or isinstance(completed.get("completed"), bool) or not isinstance(completed.get("completed"), (int, float)) or not math.isfinite(completed["completed"]) or completed["completed"] < 0:
            raise _ProtocolError("prompt response assistant has no completed timestamp")
        if error is None and (not finish or finish in _UNFINISHED):
            raise _ProtocolError("prompt response assistant has no terminal finish")
        self._own(turn, message_id)
        return payload

    def _own(self, turn: _HttpTurn, message_id: str) -> None:
        if message_id in turn.own:
            return
        if len(turn.own) >= _MAX_OWN_MESSAGES:
            self._fail("protocol-error", f"turn {turn.handle.id} produced more than {_MAX_OWN_MESSAGES} assistant messages")
            return
        turn.own.add(message_id)

    def _maybe_finish(self, turn: _HttpTurn) -> None:
        if turn.finished or self._failure is not None:
            return
        response = turn.response
        if response is None or not turn.user_seen or not turn.idle_seen:
            return
        if turn.abort_requested and not turn.abort_acknowledged:
            return
        info = response["info"]
        assert isinstance(info, dict)
        error = info.get("error")
        if isinstance(error, dict):
            name = error["name"]
            if name == _ABORTED:
                detail = None if turn.abort_requested else "assistant run aborted on the server without a local interrupt"
                self._finish(turn, "interrupted", response, detail)
                return
            data = error.get("data")
            message = data.get("message") if isinstance(data, dict) else None
            self._finish(turn, "agent-error", response, f"{name}: {message[:2000]}" if isinstance(message, str) and message else name)
            return
        self._finish(turn, "completed", response, None)

    async def _send_abort(self, turn: _HttpTurn) -> None:
        try:
            status, data = await self._exchange("POST", f"/session/{self.reference.session_id}/abort")
        except _TransportError as exc:
            self._fail("disconnected", f"abort request failed: {exc}")
            return
        except _ProtocolError as exc:
            self._fail("protocol-error", str(exc))
            return
        if turn.finished or self._failure is not None:
            return
        acknowledged = self._parse_json(data)
        if status != 200 or acknowledged is not True:
            self._fail("protocol-error", f"abort was not acknowledged with boolean true (HTTP {status})")
            return
        turn.abort_acknowledged = True
        self._maybe_finish(turn)

    def _on_abort_timeout(self, turn: _HttpTurn) -> None:
        if turn.finished:
            return
        self._fail("protocol-error", f"turn {turn.handle.id} did not settle within request_timeout_seconds={self._rt} after abort")

    # ---- events --------------------------------------------------------------

    async def _read_events(self, response: httpx.Response) -> None:
        try:
            async for chunk in response.aiter_bytes():
                for data in self._parser.feed(chunk):
                    self._handle_event(data)
                    if self._failure is not None:
                        return
                if self._failure is not None:
                    return
        except _ProtocolError as exc:
            self._fail("protocol-error", str(exc))
            return
        except Exception as exc:
            self._fail("disconnected", f"event stream failed: {type(exc).__name__}")
            return
        if self._failure is not None:
            return
        if self._parser.partial:
            self._fail("protocol-error", "event stream ended inside an incomplete SSE event")
            return
        self._fail("disconnected", "event stream closed by the server")

    def _handle_event(self, data: bytes) -> None:
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError as exc:
            self._fail("protocol-error", f"SSE event is not valid UTF-8: {exc.reason} at byte {exc.start}")
            return
        try:
            event = json.loads(text, parse_constant=_reject_constant)
        except ValueError as exc:
            self._fail("protocol-error", f"SSE event is not valid JSON: {exc}")
            return
        if not isinstance(event, dict):
            self._fail("protocol-error", f"SSE event is a JSON {type(event).__name__}, not an object")
            return
        kind = event.get("type")
        if not isinstance(kind, str) or not kind:
            self._fail("protocol-error", "SSE event has no string 'type'")
            return
        if not self._connected.done():
            if kind != "server.connected":
                self._fail("protocol-error", f"first SSE event was {kind!r}, expected 'server.connected'")
                return
            self._connected.set_result(None)
        props = event.get("properties")
        if not isinstance(props, dict):
            props = {}
        session_id = self.reference.session_id
        event_session = _event_session(kind, props)
        if event_session is not None and event_session != session_id:
            return  # another session on the same server
        if kind in ("session.status", "permission.asked", "permission.replied", "message.updated", "message.removed", "message.part.updated", "message.part.removed", "message.part.delta"):
            if event_session is None:
                self._fail("protocol-error", f"{kind} event has no session identity")
                return
        if kind == "message.updated":
            info = props.get("info")
            if not isinstance(info, dict) or info.get("sessionID") != session_id or not isinstance(info.get("id"), str) or not info["id"].startswith("msg_") or info.get("role") not in ("user", "assistant"):
                self._fail("protocol-error", "message.updated has malformed or conflicting native identity")
                return
        if kind == "permission.asked":
            permission_id = props.get("id")
            if not isinstance(permission_id, str) or re.fullmatch(r"per_[0-9A-Za-z]+", permission_id) is None:
                self._fail("protocol-error", "permission.asked has no safe native permission ID")
                return
        turn = self._active if self._active is not None and not self._active.finished else None
        foreign: str | None = None
        if kind == "session.status":
            status = props.get("status")
            state = status.get("type") if isinstance(status, dict) else None
            if state not in ("idle", "busy", "retry"):
                self._fail("protocol-error", "session.status event has no supported status.type")
                return
            if state == "idle":
                if turn is not None and turn.user_seen:
                    turn.idle_seen = True
            elif turn is not None:
                turn.idle_seen = False
            elif turn is None:
                foreign = f"session {session_id} became {state!r} without a local turn; another client is driving it"
        elif kind == "message.updated" and turn is not None:
            info = props.get("info")
            if isinstance(info, dict):
                if info.get("role") == "user" and info.get("id") == turn.message_id:
                    turn.user_seen = True
                elif info.get("role") == "assistant" and info.get("parentID") == turn.message_id and isinstance(info.get("id"), str):
                    self._own(turn, info["id"])
        elif kind == "permission.asked":
            permission_id = props.get("id")
            if isinstance(permission_id, str) and permission_id:
                if len(self._permissions) >= _MAX_PERMISSIONS and permission_id not in self._permissions:
                    self._fail("protocol-error", f"more than {_MAX_PERMISSIONS} outstanding permission requests")
                    return
                self._permissions.add(permission_id)
        elif kind == "permission.replied":
            replied = props.get("requestID")
            if isinstance(replied, str):
                self._permissions.discard(replied)
        message_id = _event_message(kind, props)
        target = turn if not kind.startswith("server.") and (message_id is None or (turn is not None and message_id in turn.own)) else None
        self._enqueue(
            SessionEvent(
                backend="rpc",
                harness="opencode",
                session_id=session_id,
                turn_id=None if target is None else target.handle.id,
                request_id=_native_request_id(kind, props),
                type=kind,
                raw=event,
            ),
            target,
            len(data),
        )
        if kind == "server.instance.disposed":
            self._fail("disconnected", "server instance was disposed")
            return
        if foreign is not None:
            self._fail("protocol-error", foreign)
        elif turn is not None and not turn.finished:
            self._maybe_finish(turn)

    # ---- startup -------------------------------------------------------------

    async def _startup(self) -> None:
        httpx = _import_httpx()
        self._httpx = httpx
        headers = {"accept": "application/json"}
        if self._options.auth == "basic":
            token = base64.b64encode(f"{self._options.username}:{self._options.password}".encode("utf-8")).decode("ascii")
            headers["authorization"] = f"Basic {token}"
        self._client = httpx.AsyncClient(
            base_url=self._options.endpoint,
            headers=headers,
            timeout=httpx.Timeout(self._rt),
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
                # The event stream failed underneath the handshake.
                code = "launch-failed" if self._failure.status == "disconnected" else "protocol-error"
            await self._raise_startup_failure(code)

    async def _handshake(self) -> None:
        spec = self._spec
        health = await self._probe("GET", "/global/health", directory=False)
        if health.get("healthy") is not True:
            raise HarnessError("GET /global/health did not report healthy: true", code="protocol-error")
        version = health.get("version")
        if not isinstance(version, str):
            raise HarnessError("GET /global/health did not report a string version", code="protocol-error")
        if version != SUPPORTED_OPENCODE_SERVER_VERSION:
            hint = " (an unversioned local build)" if version == "local" else ""
            raise HarnessError(
                f"opencode server reports version {version!r}{hint}; only {SUPPORTED_OPENCODE_SERVER_VERSION} is qualified",
                code="unsupported-backend",
            )
        path = await self._probe("GET", "/path")
        if path.get("directory") != self._directory:
            raise HarnessError(
                f"opencode server resolved directory {path.get('directory')!r} for the requested {self._directory!r}; pass the server's canonical directory",
                code="protocol-error",
            )
        if spec.resume is not None:
            session_id = spec.resume.session_id
            info = await self._probe("GET", f"/session/{session_id}")
            if info.get("id") != session_id:
                raise HarnessError(f"GET /session/{session_id} returned session {info.get('id')!r}", code="protocol-error")
        else:
            info = await self._probe("POST", "/session")
            created = info.get("id")
            if not isinstance(created, str) or _OPENCODE_SESSION_ID.fullmatch(created) is None:
                raise HarnessError("POST /session did not return a 'ses_' session id", code="protocol-error")
            session_id = created
        if info.get("directory") != self._directory:
            raise HarnessError(
                f"session {session_id} lives in directory {info.get('directory')!r}, not the requested {self._directory!r}",
                code="protocol-error",
            )
        self._reference = SessionReference(session_id=session_id, session_file=None, workdir=spec.workdir, endpoint=self._options.endpoint)
        self._stream = await self._subscribe()
        self._spawn(self._read_events(self._stream))
        try:
            await asyncio.wait_for(asyncio.shield(self._connected), self._rt)
        except asyncio.TimeoutError:
            raise HarnessError(f"GET /event sent no server.connected within request_timeout_seconds={self._rt}", code="protocol-error") from None
        if self._failure is not None:
            return
        if spec.resume is not None:
            statuses = await self._probe("GET", "/session/status")
            status = statuses.get(session_id)
            if status is not None and (not isinstance(status, dict) or status.get("type") != "idle"):
                state = status.get("type") if isinstance(status, dict) else status
                raise HarnessError(f"session {session_id} is {state!r} on the server; another client is driving it", code="protocol-error")

    async def _probe(self, method: str, path: str, *, directory: bool = True) -> dict[str, object]:
        """Startup request: transport failure / non-200 is `launch-failed`,
        an unparseable success is `protocol-error`."""
        try:
            status, data = await self._exchange(method, path, directory=directory)
        except _TransportError as exc:
            raise HarnessError(f"cannot reach opencode server {self._options.endpoint}: {exc}", code="launch-failed") from None
        except _ProtocolError as exc:
            raise HarnessError(str(exc), code="protocol-error") from None
        return self._require_object(status, data, f"{method} {path}")

    async def _subscribe(self) -> httpx.Response:
        assert self._client is not None
        httpx = self._httpx
        request = self._client.build_request(
            "GET",
            "/event",
            params={"directory": self._directory},
            headers={"accept": "text/event-stream"},
            timeout=httpx.Timeout(self._rt, read=None),
        )
        try:
            response = await asyncio.wait_for(self._client.send(request, stream=True), self._rt)
        except asyncio.TimeoutError:
            raise HarnessError(f"GET /event sent no response headers within request_timeout_seconds={self._rt}", code="launch-failed") from None
        except Exception as exc:
            raise HarnessError(f"cannot subscribe to GET /event: {type(exc).__name__}", code="launch-failed") from None
        if response.status_code != 200:
            await response.aclose()
            raise HarnessError(f"GET /event returned HTTP {response.status_code}", code="launch-failed")
        content_type = response.headers.get("content-type", "").partition(";")[0].strip().lower()
        if content_type != "text/event-stream":
            await response.aclose()
            raise HarnessError(f"GET /event answered with content type {content_type or 'none'!r}, not text/event-stream", code="protocol-error")
        return response

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
        detail = f"opencode startup failed ({failure.status}" + (f": {failure.error})" if failure.error else ")")
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
        if not self._connected.done():
            self._connected.set_result(None)
        tasks = [task for task in self._tasks if not task.done()]
        for task in tasks:
            task.cancel()
        for task in tasks:
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass
        close_error: Exception | None = None
        if self._stream is not None:
            try:
                await self._stream.aclose()
            except Exception as exc:
                close_error = exc
        if self._client is not None:
            try:
                await self._client.aclose()
            except Exception as exc:
                close_error = close_error or exc
        self._permissions.clear()
        if turn is not None and not turn.finished:
            self._finish(turn, failure.status, turn.response, failure.error)
        self._idle._close()
        if close_error is not None:
            raise HarnessError(f"opencode transport did not close cleanly: {type(close_error).__name__}", code="adapter-error") from close_error


async def open_opencode_session(spec: SessionSpec) -> LiveSession:
    """Open the validated OpenCode `spec` (see `open_session`)."""
    _import_httpx()
    session = _OpenCodeSession(spec)
    await _await_startup(session, session._startup())
    return session


__all__ = ["open_opencode_session"]
