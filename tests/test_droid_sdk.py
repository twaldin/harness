"""Live Factory Droid session contract: the `factory-droid` / `sdk` backend.

Every test drives the real installed droid-sdk (pinned 0.4.0) against
tests/helpers/droid_agent.py, a synthetic `droid exec` JSON-RPC peer selected
through `executable` and scripted with HARNESS_DROID_CASE. The cross-language
scenarios live in tests/droid_sdk_cases.json. HOME is isolated per test, the
API key is a literal non-credential and nothing touches a provider.
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path

import pytest

from harness import (
    FactoryDroidOptions,
    HarnessError,
    SessionReference,
    SessionSpec,
    SessionTurn,
    get_session_capabilities,
    open_session,
)

TESTS = Path(__file__).parent
HELPER = str((TESTS / "helpers" / "droid_agent.py").absolute())
CASES = json.loads((TESTS / "droid_sdk_cases.json").read_text())
SESSION_ID = CASES["session_id"]
LOCK_DIRNAME = ".harness-run.lock"
API_KEY = "synthetic-not-a-credential"

pytestmark = pytest.mark.skipif(sys.platform not in ("darwin", "linux"), reason="owned process groups need POSIX")
droid_sdk = pytest.importorskip("droid_sdk", reason="the factory-droid sdk backend drives the installed droid-sdk")


class Sandbox:
    """Isolated HOME, workdir and peer trace for one test."""

    def __init__(self, root: Path) -> None:
        self.home = root / "home"
        self.workdir = root / "work"
        for directory in (self.home, self.workdir):
            directory.mkdir()
        self.trace_file = root / "trace.jsonl"

    def env(self, case: str) -> dict[str, str]:
        return {
            "HOME": str(self.home),
            "FACTORY_HOME_OVERRIDE": str(self.home),
            "HARNESS_DROID_CASE": case,
            "HARNESS_DROID_TRACE": str(self.trace_file),
            "FACTORY_API_KEY": API_KEY,
        }

    def spec(self, case: str = "success", **overrides: object) -> SessionSpec:
        options: dict = dict(executable=HELPER, env=self.env(case), timeout_seconds=5, request_timeout_seconds=2)
        options.update(overrides)
        return SessionSpec("factory-droid", self.workdir, "sdk", **options)

    def trace(self) -> list[dict]:
        if not self.trace_file.exists():
            return []
        return [json.loads(line) for line in self.trace_file.read_text().splitlines() if line]

    def requests(self) -> list[str]:
        return [record["method"] for record in self.trace() if record["type"] == "request"]

    def session_file(self) -> Path:
        return self.home / ".factory" / "sessions" / ("-" + os.path.realpath(self.workdir).strip("/").replace("/", "-")) / f"{SESSION_ID}.jsonl"

    def assert_no_side_effects(self) -> None:
        assert not (self.workdir / LOCK_DIRNAME).exists()
        assert not (self.workdir / "AGENTS.md").exists()
        assert self.trace() == []


@pytest.fixture
def sandbox(tmp_path: Path) -> Sandbox:
    return Sandbox(tmp_path)


async def _drain(turn: SessionTurn) -> list[str]:
    events = []
    while True:
        try:
            events.append((await turn.events.__anext__()).type)
        except StopAsyncIteration:
            return events


async def _until(turn: SessionTurn, kind: str) -> list[str]:
    seen = []
    async for event in turn.events:
        seen.append(event.type)
        if event.type == kind:
            break
    return seen


# ── shared manifest ─────────────────────────────────────────────────────────


@pytest.mark.parametrize("case", CASES["turns"], ids=[c["name"] for c in CASES["turns"]])
async def test_shared_turn(case: dict, sandbox: Sandbox):
    async with await open_session(sandbox.spec(case["name"])) as session:
        assert session.reference.session_id == SESSION_ID
        turn = session.start_turn("hello")
        events = [event async for event in turn.events]
        result = await turn.result
    assert result.status == case["status"]
    assert result.session_id == SESSION_ID and result.turn_id == turn.id
    assert all((event.backend, event.harness, event.session_id, event.turn_id) == ("sdk", "factory-droid", SESSION_ID, turn.id) for event in events)
    if "exit_code" in case:
        assert result.exit_code == case["exit_code"]
    if "signal" in case:
        assert result.signal == case["signal"]
    if result.status == "completed":
        assert result.error is None
        assert result.raw is not None and result.raw["type"] == "agent_turn_completed" and result.raw["reason"] == "completed"
        assert result.raw["tokenUsage"] == CASES["usage"]
        delta = next(event for event in events if event.type == "assistant_text_delta")
        assert delta.raw["textDelta"] == CASES["text"]
    else:
        assert result.error
    assert not result.events_truncated
    assert not (sandbox.workdir / LOCK_DIRNAME).exists()


@pytest.mark.parametrize("case", CASES["interrupts"])
async def test_shared_interrupt(case: str, sandbox: Sandbox):
    async with await open_session(sandbox.spec(case)) as session:
        turn = session.start_turn("hello")
        assert "synthetic_unknown" in await _until(turn, "synthetic_unknown")
        await session.interrupt()
        result = await turn.result
        assert result.status == "interrupted" and result.error is None
        assert result.raw is not None and result.raw["reason"] == "cancelled" and result.raw["turnId"]
        remaining = await _drain(turn)
        assert remaining[-1] == "response"  # the interrupt acknowledgement lands after the terminal
        assert not session.closed and session.active is None
    assert sandbox.requests()[-2:] == ["droid.interrupt_session", "droid.close_session"]


@pytest.mark.parametrize("case", CASES["startup"], ids=[c["name"] for c in CASES["startup"]])
async def test_shared_startup_failure(case: dict, sandbox: Sandbox):
    with pytest.raises(HarnessError) as info:
        await open_session(sandbox.spec(case["name"], instructions="X"))
    assert info.value.code == case["code"]
    assert not (sandbox.workdir / LOCK_DIRNAME).exists()
    assert not (sandbox.workdir / "AGENTS.md").exists()


@pytest.mark.parametrize("case", CASES["resume_failures"])
async def test_shared_resume_failure(case: str, sandbox: Sandbox):
    async with await open_session(sandbox.spec()) as session:
        reference = session.reference
    with pytest.raises(HarnessError) as info:
        await open_session(sandbox.spec(case, resume=reference, instructions="X"))
    assert info.value.code == "protocol-error"
    assert sandbox.session_file().exists()  # saved logs are never deleted
    assert not (sandbox.workdir / "AGENTS.md").exists()


# ── native events and settlement ────────────────────────────────────────────


async def test_native_frames_are_delivered_raw_and_usage_stays_scoped(sandbox: Sandbox):
    async with await open_session(sandbox.spec()) as session:
        turn = session.start_turn("hello")
        events = [event async for event in turn.events]
        result = await turn.result
        assert [event.type for event in events] == [
            "response",
            "assistant_text_delta",
            "synthetic_unknown",
            "session_token_usage_changed",
            "agent_turn_completed",
        ]
        ack = events[0]
        assert ack.request_id == ack.raw["id"] and ack.raw["result"] == {} and ack.raw["type"] == "response"
        assert all(event.request_id is None for event in events[1:])
        assert events[2].raw == {"type": "synthetic_unknown", "detail": {"preserved": True}, "turnNumber": 1}
        assert events[3].raw["tokenUsage"] == CASES["usage"]
        assert result.raw is events[4].raw
        assert result.raw["turnId"] and result.raw["durationMs"] == 1
        assert result.exit_code is None and result.signal is None

        follow_up = session.start_turn("again")
        await _drain(follow_up)
        second = await follow_up.result
        assert follow_up.id != turn.id and second.status == "completed"
        # Per-turn usage is repeated as sent; the cumulative snapshot is the
        # session's own total. Nothing is summed or relabelled.
        assert second.raw["tokenUsage"] == CASES["usage"]
        assert second.raw["cumulativeTokenUsage"]["inputTokens"] == 2 * CASES["usage"]["inputTokens"]
        assert second.raw["cumulativeTokenUsage"]["factoryCredits"] == 2 * CASES["usage"]["factoryCredits"]
    submitted = [r["params"]["messageId"] for r in sandbox.trace() if r["type"] == "request" and r["method"] == "droid.add_user_message"]
    assert len(submitted) == 2 and submitted[0] != submitted[1]
    assert result.raw["turnId"] == submitted[0] and second.raw["turnId"] == submitted[1]


async def test_completion_before_acknowledgement_still_needs_the_ack(sandbox: Sandbox):
    async with await open_session(sandbox.spec("before_ack")) as session:
        turn = session.start_turn("hello")
        types = await _drain(turn)
        result = await turn.result
    assert result.status == "completed"
    assert types[-2:] == ["agent_turn_completed", "response"]


async def test_prompt_rejection_keeps_the_error_envelope(sandbox: Sandbox):
    async with await open_session(sandbox.spec("prompt_reject")) as session:
        turn = session.start_turn("hello")
        assert await _drain(turn) == ["response"]
        result = await turn.result
        assert result.status == "agent-error"
        assert result.raw is not None and result.raw["error"]["message"] == "synthetic prompt rejection"
        assert result.error is not None and "synthetic prompt rejection" in result.error
        assert not session.closed and session.active is None


async def test_native_error_reason_is_preserved(sandbox: Sandbox):
    async with await open_session(sandbox.spec("agent_error")) as session:
        turn = session.start_turn("hello")
        await _drain(turn)
        result = await turn.result
    assert result.status == "agent-error"
    assert result.raw is not None and result.raw["reason"] == "error"
    assert result.error is not None and "synthetic agent error" in result.error


async def test_idle_notifications_flow_through_session_events(sandbox: Sandbox):
    async with await open_session(sandbox.spec("idle_unknown")) as session:
        event = await session.events.__anext__()
        assert event.type == "synthetic_idle" and event.turn_id is None
        assert event.raw == {"type": "synthetic_idle", "detail": {"preserved": True}}


async def test_iterator_break_does_not_interrupt_the_agent(sandbox: Sandbox):
    async with await open_session(sandbox.spec("interrupt")) as session:
        turn = session.start_turn("hello")
        async for event in turn.events:
            if event.type == "assistant_text_delta":
                break
        await asyncio.sleep(0.1)
        assert "droid.interrupt_session" not in sandbox.requests()
        assert session.active is turn and not turn.result.done()
        await session.interrupt()
        assert (await turn.result).status == "interrupted"


# ── timeouts, hangs and disposal ────────────────────────────────────────────


async def test_turn_timeout_tears_the_session_down(sandbox: Sandbox):
    session = await open_session(sandbox.spec("hang", timeout_seconds=0.5))
    turn = session.start_turn("hello")
    result = await turn.result
    assert result.status == "timed-out"
    assert session.closed
    await session.close()
    assert not (sandbox.workdir / LOCK_DIRNAME).exists()


async def test_unacknowledged_interrupt_is_protocol_error(sandbox: Sandbox):
    session = await open_session(sandbox.spec("abort_hang", request_timeout_seconds=0.5))
    turn = session.start_turn("hello")
    await _until(turn, "synthetic_unknown")
    await session.interrupt()
    result = await turn.result
    assert result.status == "protocol-error"
    assert session.closed
    await session.close()


async def test_close_settles_active_turn_and_closes_natively(sandbox: Sandbox):
    (sandbox.workdir / "AGENTS.md").write_text("original rules\n")
    session = await open_session(sandbox.spec("hang", instructions="live rules"))
    assert (sandbox.workdir / "AGENTS.md").read_text() == "live rules"
    turn = session.start_turn("hello")
    await turn.events.__anext__()
    await session.close()
    result = await turn.result
    assert result.status == "closed" and session.closed
    assert sandbox.requests()[-1] == "droid.close_session"
    assert (sandbox.workdir / "AGENTS.md").read_text() == "original rules\n"
    assert not (sandbox.workdir / LOCK_DIRNAME).exists()
    assert [event async for event in session.events] == []


async def test_close_escalates_to_kill_within_budget(sandbox: Sandbox):
    session = await open_session(sandbox.spec("close_hang"))
    turn = session.start_turn("hello")
    await turn.events.__anext__()
    loop = asyncio.get_running_loop()
    started = loop.time()
    await session.close()
    assert loop.time() - started < 3.0
    result = await turn.result
    assert result.status == "closed" and result.signal == "SIGKILL"


async def test_close_kills_sigterm_ignoring_descendant(sandbox: Sandbox):
    async with await open_session(sandbox.spec("descendant", instructions="live rules")) as session:
        turn = session.start_turn("hello")
        await turn.events.__anext__()
        pid_file = sandbox.workdir / "synthetic-child.pid"
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
    assert not (sandbox.workdir / "AGENTS.md").exists()
    assert not (sandbox.workdir / LOCK_DIRNAME).exists()


async def test_leader_exit_stops_descendant_without_inherited_stdio(sandbox: Sandbox):
    async with await open_session(sandbox.spec("descendant_exit", instructions="held")) as session:
        turn = session.start_turn("fork")
        result = await turn.result
        assert result.status == "exited" and result.exit_code == 0
        pid = int((sandbox.workdir / "synthetic-child.pid").read_text())
        with pytest.raises(ProcessLookupError):
            os.kill(pid, 0)
    assert not (sandbox.workdir / "AGENTS.md").exists()
    assert not (sandbox.workdir / LOCK_DIRNAME).exists()


async def test_cancelled_open_tears_child_down(sandbox: Sandbox):
    opening = asyncio.ensure_future(open_session(sandbox.spec("startup_hang", request_timeout_seconds=30, instructions="X")))
    await asyncio.sleep(0.3)
    opening.cancel()
    with pytest.raises(asyncio.CancelledError):
        await opening
    assert not (sandbox.workdir / "AGENTS.md").exists()
    assert not (sandbox.workdir / LOCK_DIRNAME).exists()


async def test_parent_environment_is_never_mutated(sandbox: Sandbox):
    before = dict(os.environ)
    async with await open_session(sandbox.spec()) as session:
        assert session.spec.env == sandbox.env("success")
    assert {key for key in before.keys() | os.environ.keys() if before.get(key) != os.environ.get(key)} == set()


# ── bounds ──────────────────────────────────────────────────────────────────


async def test_unconsumed_overflow_fails_loudly(sandbox: Sandbox):
    session = await open_session(sandbox.spec("flood", max_buffer_bytes=4096))
    turn = session.start_turn("hello")
    result = await turn.result
    assert result.status == "protocol-error" and result.events_truncated
    assert session.closed
    await session.close()


async def test_stderr_is_captured_bounded(sandbox: Sandbox):
    async with await open_session(sandbox.spec("stderr", max_buffer_bytes=4096)) as session:
        turn = session.start_turn("hello")
        drained = asyncio.ensure_future(_drain(turn))
        result = await turn.result
        await drained
    assert result.status == "completed"
    assert result.stderr_bytes == len(b"synthetic stderr ") * 1024
    assert result.stderr_truncated and len(result.stderr.encode()) == 4096
    assert result.stderr.startswith("synthetic stderr")


# ── native permission and question callbacks ────────────────────────────────


def _permission_reply(selected: str):
    seen: list[dict] = []

    def reply(params: dict) -> dict:
        seen.append(params)
        return {"selectedOption": selected}

    return reply, seen


async def test_permission_callback_answers_natively(sandbox: Sandbox):
    reply, seen = _permission_reply("proceed_once")
    options = FactoryDroidOptions(on_permission=reply)
    async with await open_session(sandbox.spec("permission", factory_droid=options)) as session:
        turn = session.start_turn("hello")
        events = [event async for event in turn.events]
        result = await turn.result
        assert result.status == "completed"
        request = next(event for event in events if event.type == "request")
        assert request.request_id == "permission-1" and request.raw["method"] == "droid.request_permission"
        assert seen == [request.raw["params"]]
        assert [o["value"] for o in seen[0]["options"]] == ["proceed_once", "cancel"]
        assert (sandbox.workdir / "approved-marker").exists()
    answers = [r for r in sandbox.trace() if r["type"] == "callback_response"]
    assert answers == [{"type": "callback_response", "id": "permission-1", "result": {"selectedOption": "proceed_once"}, "error": None}]


async def test_permission_without_callback_keeps_upstream_cancel(sandbox: Sandbox):
    async with await open_session(sandbox.spec("permission")) as session:
        turn = session.start_turn("hello")
        await _drain(turn)
        result = await turn.result
        assert result.status == "interrupted"
        assert result.raw is not None and result.raw["reason"] == "permission_rejected"
        assert not (sandbox.workdir / "approved-marker").exists()
        assert not session.closed
    answers = [r for r in sandbox.trace() if r["type"] == "callback_response"]
    assert answers[0]["result"] == {"selectedOption": "cancel"}


async def test_permission_callback_cannot_expand_the_native_offer(sandbox: Sandbox):
    def tamper(params):
        params["options"].append({"label": "Always", "value": "proceed_always"})
        return {"selectedOption": "proceed_always"}

    async with await open_session(sandbox.spec(
        "permission", factory_droid=FactoryDroidOptions(on_permission=tamper),
    )) as session:
        turn = session.start_turn("Request one native approval.")
        await _drain(turn)
        result = await turn.result
    assert result.status == "agent-error"
    assert not (sandbox.workdir / "approved-marker").exists()


async def _failing_permission(params: dict) -> dict:
    raise RuntimeError("synthetic callback failure")


@pytest.mark.parametrize(
    "callback",
    [
        _permission_reply("proceed_always")[0],
        lambda params: "proceed_once",
        lambda params: {"selectedOption": "proceed_once", "extra": 1},
    ],
    ids=["unoffered", "not-an-object", "extra-field"],
)
async def test_invalid_permission_reply_fails_closed(sandbox: Sandbox, callback):
    session = await open_session(sandbox.spec("permission", factory_droid=FactoryDroidOptions(on_permission=callback)))
    turn = session.start_turn("hello")
    result = await turn.result
    assert result.status == "agent-error"
    assert session.closed
    await session.close()
    assert not (sandbox.workdir / "approved-marker").exists()
    assert not (sandbox.workdir / LOCK_DIRNAME).exists()


async def test_raising_permission_callback_retains_the_cause(sandbox: Sandbox):
    session = await open_session(sandbox.spec("permission", factory_droid=FactoryDroidOptions(on_permission=_failing_permission)))
    turn = session.start_turn("hello")
    result = await turn.result
    assert result.status == "agent-error"
    assert result.error is not None and "synthetic callback failure" in result.error
    assert session.closed
    await session.close()
    assert not (sandbox.workdir / "approved-marker").exists()
    assert not (sandbox.workdir / LOCK_DIRNAME).exists()


async def test_permission_callback_timeout_fails_closed(sandbox: Sandbox):
    async def stall(params: dict) -> dict:
        await asyncio.sleep(30)
        return {"selectedOption": "proceed_once"}

    options = FactoryDroidOptions(on_permission=stall)
    session = await open_session(sandbox.spec("permission", request_timeout_seconds=0.5, factory_droid=options))
    turn = session.start_turn("hello")
    result = await turn.result
    assert result.status == "agent-error"
    await session.close()
    assert not (sandbox.workdir / "approved-marker").exists()


async def test_question_callback_answers_natively(sandbox: Sandbox):
    seen: list[dict] = []

    async def answer(params: dict) -> dict:
        seen.append(params)
        question = params["questions"][0]
        return {"cancelled": False, "answers": [{"index": question["index"], "question": question["question"], "answer": "yes"}]}

    async with await open_session(sandbox.spec("question", factory_droid=FactoryDroidOptions(on_question=answer))) as session:
        turn = session.start_turn("hello")
        events = [event async for event in turn.events]
        result = await turn.result
        assert result.status == "completed"
        request = next(event for event in events if event.type == "request")
        assert request.request_id == "question-1" and seen == [request.raw["params"]]
    answers = [r for r in sandbox.trace() if r["type"] == "callback_response"]
    assert answers == [
        {
            "type": "callback_response",
            "id": "question-1",
            "result": {"cancelled": False, "answers": [{"index": 1, "question": "Synthetic choice?", "answer": "yes"}]},
            "error": None,
        }
    ]


async def test_question_without_callback_keeps_upstream_cancelled(sandbox: Sandbox):
    async with await open_session(sandbox.spec("question")) as session:
        turn = session.start_turn("hello")
        await _drain(turn)
        result = await turn.result
        assert result.status == "interrupted" and result.raw is not None and result.raw["reason"] == "cancelled"


@pytest.mark.parametrize(
    "reply",
    [
        {"answers": []},
        {"cancelled": False, "answers": [{"index": 7, "question": "?", "answer": "yes"}]},
        {"cancelled": False, "answers": [{"index": 1, "answer": "yes"}]},
    ],
    ids=["no-cancelled", "unoffered-index", "schema"],
)
async def test_invalid_question_reply_fails_closed(sandbox: Sandbox, reply: dict):
    session = await open_session(sandbox.spec("question", factory_droid=FactoryDroidOptions(on_question=lambda params: reply)))
    turn = session.start_turn("hello")
    result = await turn.result
    assert result.status == "agent-error"
    assert session.closed
    await session.close()


# ── native identity, options and resume ─────────────────────────────────────


async def test_reference_round_trips_into_exact_native_resume(sandbox: Sandbox):
    async with await open_session(sandbox.spec()) as session:
        reference = session.reference
        assert reference == SessionReference(SESSION_ID, sandbox.session_file(), sandbox.workdir)
        assert reference.session_file is not None and reference.session_file.exists()
        turn = session.start_turn("hello")
        await _drain(turn)
        assert (await turn.result).status == "completed"
    async with await open_session(sandbox.spec(resume=reference)) as resumed:
        assert resumed.reference == reference
        turn = resumed.start_turn("hello")
        await _drain(turn)
        result = await turn.result
    assert result.status == "completed" and result.session_id == SESSION_ID
    assert sandbox.requests() == [
        "droid.initialize_session",
        "droid.add_user_message",
        "droid.close_session",
        "droid.load_session",
        "droid.add_user_message",
        "droid.close_session",
    ]
    assert reference.session_file.exists()


async def test_resume_rejects_unverifiable_references_before_spawn(sandbox: Sandbox):
    async with await open_session(sandbox.spec()) as session:
        reference = session.reference
    sandbox.trace_file.unlink()
    assert reference.session_file is not None
    other_id = "22222222-2222-4222-8222-222222222222"
    tampered = reference.session_file.with_name(f"{other_id}.jsonl")
    header = json.loads(reference.session_file.read_text().splitlines()[0])
    tampered.write_text(json.dumps({**header, "id": other_id, "cwd": str(sandbox.home / "elsewhere")}) + "\n")
    cases = [
        SessionReference(other_id, reference.session_file, sandbox.workdir),
        SessionReference("33333333-3333-4333-8333-333333333333", reference.session_file.with_name("33333333-3333-4333-8333-333333333333.jsonl"), sandbox.workdir),
        SessionReference(other_id, tampered, sandbox.workdir),
        SessionReference(SESSION_ID, None, sandbox.workdir),
        SessionReference(SESSION_ID, reference.session_file, sandbox.home),
    ]
    for wrong in cases:
        with pytest.raises(HarnessError) as info:
            await open_session(sandbox.spec(resume=wrong, instructions="X"))
        assert info.value.code == "invalid-options"
    with pytest.raises(HarnessError) as info:
        await open_session(sandbox.spec(resume=reference, model="other-model", instructions="X"))
    assert info.value.code == "invalid-options"
    with pytest.raises(HarnessError) as info:
        await open_session(sandbox.spec(resume=reference, factory_droid=FactoryDroidOptions(autonomy="high"), instructions="X"))
    assert info.value.code == "invalid-options"
    sandbox.assert_no_side_effects()


async def test_factory_home_override_locates_the_native_session_log(sandbox: Sandbox):
    # The CLI honours FACTORY_HOME_OVERRIDE for its session root; the
    # reference must be computed from the effective child environment.
    override = sandbox.home / "override"
    override.mkdir()
    env = {**sandbox.env("success"), "FACTORY_HOME_OVERRIDE": str(override)}
    async with await open_session(sandbox.spec(env=env)) as session:
        assert session.reference.session_file is not None
        assert session.reference.session_file.is_relative_to(override / ".factory" / "sessions")
        assert session.reference.session_file.exists()
    assert not sandbox.session_file().exists()


# ── startup failures before a child exists ──────────────────────────────────


async def test_missing_api_key_is_launch_failed_before_spawn(sandbox: Sandbox, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("FACTORY_API_KEY", raising=False)
    for env in (
        {k: v for k, v in sandbox.env("success").items() if k != "FACTORY_API_KEY"},
        {**sandbox.env("success"), "FACTORY_API_KEY": ""},
    ):
        with pytest.raises(HarnessError) as info:
            await open_session(sandbox.spec(env=env, instructions="X"))
        assert info.value.code == "launch-failed"
        assert API_KEY not in str(info.value)
    sandbox.assert_no_side_effects()


async def test_sdk_version_mismatch_is_launch_failed_before_spawn(sandbox: Sandbox, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(droid_sdk, "__version__", "0.3.0")
    with pytest.raises(HarnessError) as info:
        await open_session(sandbox.spec(instructions="X"))
    assert info.value.code == "launch-failed"
    sandbox.assert_no_side_effects()


async def test_missing_sdk_is_launch_failed_before_spawn(sandbox: Sandbox, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setitem(sys.modules, "droid_sdk", None)
    with pytest.raises(HarnessError) as info:
        await open_session(sandbox.spec(instructions="X"))
    assert info.value.code == "launch-failed"
    sandbox.assert_no_side_effects()


async def test_missing_droid_executable_is_launch_failed(sandbox: Sandbox):
    with pytest.raises(HarnessError) as info:
        await open_session(sandbox.spec(executable=str(sandbox.workdir.parent / "missing-droid"), instructions="X"))
    assert info.value.code == "launch-failed"
    sandbox.assert_no_side_effects()


def test_importing_harness_does_not_import_the_sdk():
    import subprocess

    code = "import sys, harness; harness.FactoryDroidOptions(); harness.get_session_capabilities('factory-droid', 'sdk'); print('droid_sdk' in sys.modules)"
    output = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, timeout=60, check=True).stdout
    assert output.strip() == "False"


# ── capabilities and validation ─────────────────────────────────────────────


def test_session_capabilities_for_factory_droid_sdk():
    caps = get_session_capabilities("factory-droid", "sdk")
    assert caps.backend == "sdk"
    assert (caps.events, caps.interrupt, caps.follow_up, caps.resume) == (True, True, True, True)
    assert (caps.concurrent_turns, caps.approval) == (False, False)
    with pytest.raises(HarnessError) as info:
        get_session_capabilities("factory-droid", "rpc")
    assert info.value.code == "unsupported-backend"


@pytest.mark.parametrize(
    ("overrides", "code"),
    [
        ({"backend": "rpc"}, "unsupported-backend"),
        ({"backend": "cli"}, "unsupported-backend"),
        ({"harness": "pi", "backend": "rpc", "factory_droid": FactoryDroidOptions()}, "invalid-options"),
        ({"harness": "omp", "factory_droid": FactoryDroidOptions()}, "invalid-options"),
        ({"factory_droid": {"autonomy": "off"}}, "invalid-options"),
        ({"factory_droid": FactoryDroidOptions(autonomy="max")}, "invalid-options"),
        ({"factory_droid": FactoryDroidOptions(disabled_tools="Bash")}, "invalid-options"),
        ({"factory_droid": FactoryDroidOptions(disabled_tools=["Bash", ""])}, "invalid-options"),
        ({"factory_droid": FactoryDroidOptions(auto_reject_permission_requests="yes")}, "invalid-options"),
        ({"factory_droid": FactoryDroidOptions(disable_builtin_skills=1)}, "invalid-options"),
        ({"factory_droid": FactoryDroidOptions(on_permission="proceed_once")}, "invalid-options"),
        ({"factory_droid": FactoryDroidOptions(on_question={})}, "invalid-options"),
        ({"env": {"FACTORY_UPSTREAM_CLIENT_TYPE": "cli"}}, "invalid-options"),
        ({"env": {"FACTORY_UPSTREAM_SDK": "python/0.4.0"}}, "invalid-options"),
        ({"omp_sdk": "anything"}, "invalid-options"),
        ({"opencode": "anything"}, "invalid-options"),
        ({"permission_policy": "bypass"}, "unsupported-capability"),
        ({"executable": "bin/droid"}, "invalid-options"),
        ({"model": "   "}, "invalid-options"),
        ({"resume": SessionReference("id", None, TESTS)}, "invalid-options"),
        ({"resume": SessionReference("id", Path("/nowhere.jsonl"), TESTS, endpoint="http://localhost")}, "invalid-options"),
    ],
)
async def test_open_session_rejects_before_side_effects(sandbox: Sandbox, overrides: dict, code: str):
    options = dict(harness="factory-droid", workdir=sandbox.workdir, backend="sdk", executable=HELPER, env=sandbox.env("success"), instructions="X")
    options.update(overrides)
    with pytest.raises(HarnessError) as info:
        await open_session(SessionSpec(**options))
    assert info.value.code == code
    sandbox.assert_no_side_effects()


async def test_respond_approval_is_not_a_factory_channel(sandbox: Sandbox):
    async with await open_session(sandbox.spec()) as session:
        with pytest.raises(HarnessError) as info:
            await session.respond_approval("permission-1", "once")
        assert info.value.code == "unsupported-capability"
