"""Caller-owned HTTP/SSE conformance; synthetic peer only, no OpenCode install."""
from __future__ import annotations

import asyncio
import json
import sys
from contextlib import asynccontextmanager
from dataclasses import replace
from pathlib import Path

import pytest

from harness import HarnessError, OpenCodeOptions, SessionSpec, get_session_capabilities, open_session

TESTS = Path(__file__).parent
CASES = json.loads((TESTS / "opencode_cases.json").read_text())
DIRECTORY = Path("/synthetic/server/work")


@asynccontextmanager
async def peer(tmp_path, variant="normal"):
    trace = tmp_path / "requests.jsonl"
    child = await asyncio.create_subprocess_exec(
        sys.executable, "-I", str(TESTS / "helpers/opencode_server.py"),
        "--lifetime", "60", "--trace", str(trace), "--variant", variant,
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    try:
        endpoint = (await asyncio.wait_for(child.stdout.readline(), 5)).decode().strip()
        assert endpoint.startswith("http://127.0.0.1:")
        options = OpenCodeOptions(endpoint, "basic", username="synthetic", password="fixture-password")
        yield SessionSpec("opencode", DIRECTORY, "rpc", opencode=options, timeout_seconds=3, request_timeout_seconds=1), trace, child
    finally:
        child.stdin.close()
        try:
            await asyncio.wait_for(child.wait(), 3)
        except asyncio.TimeoutError:
            # This unreaped Process object, not a name/PID search, owns the child.
            child.kill()
            await child.wait()
            pytest.fail("owned synthetic peer failed to stop after stdin EOF")
        errors = (await child.stderr.read()).decode()
        assert child.returncode == 0, errors
        assert not errors, errors


def requests(trace):
    return [json.loads(line) for line in trace.read_text().splitlines()] if trace.exists() else []


def assert_caller_server_preserved(trace):
    seen = requests(trace)
    allowed = ("/global/health", "/path", "/event", "/session", "/session/status")
    for request in seen:
        path = request["path"]
        assert request["method"] != "DELETE"
        assert path in allowed or path.startswith("/session/ses_") or path.startswith("/permission/per_")
        assert not any(part in path for part in ("dispose", "config", "provider", "auth", "tui"))


@pytest.mark.parametrize("case", CASES, ids=[case["prompt"] for case in CASES])
async def test_shared_protocol_case(tmp_path, case):
    async with peer(tmp_path) as (spec, trace, child):
        spec = replace(spec, timeout_seconds=case.get("timeout_seconds", spec.timeout_seconds))
        async with await open_session(spec) as session:
            turn = session.start_turn(case["prompt"])
            events = []
            async for event in turn.events:
                events.append(event)
                if case.get("partial") and event.type == "message.part.delta":
                    child.stdin.write(b"\x01")
                    await child.stdin.drain()
            result = await turn.result
            assert result.status == case["status"]
            assert result.session_id == session.reference.session_id
            assert result.turn_id == turn.id
            assert all(event.harness == "opencode" and event.backend == "rpc" for event in events)
            assert all(event.session_id == session.reference.session_id and event.turn_id == turn.id for event in events)
            if "event_types" in case:
                assert [event.type for event in events] == case["event_types"]
            if case.get("partial"):
                assert any(event.type == "message.part.delta" and event.raw["properties"]["delta"] == "partial λ" for event in events)
            if case.get("unknown_event"):
                assert next(event.raw for event in events if event.type == "synthetic.unknown")["properties"]["nested"] == {"value": 42}
            if "text" in case:
                assert result.raw["parts"][0]["text"] == case["text"]
                assert result.raw["info"]["cost"] == 0
            assert result.exit_code is None and result.signal is None
        assert child.returncode is None
        assert_caller_server_preserved(trace)


async def test_followup_resume_identity_and_local_only_close(tmp_path):
    async with peer(tmp_path) as (spec, trace, child):
        session = await open_session(spec)
        reference = session.reference
        assert reference.workdir == DIRECTORY and reference.session_file is None
        assert reference.endpoint == spec.opencode.endpoint
        ids = []
        for _ in range(2):
            turn = session.start_turn("success")
            events = [event async for event in turn.events]
            result = await turn.result
            assert result.status == "completed" and result.session_id == reference.session_id
            user = next(event.raw["properties"]["info"] for event in events if event.type == "message.updated" and event.raw["properties"]["info"]["role"] == "user")
            ids.append(user["id"])
            assert result.raw["info"]["parentID"] == user["id"]
        assert ids[0] != ids[1]
        await asyncio.gather(session.close(), session.close())
        assert child.returncode is None
        async with await open_session(replace(spec, resume=reference)) as resumed:
            assert resumed.reference == reference
            turn = resumed.start_turn("success")
            async for _ in turn.events:
                pass
            assert (await turn.result).status == "completed"
        assert sum(request["method"] == "POST" and request["path"] == "/session" for request in requests(trace)) == 1
        assert_caller_server_preserved(trace)


async def test_interrupt_and_followup(tmp_path):
    async with peer(tmp_path) as (spec, trace, _):
        async with await open_session(spec) as session:
            turn = session.start_turn("hang")
            with pytest.raises(HarnessError) as error:
                session.start_turn("concurrent")
            assert error.value.code == "unsupported-capability"
            async for event in turn.events:
                if event.type == "message.part.delta":
                    await session.interrupt()
            assert (await turn.result).status == "interrupted"
            followup = session.start_turn("success")
            async for _ in followup.events:
                pass
            assert (await followup.result).status == "completed"
        assert sum(request["path"].endswith("/abort") for request in requests(trace)) == 1


@pytest.mark.parametrize("reply", ["once", "reject"])
async def test_explicit_permission_response(tmp_path, reply):
    async with peer(tmp_path) as (spec, trace, _):
        async with await open_session(spec) as session:
            turn = session.start_turn("approval")
            request_id = None
            async for event in turn.events:
                if event.type == "permission.asked":
                    request_id = event.raw["properties"]["id"]
                    with pytest.raises(HarnessError) as error:
                        await session.respond_approval(request_id, "always")
                    assert error.value.code == "unsupported-capability"
                    await session.respond_approval(request_id, reply)
            result = await turn.result
            assert result.status == "completed"
            assert result.raw["parts"][0]["text"] == ("permission rejected" if reply == "reject" else "permission granted")
            with pytest.raises(HarnessError):
                await session.respond_approval(request_id, reply)
        replies = [request for request in requests(trace) if request["path"].startswith("/permission/")]
        assert len(replies) == 1 and replies[0]["body"] == {"reply": reply}
        assert replies[0]["directory"] == [str(DIRECTORY)]


async def test_active_close_never_aborts_or_deletes_server_session(tmp_path):
    async with peer(tmp_path) as (spec, trace, child):
        session = await open_session(spec)
        turn = session.start_turn("close-active")
        async for event in turn.events:
            if event.type == "message.part.delta":
                await asyncio.gather(session.close(), session.close())
        assert (await turn.result).status == "closed"
        assert child.returncode is None
        assert not any(request["path"].endswith("/abort") for request in requests(trace))
        assert_caller_server_preserved(trace)
        with pytest.raises(HarnessError) as error:
            session.start_turn("after close")
        assert error.value.code == "session-closed"


async def test_turn_deadline_closes_transport_without_server_abort(tmp_path):
    async with peer(tmp_path) as (spec, trace, child):
        async with await open_session(replace(spec, timeout_seconds=0.1)) as session:
            turn = session.start_turn("hang")
            async for _ in turn.events:
                pass
            assert (await turn.result).status == "timed-out"
            assert session.closed
        assert child.returncode is None
        assert not any(request["path"].endswith("/abort") for request in requests(trace))


async def test_unconsumed_queue_overflow_is_visible(tmp_path):
    async with peer(tmp_path) as (spec, trace, _):
        async with await open_session(replace(spec, max_buffer_bytes=4096)) as session:
            turn = session.start_turn("overflow")
            result = await turn.result
            assert result.status == "protocol-error" and result.events_truncated
            events = [event async for event in turn.events]
            assert any(event.type == "message.part.delta" for event in events)
        assert_caller_server_preserved(trace)


@pytest.mark.parametrize("variant,code", [("wrong-version", "unsupported-backend"), ("wrong-directory", "protocol-error"), ("redirect", "launch-failed")])
async def test_startup_rejects_unqualified_endpoint(tmp_path, variant, code):
    async with peer(tmp_path, variant) as (spec, trace, child):
        with pytest.raises(HarnessError) as error:
            await open_session(spec)
        assert error.value.code == code
        assert child.returncode is None
        assert not any(request["method"] == "POST" for request in requests(trace))


async def test_wrong_credentials_do_not_fallback_or_leak(tmp_path):
    async with peer(tmp_path) as (spec, trace, _):
        password = "synthetic-wrong-secret"
        with pytest.raises(HarnessError) as error:
            await open_session(replace(spec, opencode=replace(spec.opencode, password=password)))
        assert error.value.code == "launch-failed"
        assert password not in str(error.value) and password not in repr(replace(spec.opencode, password=password))
        assert [request["path"] for request in requests(trace)] == ["/global/health"]


async def test_validation_precedes_all_network_and_local_effects(tmp_path):
    async with peer(tmp_path) as (spec, trace, _):
        for override in ({"instructions": "must not write"}, {"env": {"HOME": str(tmp_path)}}, {"executable": sys.executable}, {"permission_policy": "bypass"}, {"opencode": None}):
            with pytest.raises(HarnessError):
                await open_session(replace(spec, **override))
        for endpoint in ("", "http://user:secret@localhost:4096", "http://localhost:4096/path", "http://localhost:4096?workspace=foreign", "ftp://localhost"):
            with pytest.raises(HarnessError):
                await open_session(replace(spec, opencode=replace(spec.opencode, endpoint=endpoint)))
        secret_endpoint = "http://synthetic:fixture-password@["
        with pytest.raises(HarnessError) as error:
            await open_session(replace(spec, opencode=replace(spec.opencode, endpoint=secret_endpoint)))
        assert error.value.code == "invalid-options"
        assert "fixture-password" not in str(error.value)
        assert requests(trace) == []
        assert not (tmp_path / "AGENTS.md").exists()
    assert get_session_capabilities("opencode", "rpc").approval


async def test_resume_rejects_cross_endpoint_before_network(tmp_path):
    async with peer(tmp_path) as (spec, trace, _):
        async with await open_session(spec) as session:
            reference = session.reference
        before = requests(trace)
        for wrong in (
            replace(reference, endpoint="http://127.0.0.1:1"),
            replace(reference, workdir=Path("/synthetic/other")),
            replace(reference, session_file=tmp_path / "invented-history"),
        ):
            with pytest.raises(HarnessError) as error:
                await open_session(replace(spec, resume=wrong))
            assert error.value.code == "invalid-options"
        assert requests(trace) == before
        with pytest.raises(HarnessError) as error:
            await open_session(replace(spec, resume=replace(reference, session_id="ses_missing")))
        assert error.value.code == "launch-failed"
        assert sum(request["method"] == "POST" and request["path"] == "/session" for request in requests(trace)) == 1


async def test_explicit_unauthenticated_endpoint(tmp_path):
    async with peer(tmp_path, "no-auth") as (spec, trace, _):
        options = OpenCodeOptions(spec.opencode.endpoint, "none")
        async with await open_session(replace(spec, opencode=options)) as session:
            turn = session.start_turn("success")
            async for _ in turn.events:
                pass
            assert (await turn.result).status == "completed"
        assert_caller_server_preserved(trace)
