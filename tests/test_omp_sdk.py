"""Live OMP SDK session contract: the `omp` / `sdk` backend through the shared bridge.

Every test drives the real `src/harness/_omp_sdk.mjs` worker under Bun with the
synthetic SDK package in tests/helpers/omp_sdk (selected through
`OmpSdkOptions.package_root`), an isolated HOME and agent directory, and
`auth="environment"`. Behavior is selected purely by prompt string; the
cross-language cases live in tests/omp_sdk_cases.json. No provider or network
credentials are involved.
"""
from __future__ import annotations

import asyncio
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from harness import (
    HarnessError,
    OmpSdkOptions,
    SessionReference,
    SessionSpec,
    SessionTurn,
    get_session_capabilities,
    open_session,
)

TESTS = Path(__file__).parent
PACKAGE_ROOT = (TESTS / "helpers" / "omp_sdk").absolute()
CASES = json.loads((TESTS / "omp_sdk_cases.json").read_text())
LOCK_DIRNAME = ".harness-run.lock"
LIFECYCLE = ["subscribe", "unsubscribe", "beginDispose", "dispose", "auth_close"]

pytestmark = [
    pytest.mark.skipif(sys.platform not in ("darwin", "linux"), reason="owned process groups need POSIX"),
    pytest.mark.skipif(shutil.which("bun") is None, reason="the OMP SDK bridge runs under Bun"),
]


class Sandbox:
    """Isolated HOME, agent dir, workdir and lifecycle trace for one test."""

    def __init__(self, root: Path) -> None:
        self.home = root / "home"
        self.agent_dir = root / "agent"
        self.workdir = root / "work"
        for directory in (self.home, self.agent_dir, self.workdir):
            directory.mkdir()
        self.trace_file = root / "trace.log"

    def spec(self, **overrides: object) -> SessionSpec:
        options: dict = dict(
            env={"HOME": str(self.home), "HARNESS_SDK_TRACE": str(self.trace_file)},
            timeout_seconds=5,
            request_timeout_seconds=2,
            omp_sdk=OmpSdkOptions(PACKAGE_ROOT, self.agent_dir, "environment"),
        )
        options.update(overrides)
        return SessionSpec("omp", self.workdir, "sdk", **options)

    def trace(self) -> list[str]:
        return self.trace_file.read_text().split() if self.trace_file.exists() else []

    def assert_no_side_effects(self) -> None:
        assert not (self.workdir / LOCK_DIRNAME).exists()
        assert not (self.workdir / "AGENTS.md").exists()
        assert not (self.agent_dir / "sessions").exists()
        assert list(self.home.iterdir()) == []


@pytest.fixture
def sandbox(tmp_path: Path) -> Sandbox:
    return Sandbox(tmp_path)


async def _drain(turn: SessionTurn) -> list[str]:
    return [event.type async for event in turn.events]


def _assistant_text(raw: dict) -> str:
    return raw["messages"][-1]["content"][0]["text"]


# ── shared manifest ─────────────────────────────────────────────────────────


@pytest.mark.parametrize("case", CASES, ids=[c["prompt"] for c in CASES])
async def test_shared_case(case: dict, sandbox: Sandbox):
    async with await open_session(sandbox.spec()) as session:
        turn = session.start_turn(case["prompt"])
        events = [event async for event in turn.events]
        result = await turn.result
        assert not session.closed and session.active is None
    assert result.status == case["status"]
    assert result.session_id == session.reference.session_id
    assert result.turn_id == turn.id
    if "event_types" in case:
        assert [event.type for event in events] == case["event_types"]
    assert all((event.backend, event.harness, event.turn_id) == ("sdk", "omp", turn.id) for event in events)
    if result.status == "completed":
        assert result.error is None
    else:
        assert result.error
    assert result.exit_code is None and result.signal is None
    assert not result.events_truncated


# ── native events and settlement ────────────────────────────────────────────


async def test_native_events_are_delivered_raw_and_turns_follow_up(sandbox: Sandbox):
    async with await open_session(sandbox.spec()) as session:
        turn = session.start_turn("success")
        events = [event async for event in turn.events]
        result = await turn.result
        ack, *native = events
        assert ack.type == "response" and ack.request_id is not None
        assert ack.raw["command"] == "prompt" and ack.raw["success"] is True
        assert all(event.request_id is None for event in native)
        update = next(event for event in native if event.type == "message_update")
        assert update.raw == {"type": "message_update", "assistantMessageEvent": {"type": "text_delta", "delta": "reply-1"}}
        assert result.raw is not None and result.raw["type"] == "agent_end"
        assert _assistant_text(result.raw) == "reply-1"
        assert result.raw["messages"][0]["usage"] == {"input": 7, "output": 3, "cost": {"total": 0}}

        follow_up = session.start_turn("unknown")
        events = [event async for event in follow_up.events]
        result = await follow_up.result
        assert follow_up.id != turn.id and result.status == "completed"
        assert _assistant_text(result.raw) == "reply-2"
        unknown = next(event for event in events if event.type == "synthetic_unknown")
        assert unknown.raw == {"type": "synthetic_unknown", "nested": {"value": 42}, "nativeId": session.reference.session_id}


async def test_intermediate_agent_end_does_not_settle_the_turn(sandbox: Sandbox):
    async with await open_session(sandbox.spec()) as session:
        turn = session.start_turn("retry")
        ends = [event.raw for event in [e async for e in turn.events] if event.type == "agent_end"]
        result = await turn.result
    assert [end.get("isTerminal") for end in ends] == [False, None]
    assert ends[0]["messages"][0]["stopReason"] == "error"
    assert result.status == "completed" and result.raw is ends[1]


async def test_bridge_settlement_error_is_agent_error_with_bridge_frame(sandbox: Sandbox):
    async with await open_session(sandbox.spec()) as session:
        turn = session.start_turn("reject")
        assert await _drain(turn) == ["response"]
        result = await turn.result
        assert result.status == "agent-error"
        assert result.raw == {"type": "sdk_settled", "error": "synthetic prompt rejection"}
        assert result.error == "sdk turn failed: synthetic prompt rejection"
        assert not session.closed
        retry = session.start_turn("success")
        await _drain(retry)
        assert (await retry.result).status == "completed"


async def test_assistant_error_keeps_native_agent_end(sandbox: Sandbox):
    async with await open_session(sandbox.spec()) as session:
        turn = session.start_turn("error")
        await _drain(turn)
        result = await turn.result
    assert result.status == "agent-error" and result.error == "synthetic agent error"
    assert result.raw is not None and result.raw["type"] == "agent_end"


# ── interruption ────────────────────────────────────────────────────────────


async def test_interrupt_confirmed_natively_then_follow_up(sandbox: Sandbox):
    async with await open_session(sandbox.spec()) as session:
        turn = session.start_turn("hang")
        types = [(await turn.events.__anext__()).type for _ in range(3)]
        assert types == ["response", "agent_start", "message_update"]
        await session.interrupt()
        result = await turn.result
        assert result.status == "interrupted" and result.error is None
        assert result.raw is not None and result.raw["messages"][0]["stopReason"] == "aborted"
        # The native aborted end precedes the bridge's abort acknowledgement.
        assert await _drain(turn) == ["agent_end", "response"]
        assert not session.closed and session.active is None
        assert sandbox.trace() == ["subscribe", "abort"]

        follow_up = session.start_turn("success")
        await _drain(follow_up)
        result = await follow_up.result
        assert result.status == "completed" and _assistant_text(result.raw) == "reply-2"


async def test_close_settles_active_turn_and_disposes(sandbox: Sandbox):
    session = await open_session(sandbox.spec())
    turn = session.start_turn("hang")
    await turn.events.__anext__()
    await session.close()
    result = await turn.result
    assert result.status == "closed" and session.closed
    assert sandbox.trace() == LIFECYCLE
    assert not (sandbox.workdir / LOCK_DIRNAME).exists()


# ── native identity and resume ──────────────────────────────────────────────


async def test_reference_round_trips_into_exact_native_resume(sandbox: Sandbox):
    async with await open_session(sandbox.spec()) as session:
        assert session.spec.omp_sdk == OmpSdkOptions(PACKAGE_ROOT, sandbox.agent_dir, "environment")
        reference = session.reference
        assert reference.session_file is not None and reference.session_file.is_relative_to(sandbox.agent_dir)
        turn = session.start_turn("success")
        await _drain(turn)
        assert (await turn.result).status == "completed"
    assert list(sandbox.home.iterdir()) == []

    async with await open_session(sandbox.spec(resume=reference)) as resumed:
        assert resumed.reference == reference
        turn = resumed.start_turn("success")
        await _drain(turn)
        result = await turn.result
    # The native session state (prompt count) came back from the session file.
    assert result.status == "completed" and _assistant_text(result.raw) == "reply-2"
    assert result.session_id == reference.session_id


async def test_resume_verifies_header_before_spawn(sandbox: Sandbox):
    async with await open_session(sandbox.spec()) as session:
        reference = session.reference
    assert reference.session_file is not None
    wrong = SessionReference("not-the-native-id", reference.session_file, reference.workdir)
    with pytest.raises(HarnessError) as info:
        await open_session(sandbox.spec(resume=wrong, instructions="X"))
    assert info.value.code == "invalid-options"
    assert "belongs to session" in str(info.value)
    assert sandbox.trace() == LIFECYCLE  # no second bridge was ever started
    assert not (sandbox.workdir / LOCK_DIRNAME).exists()
    assert not (sandbox.workdir / "AGENTS.md").exists()


# ── disposal and ownership ──────────────────────────────────────────────────


async def test_close_runs_owned_lifecycle_without_touching_parent(sandbox: Sandbox):
    before = dict(os.environ)
    (sandbox.workdir / "AGENTS.md").write_text("original rules\n")
    async with await open_session(sandbox.spec(instructions="live rules")) as session:
        assert (sandbox.workdir / "AGENTS.md").read_text() == "live rules"
        assert sandbox.trace() == ["subscribe"]
        assert session.reference.session_file is not None
    assert sandbox.trace() == LIFECYCLE
    assert (sandbox.workdir / "AGENTS.md").read_text() == "original rules\n"
    assert not (sandbox.workdir / LOCK_DIRNAME).exists()
    assert os.environ == before
    assert list(sandbox.home.iterdir()) == []


async def test_disposal_failure_is_adapter_error_after_cleanup(sandbox: Sandbox):
    env = {"HOME": str(sandbox.home), "HARNESS_SDK_TRACE": str(sandbox.trace_file), "HARNESS_SDK_DISPOSE_ERROR": "1"}
    session = await open_session(sandbox.spec(env=env, instructions="held"))
    with pytest.raises(HarnessError) as info:
        await session.close()
    assert info.value.code == "adapter-error"
    assert "synthetic disposal failure" in str(info.value)
    assert session.closed
    assert sandbox.trace() == LIFECYCLE
    assert not (sandbox.workdir / LOCK_DIRNAME).exists()
    assert not (sandbox.workdir / "AGENTS.md").exists()


async def test_concurrent_close_calls_share_one_disposal(sandbox: Sandbox):
    env = {"HOME": str(sandbox.home), "HARNESS_SDK_TRACE": str(sandbox.trace_file), "HARNESS_SDK_DISPOSE_ERROR": "1"}
    session = await open_session(sandbox.spec(env=env))
    outcomes = await asyncio.gather(session.close(), session.close(), return_exceptions=True)
    assert [type(outcome) for outcome in outcomes] == [HarnessError, HarnessError]
    assert {outcome.code for outcome in outcomes} == {"adapter-error"}
    assert sandbox.trace().count("dispose") == 1


async def test_cancelled_open_disposes_before_propagating(sandbox: Sandbox):
    opening = asyncio.ensure_future(open_session(sandbox.spec(instructions="X")))
    await asyncio.sleep(0)  # validated and spawning, not yet handshaken
    opening.cancel()
    with pytest.raises(asyncio.CancelledError):
        await opening
    assert not (sandbox.workdir / LOCK_DIRNAME).exists()
    assert not (sandbox.workdir / "AGENTS.md").exists()
    if "subscribe" in sandbox.trace():
        assert sandbox.trace() == LIFECYCLE


# ── startup failures ────────────────────────────────────────────────────────


async def test_missing_sdk_package_is_launch_failed(sandbox: Sandbox):
    empty = sandbox.workdir.parent / "empty-package"
    empty.mkdir()
    with pytest.raises(HarnessError) as info:
        await open_session(sandbox.spec(omp_sdk=OmpSdkOptions(empty, sandbox.agent_dir, "local"), instructions="X"))
    assert info.value.code == "launch-failed"
    assert str(empty / "package.json") in str(info.value)
    sandbox.assert_no_side_effects()


def test_startup_error_diagnostic_is_fully_drained(tmp_path: Path):
    package = tmp_path / "sdk"
    package.mkdir()
    (package / "package.json").write_text((PACKAGE_ROOT / "package.json").read_text())
    diagnostic = "x" * (512 * 1024) + "native-startup-cause-end"
    (package / "sdk.mjs").write_text(
        f"export class Settings {{ static async loadReadOnly() {{ throw new Error({json.dumps(diagnostic)}) }} }}"
    )
    options = dict(
        packageRoot=str(package), agentDir=str(tmp_path / "agent"), auth="environment",
        cwd=str(tmp_path), model=None, resume=None,
    )
    child = subprocess.run(
        ["bun", "--no-env-file", str(TESTS.parent / "src" / "harness" / "_omp_sdk.mjs"), json.dumps(options)],
        input=b"", capture_output=True, timeout=5,
        env={"HOME": str(tmp_path), "PATH": os.environ["PATH"]},
    )
    assert child.returncode == 1
    assert diagnostic.encode() in child.stderr


async def test_missing_bun_executable_is_launch_failed(sandbox: Sandbox):
    with pytest.raises(HarnessError) as info:
        await open_session(sandbox.spec(executable=str(sandbox.workdir.parent / "missing-bun"), instructions="X"))
    assert info.value.code == "launch-failed"
    sandbox.assert_no_side_effects()


# ── capabilities and validation ─────────────────────────────────────────────


def test_session_capabilities_for_omp_sdk():
    caps = get_session_capabilities("omp", "sdk")
    assert caps.backend == "sdk"
    assert (caps.events, caps.interrupt, caps.follow_up, caps.resume) == (True, True, True, True)
    assert (caps.concurrent_turns, caps.approval) == (False, False)


@pytest.mark.parametrize(("name", "backend"), [("omp", "rpc"), ("omp", "cli"), ("pi", "sdk"), ("codex", "sdk")])
def test_session_capabilities_reject_unqualified_pairs(name: str, backend: str):
    with pytest.raises(HarnessError) as info:
        get_session_capabilities(name, backend)  # type: ignore[arg-type]
    assert info.value.code == "unsupported-backend"


def _options(**overrides: object) -> OmpSdkOptions:
    fields: dict = dict(package_root=PACKAGE_ROOT, agent_dir=Path("/agent"), auth="environment")
    fields.update(overrides)
    return OmpSdkOptions(**fields)


@pytest.mark.parametrize(
    ("overrides", "code"),
    [
        ({"backend": "rpc"}, "unsupported-backend"),
        ({"backend": "cli"}, "unsupported-backend"),
        ({"harness": "pi"}, "unsupported-backend"),
        ({"harness": "pi", "backend": "rpc"}, "invalid-options"),
        ({"omp_sdk": None}, "invalid-options"),
        ({"omp_sdk": {"package_root": "/p", "agent_dir": "/a", "auth": "local"}}, "invalid-options"),
        ({"omp_sdk": _options(package_root="helpers/omp_sdk")}, "invalid-options"),
        ({"omp_sdk": _options(agent_dir="")}, "invalid-options"),
        ({"omp_sdk": _options(agent_dir="/agent\0dir")}, "invalid-options"),
        ({"omp_sdk": _options(auth="oauth")}, "invalid-options"),
        ({"omp_sdk": _options(auth=None)}, "invalid-options"),
        ({"env": {"PI_CODING_AGENT_DIR": "/elsewhere"}}, "invalid-options"),
        ({"env": {"PI_CONFIG_DIR": "/elsewhere"}}, "invalid-options"),
        ({"env": {"OMP_PROFILE": "other"}}, "invalid-options"),
        ({"env": {"PI_PROFILE": "other"}}, "invalid-options"),
        ({"permission_policy": "bypass"}, "unsupported-capability"),
        ({"executable": "bin/bun"}, "invalid-options"),
        ({"resume": SessionReference("id", None, TESTS)}, "invalid-options"),
    ],
)
async def test_open_session_rejects_before_side_effects(sandbox: Sandbox, overrides: dict, code: str):
    options = dict(harness="omp", workdir=sandbox.workdir, backend="sdk", instructions="X", omp_sdk=_options())
    options.update(overrides)
    with pytest.raises(HarnessError) as info:
        await open_session(SessionSpec(**options))
    assert info.value.code == code
    sandbox.assert_no_side_effects()


async def test_matching_owned_env_entries_are_accepted(sandbox: Sandbox):
    env = {"HOME": str(sandbox.home), "PI_CODING_AGENT_DIR": str(sandbox.agent_dir), "PI_CONFIG_DIR": str(sandbox.agent_dir)}
    async with await open_session(sandbox.spec(env=env)) as session:
        assert session.spec.env == env
        assert session.reference.session_file is not None


# ── events ──────────────────────────────────────────────────────────────────


async def test_unconsumed_overflow_fails_loudly(sandbox: Sandbox):
    session = await open_session(sandbox.spec(max_buffer_bytes=4096))
    turn = session.start_turn("flood")
    result = await turn.result
    assert result.status == "protocol-error" and result.events_truncated
    assert "max_buffer_bytes=4096" in (result.error or "")
    assert session.closed
    # The bridge may trip its own 1 MiB transport bound before our SIGTERM
    # lands; then close() reports that exit rather than a clean disposal.
    try:
        await session.close()
    except HarnessError as exc:
        assert exc.code == "adapter-error"
    assert not (sandbox.workdir / LOCK_DIRNAME).exists()
