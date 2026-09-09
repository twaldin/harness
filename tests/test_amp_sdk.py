"""Live Amp SDK session contract: the `amp` / `sdk` backend through the shared worker.

Every test drives the real `src/harness/_amp_sdk.mjs` worker under Node with
the synthetic `@ampcode/sdk` package in tests/helpers/amp_sdk (selected through
`AmpSdkOptions.package_root`) and the synthetic CLI tests/helpers/amp_cli.mjs
(`AmpSdkOptions.cli_path`), an isolated HOME and a disposable workdir holding
the synthetic thread state. Behavior is selected purely by prompt string; the
cross-language cases live in tests/amp_sdk_cases.json. No network, provider or
credentials are involved.
"""
from __future__ import annotations

import asyncio
import json
import os
import shutil
import sys
import time
from pathlib import Path

import pytest

from harness import (
    AmpSdkOptions,
    HarnessError,
    OmpSdkOptions,
    OpenCodeOptions,
    SessionReference,
    SessionSpec,
    SessionTurn,
    get_session_capabilities,
    open_session,
)

TESTS = Path(__file__).parent
PACKAGE_ROOT = (TESTS / "helpers" / "amp_sdk").absolute()
CLI_PATH = (TESTS / "helpers" / "amp_cli.mjs").absolute()
MANIFEST = json.loads((TESTS / "amp_sdk_cases.json").read_text())
CASES = MANIFEST["cases"]
THREAD_ID = MANIFEST["sessionId"]
ENDPOINT = "https://ampcode.com"
LOCK_DIRNAME = ".harness-run.lock"
THREAD_STATE = ".amp-synthetic-thread.json"
SUCCESS_EVENTS = ["system", "assistant", "future_event", "result"]

pytestmark = [
    pytest.mark.skipif(sys.platform not in ("darwin", "linux"), reason="owned process groups need POSIX"),
    pytest.mark.skipif(shutil.which("node") is None, reason="the Amp SDK worker runs under Node"),
]


class Sandbox:
    """Isolated HOME and disposable workdir (thread state lives there) for one test."""

    def __init__(self, root: Path) -> None:
        self.home = root / "home"
        self.workdir = root / "work"
        for directory in (self.home, self.workdir):
            directory.mkdir()

    def options(self, **overrides: object) -> AmpSdkOptions:
        fields: dict = dict(package_root=PACKAGE_ROOT, cli_path=CLI_PATH, executor="local", mode="low")
        fields.update(overrides)
        return AmpSdkOptions(**fields)

    def spec(self, **overrides: object) -> SessionSpec:
        options: dict = dict(
            env={"HOME": str(self.home), "AMP_URL": ENDPOINT},
            timeout_seconds=5,
            request_timeout_seconds=3,
            amp_sdk=self.options(),
        )
        options.update(overrides)
        return SessionSpec("amp", self.workdir, "sdk", **options)

    def thread_state(self) -> dict:
        return json.loads((self.workdir / THREAD_STATE).read_text())

    def assert_no_side_effects(self) -> None:
        assert not (self.workdir / LOCK_DIRNAME).exists()
        assert not (self.workdir / "AGENTS.md").exists()
        assert not (self.workdir / THREAD_STATE).exists()
        assert list(self.home.iterdir()) == []


@pytest.fixture
def sandbox(tmp_path: Path) -> Sandbox:
    return Sandbox(tmp_path)


async def _drain(turn: SessionTurn) -> list[str]:
    return [event.type async for event in turn.events]


async def _read_until(turn: SessionTurn, kind: str) -> list[str]:
    seen: list[str] = []
    async for event in turn.events:
        seen.append(event.type)
        if event.type == kind:
            return seen
    raise AssertionError(f"turn ended without a {kind!r} event; saw {seen}")


# ── shared manifest ─────────────────────────────────────────────────────────


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
async def test_shared_case(case: dict, sandbox: Sandbox):
    async with await open_session(sandbox.spec()) as session:
        assert session.reference.session_id == THREAD_ID
        turn = session.start_turn(case["prompt"])
        events = [event async for event in turn.events]
        result = await turn.result
        # Only a protocol failure invalidates the session; native outcomes
        # (including a non-zero CLI exit) leave the thread usable.
        assert session.closed == (case["status"] == "protocol-error")
        assert session.active is None
    assert result.status == case["status"]
    assert result.session_id == THREAD_ID and result.turn_id == turn.id
    assert all((event.backend, event.harness, event.turn_id, event.request_id) == ("sdk", "amp", turn.id, None) for event in events)
    assert all(event.session_id == THREAD_ID for event in events)
    if "exitCode" in case:
        assert result.exit_code == case["exitCode"] and result.signal is None
    if "rawType" in case:
        assert result.raw is not None and result.raw["type"] == case["rawType"]
        assert result.raw == next(event.raw for event in events if event.type == case["rawType"])
    if result.status == "completed":
        assert result.error is None
    else:
        assert result.error
    assert not result.events_truncated


# ── native events and settlement ────────────────────────────────────────────


async def test_native_events_are_delivered_raw_and_turns_follow_up(sandbox: Sandbox):
    async with await open_session(sandbox.spec()) as session:
        turn = session.start_turn("success")
        events = [event async for event in turn.events]
        result = await turn.result
        assert [event.type for event in events] == SUCCESS_EVENTS
        init = events[0].raw
        assert init["subtype"] == "init" and init["session_id"] == THREAD_ID
        future = next(event for event in events if event.type == "future_event")
        assert future.raw == {"type": "future_event", "session_id": THREAD_ID, "value": 17}
        assert result.status == "completed" and result.raw is not None
        assert result.raw["result"] == "synthetic turn 1"
        # Native usage is retained verbatim, nulls and unknown fields included.
        assert result.raw["usage"] == {"input_tokens": None, "output_tokens": 2, "max_tokens": 123, "cache_creation": {"ephemeral_5m_input_tokens": 4}}
        assert (result.exit_code, result.signal) == (0, None)

        follow_up = session.start_turn("success")
        assert await _drain(follow_up) == SUCCESS_EVENTS
        result = await follow_up.result
        assert follow_up.id != turn.id and result.status == "completed"
        assert result.raw is not None and result.raw["result"] == "synthetic turn 2"
        assert sandbox.thread_state()["turns"] == 2


async def test_native_agent_error_keeps_result_and_thread(sandbox: Sandbox):
    async with await open_session(sandbox.spec()) as session:
        turn = session.start_turn("agent-error")
        await _drain(turn)
        result = await turn.result
        assert result.status == "agent-error" and result.error == "synthetic native rejection"
        assert result.raw is not None and result.raw["is_error"] is True
        assert not session.closed
        retry = session.start_turn("success")
        await _drain(retry)
        assert (await retry.result).status == "completed"


async def test_nonzero_native_exit_after_result_is_exited_with_raw(sandbox: Sandbox):
    async with await open_session(sandbox.spec()) as session:
        turn = session.start_turn("exit-after-result")
        await _drain(turn)
        result = await turn.result
        assert result.status == "exited" and result.exit_code == 3 and result.signal is None
        assert result.raw is not None and result.raw["type"] == "result"
        assert not session.closed


async def test_concurrent_turns_are_rejected(sandbox: Sandbox):
    async with await open_session(sandbox.spec()) as session:
        turn = session.start_turn("success")
        with pytest.raises(HarnessError) as info:
            session.start_turn("success")
        assert info.value.code == "unsupported-capability"
        await _drain(turn)
        assert (await turn.result).status == "completed"


# ── interruption, timeout and close ─────────────────────────────────────────


async def test_interrupt_after_assistant_then_follow_up(sandbox: Sandbox):
    async with await open_session(sandbox.spec()) as session:
        turn = session.start_turn("hang")
        events = aiter(turn.events)
        assert (await anext(events)).type == "system"
        assert (await anext(events)).type == "assistant"
        await session.interrupt()
        result = await turn.result
        assert result.status == "interrupted" and result.error is None and result.raw is None
        with pytest.raises(StopAsyncIteration):
            await anext(events)
        assert not session.closed and session.active is None

        follow_up = session.start_turn("success")
        await _drain(follow_up)
        result = await follow_up.result
        assert result.status == "completed" and result.session_id == THREAD_ID
        assert result.raw is not None and result.raw["result"] == "synthetic turn 2"


async def test_interrupt_stops_native_descendants(sandbox: Sandbox):
    async with await open_session(sandbox.spec()) as session:
        turn = session.start_turn("child-hang")
        await _read_until(turn, "assistant")
        deadline = time.monotonic() + 3
        while not (sandbox.workdir / ".amp-synthetic-child.json").exists():
            assert time.monotonic() < deadline, "the synthetic CLI did not record its owned child"
            await asyncio.sleep(0.02)
        pid = json.loads((sandbox.workdir / ".amp-synthetic-child.json").read_text())["pid"]
        await session.interrupt()
        assert (await turn.result).status == "interrupted"
    deadline = time.monotonic() + 2
    while True:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            break
        assert time.monotonic() < deadline, f"descendant {pid} survived the interrupted worker group"
        await asyncio.sleep(0.02)


async def test_turn_timeout_invalidates_session(sandbox: Sandbox):
    session = await open_session(sandbox.spec(timeout_seconds=1.5))
    turn = session.start_turn("hang")
    result = await turn.result
    assert result.status == "timed-out" and "timeout_seconds=1.5" in (result.error or "")
    assert session.closed
    with pytest.raises(HarnessError) as info:
        session.start_turn("success")
    assert info.value.code == "session-closed"
    await session.close()
    assert not (sandbox.workdir / LOCK_DIRNAME).exists()


async def test_close_settles_active_turn_and_restores_lease(sandbox: Sandbox):
    session = await open_session(sandbox.spec(instructions="X"))
    assert (sandbox.workdir / "AGENTS.md").read_text() == "X"
    turn = session.start_turn("hang")
    await _read_until(turn, "assistant")
    await asyncio.gather(session.close(), session.close())
    result = await turn.result
    assert result.status == "closed" and session.closed
    assert not (sandbox.workdir / LOCK_DIRNAME).exists()
    assert not (sandbox.workdir / "AGENTS.md").exists()


# ── native identity and resume ──────────────────────────────────────────────


async def test_reference_round_trips_into_exact_resume(sandbox: Sandbox):
    async with await open_session(sandbox.spec()) as session:
        assert session.spec.amp_sdk == AmpSdkOptions(PACKAGE_ROOT, CLI_PATH, "local", "low")
        reference = session.reference
        assert reference == SessionReference(THREAD_ID, None, sandbox.workdir, ENDPOINT)
        turn = session.start_turn("success")
        await _drain(turn)
        assert (await turn.result).status == "completed"

    async with await open_session(sandbox.spec(resume=reference)) as resumed:
        assert resumed.reference == reference
        turn = resumed.start_turn("success")
        await _drain(turn)
        result = await turn.result
    assert result.status == "completed" and result.session_id == THREAD_ID
    assert result.raw is not None and result.raw["result"] == "synthetic turn 2"


async def test_resume_of_unknown_thread_is_launch_failed(sandbox: Sandbox):
    other = SessionReference("T-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", None, sandbox.workdir, ENDPOINT)
    with pytest.raises(HarnessError) as info:
        await open_session(sandbox.spec(resume=other, instructions="X"))
    assert info.value.code == "launch-failed"
    assert not (sandbox.workdir / LOCK_DIRNAME).exists()
    assert not (sandbox.workdir / "AGENTS.md").exists()


async def test_visibility_applies_to_creation_only(sandbox: Sandbox):
    async with await open_session(sandbox.spec(amp_sdk=sandbox.options(visibility="unlisted"))):
        assert sandbox.thread_state()["visibility"] == "unlisted"


async def test_cancelled_open_releases_lease_before_propagating(sandbox: Sandbox):
    opening = asyncio.ensure_future(open_session(sandbox.spec(instructions="X")))
    await asyncio.sleep(0)  # validated and launching, not yet opened
    opening.cancel()
    with pytest.raises(asyncio.CancelledError):
        await opening
    assert not (sandbox.workdir / LOCK_DIRNAME).exists()
    assert not (sandbox.workdir / "AGENTS.md").exists()


# ── startup failures ────────────────────────────────────────────────────────


async def test_missing_sdk_package_is_launch_failed(sandbox: Sandbox):
    empty = sandbox.workdir.parent / "empty-package"
    empty.mkdir()
    with pytest.raises(HarnessError) as info:
        await open_session(sandbox.spec(amp_sdk=sandbox.options(package_root=empty), instructions="X"))
    assert info.value.code == "launch-failed"
    sandbox.assert_no_side_effects()


async def test_missing_cli_is_launch_failed(sandbox: Sandbox):
    missing = sandbox.workdir.parent / "missing-amp"
    with pytest.raises(HarnessError) as info:
        await open_session(sandbox.spec(amp_sdk=sandbox.options(cli_path=missing), instructions="X"))
    assert info.value.code == "launch-failed"
    sandbox.assert_no_side_effects()


async def test_missing_node_executable_is_launch_failed(sandbox: Sandbox):
    with pytest.raises(HarnessError) as info:
        await open_session(sandbox.spec(executable="harness-definitely-missing-node", instructions="X"))
    assert info.value.code == "launch-failed"
    sandbox.assert_no_side_effects()


# ── capabilities and validation ─────────────────────────────────────────────


def test_session_capabilities_for_amp_sdk():
    caps = get_session_capabilities("amp", "sdk")
    assert caps.backend == "sdk"
    assert (caps.events, caps.interrupt, caps.follow_up, caps.resume) == (True, True, True, True)
    assert (caps.concurrent_turns, caps.approval) == (False, False)


@pytest.mark.parametrize("backend", ["rpc", "cli"])
def test_session_capabilities_reject_unqualified_amp_pairs(backend: str):
    with pytest.raises(HarnessError) as info:
        get_session_capabilities("amp", backend)  # type: ignore[arg-type]
    assert info.value.code == "unsupported-backend"


def _options(**overrides: object) -> AmpSdkOptions:
    fields: dict = dict(package_root=PACKAGE_ROOT, cli_path=CLI_PATH, executor="local", mode="low")
    fields.update(overrides)
    return AmpSdkOptions(**fields)


def _reference(**overrides: object) -> SessionReference:
    fields: dict = dict(session_id=THREAD_ID, session_file=None, workdir=None, endpoint=ENDPOINT)
    fields.update(overrides)
    return SessionReference(**fields)


@pytest.mark.parametrize(
    ("overrides", "code"),
    [
        ({"backend": "rpc"}, "unsupported-backend"),
        ({"backend": "cli"}, "unsupported-backend"),
        ({"harness": "codex"}, "unsupported-backend"),
        ({"harness": "omp"}, "invalid-options"),
        ({"harness": "pi", "backend": "rpc"}, "invalid-options"),
        ({"amp_sdk": None}, "invalid-options"),
        ({"amp_sdk": {"package_root": "/p", "cli_path": "/c", "executor": "local", "mode": "low"}}, "invalid-options"),
        ({"amp_sdk": _options(package_root="helpers/amp_sdk")}, "invalid-options"),
        ({"amp_sdk": _options(package_root="")}, "invalid-options"),
        ({"amp_sdk": _options(cli_path="amp")}, "invalid-options"),
        ({"amp_sdk": _options(cli_path="/usr/local/bin/amp\0")}, "invalid-options"),
        ({"amp_sdk": _options(executor="remote")}, "unsupported-capability"),
        ({"amp_sdk": _options(executor=None)}, "unsupported-capability"),
        ({"amp_sdk": _options(mode="")}, "invalid-options"),
        ({"amp_sdk": _options(mode="   ")}, "invalid-options"),
        ({"amp_sdk": _options(mode=None)}, "invalid-options"),
        ({"amp_sdk": _options(effort="ultra")}, "invalid-options"),
        ({"amp_sdk": _options(visibility="public")}, "invalid-options"),
        ({"amp_sdk": _options(settings_file="settings.json")}, "invalid-options"),
        ({"model": "gpt-5"}, "invalid-options"),
        ({"env": {"AMP_SKIP_UPDATE_CHECK": "0"}}, "invalid-options"),
        ({"env": {"AMP_URL": "ftp://ampcode.com"}}, "invalid-options"),
        ({"env": {"AMP_URL": "https://ampcode.com/api?x=1"}}, "invalid-options"),
        ({"omp_sdk": OmpSdkOptions(PACKAGE_ROOT, Path("/agent"), "environment")}, "invalid-options"),
        ({"opencode": OpenCodeOptions("http://127.0.0.1:4096", "none")}, "invalid-options"),
        ({"permission_policy": "bypass"}, "unsupported-capability"),
        ({"executable": "bin/node"}, "invalid-options"),
        ({"resume": _reference(session_id="T-11111111")}, "invalid-options"),
        ({"resume": _reference(session_file=Path("/tmp/thread.jsonl"))}, "invalid-options"),
        ({"resume": _reference(endpoint=None)}, "invalid-options"),
        ({"resume": _reference(endpoint="https://amp.example.test")}, "invalid-options"),
        ({"resume": _reference(workdir=Path("/elsewhere"))}, "invalid-options"),
        ({"resume": _reference(), "amp_sdk": _options(visibility="private")}, "invalid-options"),
    ],
)
async def test_open_session_rejects_before_side_effects(sandbox: Sandbox, overrides: dict, code: str):
    options = dict(harness="amp", workdir=sandbox.workdir, backend="sdk", instructions="X", env={"AMP_URL": ENDPOINT}, amp_sdk=_options())
    resume = overrides.get("resume")
    if isinstance(resume, SessionReference) and resume.workdir is None:
        overrides = {**overrides, "resume": SessionReference(resume.session_id, resume.session_file, sandbox.workdir, resume.endpoint)}
    options.update(overrides)
    with pytest.raises(HarnessError) as info:
        await open_session(SessionSpec(**options))
    assert info.value.code == code
    sandbox.assert_no_side_effects()


async def test_endpoint_defaults_and_pinned_update_check_are_accepted(sandbox: Sandbox, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("AMP_URL", raising=False)
    env = {"HOME": str(sandbox.home), "AMP_SKIP_UPDATE_CHECK": "1"}
    async with await open_session(sandbox.spec(env=env)) as session:
        assert session.spec.env == env
        assert session.reference.endpoint == "https://ampcode.com"


# ── events and stderr ───────────────────────────────────────────────────────


async def test_unconsumed_overflow_fails_loudly(sandbox: Sandbox):
    session = await open_session(sandbox.spec(max_buffer_bytes=4096))
    turn = session.start_turn("overflow")
    result = await turn.result
    assert result.status == "protocol-error" and result.events_truncated
    assert "max_buffer_bytes=4096" in (result.error or "")
    assert session.closed
    await session.close()
    assert not (sandbox.workdir / LOCK_DIRNAME).exists()


async def test_native_stderr_is_captured_and_bounded(sandbox: Sandbox):
    async with await open_session(sandbox.spec()) as session:
        turn = session.start_turn("stderr")
        await _drain(turn)
        result = await turn.result
        assert result.status == "completed"
        assert "synthetic-stderr" in result.stderr and result.stderr_bytes >= 1700
        assert not result.stderr_truncated

    async with await open_session(sandbox.spec(max_buffer_bytes=1024)) as session:
        turn = session.start_turn("stderr")
        await _drain(turn)
        result = await turn.result
        assert result.status == "completed"
        assert result.stderr_truncated and result.stderr_bytes >= 1700 and len(result.stderr.encode()) <= 1024
