"""Inspected synthetic OpenCode 1.18.29 peer; never loads OpenCode or host config.

The invoking test owns this child handle. Mandatory finite lifetime, loopback
port 0, synthetic Basic auth, and optional private request trace. EOF on stdin
or lifetime expiry closes every accepted connection and exits the child.
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import json
import sys
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

DIRECTORY = "/synthetic/server/work"
AUTH = "Basic " + base64.b64encode(b"synthetic:fixture-password").decode()


class Peer:
    def __init__(self, variant: str, trace: Path) -> None:
        self.variant = variant
        self.trace = trace
        self.streams: set[asyncio.StreamWriter] = set()
        self.connections: set[asyncio.StreamWriter] = set()
        self.sessions: dict[str, dict] = {}
        self.running: dict[str, asyncio.Event] = {}
        self.permissions: dict[str, tuple[asyncio.Event, list[str]]] = {}
        self.sequence = 0
        self.partial_consumed = asyncio.Event()

    async def response(self, writer, status=200, body=None, headers=None):
        payload = b"" if body is None else json.dumps(body).encode()
        fields = {"Content-Type": "application/json", "Content-Length": str(len(payload)), "Connection": "close"}
        fields.update(headers or {})
        writer.write(f"HTTP/1.1 {status} Synthetic\r\n".encode() + b"".join(f"{k}: {v}\r\n".encode() for k, v in fields.items()) + b"\r\n" + payload)
        await writer.drain()

    async def emit(self, event):
        # Multibyte text, CRLF, comments and a fragmented write exercise framing.
        data = (": synthetic heartbeat\r\ndata: " + json.dumps(event, ensure_ascii=False) + "\r\n\r\n").encode()
        await self.raw(data)

    async def raw(self, data: bytes):
        for writer in tuple(self.streams):
            try:
                for offset in range(0, len(data), 4093):
                    writer.write(data[offset:offset + 4093])
                    await writer.drain()
            except (ConnectionError, OSError):
                self.streams.discard(writer)

    async def status(self, sid: str, kind: str):
        await self.emit({"type": "session.status", "properties": {"sessionID": sid, "status": {"type": kind}}})

    async def prompt(self, writer, sid: str, body: dict):
        mid = body["messageID"]
        prompt = body["parts"][0]["text"]
        self.sequence += 1
        aid = f"msg_{self.sequence:026d}"
        abort = asyncio.Event()
        self.running[sid] = abort
        self.partial_consumed.clear()
        user = {"id": mid, "sessionID": sid, "role": "user", "time": {"created": 1}, "agent": "build", "model": {"providerID": "synthetic", "modelID": "fixture"}}
        info = {"id": aid, "sessionID": sid, "role": "assistant", "parentID": mid, "time": {"created": 2}, "modelID": "fixture", "providerID": "synthetic", "mode": "build", "agent": "build", "path": {"cwd": DIRECTORY, "root": DIRECTORY}, "cost": 0, "tokens": {"input": 7, "output": 3, "reasoning": 0, "cache": {"read": 0, "write": 0}}}
        part = {"id": f"prt_{self.sequence:026d}", "sessionID": sid, "messageID": aid, "type": "text", "text": "synthetic reply"}
        try:
            if prompt == "early-idle":
                await self.status(sid, "idle")
            await self.emit({"type": "message.updated", "properties": {"sessionID": sid, "info": user}})
            await self.status(sid, "busy")
            await self.emit({"type": "message.updated", "properties": {"sessionID": sid, "info": info}})
            await self.emit({"type": "message.part.delta", "properties": {"sessionID": sid, "messageID": aid, "partID": part["id"], "field": "text", "delta": "partial λ"}})
            if prompt in ("http-error", "foreign-writer"):
                # Test-only stdin acknowledgement: HTTP and SSE are independent
                # channels, so server write order cannot prove client receipt.
                await self.partial_consumed.wait()
            if prompt == "foreign-session":
                await self.emit({"type": "message.updated", "properties": {"sessionID": "ses_foreign", "info": {**user, "sessionID": "ses_foreign", "id": "msg_foreign"}}})
            if prompt == "foreign-writer":
                await self.emit({"type": "message.updated", "properties": {"sessionID": sid, "info": {**user, "id": "msg_foreign"}}})
                info["parentID"] = "msg_foreign"
            if prompt == "http-error":
                return await self.response(writer, 503, {"name": "UnknownError", "message": "synthetic HTTP failure"})
            if prompt == "unknown":
                await self.emit({"type": "synthetic.unknown", "properties": {"sessionID": sid, "nested": {"value": 42}}})
            if prompt == "future-message":
                await self.emit({"type": "message.synthetic", "properties": {"nested": {"value": 42}}})
            if prompt in ("bad-status-event", "bad-message-event", "disposed"):
                if prompt == "bad-status-event":
                    await self.emit({"type": "session.status", "properties": {"sessionID": sid, "status": {"type": 3}}})
                elif prompt == "bad-message-event":
                    await self.emit({"type": "message.updated", "properties": {"sessionID": sid, "info": {**user, "id": None}}})
                else:
                    await self.emit({"type": "server.instance.disposed", "properties": {}})
                await abort.wait()
                return
            if prompt == "oversize-fields":
                await self.raw(b": ignored\n" * 110_000 + b"\n")
                await abort.wait()
                return
            if prompt == "malformed":
                await self.raw(b"data: not-json\n\n")
                await abort.wait()
                return
            if prompt == "partial-eof":
                await self.raw(b'data: {"type":"unfinished')
            if prompt in ("partial-eof", "disconnect"):
                for stream in tuple(self.streams):
                    stream.close()
                self.streams.clear()
                await abort.wait()
                return
            if prompt == "oversize":
                await self.raw(b"data: " + b"x" * (1_048_576 + 1) + b"\n\n")
                await abort.wait()
                return
            if prompt == "invalid-utf8":
                await self.raw(b'data: {"type":"\xff"}\n\n')
                await abort.wait()
                return
            if prompt == "overflow":
                for _ in range(20):
                    await self.emit({"type": "synthetic.large", "properties": {"sessionID": sid, "text": "x" * 1000}})
            if prompt == "ack-only":
                await self.response(writer, 204)
                await abort.wait()
                return
            if prompt in ("hang", "close-active"):
                await abort.wait()
                info["error"] = {"name": "MessageAbortedError", "data": {"message": "synthetic abort"}}
            if prompt in ("approval", "reject-permission"):
                pid = f"per_{self.sequence:026d}"
                ready = asyncio.Event()
                replies: list[str] = []
                self.permissions[pid] = (ready, replies)
                await self.emit({"type": "permission.asked", "properties": {"id": pid, "sessionID": sid, "permission": "bash", "patterns": ["echo synthetic"], "metadata": {}, "always": ["echo *"], "tool": {"messageID": aid, "callID": "synthetic-call"}}})
                await ready.wait()
                await self.emit({"type": "permission.replied", "properties": {"sessionID": sid, "requestID": pid, "reply": replies[0]}})
                # A rejected tool is not necessarily an agent failure: upstream
                # may recover and finish normally. Preserve its actual result.
                part["text"] = "permission rejected" if replies[0] == "reject" else "permission granted"
            if prompt == "error":
                info["error"] = {"name": "APIError", "data": {"message": "synthetic provider rejected", "statusCode": 401, "isRetryable": False}}
            info["time"]["completed"] = 3
            info["finish"] = "stop"
            await self.emit({"type": "message.updated", "properties": {"sessionID": sid, "info": info}})
            self.running.pop(sid, None)
            if prompt in ("response-first", "missing-idle"):
                await self.response(writer, body={"info": info, "parts": [part]})
                if prompt == "missing-idle":
                    await abort.wait()
                    return
                # Model independent-channel delivery: the SSE terminal frame
                # may reach the reader after the completed HTTP response.
                await asyncio.sleep(0.05)
                await self.status(sid, "idle")
                return
            await self.status(sid, "idle")
            if prompt == "early-idle":
                await asyncio.sleep(0.05)
            result = {"info": dict(info), "parts": [part]}
            if prompt == "wrong-parent":
                result["info"]["parentID"] = "msg_foreign"
            if prompt == "nonterminal":
                result["info"]["finish"] = "tool-calls"
            if prompt == "wrong-session":
                result["info"]["sessionID"] = "ses_foreign"
            if prompt == "oversize-http":
                result["parts"][0]["text"] = "x" * (1_048_576 + 1)
            await self.response(writer, body=result)
        finally:
            self.running.pop(sid, None)

    async def handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        self.connections.add(writer)
        try:
            raw = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 5)
            lines = raw.decode("ascii").split("\r\n")
            method, target, _ = lines[0].split(" ")
            headers = {key.lower(): value for key, value in (line.split(": ", 1) for line in lines[1:] if line)}
            length = int(headers.get("content-length", "0"))
            if length > 1_048_576:
                return await self.response(writer, 413)
            payload = await reader.readexactly(length)
            body = json.loads(payload) if payload else None
            url = urlsplit(target)
            route = url.path
            # Never record authorization values or real host state.
            with self.trace.open("a") as trace:
                trace.write(json.dumps({"method": method, "path": route, "directory": parse_qs(url.query).get("directory"), "body": body}) + "\n")
            if headers.get("authorization") != AUTH and self.variant != "no-auth":
                return await self.response(writer, 401, headers={"WWW-Authenticate": 'Basic realm="Secure Area"'})
            if self.variant == "redirect":
                return await self.response(writer, 302, headers={"Location": "http://127.0.0.1:1/forbidden"})
            if route == "/global/health":
                return await self.response(writer, body={"healthy": True, "version": "0.0.0" if self.variant == "wrong-version" else "1.18.29"})
            if parse_qs(url.query).get("directory") != [DIRECTORY]:
                return await self.response(writer, 400, {"message": "explicit server directory required"})
            if route == "/path":
                return await self.response(writer, body={"home": "/synthetic/home", "state": "/synthetic/state", "config": "/synthetic/config", "worktree": DIRECTORY, "directory": "/wrong" if self.variant == "wrong-directory" else DIRECTORY})
            if route == "/session" and method == "POST":
                sid = f"ses_{len(self.sessions) + 1:026d}"
                session = {"id": sid, "slug": "synthetic-session", "projectID": "synthetic", "directory": DIRECTORY, "title": "Synthetic fixture", "version": "1.18.29", "time": {"created": 1, "updated": 1}}
                self.sessions[sid] = session
                return await self.response(writer, body=session)
            if route == "/session/status":
                statuses = {sid: {"type": "busy"} for sid in self.running}
                if self.variant == "busy":
                    statuses.update({sid: {"type": "busy"} for sid in self.sessions})
                return await self.response(writer, body=statuses)
            if route == "/event":
                writer.write(b"HTTP/1.1 200 Synthetic\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n")
                await writer.drain()
                self.streams.add(writer)
                await self.emit({"type": "server.connected", "properties": {}})
                await reader.read()
                return
            bits = route.strip("/").split("/")
            if len(bits) == 2 and bits[0] == "session" and method == "GET":
                if bits[1] not in self.sessions:
                    return await self.response(writer, 404, {"name": "NotFoundError", "data": {"message": "synthetic missing session"}})
                return await self.response(writer, body=self.sessions[bits[1]])
            if len(bits) == 3 and bits[0] == "session" and bits[2] == "message" and method == "POST":
                return await self.prompt(writer, bits[1], body)
            if len(bits) == 3 and bits[0] == "session" and bits[2] == "abort" and method == "POST":
                if bits[1] in self.running:
                    self.running[bits[1]].set()
                return await self.response(writer, body=True)
            if len(bits) == 3 and bits[0] == "permission" and bits[2] == "reply" and method == "POST":
                pending = self.permissions.pop(bits[1], None)
                if pending is None:
                    return await self.response(writer, 404, {"message": "synthetic unknown permission"})
                pending[1].append(body["reply"])
                pending[0].set()
                return await self.response(writer, body=True)
            await self.response(writer, 404, {"message": "unexpected fixture route"})
        except (asyncio.IncompleteReadError, asyncio.LimitOverrunError, asyncio.TimeoutError, ConnectionError, OSError):
            pass
        finally:
            self.streams.discard(writer)
            self.connections.discard(writer)
            writer.close()
            try:
                await writer.wait_closed()
            except (ConnectionError, OSError):
                pass


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
        else:
            peer.partial_consumed.set()

    loop.add_reader(sys.stdin.fileno(), stdin_ready)
    try:
        await asyncio.wait_for(eof.wait(), args.lifetime)
    except asyncio.TimeoutError:
        pass
    finally:
        loop.remove_reader(sys.stdin.fileno())
        server.close()
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
