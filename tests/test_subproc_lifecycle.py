"""Subprocess lifecycle contract: group ownership, cancellation, termination classification.

The cross-language scenarios live in tests/subprocess_cases.json and run here
through `test_shared_case`; ts/tests/subproc-lifecycle.test.ts and the Node
smoke consume the same file, so each case's observable outcome is asserted
identically in both languages. Python-only behavior (Task.cancel, startup
races, adapter-level classification) stays as ordinary tests below.

Children come from tests/process_tree.py (ownership: records the pids it
creates and a `ready` marker so tests never rely on startup sleeps) and
tests/subprocess_child.py (byte-level I/O). Every test kills its own recorded
pids on teardown; nothing is matched by name.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import signal
import subprocess
import sys
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

import pytest

import harness._subproc as subproc_module
import harness.adapters  # noqa: F401 — populates registry
from harness._subproc import SubprocOutcome, run_subprocess, run_subprocess_async
from harness.base import RunSpec
from harness.registry import run, run_async
from tests.process_tree import STDOUT_TEXT

TESTS = Path(__file__).parent
FIXTURE = TESTS / "process_tree.py"
CASES_PATH = TESTS / "subprocess_cases.json"
PYTHON = sys.executable
ROLES = ("leader", "child", "grandchild")

# cleanup is 0.5s grace + 1.0s drain; anything beyond that plus scheduling slack is a hang
CLEANUP_BUDGET = 1.5
SLACK = 1.5


# ── process helpers ─────────────────────────────────────────────────────────


def _state(pid: int) -> str | None:
    """`ps` state letters for pid, or None when the kernel no longer knows it.

    A zombie still answers kill(pid, 0); ps reports it as `Z`.
    """
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return None
    except PermissionError:
        pass
    probe = subprocess.run(["ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True, check=False)
    return probe.stdout.strip() or None


def _is_running(pid: int) -> bool:
    state = _state(pid)
    return state is not None and not state.startswith("Z")


def _is_zombie(pid: int) -> bool:
    state = _state(pid)
    return state is not None and state.startswith("Z")


def _wait_gone(pids: list[int], timeout: float = 2.0) -> list[int]:
    """Return pids still running after `timeout` (reparented orphans are reaped asynchronously)."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if not any(_is_running(pid) for pid in pids):
            return []
        time.sleep(0.02)
    return [pid for pid in pids if _is_running(pid)]


def _kill_recorded(directory: Path) -> None:
    for role in ROLES:
        pid_file = directory / f"{role}.pid"
        if pid_file.exists():
            try:
                os.kill(int(pid_file.read_text()), signal.SIGKILL)
            except (ProcessLookupError, PermissionError, ValueError):
                pass


def _recorded(directory: Path) -> dict[str, int]:
    return {role: int((directory / f"{role}.pid").read_text()) for role in ROLES if (directory / f"{role}.pid").exists()}


def _wait_ready(directory: Path, timeout: float = 10.0) -> None:
    deadline = time.monotonic() + timeout
    while not (directory / "ready").exists():
        assert time.monotonic() < deadline, f"fixture never became ready in {directory}"
        time.sleep(0.01)


async def _wait_ready_async(directory: Path, timeout: float = 10.0) -> None:
    deadline = time.monotonic() + timeout
    while not (directory / "ready").exists():
        assert time.monotonic() < deadline, f"fixture never became ready in {directory}"
        await asyncio.sleep(0.01)


def _fixture_cmd(mode: str, directory: Path) -> list[str]:
    return [PYTHON, str(FIXTURE), mode, str(directory)]


def _cancel_when_ready(directory: Path) -> threading.Event:
    cancel = threading.Event()

    def arm() -> None:
        _wait_ready(directory)
        cancel.set()

    threading.Thread(target=arm, daemon=True).start()
    return cancel


@pytest.fixture
def tree_dir(tmp_path: Path):
    directory = tmp_path / "tree"
    directory.mkdir()
    yield directory
    _kill_recorded(directory)


@pytest.fixture
def unrelated_process():
    """A process in its own session that must survive every run's cleanup."""
    proc = subprocess.Popen([PYTHON, "-c", "import time; time.sleep(60)"], start_new_session=True)
    yield proc
    proc.kill()
    proc.wait()


# ── shared cases (tests/subprocess_cases.json) ─────────────────────────────

MANIFEST = json.loads(CASES_PATH.read_text(encoding="utf-8"))
LANGUAGE = "python"
RUNNERS = ("sync", "async")
REQUIRED_CATEGORIES = {"spawn", "stdinEof", "signal", "timeout", "cancellation", "grandchildren", "flood", "chunkBoundary"}
OPTION_NAMES = {
    "timeoutSeconds": "timeout_seconds",
    "inactivityTimeoutSeconds": "inactivity_timeout_seconds",
    "maxOutputBytes": "max_output_bytes",
    "stdin": "stdin",
    "gracefulSignal": "graceful_signal",
}
OUTCOME_FIELDS = {
    "termination": "termination",
    "exitCode": "exit_code",
    "timedOut": "timed_out",
    "signal": "signal",
    "launchError": "launch_error",
    "timeoutKind": "timeout_kind",
    "callbackError": "callback_error",
    "stdout": "stdout",
    "stderr": "stderr",
    "stdoutBytes": "stdout_bytes",
    "stderrBytes": "stderr_bytes",
    "stdoutTruncated": "stdout_truncated",
    "stderrTruncated": "stderr_truncated",
}
DERIVED_EXPECTATIONS = {
    "stdoutLength", "stderrLength", "stdoutEqualsStdin", "stdoutPattern", "stderrContains",
    "streamedStdout", "streamedStderr", "streamedNoReplacement",
    "minDurationSeconds", "maxDurationSeconds", "maxCancelLatencySeconds",
    "treeStopped", "leaderReaped", "childRunning", "filesExist", "filesAbsent",
}
STREAMED_EXPECTATIONS = {"streamedStdout", "streamedStderr", "streamedNoReplacement"}
TREE_EXPECTATIONS = {"treeStopped", "leaderReaped", "childRunning"}


@dataclass
class _Observed:
    outcome: SubprocOutcome
    stdin: str | None
    chunks: list[tuple[str, str]] = field(default_factory=list)
    cancel_latency: float | None = None

    def streamed(self, stream: str) -> str:
        return "".join(text for name, text in self.chunks if name == stream)


def _substitute(value: str, directory: Path) -> str:
    return value.replace("{python}", PYTHON).replace("{tests}", str(TESTS)).replace("{dir}", str(directory))


def _stdin_text(spec: object) -> str | None:
    if isinstance(spec, dict):
        return spec["repeat"] * spec["times"]
    assert spec is None or isinstance(spec, str)
    return spec


def _prepare_case(case: dict, directory: Path) -> tuple[list[str], Path, dict]:
    for name, spec in case.get("files", {}).items():
        path = directory / name
        path.write_text(spec["content"], encoding="utf-8")
        path.chmod(spec["mode"])
    cmd = [_substitute(arg, directory) for arg in case["argv"]]
    cwd = Path(_substitute(case.get("cwd", "{dir}"), directory))
    kwargs: dict = {}
    for key, value in case["options"].items():
        if key == "onOutput":
            continue
        kwargs[OPTION_NAMES[key]] = _stdin_text(value) if key == "stdin" else value
    return cmd, cwd, kwargs


def _collector(case: dict, directory: Path, chunks: list[tuple[str, str]]):
    def collect(text: str, stream: str) -> None:
        chunks.append((stream, text))
        if case.get("acknowledgeChunks"):
            (directory / f"chunk-{len(chunks) - 1}").touch()
    return collect


def _run_shared_case_sync(case: dict, directory: Path) -> _Observed:
    cmd, cwd, kwargs = _prepare_case(case, directory)
    chunks: list[tuple[str, str]] = []
    if case["options"].get("onOutput"):
        kwargs["on_output"] = _collector(case, directory, chunks)
    cancelled_at: list[float] = []
    if case.get("cancel") == "beforeLaunch":
        kwargs["cancel"] = threading.Event()
        kwargs["cancel"].set()
    elif case.get("cancel") == "afterReady":
        cancel = threading.Event()

        def arm() -> None:
            _wait_ready(directory)
            cancelled_at.append(time.monotonic())
            cancel.set()

        threading.Thread(target=arm, daemon=True).start()
        kwargs["cancel"] = cancel
    outcome = run_subprocess(cmd, cwd=cwd, **kwargs)
    returned = time.monotonic()
    latency = returned - cancelled_at[0] if cancelled_at else None
    return _Observed(outcome, kwargs.get("stdin"), chunks, latency)


async def _run_shared_case_async(case: dict, directory: Path) -> _Observed:
    cmd, cwd, kwargs = _prepare_case(case, directory)
    chunks: list[tuple[str, str]] = []
    if case["options"].get("onOutput"):
        kwargs["on_output"] = _collector(case, directory, chunks)
    cancel = threading.Event()
    if case.get("cancel"):
        kwargs["cancel"] = cancel
    if case.get("cancel") == "beforeLaunch":
        cancel.set()
    task = asyncio.ensure_future(run_subprocess_async(cmd, cwd=cwd, **kwargs))
    cancelled_at: float | None = None
    try:
        if case.get("cancel") == "afterReady":
            await _wait_ready_async(directory)
            cancelled_at = time.monotonic()
            cancel.set()
        outcome = await task
        latency = time.monotonic() - cancelled_at if cancelled_at is not None else None
        return _Observed(outcome, kwargs.get("stdin"), chunks, latency)
    finally:
        if not task.done():
            cancel.set()
            await task


def _check_shared_case(case: dict, observed: _Observed, directory: Path) -> None:
    outcome = observed.outcome
    for key, expected in case["expect"].items():
        label = f"{case['id']}: {key}"
        if key in OUTCOME_FIELDS:
            assert getattr(outcome, OUTCOME_FIELDS[key]) == expected, label
        elif key == "stdoutLength":
            assert len(outcome.stdout) == expected, label
        elif key == "stderrLength":
            assert len(outcome.stderr) == expected, label
        elif key == "stdoutEqualsStdin":
            assert (outcome.stdout == observed.stdin) is expected, label
        elif key == "stdoutPattern":
            assert re.search(expected, outcome.stdout), f"{label}: {outcome.stdout!r}"
        elif key == "stderrContains":
            assert expected in outcome.stderr, label
        elif key == "streamedStdout":
            assert observed.streamed("stdout") == expected, label
        elif key == "streamedStderr":
            assert observed.streamed("stderr") == expected, label
        elif key == "streamedNoReplacement":
            assert all("\ufffd" not in text for _, text in observed.chunks) is expected, label
        elif key == "minDurationSeconds":
            assert outcome.duration_seconds >= expected, f"{label}: {outcome.duration_seconds}"
        elif key == "maxDurationSeconds":
            assert outcome.duration_seconds <= expected, f"{label}: {outcome.duration_seconds}"
        elif key == "maxCancelLatencySeconds":
            assert observed.cancel_latency is not None and observed.cancel_latency <= expected, f"{label}: {observed.cancel_latency}"
        elif key == "treeStopped":
            pids = _recorded(directory)
            assert set(pids) == set(ROLES), label
            assert (_wait_gone(list(pids.values())) == []) is expected, label
        elif key == "leaderReaped":
            leader = _recorded(directory)["leader"]
            assert (_wait_gone([leader], timeout=0.5) == [] and not _is_zombie(leader)) is expected, label
        elif key == "childRunning":
            assert _is_running(_recorded(directory)["child"]) is expected, label
        elif key == "filesExist":
            assert [name for name in expected if (directory / name).exists()] == expected, label
        elif key == "filesAbsent":
            time.sleep(0.2)  # a wrongly launched child would create the file shortly after; nothing to await
            assert [name for name in expected if (directory / name).exists()] == [], label
        else:
            raise AssertionError(f"{label}: unknown expectation")


def _shared_params() -> list:
    return [
        pytest.param(case, runner, id=f"{case['id']}[{runner}]")
        for case in MANIFEST["cases"]
        for runner in case["runners"][LANGUAGE]
    ]


@pytest.mark.parametrize("case,runner", _shared_params())
async def test_shared_case(case: dict, runner: str, tree_dir: Path):
    observed = _run_shared_case_sync(case, tree_dir) if runner == "sync" else await _run_shared_case_async(case, tree_dir)
    _check_shared_case(case, observed, tree_dir)


def test_shared_cases_are_all_applicable_here():
    """Coverage guard: every manifest case runs here and uses only understood options/expectations."""
    cases = MANIFEST["cases"]
    ids = [case["id"] for case in cases]
    assert len(ids) == len(set(ids)), "duplicate case ids"
    assert set(MANIFEST["categories"]) == REQUIRED_CATEGORIES
    assert {case["category"] for case in cases} == REQUIRED_CATEGORIES, "a required category has no case"
    for case in cases:
        runners = case["runners"]
        assert set(runners) == {LANGUAGE, "typescript"}, f"{case['id']}: runners must name both languages"
        assert runners[LANGUAGE] and set(runners[LANGUAGE]) <= set(RUNNERS), f"{case['id']}: no Python runner"
        options = case["options"]
        assert "timeoutSeconds" in options, f"{case['id']}: timeoutSeconds must be explicit"
        assert set(options) <= set(OPTION_NAMES) | {"onOutput"}, f"{case['id']}: unknown option"
        expectations = set(case["expect"])
        assert expectations <= set(OUTCOME_FIELDS) | DERIVED_EXPECTATIONS, f"{case['id']}: unknown expectation"
        assert case.get("cancel") in (None, "beforeLaunch", "afterReady"), f"{case['id']}: unknown cancel mode"
        if expectations & STREAMED_EXPECTATIONS:
            assert options.get("onOutput"), f"{case['id']}: streamed expectations need onOutput"
        if case.get("acknowledgeChunks"):
            assert options.get("onOutput") and "gated-pieces" in case["argv"]
        if expectations & TREE_EXPECTATIONS or case.get("cancel") == "afterReady":
            assert "{tests}/process_tree.py" in case["argv"], f"{case['id']}: needs the process_tree fixture"
        if "maxCancelLatencySeconds" in expectations:
            assert case.get("cancel") == "afterReady", f"{case['id']}: cancel latency needs afterReady"


def test_timeout_leaves_unrelated_session_alone(tree_dir: Path, unrelated_process: subprocess.Popen):
    run_subprocess(_fixture_cmd("tree", tree_dir), cwd=tree_dir, timeout_seconds=1)
    assert _is_running(unrelated_process.pid)
    assert unrelated_process.poll() is None


# ── Task.cancel ─────────────────────────────────────────────────────────────


async def test_task_cancel_during_communication_cleans_up_then_raises(tree_dir: Path):
    task = asyncio.ensure_future(
        run_subprocess_async(_fixture_cmd("tree", tree_dir), cwd=tree_dir, timeout_seconds=20)
    )
    await _wait_ready_async(tree_dir)
    started = time.monotonic()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert time.monotonic() - started < CLEANUP_BUDGET + SLACK
    # cleanup finished before the exception surfaced — no async reaping race to wait out
    pids = _recorded(tree_dir)
    assert set(pids) == set(ROLES)
    assert _wait_gone(list(pids.values()), timeout=0.5) == []


async def test_repeated_task_cancel_is_safe(tree_dir: Path):
    task = asyncio.ensure_future(
        run_subprocess_async(_fixture_cmd("tree", tree_dir), cwd=tree_dir, timeout_seconds=20)
    )
    await _wait_ready_async(tree_dir)
    for _ in range(3):
        task.cancel()
        await asyncio.sleep(0.05)
    with pytest.raises(asyncio.CancelledError):
        await task
    assert _wait_gone(list(_recorded(tree_dir).values()), timeout=0.5) == []


async def test_task_cancel_during_startup_still_owns_the_process(tree_dir: Path, monkeypatch: pytest.MonkeyPatch):
    """Cancel while Popen is still returning: the spawned process must not leak."""
    spawned = threading.Event()
    release = threading.Event()
    spawned_pids: list[int] = []
    real_popen = subprocess.Popen

    class BlockingPopen(real_popen):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            spawned_pids.append(self.pid)
            spawned.set()
            release.wait(10)

    class SubprocessProxy:
        Popen = BlockingPopen

        def __getattr__(self, name: str):
            return getattr(subprocess, name)

    monkeypatch.setattr(subproc_module, "subprocess", SubprocessProxy())

    task = asyncio.ensure_future(
        run_subprocess_async(_fixture_cmd("solo", tree_dir), cwd=tree_dir, timeout_seconds=20)
    )
    assert await asyncio.to_thread(spawned.wait, 10)
    task.cancel()
    await asyncio.sleep(0.05)
    release.set()
    with pytest.raises(asyncio.CancelledError) as cancelled:
        await task
    assert cancelled.value.__cause__ is None
    # The leader may die before it records its pid; the barrier saw the real one.
    assert len(spawned_pids) == 1
    owned_pids = spawned_pids + [pid for pid in _recorded(tree_dir).values() if pid not in spawned_pids]
    assert _wait_gone(owned_pids, timeout=0.5) == []
    assert not _is_zombie(spawned_pids[0])


# ── adapter-level classification ────────────────────────────────────────────


@pytest.fixture
def fake_claude(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """`claude` on PATH that execs the fixture; the tree dir arrives via PROCESS_TREE_DIR."""
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    script = bin_dir / "claude"
    script.write_text(f'#!/bin/sh\nexec "{PYTHON}" "{FIXTURE}" "${{PROCESS_TREE_MODE:-tree}}" "$PROCESS_TREE_DIR"\n')
    script.chmod(0o755)
    monkeypatch.setenv("PATH", f"{bin_dir}{os.pathsep}{os.environ.get('PATH', '')}")
    return script


def test_run_result_classifies_cancellation(tree_dir: Path, fake_claude: Path):
    cancel = _cancel_when_ready(tree_dir)
    spec = RunSpec(
        harness="claude-code",
        prompt="hi",
        workdir=tree_dir,
        timeout_seconds=20,
        env={"PROCESS_TREE_DIR": str(tree_dir)},
        cancel=cancel,
    )
    result = run(spec)
    assert result.termination == "cancelled"
    assert result.exit_code == -1
    assert not result.timed_out
    assert not result.ok
    assert result.signal == "SIGTERM"
    assert result.launch_error is None
    assert result.cost_usd is None
    assert result.stdout == STDOUT_TEXT
    assert _wait_gone(list(_recorded(tree_dir).values())) == []


async def test_run_async_task_cancel_cleans_tree(tree_dir: Path, fake_claude: Path):
    spec = RunSpec(
        harness="claude-code",
        prompt="hi",
        workdir=tree_dir,
        timeout_seconds=20,
        env={"PROCESS_TREE_DIR": str(tree_dir)},
    )
    task = asyncio.ensure_future(run_async(spec))
    await _wait_ready_async(tree_dir)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert _wait_gone(list(_recorded(tree_dir).values()), timeout=0.5) == []


def test_run_result_classifies_launch_failure(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("PATH", str(tmp_path))  # no `claude` anywhere
    result = run(RunSpec(harness="claude-code", prompt="hi", workdir=tmp_path, timeout_seconds=5))
    assert result.termination == "launch-failed"
    assert result.launch_error == "ENOENT"
    assert result.exit_code == -1
    assert not result.timed_out
