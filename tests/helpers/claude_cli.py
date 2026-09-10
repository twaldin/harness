#!/usr/bin/env python3
"""Synthetic Claude stdio peer for real SDK conformance; never calls a provider."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import signal
import sys
import uuid

# Every peer is finite, even if the owning test fails before closing its handle.
signal.alarm(30)
if "--version" in sys.argv or "-v" in sys.argv:
    print(os.environ.get("HARNESS_TEST_CLAUDE_VERSION", "2.1.259") + " (Claude Code)")
    sys.exit(0)

parser = argparse.ArgumentParser(add_help=False)
parser.add_argument("--session-id")
parser.add_argument("--resume")
parser.add_argument("--model")
parser.add_argument("--setting-sources")
parser.add_argument("--settings")
args, _ = parser.parse_known_args()
cwd = str(Path.cwd())
config = Path(os.environ["CLAUDE_CONFIG_DIR"])
if args.resume:
    transcript = Path(args.resume)
    record = json.loads(transcript.read_text().splitlines()[0])
    session_id = record["sessionId"]
else:
    session_id = args.session_id or str(uuid.uuid4())
    transcript = config / "projects" / "synthetic-project" / f"{session_id}.jsonl"
    transcript.parent.mkdir(parents=True, exist_ok=True)
    transcript.write_text(
        json.dumps(
            {
                "type": "user",
                "sessionId": session_id,
                "cwd": cwd,
                "message": {"role": "user", "content": "synthetic history"},
            }
        )
        + "\n"
    )

hooks: dict = {}
pending: dict = {}
turn = 0
active = ""


def send(value: dict) -> None:
    print(json.dumps(value), flush=True)


def result(
    error: bool = False, interrupted: bool = False, text: str = "synthetic reply"
) -> None:
    global active
    send(
        {
            "type": "result",
            "subtype": "error_during_execution" if error or interrupted else "success",
            "is_error": error or interrupted,
            "session_id": session_id,
            "uuid": f"result-{turn}",
            "duration_ms": 1,
            "duration_api_ms": 1,
            "num_turns": 1,
            "result": text,
            "errors": ["synthetic native failure"] if error else [],
            "terminal_reason": "aborted_streaming" if interrupted else "completed",
            "total_cost_usd": 0.01 * turn,
            "modelUsage": {
                "synthetic-model": {"inputTokens": turn * 10, "outputTokens": turn * 2}
            },
            "usage": {"input_tokens": 10, "output_tokens": 2},
            "future_result_field": {"preserve": True},
        }
    )
    active = ""


def finish(**options: object) -> None:
    callbacks = [
        callback
        for matcher in hooks.get("Stop", [])
        for callback in matcher.get("hookCallbackIds", [])
    ]
    if not callbacks:
        result(**options)
        return
    callback_id = callbacks[0]
    request_id = f"stop-{turn}"
    pending[request_id] = ("stop", options)
    send(
        {
            "type": "control_request",
            "request_id": request_id,
            "request": {
                "subtype": "hook_callback",
                "callback_id": callback_id,
                "input": {
                    "hook_event_name": "Stop",
                    "session_id": session_id,
                    "cwd": cwd,
                    "transcript_path": str(transcript),
                    "stop_hook_active": False,
                    "last_assistant_message": "synthetic reply",
                },
                "tool_use_id": None,
            },
        }
    )


def assistant(text: str = "partial synthetic text") -> None:
    send(
        {
            "type": "assistant",
            "session_id": session_id,
            "uuid": f"assistant-{turn}",
            "parent_tool_use_id": None,
            "future_assistant_field": {"preserve": True},
            "message": {
                "id": f"message-{turn}",
                "role": "assistant",
                "model": "synthetic-model",
                "content": [
                    {"type": "text", "text": text},
                    {"type": "future_content", "preserve": True},
                ],
                "stop_reason": "end_turn",
                "usage": {"input_tokens": 10, "output_tokens": 2},
            },
        }
    )


for line in sys.stdin:
    frame = json.loads(line)
    if frame["type"] == "control_request":
        request = frame["request"]
        command = request["subtype"]
        data = {}
        if command == "initialize":
            hooks = request.get("hooks") or {}
            data = {
                "commands": [],
                "models": [],
                "account": {},
                "session_state": "idle",
            }
        elif command == "interrupt":
            data = (
                {}
                if os.environ.get("HARNESS_TEST_CLAUDE_RECEIPT") == "missing"
                else {"still_queued": []}
            )
        send(
            {
                "type": "control_response",
                "response": {
                    "subtype": "success",
                    "request_id": frame["request_id"],
                    "response": data,
                },
            }
        )
        if command == "interrupt" and active and "still_queued" in data:
            finish(interrupted=active != "race")
    elif frame["type"] == "control_response":
        response = frame["response"]
        action = pending.pop(response["request_id"], None)
        if action is None:
            continue
        if action[0] == "stop":
            result(**action[1])
        else:
            decision = response.get("response", {}).get("behavior")
            assistant("permission " + str(decision))
            finish(text="permission " + str(decision))
    elif frame["type"] == "user":
        turn += 1
        active = frame["message"]["content"]
        send(
            {
                "type": "system",
                "subtype": "init",
                "session_id": session_id,
                "cwd": cwd,
                "model": args.model,
                "capabilities": ["interrupt_receipt_v1"],
                "synthetic_settings": {
                    "sources": args.setting_sources,
                    "file": args.settings,
                },
            }
        )
        send(
            {
                "type": "future_native_event",
                "session_id": session_id,
                "payload": {"preserve": True},
            }
        )
        assistant()
        if active in ("hang", "race"):
            continue
        if active == "partial-eof":
            sys.stdout.write('{"type":')
            sys.stdout.flush()
            sys.exit(0)
        if active == "invalid-json":
            print("{invalid json}", flush=True)
            continue
        if active == "native-exit":
            sys.exit(7)
        if active == "overflow":
            send(
                {
                    "type": "future_native_event",
                    "session_id": session_id,
                    "payload": "x" * 1_048_577,
                }
            )
            continue
        if active == "permission":
            request_id = f"permission-{turn}"
            pending[request_id] = ("permission", {})
            send(
                {
                    "type": "control_request",
                    "request_id": request_id,
                    "request": {
                        "subtype": "can_use_tool",
                        "tool_name": "Bash",
                        "input": {"command": "synthetic-no-execution"},
                        "tool_use_id": f"tool-{turn}",
                        "permission_suggestions": [],
                    },
                }
            )
            continue
        finish(error=active == "native-error")
