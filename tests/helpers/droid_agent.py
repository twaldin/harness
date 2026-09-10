#!/usr/bin/env python3
"""Finite, synthetic Droid JSON-RPC peer consumed through the real optional SDKs.

No provider, authentication, ambient config, or transcript is read. Every artifact
is created under the test's explicit HOME/workdir. Children stay in the caller's
owned process group; the peer and each child have a 20-second absolute lifetime.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import signal
import sys
import time

if "--version" in sys.argv:
    print("0.213.0")
    raise SystemExit(0)

signal.alarm(20)
CASE = os.environ.get("HARNESS_DROID_CASE", "success")
SID = "11111111-1111-4111-8111-111111111111"
CWD = str(Path.cwd())
HOME = Path(os.environ["HOME"])
ROOT = Path(os.environ.get("FACTORY_HOME_OVERRIDE") or HOME) / ".factory" / "sessions"
PROTOCOL = "0.0.0" if CASE == "bad_protocol" else "1.204.0"
active: str | None = None
pending_prompt: dict | None = None
turn_number = 0
session_file: Path | None = None
settings: dict = {}


def trace(kind: str, **values: object) -> None:
    path = os.environ.get("HARNESS_DROID_TRACE")
    if path:
        with Path(path).open("a") as stream:
            stream.write(json.dumps({"type": kind, **values}) + "\n")


def emit(frame: object, fragmented: bool = False) -> None:
    data = (json.dumps(frame, ensure_ascii=False) + "\n").encode()
    if fragmented:
        for byte in data:
            os.write(1, bytes([byte]))
    else:
        os.write(1, data)


def envelope(kind: str, **fields: object) -> dict:
    return {"jsonrpc": "2.0", "factoryApiVersion": "0.0.0" if CASE == "bad_api" else "1.0.0", "factoryProtocolVersion": PROTOCOL, "type": kind, **fields}


def response(request: dict, result: object = None, error: dict | None = None) -> None:
    payload = {"error": error} if error is not None else {"result": {} if result is None else result}
    emit(envelope("response", id=request["id"], **payload))


def notify(kind: str, **fields: object) -> None:
    emit(envelope("notification", method="droid.session_notification", params={"sessionId": SID, "notification": {"type": kind, **fields}}), CASE == "unicode")


def usage(multiplier: int = 1) -> dict:
    return {"inputTokens": 10 * multiplier, "outputTokens": 2 * multiplier, "cacheCreationTokens": 0, "cacheReadTokens": 3 * multiplier, "thinkingTokens": 0, "factoryCredits": 0.25 * multiplier}


def complete(reason: str = "completed") -> None:
    global active
    if active is None:
        return
    notify("agent_turn_completed", reason=reason, turnId=active, tokenUsage=usage(), cumulativeTokenUsage=usage(turn_number), durationMs=1)
    active = None


def start_output() -> None:
    notify("assistant_text_delta", messageId="assistant-synthetic", blockIndex=0, textDelta="synthetic \u2603\u2028reply")
    notify("synthetic_unknown", detail={"preserved": True}, turnNumber=turn_number)


def persist() -> None:
    global session_file
    directory = ROOT / ("-" + CWD.strip("/").replace("/", "-"))
    directory.mkdir(parents=True, exist_ok=True)
    session_file = directory / f"{SID}.jsonl"
    session_file.write_text(json.dumps({"type": "session_start", "id": SID, "cwd": CWD, "version": 2, "title": "synthetic", "owner": "synthetic"}) + "\n")
    session_file.with_suffix(".settings.json").write_text(json.dumps(settings))


def descendant(exit_leader: bool) -> None:
    read_fd, write_fd = os.pipe()
    child = os.fork()
    if child == 0:
        os.close(read_fd)
        signal.alarm(20)
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        for fd in (0, 1, 2):
            os.close(fd)
        with Path("synthetic-child.pid").open("w") as stream:
            # Exercise readers observing a newly created but not yet populated file.
            time.sleep(0.1)
            stream.write(str(os.getpid()))
        os.write(write_fd, b"ready")
        os.close(write_fd)
        time.sleep(20)
        os._exit(0)
    os.close(write_fd)
    os.read(read_fd, 5)
    os.close(read_fd)
    trace("descendant", leader=os.getpid(), child=child, group=os.getpgrp())
    if exit_leader:
        raise SystemExit(0)


trace("started", pid=os.getpid(), group=os.getpgrp())
if CASE == "close_hang":
    signal.signal(signal.SIGTERM, signal.SIG_IGN)

for line in sys.stdin.buffer:
    request = json.loads(line)
    if request.get("type") == "response":
        trace("callback_response", id=request.get("id"), result=request.get("result"), error=request.get("error"))
        result = request.get("result", {})
        if request.get("id") == "permission-1":
            accepted = result.get("selectedOption") == "proceed_once"
            if accepted:
                Path("approved-marker").write_text("synthetic permission accepted")
            complete("completed" if accepted or CASE == "permission_completed" else "permission_rejected")
        elif request.get("id") == "question-1":
            complete("cancelled" if result.get("cancelled", True) else "completed")
        continue
    method = request.get("method")
    params = request.get("params", {})
    trace("request", method=method, params=params)
    if method in ("droid.initialize_session", "droid.load_session"):
        if CASE == "startup_hang":
            continue
        if CASE == "init_error":
            response(request, error={"code": -32000, "message": "synthetic initialization rejected"})
            continue
        if method == "droid.initialize_session":
            SID = params.get("sessionId") or SID
            CWD = params.get("cwd", CWD)
            settings = {"modelId": params.get("modelId", "synthetic-model"), "reasoningEffort": "none", "interactionMode": "auto", "autonomyLevel": params.get("autonomyLevel", "off"), "disabledToolIds": params.get("disabledToolIds", [])}
            persist()
        else:
            SID = params["sessionId"]
            targets = list(ROOT.glob(f"*/{SID}.jsonl"))
            if not targets:
                response(request, error={"code": -32004, "message": "Synthetic session not found"})
                continue
            session_file = targets[0]
            CWD = json.loads(session_file.read_text().splitlines()[0])["cwd"]
            settings = json.loads(session_file.with_suffix(".settings.json").read_text())
        data = {"session": {"messages": [], "title": "synthetic"}, "settings": settings}
        if method == "droid.initialize_session":
            data["sessionId"] = SID
        else:
            data.update(cwd=CWD, isAgentLoopInProgress=False, workingState="idle")
        if CASE == "bad_state":
            data["sessionId"] = None
        elif CASE == "wrong_resume_cwd":
            data["cwd"] = str(HOME / "wrong-workdir")
        elif CASE == "missing_cwd":
            data.pop("cwd", None)
        response(request, data)
        if CASE == "idle_unknown":
            notify("synthetic_idle", detail={"preserved": True})
    elif method == "droid.add_user_message":
        turn_number += 1
        active = params["messageId"]
        if CASE == "prompt_reject":
            response(request, error={"code": -32602, "message": "synthetic prompt rejection"})
            active = None
            continue
        if CASE == "before_ack":
            start_output()
            complete()
            time.sleep(0.02)
            response(request)
            continue
        if CASE == "interrupt_before_ack" and turn_number == 1:
            pending_prompt = request
            start_output()
            continue
        response(request)
        if CASE == "wrong_delta":
            emit(envelope("notification", method="droid.session_notification", params={"sessionId": "22222222-2222-4222-8222-222222222222", "notification": {"type": "assistant_text_delta", "messageId": "foreign-message", "blockIndex": 0, "textDelta": "foreign session output"}}))
            complete()
            continue
        start_output()
        if CASE in ("interrupt", "interrupt_before_ack") and turn_number > 1:
            complete()
            continue
        if CASE in ("interrupt", "abort_hang", "abort_ack_hang", "close_hang", "hang"):
            continue
        if CASE in ("permission", "permission_completed"):
            emit(envelope("request", id="permission-1", method="droid.request_permission", params={"toolUses": [], "options": [{"label": "Allow once", "value": "proceed_once"}, {"label": "Reject", "value": "cancel"}], "associatedSessionIds": [SID]}))
        elif CASE == "question":
            emit(envelope("request", id="question-1", method="droid.ask_user", params={"toolCallId": "question-tool", "questions": [{"index": 1, "topic": "synthetic", "question": "Synthetic choice?", "options": ["yes", "no"]}]}))
        elif CASE == "agent_error":
            notify("error", message="synthetic agent error", errorType="Error", timestamp="2026-01-01T00:00:00Z")
            complete("error")
        elif CASE == "malformed":
            os.write(1, b"{broken\n")
        elif CASE == "nonobject":
            emit([])
        elif CASE == "invalid_utf8":
            os.write(1, b'{"type":"notification","bad":"\xff"}\n')
        elif CASE == "partial":
            os.write(1, b'{"type":"notification"')
            raise SystemExit(0)
        elif CASE == "duplicate_response":
            response(request)
        elif CASE == "unknown_response":
            response({"id": "not-a-request"})
        elif CASE == "wrong_session":
            SID = "22222222-2222-4222-8222-222222222222"
            complete()
        elif CASE == "wrong_turn":
            active = "wrong-turn-id"
            complete()
        elif CASE == "oversized":
            notify("synthetic_unknown", text="x" * 1_048_576)
        elif CASE == "flood":
            for _ in range(2000):
                notify("synthetic_unknown", text="x" * 1024)
        elif CASE == "exit7":
            raise SystemExit(7)
        elif CASE == "signal":
            os.kill(os.getpid(), signal.SIGTERM)
        elif CASE == "disconnect":
            os.close(1)
            time.sleep(20)
        elif CASE in ("descendant", "descendant_exit"):
            descendant(CASE == "descendant_exit")
        else:
            if CASE == "stderr":
                os.write(2, b"synthetic stderr " * 1024)
            notify("session_token_usage_changed", tokenUsage=usage(turn_number))
            complete()
    elif method == "droid.interrupt_session":
        if CASE == "abort_hang":
            continue
        if CASE == "abort_ack_hang":
            response(request)
            continue
        if pending_prompt is not None:
            response(pending_prompt)
            pending_prompt = None
        complete("cancelled")
        response(request)
    elif method == "droid.close_session":
        if CASE != "close_hang":
            response(request)
    else:
        response(request, error={"code": -32601, "message": "synthetic unsupported method"})

if CASE == "close_hang":
    time.sleep(20)
trace("eof")
