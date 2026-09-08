#!/usr/bin/env python3
"""Synthetic Pi RPC peer. No provider, credentials, or private conversation data."""
from __future__ import annotations

import json
import os
from pathlib import Path
import signal
import sys
import time

CASE = os.environ.get("HARNESS_RPC_CASE", "success")
SESSION_ID = "11111111-2222-4333-8444-555555555555"
SESSION_FILE = str(Path.cwd() / "synthetic-session.jsonl")
if "--session" in sys.argv:
    SESSION_FILE = sys.argv[sys.argv.index("--session") + 1]
    SESSION_ID = json.loads(Path(SESSION_FILE).read_text().split("\n")[0])["id"]
else:
    Path(SESSION_FILE).write_text(json.dumps({"type": "session", "id": SESSION_ID, "cwd": str(Path.cwd())}) + "\n")


def emit(value: object, *, fragmented: bool = False) -> None:
    data = (json.dumps(value, ensure_ascii=False) + "\n").encode()
    if fragmented:
        for byte in data:
            os.write(1, bytes([byte]))
    else:
        os.write(1, data)


def response(request: dict, *, success: bool = True, data: object = None, **extra: object) -> None:
    value = {"id": request["id"], "type": "response", "command": request["type"], "success": success, **extra}
    if data is not None:
        value["data"] = data
    emit(value)


def end(reason: str = "stop", retry: bool = False) -> None:
    emit({"type": "agent_end", "willRetry": retry, "messages": [{"role": "assistant", "stopReason": reason, "content": [{"type": "text", "text": "synthetic reply"}], "usage": {"input": 2, "output": 3, "cost": {"total": 0}}}]})


def complete(reason: str = "stop") -> None:
    emit({"type": "message_update", "assistantMessageEvent": {"type": "text_delta", "delta": "synthetic reply"}})
    end(reason)
    emit({"type": "agent_settled"})


pending_prompt = None
for line in sys.stdin.buffer:
    request = json.loads(line)
    command = request["type"]
    if command == "get_state":
        if CASE == "startup_hang":
            continue
        if CASE == "prelude":
            emit({"type": "synthetic_idle", "nativeDetail": {"retained": True}})
        if CASE == "prelude_flood":
            for _ in range(2000):
                emit({"type": "synthetic_idle", "text": "x" * 1024})
            continue
        state = {"sessionId": SESSION_ID, "sessionFile": SESSION_FILE, "isStreaming": False, "isCompacting": False}
        if CASE == "bad_state":
            state["sessionId"] = None
        if CASE == "wrong_session":
            state["sessionId"] = "wrong-native-id"
        if CASE == "relative_state":
            state["sessionFile"] = "relative.jsonl"
        response(request, data=state)
        if CASE == "idle_unknown":
            emit({"type": "synthetic_idle", "nativeDetail": {"retained": True}})
    elif command == "prompt":
        if CASE == "reject":
            response(request, success=False, error="synthetic rejection")
            continue
        if CASE == "bad_success":
            response(request, success="yes")
            continue
        if CASE == "reject_then_malformed":
            frames = [
                {"id": request["id"], "type": "response", "command": "prompt", "success": False, "error": "synthetic rejection"},
                {"type": ""},
            ]
            os.write(1, b"".join((json.dumps(frame) + "\n").encode() for frame in frames))
            continue
        if CASE == "before_ack":
            emit({"type": "agent_start"})
            complete()
            time.sleep(0.05)
            response(request)
            continue
        if CASE == "interrupt_before_ack":
            pending_prompt = request
            emit({"type": "agent_start"})
            continue
        response(request)
        emit({"type": "agent_start"})
        if CASE == "malformed":
            os.write(1, b"{broken\n")
        elif CASE == "nonobject":
            emit([])
        elif CASE == "missing_type":
            emit({"unexpected": True})
        elif CASE == "empty_type":
            emit({"type": ""})
        elif CASE == "invalid_utf8":
            os.write(1, b'{"type":"unknown","text":"\xff"}\n')
        elif CASE == "partial":
            os.write(1, b'{"type":"message_update"')
            sys.exit(0)
        elif CASE == "wrong_id":
            response({"type": "prompt", "id": "not-a-request"})
        elif CASE == "wrong_command":
            response({"type": "get_messages", "id": request["id"]})
        elif CASE == "duplicate":
            response(request)
        elif CASE == "exit7":
            sys.exit(7)
        elif CASE == "signal":
            os.kill(os.getpid(), signal.SIGTERM)
        elif CASE == "disconnect":
            os.close(1)
            time.sleep(30)
        elif CASE in ("hang", "interrupt", "abort_hang", "close"):
            continue
        elif CASE == "oversized":
            os.write(1, b'{"type":"unknown","text":"' + b"x" * 1_048_576 + b'"}\n')
        elif CASE in ("flood", "flood_after_break"):
            if CASE == "flood_after_break":
                while not Path("continue-flood").exists():
                    time.sleep(0.01)
            for _ in range(2000):
                emit({"type": "unknown", "text": "x" * 1024})
        elif CASE == "descendant_exit":
            ready_read, ready_write = os.pipe()
            child = os.fork()
            if child == 0:
                os.close(ready_read)
                signal.signal(signal.SIGTERM, signal.SIG_IGN)
                for fd in (0, 1, 2):
                    os.close(fd)
                Path("synthetic-child.pid").write_text(str(os.getpid()))
                os.write(ready_write, b"ready")
                os.close(ready_write)
                while True:
                    time.sleep(1)
            os.close(ready_write)
            os.read(ready_read, 5)
            os.close(ready_read)
            sys.exit(0)
        elif CASE == "descendant":
            child = os.fork()
            if child == 0:
                signal.signal(signal.SIGTERM, signal.SIG_IGN)
                Path("synthetic-child.pid").write_text(str(os.getpid()))
                while True:
                    time.sleep(1)
            continue
        else:
            if CASE == "retry_empty":
                end("error", retry=True)
                emit({"type": "agent_end", "messages": []})
                emit({"type": "agent_settled"})
                continue
            if CASE == "stderr":
                os.write(2, b"synthetic diagnostics\n" * 100)
                time.sleep(0.05)
            if CASE == "unknown_event":
                emit({"type": "new_upstream_event", "nativeDetail": {"retained": True}})
            if CASE == "unicode":
                emit({"type": "message_update", "assistantMessageEvent": {"type": "text_delta", "delta": "snowman \u2603 separator \u2028 and \u2029"}}, fragmented=True)
            if CASE == "retry":
                end("error", retry=True)
                emit({"type": "auto_retry_start", "attempt": 1})
                time.sleep(0.05)
                emit({"type": "agent_start"})
            complete("error" if CASE == "agent_error" else "stop")
    elif command == "abort":
        if CASE == "abort_hang":
            continue
        end("aborted")
        emit({"type": "agent_settled"})
        response(request)
        if pending_prompt is not None:
            response(pending_prompt)
            pending_prompt = None
    else:
        response(request, success=False, error="synthetic unsupported operation")
