"""Live Pi RPC session contract: handshake, turns, events, interruption, teardown.

Every test drives a real child: tests/helpers/rpc_agent.py is a synthetic Pi
RPC peer whose behavior is selected with HARNESS_RPC_CASE. The cross-language
scenarios live in tests/session_cases.json (TypeScript and the Node package
consume the same file); Python-only edges follow as ordinary tests.
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path

import pytest

from harness import (
    HarnessError,
    SessionReference,
    SessionSpec,
    SessionTurn,
    get_session_capabilities,
    open_session,
)

TESTS = Path(__file__).parent
HELPER = str((TESTS / "helpers" / "rpc_agent.py").absolute())
CASES = json.loads((TESTS / "session_cases.json").read_text())
LOCK_DIRNAME = ".harness-run.lock"

pytestmark = pytest.mark.skipif(sys.platform not in ("darwin", "linux"), reason="owned process groups need POSIX")


def _spec(case: str, workdir: Path, **overrides: object) -> SessionSpec:
    options: dict = dict(
        executable=HELPER,
        env={"HARNESS_RPC_CASE": case},
        timeout_seconds=5,
        request_timeout_seconds=1,
    )
    options.update(overrides)
    return SessionSpec("pi", workdir, "rpc", **options)


async def _first_event(turn: SessionTurn):
    return await turn.events.__anext__()


async def _drain(turn: SessionTurn) -> list[str]:
    return [event.type async for event in turn.events]


# ── shared manifest ─────────────────────────────────────────────────────────


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
async def test_shared_case(case: dict, tmp_path: Path):
    timeout = 1 if case["status"] == "timed-out" else 5
    async with await open_session(_spec(case["name"], tmp_path, timeout_seconds=timeout)) as session:
        turn = session.start_turn("hello")
        types = await _drain(turn)
        result = await turn.result
    assert result.status == case["status"]
    assert result.session_id == session.reference.session_id
    assert result.turn_id == turn.id
    if "event_types" in case:
        assert types == case["event_types"]
    if "exit_code" in case:
        assert result.exit_code == case["exit_code"]
    if "signal" in case:
        assert result.signal == case["signal"]
    if result.status == "completed":
        assert result.error is None
    else:
        assert result.error
    assert not result.events_truncated


async def test_completed_turn_keeps_native_payloads_and_session_alive(tmp_path: Path):
    async with await open_session(_spec("success", tmp_path)) as session:
        turn = session.start_turn("hello")
        events = [event async for event in turn.events]
        result = await turn.result
        assert result.raw is not None and result.raw["type"] == "agent_end"
        assert result.raw["messages"][0]["usage"] == {"input": 2, "output": 3, "cost": {"total": 0}}
        assert result.exit_code is None and result.signal is None
        assert all(event.turn_id == turn.id and event.session_id == session.reference.session_id for event in events)
        assert events[0].type == "response" and events[0].request_id is not None
        assert events[0].raw["command"] == "prompt" and events[0].raw["success"] is True
        assert not session.closed and session.active is None
        follow_up = session.start_turn("again")
        assert follow_up.id != turn.id
        assert (await follow_up.result).status == "completed"
        assert session.reference.session_id == result.session_id


async def test_stderr_is_captured_bounded(tmp_path: Path):
    async with await open_session(_spec("stderr", tmp_path, max_buffer_bytes=1000)) as session:
        turn = session.start_turn("hello")
        drained = asyncio.ensure_future(_drain(turn))
        result = await turn.result
        await drained
    assert result.status == "completed"
    assert result.stderr_bytes == len(b"synthetic diagnostics\n") * 100
    assert result.stderr_truncated and len(result.stderr.encode()) == 1000
    assert result.stderr.startswith("synthetic diagnostics")


async def test_unicode_separators_stay_inside_one_frame(tmp_path: Path):
    async with await open_session(_spec("unicode", tmp_path)) as session:
        turn = session.start_turn("hello")
        deltas = [
            event.raw["assistantMessageEvent"]["delta"]
            async for event in turn.events
            if event.type == "message_update"
        ]
        await turn.result
    assert deltas[0] == "snowman \u2603 separator \u2028 and \u2029"


# ── capabilities and validation ─────────────────────────────────────────────


def test_session_capabilities_for_pi_rpc():
    caps = get_session_capabilities("pi")
    assert caps.backend == "rpc"
    assert (caps.events, caps.interrupt, caps.follow_up, caps.resume) == (True, True, True, True)
    assert (caps.concurrent_turns, caps.approval) == (False, False)


@pytest.mark.parametrize(
    ("name", "backend", "code"),
    [
        ("nope", "rpc", "unknown-harness"),
        ("codex", "rpc", "unsupported-backend"),
        ("pi", "cli", "unsupported-backend"),
        ("pi", "sdk", "unsupported-backend"),
        ("pi", "grpc", "invalid-options"),
        ("codex", "grpc", "invalid-options"),
        ("nope", "grpc", "unknown-harness"),
    ],
)
def test_session_capabilities_rejections(name: str, backend: str, code: str):
    with pytest.raises(HarnessError) as info:
        get_session_capabilities(name, backend)  # type: ignore[arg-type]
    assert info.value.code == code


@pytest.mark.parametrize(
    ("overrides", "code"),
    [
        ({"harness": "nope"}, "unknown-harness"),
        ({"harness": "claude-code"}, "unsupported-backend"),
        ({"backend": "cli"}, "unsupported-backend"),
        ({"backend": "grpc"}, "invalid-options"),
        ({"harness": "codex", "backend": "grpc"}, "invalid-options"),
        ({"harness": "nope", "backend": "grpc"}, "unknown-harness"),
        ({"permission_policy": "bypass"}, "unsupported-capability"),
        ({"permission_policy": "yolo"}, "invalid-options"),
        ({"model": "   "}, "invalid-options"),
        ({"executable": "bin/pi"}, "invalid-options"),
        ({"timeout_seconds": -1}, "invalid-options"),
        ({"request_timeout_seconds": 0}, "invalid-options"),
        ({"max_buffer_bytes": 1.5}, "invalid-options"),
        ({"resume": SessionReference("id", None, Path("/tmp"))}, "invalid-options"),
    ],
)
async def test_open_session_rejects_before_spawn(tmp_path: Path, overrides: dict, code: str):
    options = dict(harness="pi", workdir=tmp_path, backend="rpc", executable=HELPER)
    options.update(overrides)
    with pytest.raises(HarnessError) as info:
        async with await open_session(SessionSpec(**options)):
            pass
    assert info.value.code == code
    assert not (tmp_path / LOCK_DIRNAME).exists()
    assert not (tmp_path / "synthetic-session.jsonl").exists()


async def test_open_session_missing_executable_is_launch_failed(tmp_path: Path):
    with pytest.raises(HarnessError) as info:
        async with await open_session(_spec("success", tmp_path, executable=str(tmp_path / "missing-pi"), instructions="X")):
            pass
    assert info.value.code == "launch-failed"
    assert not (tmp_path / "AGENTS.md").exists()
    assert not (tmp_path / LOCK_DIRNAME).exists()


@pytest.mark.parametrize(("case", "fragment"), [("startup_hang", "get_state"), ("bad_state", "sessionId")])
async def test_open_session_handshake_failures_are_protocol_errors(tmp_path: Path, case: str, fragment: str):
    with pytest.raises(HarnessError) as info:
        async with await open_session(_spec(case, tmp_path)):
            pass
    assert info.value.code == "protocol-error"
    assert fragment in str(info.value)
    assert not (tmp_path / LOCK_DIRNAME).exists()


# ── turn admission ──────────────────────────────────────────────────────────


async def test_start_turn_admission_rules(tmp_path: Path):
    async with await open_session(_spec("success", tmp_path)) as session:
        for prompt in ("", "  \n", "a\0b"):
            with pytest.raises(HarnessError) as info:
                session.start_turn(prompt)
            assert info.value.code == "invalid-options"
        turn = session.start_turn("hello")
        assert session.active is turn
        with pytest.raises(HarnessError) as info:
            session.start_turn("overlap")
        assert info.value.code == "unsupported-capability"
        assert (await turn.result).status == "completed"
        with pytest.raises(HarnessError) as info:
            await session.interrupt()
        assert info.value.code == "unsupported-capability"
    with pytest.raises(HarnessError) as info:
        session.start_turn("after close")
    assert info.value.code == "session-closed"
    with pytest.raises(HarnessError) as info:
        await session.interrupt()
    assert info.value.code == "session-closed"


async def test_turn_ids_are_monotonic_strings(tmp_path: Path):
    async with await open_session(_spec("success", tmp_path)) as session:
        ids = []
        for _ in range(3):
            turn = session.start_turn("hello")
            await turn.result
            ids.append(turn.id)
    assert ids == ["turn-1", "turn-2", "turn-3"]


# ── interruption ────────────────────────────────────────────────────────────


async def test_interrupt_confirmed_by_native_abort(tmp_path: Path):
    async with await open_session(_spec("interrupt", tmp_path)) as session:
        turn = session.start_turn("hello")
        assert (await _first_event(turn)).type == "response"
        await session.interrupt()
        result = await turn.result
        assert result.status == "interrupted"
        assert result.raw is not None and result.raw["messages"][-1]["stopReason"] == "aborted"
        assert [event.type async for event in turn.events] == ["agent_start", "agent_end", "agent_settled", "response"]
        assert not session.closed and session.active is None


async def test_interrupt_before_prompt_ack_keeps_slot_until_both_acks(tmp_path: Path):
    async with await open_session(_spec("interrupt_before_ack", tmp_path)) as session:
        turn = session.start_turn("hello")
        assert (await _first_event(turn)).type == "agent_start"
        await session.interrupt()
        result = await turn.result
        assert result.status == "interrupted"
        commands = [event.raw["command"] async for event in turn.events if event.type == "response"]
        assert commands == ["abort", "prompt"]
        assert session.active is None


async def test_unacknowledged_abort_tears_down(tmp_path: Path):
    async with await open_session(_spec("abort_hang", tmp_path)) as session:
        turn = session.start_turn("hello")
        await _first_event(turn)
        await session.interrupt()
        result = await turn.result
        assert result.status == "protocol-error"
        assert "abort" in (result.error or "")
        assert session.closed


# ── disposal ────────────────────────────────────────────────────────────────


async def test_close_settles_active_turn_and_restores_instructions(tmp_path: Path):
    (tmp_path / "AGENTS.md").write_text("original rules\n")
    async with await open_session(_spec("close", tmp_path, instructions="live rules")) as session:
        assert (tmp_path / "AGENTS.md").read_text() == "live rules"
        turn = session.start_turn("hello")
        await _first_event(turn)
        await asyncio.gather(session.close(), session.close())
        result = await turn.result
        assert result.status == "closed" and result.error is None
        assert result.signal == "SIGTERM"
        assert (tmp_path / "AGENTS.md").read_text() == "original rules\n"
        assert not (tmp_path / LOCK_DIRNAME).exists()
        assert [event.type async for event in turn.events] == ["agent_start"]
        assert [event async for event in session.events] == [] and session.closed
        await session.close()


async def test_close_kills_sigterm_ignoring_descendant(tmp_path: Path):
    async with await open_session(_spec("descendant", tmp_path, instructions="live rules")) as session:
        turn = session.start_turn("hello")
        await _first_event(turn)
        pid_file = tmp_path / "synthetic-child.pid"
        for _ in range(200):
            if pid_file.exists() and pid_file.read_text():
                break
            await asyncio.sleep(0.02)
        pid = int(pid_file.read_text())
        loop = asyncio.get_running_loop()
        started = loop.time()
        await session.close()
        assert loop.time() - started < 3.0
        assert (await turn.result).status == "closed"
        with pytest.raises(ProcessLookupError):
            os.kill(pid, 0)
        assert not (tmp_path / "AGENTS.md").exists()
        assert not (tmp_path / LOCK_DIRNAME).exists()


async def test_leader_exit_stops_descendant_without_inherited_stdio(tmp_path: Path):
    async with await open_session(_spec("descendant_exit", tmp_path, instructions="held")) as session:
        turn = session.start_turn("fork")
        result = await turn.result
        assert result.status == "exited"
        pid = int((tmp_path / "synthetic-child.pid").read_text())
        with pytest.raises(ProcessLookupError):
            os.kill(pid, 0)
        assert not (tmp_path / "AGENTS.md").exists()
        assert not (tmp_path / LOCK_DIRNAME).exists()


async def test_cancelled_open_tears_child_down(tmp_path: Path):
    opening = asyncio.ensure_future(open_session(_spec("startup_hang", tmp_path, request_timeout_seconds=30, instructions="X")))
    await asyncio.sleep(0.3)
    loop = asyncio.get_running_loop()
    started = loop.time()
    opening.cancel()
    with pytest.raises(asyncio.CancelledError):
        await opening
    assert loop.time() - started < 3.0
    assert not (tmp_path / "AGENTS.md").exists()
    assert not (tmp_path / LOCK_DIRNAME).exists()


async def test_cancelled_turn_result_await_does_not_break_the_turn(tmp_path: Path):
    async with await open_session(_spec("success", tmp_path)) as session:
        turn = session.start_turn("hello")
        waiter = asyncio.ensure_future(turn.result)
        await asyncio.sleep(0)
        waiter.cancel()
        with pytest.raises(asyncio.CancelledError):
            await waiter
        assert (await turn.result).status == "completed"


# ── events ──────────────────────────────────────────────────────────────────


async def test_idle_frames_flow_through_session_events(tmp_path: Path):
    async with await open_session(_spec("idle_unknown", tmp_path)) as session:
        idle = await session.events.__anext__()
        turn = session.start_turn("hello")
        turn_events = await _drain(turn)
        await turn.result
    remaining = [event async for event in session.events]
    assert idle.type == "synthetic_idle" and idle.raw == {"type": "synthetic_idle", "nativeDetail": {"retained": True}}
    assert idle.turn_id is None and idle.request_id is None
    assert idle.session_id == session.reference.session_id
    assert turn_events[0] == "response" and remaining == []


async def test_unconsumed_overflow_fails_loudly_but_keeps_buffered_events(tmp_path: Path):
    async with await open_session(_spec("flood", tmp_path, max_buffer_bytes=4096)) as session:
        turn = session.start_turn("hello")
        result = await turn.result
        assert result.status == "protocol-error" and result.events_truncated
        assert "max_buffer_bytes" in (result.error or "")
        buffered = [event async for event in turn.events]
        assert buffered and buffered[0].type == "response"
        assert sum(len(json.dumps(e.raw, ensure_ascii=False).encode()) for e in buffered) <= 4096
        assert session.closed


async def test_breaking_event_iteration_keeps_overflow_detection(tmp_path: Path):
    async with await open_session(_spec("flood_after_break", tmp_path, max_buffer_bytes=4096)) as session:
        turn = session.start_turn("hello")
        async for event in turn.events:
            assert event.type == "response"
            break
        (tmp_path / "continue-flood").touch()
        result = await turn.result
        assert result.status == "protocol-error"
        assert result.events_truncated
        assert session.closed


async def test_events_iterator_is_single_consumer(tmp_path: Path):
    async with await open_session(_spec("success", tmp_path)) as session:
        turn = session.start_turn("hello")
        iterator = turn.events.__aiter__()
        with pytest.raises(HarnessError) as info:
            turn.events.__aiter__()
        assert info.value.code == "unsupported-capability"
        assert (await iterator.__anext__()).type == "response"
        await turn.result


# ── native identity and resume ──────────────────────────────────────────────


async def test_reference_round_trips_into_resume(tmp_path: Path):
    async with await open_session(_spec("success", tmp_path)) as session:
        reference = session.reference
        assert reference.session_id == "11111111-2222-4333-8444-555555555555"
        assert reference.session_file == tmp_path.absolute() / "synthetic-session.jsonl"
        assert reference.workdir == tmp_path.absolute()

    async with await open_session(_spec("success", tmp_path, resume=reference)) as resumed:
        assert resumed.reference.session_id == reference.session_id
        assert resumed.spec.resume == reference
        turn = resumed.start_turn("continue")
        assert (await turn.result).status == "completed"


async def test_resume_verifies_header_before_spawn_and_identity_after(tmp_path: Path):
    async with await open_session(_spec("success", tmp_path)) as session:
        reference = session.reference
        await session.close()
        assert reference.session_file is not None

        with pytest.raises(HarnessError) as info:
            async with await open_session(_spec("success", tmp_path, resume=SessionReference("other-id", reference.session_file, reference.workdir))):
                pass
        assert info.value.code == "invalid-options"

        with pytest.raises(HarnessError) as info:
            async with await open_session(_spec("success", tmp_path, resume=SessionReference(reference.session_id, tmp_path / "missing.jsonl", reference.workdir))):
                pass
        assert info.value.code == "invalid-options"

        elsewhere = tmp_path / "elsewhere"
        elsewhere.mkdir()
        with pytest.raises(HarnessError) as info:
            async with await open_session(_spec("success", elsewhere, resume=reference)):
                pass
        assert info.value.code == "invalid-options"
        with pytest.raises(HarnessError) as info:
            async with await open_session(_spec("success", tmp_path, resume=SessionReference(reference.session_id, reference.session_file, elsewhere))):
                pass
        assert info.value.code == "invalid-options"

        with pytest.raises(HarnessError) as info:
            async with await open_session(_spec("wrong_session", tmp_path, resume=reference)):
                pass
        assert info.value.code == "protocol-error"
        assert "wrong-native-id" in str(info.value)
        assert not (tmp_path / LOCK_DIRNAME).exists()



async def test_startup_events_wait_for_verified_native_identity(tmp_path: Path):
    async with await open_session(_spec("prelude", tmp_path)) as session:
        event = await asyncio.wait_for(session.events.__anext__(), 1)
        assert event.type == "synthetic_idle"
        assert event.session_id == session.reference.session_id
        assert event.turn_id is None
        assert event.raw["nativeDetail"] == {"retained": True}


@pytest.mark.parametrize("scenario", ["prelude_flood", "relative_state"])
async def test_invalid_startup_stream_releases_ownership(scenario: str, tmp_path: Path):
    with pytest.raises(HarnessError) as info:
        async with await open_session(_spec(scenario, tmp_path, max_buffer_bytes=512)):
            pass
    assert info.value.code == "protocol-error"
    assert not (tmp_path / LOCK_DIRNAME).exists()


async def test_cancelled_interrupt_disposes_before_propagating(tmp_path: Path):
    async with await open_session(_spec("abort_hang", tmp_path, request_timeout_seconds=10)) as session:
        turn = session.start_turn("synthetic prompt")
        await _first_event(turn)
        interrupt = asyncio.create_task(session.interrupt())
        await asyncio.sleep(0.02)
        interrupt.cancel()
        with pytest.raises(asyncio.CancelledError):
            await interrupt
        assert session.closed
        assert (await turn.result).status == "closed"
        assert not (tmp_path / LOCK_DIRNAME).exists()
