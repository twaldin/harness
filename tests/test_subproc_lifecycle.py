"""Subprocess lifecycle contract: group ownership, cancellation, termination classification.

Driven by the shared fixture in tests/process_tree.py, which records the pids
it creates and a `ready` marker so tests never rely on startup sleeps. Every
test kills its own recorded pids on teardown; nothing is matched by name.
"""
from __future__ import annotations

import asyncio
import os
import signal
import stat
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

import harness._subproc as subproc_module
import harness.adapters  # noqa: F401 — populates registry
from harness._subproc import SubprocOutcome, run_subprocess, run_subprocess_async
from harness.base import RunSpec
from harness.registry import run, run_async
from tests.process_tree import STDERR_MARKER, STDOUT_TEXT

FIXTURE = Path(__file__).parent / "process_tree.py"
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


def _assert_stopped(outcome: SubprocOutcome, directory: Path) -> None:
    pids = _recorded(directory)
    assert set(pids) == set(ROLES)
    assert _wait_gone(list(pids.values())) == []
    assert outcome.duration_seconds < CLEANUP_BUDGET + SLACK + 1  # 1s run timeout, or cancel/exit right after readiness
    assert outcome.stdout == STDOUT_TEXT  # partial capture survives forced termination
    assert STDERR_MARKER in outcome.stderr


# ── timeout ─────────────────────────────────────────────────────────────────


def test_sync_timeout_kills_term_ignoring_tree(tree_dir: Path):
    outcome = run_subprocess(_fixture_cmd("tree", tree_dir), cwd=tree_dir, timeout_seconds=1)
    assert outcome.timed_out
    assert outcome.exit_code == -1
    assert outcome.termination == "timed-out"
    assert outcome.launch_error is None
    assert outcome.duration_seconds >= 1
    _assert_stopped(outcome, tree_dir)


async def test_async_timeout_kills_term_ignoring_tree(tree_dir: Path):
    outcome = await run_subprocess_async(_fixture_cmd("tree", tree_dir), cwd=tree_dir, timeout_seconds=1)
    assert outcome.timed_out
    assert outcome.exit_code == -1
    assert outcome.termination == "timed-out"
    _assert_stopped(outcome, tree_dir)


def test_timeout_reaps_direct_child(tree_dir: Path):
    outcome = run_subprocess(_fixture_cmd("solo", tree_dir), cwd=tree_dir, timeout_seconds=1)
    assert outcome.termination == "timed-out"
    leader = _recorded(tree_dir)["leader"]
    assert not _is_zombie(leader)
    with pytest.raises(ChildProcessError):  # already reaped by the runner, not left for us
        os.waitpid(leader, os.WNOHANG)


def test_timeout_leaves_unrelated_session_alone(tree_dir: Path, unrelated_process: subprocess.Popen):
    run_subprocess(_fixture_cmd("tree", tree_dir), cwd=tree_dir, timeout_seconds=1)
    assert _is_running(unrelated_process.pid)
    assert unrelated_process.poll() is None


# ── explicit cancellation (threading.Event) ────────────────────────────────


def test_sync_cancel_event_returns_cancelled_outcome(tree_dir: Path):
    cancel = _cancel_when_ready(tree_dir)
    outcome = run_subprocess(_fixture_cmd("tree", tree_dir), cwd=tree_dir, timeout_seconds=20, cancel=cancel)
    assert outcome.termination == "cancelled"
    assert outcome.exit_code == -1
    assert not outcome.timed_out
    assert outcome.duration_seconds < 20 - SLACK
    _assert_stopped(outcome, tree_dir)


async def test_async_cancel_event_returns_cancelled_outcome(tree_dir: Path):
    cancel = threading.Event()
    task = asyncio.ensure_future(
        run_subprocess_async(_fixture_cmd("tree", tree_dir), cwd=tree_dir, timeout_seconds=20, cancel=cancel)
    )
    await _wait_ready_async(tree_dir)
    cancel.set()
    outcome = await task
    assert outcome.termination == "cancelled"
    assert outcome.exit_code == -1
    assert not outcome.timed_out
    _assert_stopped(outcome, tree_dir)


def test_pre_cancelled_event_never_launches(tmp_path: Path):
    cancel = threading.Event()
    cancel.set()
    outcome = run_subprocess(["sh", "-c", "touch launched; sleep 5"], cwd=tmp_path, timeout_seconds=5, cancel=cancel)
    assert outcome.termination == "cancelled"
    assert outcome.exit_code == -1
    assert not outcome.timed_out
    assert outcome.duration_seconds < 1
    time.sleep(0.2)
    assert not (tmp_path / "launched").exists()


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


# ── leader exit with leftovers ──────────────────────────────────────────────


@pytest.mark.parametrize("mode", ["early-exit", "closed-pipes"])
def test_early_leader_exit_stops_leftovers_and_keeps_exit_code(tree_dir: Path, mode: str):
    outcome = run_subprocess(_fixture_cmd(mode, tree_dir), cwd=tree_dir, timeout_seconds=30)
    assert outcome.exit_code == 7
    assert outcome.termination == "exited"
    assert outcome.signal is None
    assert not outcome.timed_out
    assert outcome.duration_seconds < 30 - SLACK  # returned on leader exit, not on run timeout
    assert outcome.duration_seconds < CLEANUP_BUDGET + SLACK + 1
    _assert_stopped(outcome, tree_dir)


@pytest.mark.parametrize("mode", ["early-exit", "closed-pipes"])
async def test_async_early_leader_exit_stops_leftovers(tree_dir: Path, mode: str):
    outcome = await run_subprocess_async(_fixture_cmd(mode, tree_dir), cwd=tree_dir, timeout_seconds=30)
    assert outcome.exit_code == 7
    assert outcome.termination == "exited"
    assert outcome.duration_seconds < CLEANUP_BUDGET + SLACK + 1
    _assert_stopped(outcome, tree_dir)


def test_graceful_tree_gets_sigterm_and_reaps_itself(tree_dir: Path):
    cancel = _cancel_when_ready(tree_dir)
    outcome = run_subprocess(_fixture_cmd("graceful", tree_dir), cwd=tree_dir, timeout_seconds=20, cancel=cancel)
    assert outcome.termination == "cancelled"
    pids = _recorded(tree_dir)
    assert _wait_gone(list(pids.values())) == []
    for role in ROLES:
        assert (tree_dir / f"{role}.term").exists(), f"{role} never saw SIGTERM"
        assert not _is_zombie(pids[role])


def test_escaped_pipe_holder_does_not_hang_the_run(tree_dir: Path):
    outcome = run_subprocess(_fixture_cmd("escaped", tree_dir), cwd=tree_dir, timeout_seconds=30)
    assert outcome.exit_code == 0
    assert outcome.termination == "exited"
    assert not outcome.timed_out
    assert outcome.duration_seconds < CLEANUP_BUDGET + SLACK
    assert outcome.stdout == STDOUT_TEXT
    pids = _recorded(tree_dir)
    assert not _is_zombie(pids["leader"])
    # Documented limitation: a descendant that left the group is not ours to stop.
    assert _is_running(pids["child"])


# ── termination classification ──────────────────────────────────────────────


def test_self_signal_is_signaled_not_timed_out(tree_dir: Path):
    outcome = run_subprocess(_fixture_cmd("self-signal", tree_dir), cwd=tree_dir, timeout_seconds=10)
    assert outcome.termination == "signaled"
    assert outcome.signal == "SIGTERM"
    assert outcome.exit_code == -signal.SIGTERM
    assert not outcome.timed_out
    assert outcome.duration_seconds < 10 - SLACK


def test_partial_utf8_decodes_with_replacement(tree_dir: Path):
    outcome = run_subprocess(_fixture_cmd("partial-utf8", tree_dir), cwd=tree_dir, timeout_seconds=1)
    assert outcome.termination == "timed-out"
    assert outcome.stdout.startswith("h\u00e9llo ")
    assert outcome.stdout.rstrip("\ufffd") == "h\u00e9llo "
    assert "\ufffd" in outcome.stdout


@pytest.mark.parametrize("runner", ["sync", "async"])
async def test_missing_binary_is_launch_failed(tmp_path: Path, runner: str):
    cmd = [str(tmp_path / "no-such-binary")]
    if runner == "sync":
        outcome = run_subprocess(cmd, cwd=tmp_path, timeout_seconds=5)
    else:
        outcome = await run_subprocess_async(cmd, cwd=tmp_path, timeout_seconds=5)
    assert outcome.termination == "launch-failed"
    assert outcome.launch_error == "ENOENT"
    assert outcome.exit_code == -1
    assert not outcome.timed_out
    assert outcome.signal is None
    assert outcome.duration_seconds < 1


def test_missing_cwd_is_launch_failed(tmp_path: Path):
    outcome = run_subprocess(["sh", "-c", "true"], cwd=tmp_path / "gone", timeout_seconds=5)
    assert outcome.termination == "launch-failed"
    assert outcome.launch_error == "ENOENT"
    assert outcome.exit_code == -1


def test_non_executable_is_launch_failed_eacces(tmp_path: Path):
    script = tmp_path / "not-executable"
    script.write_text("#!/bin/sh\necho ran\n")
    script.chmod(stat.S_IRUSR | stat.S_IWUSR)
    outcome = run_subprocess([str(script)], cwd=tmp_path, timeout_seconds=5)
    assert outcome.termination == "launch-failed"
    assert outcome.launch_error == "EACCES"
    assert outcome.exit_code == -1
    assert not outcome.timed_out


def test_normal_exit_fields(tmp_path: Path):
    outcome = run_subprocess(["sh", "-c", "exit 3"], cwd=tmp_path, timeout_seconds=5)
    assert (outcome.exit_code, outcome.termination, outcome.signal, outcome.launch_error) == (3, "exited", None, None)


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
