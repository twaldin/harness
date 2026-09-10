"""Real optional SDK with a finite synthetic CLI; no native provider or auth."""

from __future__ import annotations

import asyncio
from dataclasses import replace
import importlib.util
import json
from pathlib import Path
import subprocess
import sys

import pytest

from harness import (
    ClaudeSdkOptions,
    HarnessError,
    SessionReference,
    SessionSpec,
    get_session_capabilities,
    open_session,
)

ROOT = Path(__file__).parent
CASES = json.loads((ROOT / "claude_sdk_cases.json").read_text())
SDK = importlib.util.find_spec("claude_agent_sdk")
pytestmark = pytest.mark.skipif(
    sys.platform not in ("darwin", "linux") or SDK is None,
    reason="Claude SDK optional test dependency and POSIX required",
)


@pytest.fixture
def spec(tmp_path: Path) -> SessionSpec:
    workdir = tmp_path / "work"
    workdir.mkdir()
    home = tmp_path / "home"
    home.mkdir()
    assert SDK is not None and SDK.origin is not None
    return SessionSpec(
        "claude-code",
        workdir,
        "sdk",
        executable=sys.executable,
        model="synthetic-model",
        env={"HOME": str(home), "HARNESS_TEST_CLAUDE_VERSION": "2.1.259"},
        timeout_seconds=5,
        request_timeout_seconds=10,
        claude_sdk=ClaudeSdkOptions(
            package_root=Path(SDK.origin).parent,
            cli_path=(ROOT / "helpers" / "claude_cli.py").absolute(),
            config_dir=tmp_path / "config",
            setting_sources=("project",),
        ),
    )


async def collect(turn):
    return [event async for event in turn.events]


@pytest.mark.parametrize("case", CASES, ids=[case["prompt"] for case in CASES])
async def test_shared_native_sdk_cases(spec: SessionSpec, case: dict):
    session = await open_session(spec)
    try:
        turn = session.start_turn(case["prompt"])
        events = await collect(turn)
        result = await turn.result
        assert result.status == case["status"]
        assert result.session_id == session.reference.session_id
        unknown = next(event for event in events if event.type == "future_native_event")
        assert unknown.raw["payload"] == {"preserve": True}
        assistant = next(event for event in events if event.type == "assistant")
        assert assistant.raw["future_assistant_field"] == {"preserve": True}
        assert assistant.raw["message"]["content"][-1] == {
            "type": "future_content",
            "preserve": True,
        }
        assert all(
            event.harness == "claude-code"
            and event.backend == "sdk"
            and event.turn_id == turn.id
            for event in events
        )
        if case["terminal"]:
            assert result.raw["future_result_field"] == {"preserve": True}
            assert result.raw["total_cost_usd"] == 0.01
            assert result.raw["modelUsage"]["synthetic-model"]["inputTokens"] == 10
        if case["status"] == "agent-error":
            assert result.raw["errors"] == ["synthetic native failure"]
            assert result.error
    finally:
        await session.close()
    assert not (spec.workdir / ".harness-run.lock").exists()


async def test_follow_up_exact_resume_and_cumulative_cost(spec: SessionSpec):
    session = await open_session(spec)
    selected_id = session.reference.session_id
    try:
        for number in (1, 2):
            turn = session.start_turn("success")
            await collect(turn)
            result = await turn.result
            assert result.status == "completed"
            assert result.session_id == selected_id
            assert result.raw["total_cost_usd"] == 0.01 * number
        reference = session.reference
        assert reference.session_file is not None and reference.session_file.exists()
    finally:
        await session.close()
    async with await open_session(replace(spec, resume=reference)) as resumed:
        turn = resumed.start_turn("success")
        await collect(turn)
        assert (await turn.result).session_id == selected_id
        assert resumed.reference.session_file == reference.session_file
    wrong = replace(reference, session_id="00000000-0000-4000-8000-000000000000")
    with pytest.raises(HarnessError):
        await open_session(replace(spec, resume=wrong))
    assert not (spec.workdir / ".harness-run.lock").exists()


async def test_resume_preserves_uppercase_native_uuid(spec: SessionSpec):
    session_id = "ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF"
    transcript = spec.workdir / "uppercase-native.jsonl"
    transcript.write_text(
        json.dumps({"type": "user", "sessionId": session_id, "cwd": str(spec.workdir)})
        + "\n"
    )
    reference = SessionReference(session_id, transcript, spec.workdir)
    async with await open_session(replace(spec, resume=reference)) as resumed:
        turn = resumed.start_turn("success")
        await collect(turn)
        result = await turn.result
        assert result.status == "completed"
        assert result.session_id == session_id
        assert resumed.reference == reference
    with pytest.raises(HarnessError):
        await open_session(
            replace(spec, resume=replace(reference, session_id=session_id.lower()))
        )
    assert not (spec.workdir / ".harness-run.lock").exists()


@pytest.mark.parametrize(
    ("prompt", "status"), [("hang", "interrupted"), ("race", "completed")]
)
async def test_interrupt_receipt_settlement_and_follow_up(
    spec: SessionSpec, prompt: str, status: str
):
    async with await open_session(spec) as session:
        turn = session.start_turn(prompt)
        interruption = None
        events = []
        async for event in turn.events:
            events.append(event)
            if event.type == "assistant":
                with pytest.raises(HarnessError) as caught:
                    session.start_turn("concurrent")
                assert caught.value.code == "unsupported-capability"
                interruption = asyncio.create_task(session.interrupt())
        assert interruption is not None
        await interruption
        assert (await turn.result).status == status
        receipt = next(event for event in events if event.type == "claude_interrupt")
        assert receipt.raw["receipt"]["still_queued"] == []
        follow = session.start_turn("success")
        await collect(follow)
        assert (await follow.result).status == "completed"


async def test_missing_receipt_rejects_concurrent_interrupt_callers(spec: SessionSpec):
    async with await open_session(
        replace(spec, env={**spec.env, "HARNESS_TEST_CLAUDE_RECEIPT": "missing"})
    ) as session:
        turn = session.start_turn("hang")
        async for event in turn.events:
            if event.type == "assistant":
                outcomes = await asyncio.gather(
                    session.interrupt(), session.interrupt(), return_exceptions=True
                )
                assert all(
                    isinstance(error, HarnessError) and error.code == "adapter-error"
                    for error in outcomes
                )
                await session.close()
        assert (await turn.result).status == "closed"


@pytest.mark.parametrize(
    ("decision", "expected"), [("once", "allow"), ("reject", "deny")]
)
async def test_sdk_permission_callback_round_trip(
    spec: SessionSpec, decision: str, expected: str
):
    assert get_session_capabilities("claude-code", "sdk").approval
    async with await open_session(spec) as session:
        turn = session.start_turn("permission")
        request_id = None
        async for event in turn.events:
            if event.type == "claude_permission":
                request_id = event.request_id
                assert event.raw["tool_name"] == "Bash"
                await session.respond_approval(request_id, decision)
        assert (await turn.result).raw["result"] == "permission " + expected
        assert request_id is not None
        with pytest.raises(HarnessError) as caught:
            await session.respond_approval(request_id, decision)
        assert caught.value.code == "invalid-options"


async def test_close_restores_instructions_and_settles_active_turn(spec: SessionSpec):
    instruction = spec.workdir / "CLAUDE.md"
    instruction.write_text("original instructions")
    session = await open_session(replace(spec, instructions="temporary instructions"))
    turn = session.start_turn("hang")
    consuming = asyncio.create_task(collect(turn))
    await asyncio.gather(session.close(), session.close())
    await consuming
    assert (await turn.result).status == "closed"
    assert instruction.read_text() == "original instructions"
    assert not (spec.workdir / ".harness-run.lock").exists()


async def test_deadline_releases_pending_native_permission(spec: SessionSpec):
    session = await open_session(replace(spec, timeout_seconds=0.3))
    try:
        turn = session.start_turn("permission")
        events = await collect(turn)
        assert any(event.type == "claude_permission" for event in events)
        assert (await turn.result).status == "timed-out"
    finally:
        await session.close()
    assert not (spec.workdir / ".harness-run.lock").exists()


async def test_explicit_failures_do_not_fall_back(spec: SessionSpec):
    with pytest.raises(HarnessError) as caught:
        await open_session(replace(spec, permission_policy="bypass"))
    assert caught.value.code == "unsupported-capability"
    with pytest.raises(HarnessError) as caught:
        await open_session(
            replace(
                spec,
                claude_sdk=replace(
                    spec.claude_sdk, package_root=spec.workdir / "absent"
                ),
            )
        )
    assert caught.value.code == "launch-failed"
    assert not (spec.workdir / ".harness-run.lock").exists()
    with pytest.raises(HarnessError) as caught:
        await open_session(
            replace(spec, env={**spec.env, "HARNESS_TEST_CLAUDE_VERSION": "0.0.0"})
        )
    assert caught.value.code == "launch-failed"
    assert not (spec.workdir / ".harness-run.lock").exists()


def test_ordinary_import_and_capabilities_do_not_import_sdk():
    script = "import sys; import harness; harness.get_session_capabilities('claude-code', 'sdk'); assert not any(name == 'claude_agent_sdk' or name.startswith('claude_agent_sdk.') for name in sys.modules)"
    result = subprocess.run(
        [sys.executable, "-c", script], capture_output=True, text=True, timeout=10
    )
    assert result.returncode == 0, result.stderr
