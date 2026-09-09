"""Inspected synthetic OpenHands Agent Server 1.45.0 peer; never loads OpenHands.

The invoking test owns this child handle. Mandatory finite lifetime, loopback
port 0, synthetic session API key and a private request trace. EOF on stdin or
lifetime expiry closes every accepted connection and task and exits the child.
Frame and event shapes follow the pinned sources (session_protocol.py,
session_socket.py, event_service.py, models.py, conversation/state.py at
49ea74587c376b90700f6eff128c3d9b57585d27); only stdlib is used.

stdin bytes: 0x01 = "partial output consumed" (races), 0x02 = release hanging runs.
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import hashlib
import json
import struct
import sys
import uuid
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

KEY = "fixture-api-key"
AGENT_PROFILE = "fixture-agent"
LLM_PROFILE = "fixture-llm"
MODEL = "synthetic/fixture"
WORKDIR = "/synthetic/server/work"
PROFILE_ID = "11111111-1111-4111-8111-111111111111"
REVISION = 1
VERSION = "1.45.0"
MAX_BODY = 1_048_576
WS_GUID = b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


class Conversation:
    def __init__(self, cid: str, workdir: str) -> None:
        self.id = cid
        self.workdir = workdir
        self.execution_status = "idle"
        self.events: list[dict] = []
        self.prompt_tokens = 0
        self.completion_tokens = 0
        self.last_user_message_id: str | None = None
        self.leaf_event_id: str | None = None
        self.running: asyncio.Task | None = None
        self.interrupt = asyncio.Event()
        self.pending_prompt: str | None = None

    def stats(self) -> dict:
        usage = {
            "model": MODEL, "prompt_tokens": self.prompt_tokens, "completion_tokens": self.completion_tokens,
            "cache_read_tokens": 0, "cache_write_tokens": 0, "reasoning_tokens": 0, "context_window": 0,
            "per_turn_token": 0, "response_id": "",
        }
        return {"usage_to_metrics": {"agent": {"model_name": MODEL, "accumulated_cost": 0.0, "max_budget_per_task": None, "accumulated_token_usage": usage, "costs": [], "response_latencies": [], "token_usages": []}}}

    def agent(self) -> dict:
        return {"kind": "Agent", "llm": {"model": MODEL, "usage_id": "agent", "api_key": None, "base_url": None}, "tools": [], "agent_context": None, "system_prompt_kwargs": {}}

    def info(self, variant: str) -> dict:
        workdir = "/synthetic/other" if variant == "wrong-workdir" else self.workdir
        status = "synthetic_state" if variant == "unknown-status" else self.execution_status
        return {
            "id": "22222222-2222-4222-8222-222222222222" if variant == "wrong-identity" else self.id,
            "agent": self.agent(),
            "workspace": {"kind": "LocalWorkspace", "working_dir": workdir},
            "persistence_dir": "workspace/conversations", "max_iterations": 500, "stuck_detection": True,
            "execution_status": status, "confirmation_policy": {"kind": "NeverConfirm"}, "security_analyzer": None,
            "activated_knowledge_skills": [], "invoked_skills": [], "blocked_actions": {}, "blocked_messages": {},
            "last_user_message_id": self.last_user_message_id, "leaf_event_id": self.leaf_event_id,
            "stats": self.stats(), "secret_registry": {"secret_sources": {}}, "agent_state": {}, "hook_config": None,
            "title": None, "metrics": None, "created_at": "2026-09-08T00:00:00Z", "updated_at": "2026-09-08T00:00:00Z",
            "forked_from_conversation_id": None, "forked_from_event_id": None, "parent_conversation_id": None,
            "sub_conversation_ids": [], "tags": {}, "current_model_id": None, "available_models": [],
            "supports_runtime_model_switch": False,
            "launched_agent_profile": {"agent_profile_id": PROFILE_ID, "revision": 2 if variant == "profile-mismatch" else REVISION},
            "client_tools": [],
        }

    def full_state(self) -> dict:
        # ConversationState.model_dump(mode="json", exclude_none=True)
        return {
            "id": self.id, "agent": self.agent(), "workspace": {"kind": "LocalWorkspace", "working_dir": self.workdir},
            "persistence_dir": "workspace/conversations", "max_iterations": 500, "stuck_detection": True,
            "execution_status": self.execution_status, "confirmation_policy": {"kind": "NeverConfirm"},
            "activated_knowledge_skills": [], "activated_path_rules": [], "invoked_skills": [],
            "blocked_actions": {}, "blocked_messages": {},
            **({"last_user_message_id": self.last_user_message_id} if self.last_user_message_id else {}),
            **({"leaf_event_id": self.leaf_event_id} if self.leaf_event_id else {}),
            "head_is_empty": False, "stats": self.stats(), "secret_registry": {"secret_sources": {}}, "tags": {}, "agent_state": {},
        }


def event(kind: str, source: str, **fields) -> dict:
    return {"kind": kind, "id": str(uuid.uuid4()), "timestamp": "2026-09-08T00:00:00.000000", "source": source, **fields}


def message_event(source: str, role: str, text: str) -> dict:
    # DurableFrame.model_dump_json(exclude_none=True): None-valued fields are absent.
    llm_message = {"role": role, "content": [{"cache_prompt": False, "type": "text", "text": text}], "thinking_blocks": []}
    extra = {} if source == "user" else {"llm_response_id": "resp-synthetic"}
    return event("MessageEvent", source, llm_message=llm_message, activated_skills=[], extended_content=[], **extra)


def state_event(key: str, value) -> dict:
    return event("ConversationStateUpdateEvent", "environment", key=key, value=value)


class Peer:
    def __init__(self, variant: str, trace: Path) -> None:
        self.variant = variant
        self.trace = trace
        self.connections: set[asyncio.StreamWriter] = set()
        self.sockets: dict[str, set[asyncio.StreamWriter]] = {}
        self.conversations: dict[str, Conversation] = {}
        self.tasks: set[asyncio.Task] = set()
        self.partial_consumed = asyncio.Event()
        self.release = asyncio.Event()

    # ---- HTTP -----------------------------------------------------------------

    async def response(self, writer, status=200, body=None, headers=None, raw: bytes | None = None):
        payload = raw if raw is not None else b"" if body is None else json.dumps(body).encode()
        fields = {"Content-Type": "application/json", "Content-Length": str(len(payload)), "Connection": "close"}
        fields.update(headers or {})
        writer.write(f"HTTP/1.1 {status} Synthetic\r\n".encode() + b"".join(f"{k}: {v}\r\n".encode() for k, v in fields.items()) + b"\r\n" + payload)
        await writer.drain()

    # ---- WebSocket ------------------------------------------------------------

    def frame(self, opcode: int, payload: bytes) -> bytes:
        head = bytes([0x80 | opcode])
        n = len(payload)
        if n < 126:
            head += bytes([n])
        elif n < 65536:
            head += bytes([126]) + struct.pack("!H", n)
        else:
            head += bytes([127]) + struct.pack("!Q", n)
        return head + payload

    async def broadcast(self, cid: str, data: bytes):
        for writer in tuple(self.sockets.get(cid, ())):
            try:
                for offset in range(0, len(data), 65536):
                    writer.write(data[offset:offset + 65536])
                    await writer.drain()
            except (ConnectionError, OSError):
                self.sockets[cid].discard(writer)

    async def send_text(self, cid: str, payload: bytes):
        await self.broadcast(cid, self.frame(1, payload))

    async def send_frame(self, cid: str, frame: dict):
        await self.send_text(cid, json.dumps(frame, ensure_ascii=False).encode())

    async def durable(self, conv: Conversation, ev: dict, seq: int | None = None):
        if seq is None:
            seq = len(conv.events)
            conv.events.append(ev)
            conv.leaf_event_id = ev["id"]
        await self.send_frame(conv.id, {"type": "durable", "seq": seq, "event": ev})

    async def transient(self, conv: Conversation, ev: dict):
        await self.send_frame(conv.id, {"type": "transient", "event": ev})

    async def status(self, conv: Conversation, value: str):
        conv.execution_status = value
        await self.durable(conv, state_event("execution_status", value))

    async def snapshot(self, conv: Conversation):
        await self.transient(conv, state_event("full_state", conv.full_state()))

    async def close_sockets(self, cid: str):
        for writer in tuple(self.sockets.get(cid, ())):
            try:
                writer.write(self.frame(8, struct.pack("!H", 1001)))
                await writer.drain()
            except (ConnectionError, OSError):
                pass
            writer.close()
        self.sockets.pop(cid, None)

    async def read_frame(self, reader: asyncio.StreamReader):
        head = await reader.readexactly(2)
        opcode = head[0] & 0x0F
        masked = head[1] & 0x80
        n = head[1] & 0x7F
        if n == 126:
            n = struct.unpack("!H", await reader.readexactly(2))[0]
        elif n == 127:
            n = struct.unpack("!Q", await reader.readexactly(8))[0]
        if n > MAX_BODY:
            raise ConnectionError("oversized inbound frame")
        mask = await reader.readexactly(4) if masked else b""
        payload = await reader.readexactly(n)
        if masked:
            payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        return opcode, payload

    async def websocket(self, reader, writer, headers: dict, cid: str):
        if self.variant == "ws-redirect":
            return await self.response(writer, 302, headers={"Location": "/sockets/redirected"})
        if self.variant == "ws-reject":
            return await self.response(writer, 403, {"detail": "synthetic socket rejection"})
        accept = base64.b64encode(hashlib.sha1(headers["sec-websocket-key"].encode() + WS_GUID).digest()).decode()
        writer.write(b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept.encode() + b"\r\n\r\n")
        await writer.drain()
        # First-message auth (sockets._accept_authenticated_websocket).
        try:
            opcode, payload = await asyncio.wait_for(self.read_frame(reader), 10)
            data = json.loads(payload) if opcode == 1 else None
        except (asyncio.TimeoutError, ValueError):
            data = None
        if not isinstance(data, dict) or data.get("type") != "auth" or data.get("session_api_key") != KEY:
            writer.write(self.frame(8, struct.pack("!H", 4001) + b"Authentication failed"))
            await writer.drain()
            return
        conv = self.conversations.get(cid)
        if conv is None:
            writer.write(self.frame(8, struct.pack("!H", 4004) + b"Conversation not found"))
            await writer.drain()
            return
        self.sockets.setdefault(cid, set()).add(writer)
        sync = {"type": "sync"}
        if conv.events:
            sync["through_seq"] = len(conv.events) - 1
        writer.write(self.frame(1, json.dumps(sync).encode()))
        writer.write(self.frame(1, json.dumps({"type": "transient", "event": state_event("full_state", conv.full_state())}).encode()))
        await writer.drain()
        while True:
            opcode, payload = await self.read_frame(reader)
            if opcode == 8:
                writer.write(self.frame(8, payload[:2]))
                await writer.drain()
                return
            if opcode == 9:
                writer.write(self.frame(10, payload))
                await writer.drain()
                continue
            if opcode in (1, 2):
                # Inbound messages besides auth request deferred reruns upstream;
                # the harness never sends them, so the fixture treats one as a hard error.
                writer.write(self.frame(1, json.dumps({"type": "error", "code": "FixtureInboundMessage", "detail": "fixture forbids inbound socket messages"}).encode()))
                await writer.drain()

    # ---- runs -----------------------------------------------------------------

    async def run(self, conv: Conversation, prompt: str):
        conv.prompt_tokens += 7
        conv.completion_tokens += 3
        reply = message_event("agent", "assistant", "synthetic reply λ")
        try:
            if prompt == "error-before-running":
                await self.durable(conv, event("ConversationErrorEvent", "environment", code="SyntheticStartupError", detail="synthetic runtime failed before running"))
                await self.status(conv, "error")
                await self.snapshot(conv)
                return
            await self.status(conv, "running")
            if prompt == "unknown":
                await self.durable(conv, event("SyntheticFutureEvent", "environment", nested={"value": 42}))
                await self.send_frame(conv.id, {"type": "item_started", "item_id": reply["id"], "attempt": 1, "anchor_seq": len(conv.events) - 1})
            if prompt in ("disconnect", "malformed", "invalid-utf8", "binary", "oversize", "numeric-overflow", "seq-gap", "seq-duplicate", "seq-backward", "bad-frame", "bad-event", "unknown-execution-status", "hang", "close-active", "interrupt-ack-only", "interrupt-race", "interrupt-late-paused", "waiting-approval"):
                # Independent channels: the socket cannot prove client receipt, so
                # the test acknowledges the running transition over stdin first.
                await self.partial_consumed.wait()
            if prompt == "disconnect":
                await self.close_sockets(conv.id)
                await self.release.wait()
                return
            if prompt == "malformed":
                await self.send_text(conv.id, b"not-json")
                await self.release.wait()
                return
            if prompt == "invalid-utf8":
                await self.send_text(conv.id, b'{"type":"transient","event":{"kind":"\xff"}}')
                await self.release.wait()
                return
            if prompt == "binary":
                await self.broadcast(conv.id, self.frame(2, b'{"type":"sync"}'))
                await self.release.wait()
                return
            if prompt == "oversize":
                await self.send_frame(conv.id, {"type": "transient", "event": event("SyntheticLargeEvent", "environment", text="x" * (MAX_BODY + 1))})
                await self.release.wait()
                return
            if prompt == "numeric-overflow":
                # Lexically valid JSON whose number has no finite representation.
                await self.send_text(conv.id, b'{"type":"transient","event":{"kind":"SyntheticNumberEvent","id":"synthetic-number","timestamp":"2026-09-08T00:00:00","source":"environment","value":{"nested":1e999}}}')
                await self.release.wait()
                return
            if prompt in ("seq-gap", "seq-duplicate", "seq-backward"):
                seq = len(conv.events) + (1 if prompt == "seq-gap" else -1 if prompt == "seq-duplicate" else -2)
                await self.durable(conv, state_event("stats", conv.stats()), seq=seq)
                await self.release.wait()
                return
            if prompt == "bad-frame":
                await self.send_frame(conv.id, {"type": "durable", "seq": "3", "event": state_event("stats", conv.stats())})
                await self.release.wait()
                return
            if prompt == "bad-event":
                await self.durable(conv, {**message_event("agent", "assistant", "x"), "llm_message": "not-an-object"})
                await self.release.wait()
                return
            if prompt == "unknown-execution-status":
                await self.status(conv, "synthetic_state")
                await self.release.wait()
                return
            if prompt == "overflow":
                for _ in range(20):
                    await self.durable(conv, event("SyntheticLargeEvent", "environment", text="x" * 1000))
            if prompt == "recoverable-error":
                await self.durable(conv, event("AgentErrorEvent", "agent", error="synthetic recoverable tool failure", tool_name="terminal", tool_call_id="call-synthetic"))
            if prompt == "waiting-approval":
                await self.status(conv, "waiting_for_confirmation")
                await self.snapshot(conv)
                await self.release.wait()
                return
            if prompt in ("hang", "hang-eager", "close-active", "interrupt-ack-only", "interrupt-race", "interrupt-late-paused"):
                interrupt = asyncio.ensure_future(conv.interrupt.wait())
                release = asyncio.ensure_future(self.release.wait())
                try:
                    await asyncio.wait({interrupt, release}, return_when=asyncio.FIRST_COMPLETED)
                finally:
                    interrupt.cancel()
                    release.cancel()
                if conv.interrupt.is_set() and prompt not in ("interrupt-ack-only", "interrupt-race", "interrupt-late-paused"):
                    await self.status(conv, "paused")
                    await self.snapshot(conv)
                    return
                if conv.interrupt.is_set() and prompt == "interrupt-ack-only":
                    await self.release.wait()
                    return
            if prompt == "error":
                await self.durable(conv, event("ConversationErrorEvent", "environment", code="SyntheticProviderError", detail="synthetic provider rejected the request"))
                await self.status(conv, "error")
                await self.snapshot(conv)
                return
            if prompt == "stuck":
                await self.status(conv, "stuck")
                await self.snapshot(conv)
                return
            if prompt == "paused":
                await self.status(conv, "paused")
                await self.snapshot(conv)
                return
            await self.durable(conv, reply)
            await self.durable(conv, state_event("stats", conv.stats()))
            await self.status(conv, "finished")
            if prompt == "missing-snapshot":
                await self.release.wait()
                return
            if prompt == "stale-snapshot":
                # A snapshot whose execution_status predates the terminal event never settles.
                stale = conv.full_state()
                stale["execution_status"] = "running"
                await self.transient(conv, state_event("full_state", stale))
                await self.release.wait()
                return
            await self.snapshot(conv)
        finally:
            conv.running = None
            conv.interrupt.clear()

    def spawn(self, coro) -> asyncio.Task:
        task = asyncio.create_task(coro)
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)
        return task

    # ---- routing --------------------------------------------------------------

    async def handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        self.connections.add(writer)
        try:
            raw = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 5)
            lines = raw.decode("latin-1").split("\r\n")
            method, target, _ = lines[0].split(" ")
            headers = {key.lower(): value for key, value in (line.split(": ", 1) for line in lines[1:] if line)}
            length = int(headers.get("content-length", "0"))
            if length > MAX_BODY:
                return await self.response(writer, 413, {"detail": "payload too large"})
            payload = await reader.readexactly(length)
            body = json.loads(payload) if payload else None
            url = urlsplit(target)
            route = url.path
            upgrade = headers.get("upgrade", "").lower() == "websocket"
            # Never record credential values.
            with self.trace.open("a") as trace:
                trace.write(json.dumps({"method": method, "path": route, "query": url.query, "body": body, "expose_secrets": "x-expose-secrets" in headers, "upgrade": upgrade}) + "\n")
            if self.variant == "redirect":
                return await self.response(writer, 302, headers={"Location": "http://127.0.0.1:1/forbidden"})
            if route == "/server_info" and method == "GET":
                sdk = "1.44.0" if self.variant == "wrong-version" else VERSION
                return await self.response(writer, body={"uptime": 1, "idle_time": 0, "title": "OpenHands Agent Server", "version": VERSION, "sdk_version": sdk, "tools_version": VERSION, "workspace_version": VERSION, "build_git_sha": "unknown", "build_git_ref": "unknown", "python_version": "3.12.0 (synthetic)", "usable_tools": ["terminal"], "runtime_idle_timeout_seconds": None, "capabilities": ["credential_binding_v1"], "max_foreground_terminal_timeout_seconds": None, "docs": "/docs", "redoc": "/redoc"})
            bits = route.strip("/").split("/")
            if upgrade:
                if len(bits) == 3 and bits[:2] == ["sockets", "session"] and "session_api_key" not in parse_qs(url.query):
                    return await self.websocket(reader, writer, headers, bits[2])
                return await self.response(writer, 403, {"detail": "fixture accepts first-message auth on /sockets/session/{id} only"})
            if bits[0] != "api" or len(bits) < 2:
                return await self.response(writer, 404, {"detail": "Not Found"})
            if headers.get("x-session-api-key") != KEY:
                return await self.response(writer, 401, {"detail": "Invalid session API key"})
            if headers.get("x-expose-secrets"):
                return await self.response(writer, 400, {"detail": "fixture forbids secret exposure"})
            if bits[1] == "agent-profiles" and len(bits) == 3 and method == "GET":
                if bits[2] != AGENT_PROFILE:
                    return await self.response(writer, 404, {"detail": f"Agent profile '{bits[2]}' not found"})
                profile = {"schema_version": 2, "id": PROFILE_ID, "name": AGENT_PROFILE, "revision": REVISION, "mcp_server_refs": None}
                if self.variant == "acp-profile":
                    profile.update({"agent_kind": "acp", "acp_server": "claude-code", "acp_model": None, "acp_session_mode": None, "acp_prompt_timeout": 1800.0, "acp_startup_timeout": 90.0, "acp_command": None, "acp_args": None})
                else:
                    profile.update({"agent_kind": "openhands", "llm_profile_ref": LLM_PROFILE, "agent": "CodeActAgent", "tools": None, "system_message_suffix": None, "disabled_skills": [], "condenser": {"kind": "llm_summarizing", "max_size": 240, "keep_first": 4}, "verification": {"critic_enabled": False}, "enable_sub_agents": False, "enable_switch_llm_tool": True, "tool_concurrency_limit": 1})
                return await self.response(writer, body={"name": AGENT_PROFILE, "profile": profile})
            if bits[1] == "profiles" and len(bits) == 3 and method == "GET":
                if bits[2] != LLM_PROFILE:
                    return await self.response(writer, 404, {"detail": f"Profile '{bits[2]}' not found"})
                model = "synthetic/other" if self.variant == "wrong-model" else MODEL
                return await self.response(writer, body={"name": LLM_PROFILE, "config": {"model": model, "usage_id": "agent", "api_key": None, "base_url": None, "temperature": 0.0, "max_output_tokens": None}, "api_key_set": True})
            if bits[1] != "conversations":
                return await self.response(writer, 404, {"detail": "unexpected fixture route"})
            if len(bits) == 2 and method == "POST":
                return await self.create(writer, body)
            if len(bits) < 3:
                return await self.response(writer, 404, {"detail": "unexpected fixture route"})
            conv = self.conversations.get(bits[2])
            if len(bits) == 3 and method == "GET":
                if conv is None:
                    return await self.response(writer, 404, {"detail": "Not Found"})
                if self.variant == "oversize-http":
                    return await self.response(writer, raw=json.dumps({**conv.info(self.variant), "padding": "x" * (MAX_BODY + 1)}).encode())
                return await self.response(writer, body=conv.info(self.variant))
            if conv is None:
                return await self.response(writer, 404, {"detail": "Not Found"})
            if len(bits) == 4 and bits[3] == "events" and method == "POST":
                return await self.send_message(writer, conv, body)
            if len(bits) == 4 and bits[3] == "run" and method == "POST":
                return await self.start_run(writer, conv)
            if len(bits) == 4 and bits[3] == "interrupt" and method == "POST":
                if conv.running is None:
                    # conversation_service.interrupt_conversation: an existing conversation
                    # answers Success even when nothing runs, and republishes its state.
                    # An acknowledgement therefore never proves the caller's run paused.
                    await self.snapshot(conv)
                    return await self.response(writer, body={"success": True})
                if conv.pending_prompt in ("interrupt-race", "interrupt-late-paused"):
                    # Normal completion wins the race with the interrupt request.
                    self.release.set()
                    await conv.running
                    self.release.clear()
                    if conv.pending_prompt == "interrupt-late-paused":
                        await self.status(conv, "paused")
                        await self.snapshot(conv)
                    return await self.response(writer, body={"success": True})
                conv.interrupt.set()
                await asyncio.sleep(0.01)
                return await self.response(writer, body={"success": True})
            await self.response(writer, 404, {"detail": "unexpected fixture route"})
        except (asyncio.IncompleteReadError, asyncio.LimitOverrunError, asyncio.TimeoutError, ConnectionError, OSError, ValueError, KeyError):
            pass
        finally:
            for sockets in self.sockets.values():
                sockets.discard(writer)
            self.connections.discard(writer)
            writer.close()
            try:
                await writer.wait_closed()
            except (ConnectionError, OSError):
                pass

    async def create(self, writer, body):
        if not isinstance(body, dict):
            return await self.response(writer, 422, {"detail": "body required"})
        forbidden = {"agent", "agent_settings", "initial_message", "secrets", "hook_config", "plugins", "tool_module_qualnames", "client_tools"} & set(body)
        if forbidden:
            return await self.response(writer, 422, {"detail": f"fixture forbids {sorted(forbidden)}"})
        cid = body.get("conversation_id")
        try:
            canonical = str(uuid.UUID(cid))
        except (TypeError, ValueError):
            return await self.response(writer, 422, {"detail": "conversation_id must be a UUID"})
        workspace = body.get("workspace")
        if body.get("agent_profile_id") != PROFILE_ID or not isinstance(workspace, dict) or workspace.get("kind") != "LocalWorkspace" or not isinstance(workspace.get("working_dir"), str):
            return await self.response(writer, 422, {"detail": "agent_profile_id and LocalWorkspace required"})
        existing = self.conversations.get(canonical)
        if existing is not None or self.variant == "collision":
            existing = existing or Conversation(canonical, workspace["working_dir"])
            return await self.response(writer, 200, existing.info(self.variant))
        conv = Conversation(canonical, workspace["working_dir"])
        self.conversations[canonical] = conv
        return await self.response(writer, 201, conv.info(self.variant))

    async def send_message(self, writer, conv: Conversation, body):
        if not isinstance(body, dict) or body.get("role") != "user" or body.get("run") is not False:
            return await self.response(writer, 422, {"detail": "fixture requires role user and run false"})
        content = body.get("content")
        if not isinstance(content, list) or len(content) != 1 or content[0].get("type") != "text" or not isinstance(content[0].get("text"), str):
            return await self.response(writer, 422, {"detail": "single TextContent required"})
        if conv.running is not None:
            # Upstream appends and defers; the harness must never reach this while busy.
            return await self.response(writer, 409, {"detail": "fixture: message while running"})
        prompt = content[0]["text"]
        conv.pending_prompt = prompt
        self.partial_consumed.clear()
        if prompt == "events-http-error":
            return await self.response(writer, 503, {"detail": "synthetic send failure"})
        echo = message_event("user", "user", "foreign text" if prompt == "echo-mismatch" else prompt)
        conv.last_user_message_id = echo["id"]
        if prompt == "ack-first":
            await self.response(writer, body={"success": True})
            # Independent channels: the echo may trail the HTTP acknowledgement.
            await asyncio.sleep(0.05)
            await self.durable(conv, echo)
            return
        await self.durable(conv, echo)
        await self.response(writer, body={"success": True})

    async def start_run(self, writer, conv: Conversation):
        prompt = conv.pending_prompt
        if conv.running is not None or prompt == "run-busy":
            return await self.response(writer, 409, {"detail": "Conversation already running. Wait for completion or pause first."})
        if prompt is None:
            return await self.response(writer, 400, {"detail": "no pending message"})
        conv.pending_prompt = prompt if prompt in ("interrupt-race", "interrupt-late-paused") else None
        if prompt == "ack-only":
            return await self.response(writer, body={"success": True})
        if prompt == "run-no-body":
            return await self.response(writer, 200, raw=b"")
        if prompt == "run-unsuccessful":
            return await self.response(writer, body={"success": False})
        if prompt == "run-oversize":
            return await self.response(writer, raw=json.dumps({"success": True, "padding": "x" * (MAX_BODY + 1)}).encode())
        if prompt == "run-partial-json":
            return await self.response(writer, raw=b'{"success": tr')
        if prompt == "terminal-before-ack":
            conv.running = self.spawn(self.run(conv, prompt))
            await conv.running
            return await self.response(writer, body={"success": True})
        conv.running = self.spawn(self.run(conv, prompt))
        await self.response(writer, body={"success": True})


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--lifetime", type=float, required=True)
    parser.add_argument("--trace", type=Path, required=True)
    parser.add_argument("--variant", default="normal")
    args = parser.parse_args()
    if not 0 < args.lifetime <= 120:
        parser.error("lifetime must be within (0, 120] seconds")
    peer = Peer(args.variant, args.trace)
    server = await asyncio.start_server(peer.handle, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    print(f"http://127.0.0.1:{port}", flush=True)
    eof = asyncio.Event()
    loop = asyncio.get_running_loop()

    def stdin_ready():
        data = sys.stdin.buffer.read1(4096)
        if not data:
            eof.set()
            loop.remove_reader(sys.stdin.fileno())
            return
        if b"\x01" in data:
            peer.partial_consumed.set()
        if b"\x02" in data:
            peer.release.set()

    loop.add_reader(sys.stdin.fileno(), stdin_ready)
    try:
        await asyncio.wait_for(eof.wait(), args.lifetime)
    except asyncio.TimeoutError:
        pass
    finally:
        loop.remove_reader(sys.stdin.fileno())
        server.close()
        for task in tuple(peer.tasks):
            task.cancel()
        for task in tuple(peer.tasks):
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass
        for writer in tuple(peer.connections):
            writer.close()
        for writer in tuple(peer.connections):
            try:
                await writer.wait_closed()
            except (ConnectionError, OSError):
                pass
        await server.wait_closed()


if __name__ == "__main__":
    asyncio.run(main())
