"""Streaming I/O contract: stdin validation, output callbacks, teardown with pending callbacks, run()-level I/O.

Cross-language stdin/capture/inactivity scenarios live in
tests/subprocess_cases.json and run from tests/test_subproc_lifecycle.py.
Children here are `python3 -c` snippets or shell pipelines; every test that
streams proves liveness through side effects (a callback unblocks the child)
rather than timing.
"""
from __future__ import annotations

import asyncio
import concurrent.futures
import sys
import threading
import time
from pathlib import Path

import pytest

import harness.adapters  # noqa: F401 — populates registry
from harness import HarnessError, RunSpec, SubprocOutcome, parse_output, run, run_async
from harness._subproc import run_subprocess, run_subprocess_async

PYTHON = sys.executable
CLEANUP_BUDGET = 1.5
SLACK = 1.5
INTERRUPTED = "on_output callback did not complete before teardown finished"


def _py(code: str) -> list[str]:
    return [PYTHON, "-u", "-c", code]


def _gated_child(gate: Path) -> list[str]:
    """Prints on both streams, then blocks until `gate` exists, then prints again."""
    return _py(
        "import sys, time, os\n"
        "print('first', flush=True); print('wake', file=sys.stderr, flush=True)\n"
        f"while not os.path.exists({str(gate)!r}): time.sleep(0.01)\n"
        "print('last', flush=True)"
    )


async def _no_tasks_left() -> None:
    await asyncio.sleep(0.05)
    assert [t for t in asyncio.all_tasks() if t is not asyncio.current_task()] == []


# ── stdin ───────────────────────────────────────────────────────────────────


def test_stdin_conflicts_with_inherited_stdin(tmp_path: Path):
    with pytest.raises(ValueError, match="stdin_close"):
        run_subprocess(["cat"], cwd=tmp_path, timeout_seconds=5, stdin="", stdin_close=False)


# ── callbacks ───────────────────────────────────────────────────────────────


def test_sync_callback_is_live_and_labels_streams(tmp_path: Path):
    """The child blocks until the callback reacts to its first chunk: delivery is not deferred to exit."""
    gate = tmp_path / "gate"
    seen: list[tuple[str, str]] = []

    def on_output(chunk: str, stream: str) -> None:
        seen.append((stream, chunk))
        if stream == "stderr":
            gate.touch()

    outcome = run_subprocess(_gated_child(gate), cwd=tmp_path, timeout_seconds=5, on_output=on_output)
    assert outcome.termination == "exited"
    assert outcome.callback_error is None
    assert "".join(c for s, c in seen if s == "stdout") == "first\nlast\n"
    assert "".join(c for s, c in seen if s == "stderr") == "wake\n"
    assert outcome.stdout == "first\nlast\n"


async def test_async_callback_runs_on_the_caller_loop_and_may_await(tmp_path: Path):
    loop = asyncio.get_running_loop()
    gate = tmp_path / "gate"
    seen: list[tuple[str, str]] = []

    async def on_output(chunk: str, stream: str) -> None:
        assert asyncio.get_running_loop() is loop
        await asyncio.sleep(0)
        seen.append((stream, chunk))
        if stream == "stderr":
            gate.touch()

    outcome = await run_subprocess_async(_gated_child(gate), cwd=tmp_path, timeout_seconds=5, on_output=on_output)
    assert outcome.termination == "exited"
    assert outcome.callback_error is None
    assert "".join(c for s, c in seen if s == "stdout") == "first\nlast\n"


async def test_sync_callback_in_run_async_executes_on_the_loop_thread(tmp_path: Path):
    threads: set[int] = set()
    outcome = await run_subprocess_async(
        ["sh", "-c", "echo a"], cwd=tmp_path, timeout_seconds=5,
        on_output=lambda t, s: threads.add(threading.get_ident()),
    )
    assert outcome.callback_error is None
    assert threads == {threading.get_ident()}


@pytest.mark.parametrize("reject", [False, True])
async def test_completed_callback_is_collected_before_next_delivery(monkeypatch, tmp_path: Path, reject: bool):
    schedule = asyncio.run_coroutine_threadsafe
    seen: list[tuple[str, str]] = []

    def complete_before_return(coro, loop):
        future = schedule(coro, loop)
        # Force completion before the reader can observe the returned future.
        concurrent.futures.wait((future,), timeout=5)
        assert future.done()
        return future

    def on_output(chunk: str, stream: str) -> None:
        seen.append((stream, chunk))
        if reject:
            raise ValueError("callback rejected")

    monkeypatch.setattr(asyncio, "run_coroutine_threadsafe", complete_before_return)
    outcome = await run_subprocess_async(
        ["sh", "-c", "echo out; echo err >&2"], cwd=tmp_path,
        timeout_seconds=5, max_output_bytes=0, on_output=on_output,
    )
    assert (outcome.stdout, outcome.stderr) == ("", "")
    assert (outcome.stdout_truncated, outcome.stderr_truncated) == (True, True)
    if reject:
        assert outcome.callback_error is not None
        assert len(seen) == 1  # Failure disables further delivery, not pipe draining.
    else:
        assert (outcome.termination, outcome.exit_code, outcome.callback_error) == ("exited", 0, None)
        assert sorted(seen) == [("stderr", "err\n"), ("stdout", "out\n")]


async def test_async_backpressure_serializes_callbacks_and_pauses_inactivity(tmp_path: Path):
    in_flight = 0
    peak = 0
    received: list[str] = []

    async def slow(chunk: str, stream: str) -> None:
        nonlocal in_flight, peak
        in_flight += 1
        peak = max(peak, in_flight)
        # One callback outlasts inactivity; chunk count must not consume the
        # wall timeout or the bounded post-exit drain budget.
        await asyncio.sleep(1.1 if not received else 0)
        received.append(chunk)
        in_flight -= 1

    lines = "".join(f"{i:06d}\n" for i in range(20000))  # 140 KB, dwarfs the pipe buffer
    outcome = await run_subprocess_async(
        _py("import sys; sys.stdout.write(''.join(f'{i:06d}\\n' for i in range(20000)))"), cwd=tmp_path, timeout_seconds=20,
        inactivity_timeout_seconds=1, on_output=slow,
    )
    assert (outcome.termination, outcome.exit_code, outcome.callback_error) == ("exited", 0, None)
    assert peak == 1
    assert "".join(received) == lines
    assert outcome.stdout == lines


@pytest.mark.parametrize("runner", ["sync", "async"])
async def test_callback_exception_stops_the_run_as_callback_error(tmp_path: Path, runner: str):
    def boom(chunk: str, stream: str) -> None:
        raise RuntimeError("consumer broke")

    cmd = ["sh", "-c", "echo a; sleep 30"]
    kwargs = dict(cwd=tmp_path, timeout_seconds=30, on_output=boom)
    outcome = run_subprocess(cmd, **kwargs) if runner == "sync" else await run_subprocess_async(cmd, **kwargs)
    assert outcome.termination == "callback-error"
    assert outcome.callback_error == "RuntimeError: consumer broke"
    assert (outcome.exit_code, outcome.timed_out, outcome.timeout_kind) == (-1, False, None)
    assert outcome.stdout == "a\n"  # capture continues without the callback
    assert outcome.duration_seconds < CLEANUP_BUDGET + SLACK


async def test_async_rejection_after_leader_exit_keeps_exit_but_flags_callback(tmp_path: Path):
    async def late_fail(chunk: str, stream: str) -> None:
        await asyncio.sleep(0.2)
        raise ValueError("late")

    outcome = await run_subprocess_async(["sh", "-c", "echo a; exit 4"], cwd=tmp_path, timeout_seconds=5, on_output=late_fail)
    assert (outcome.termination, outcome.exit_code) == ("exited", 4)
    assert outcome.callback_error == "ValueError: late"


@pytest.mark.parametrize("runner", ["sync", "async"])
async def test_callback_failure_preserves_an_already_reaped_exit(monkeypatch, tmp_path: Path, runner: str):
    import harness._subproc as engine

    original_popen = engine.subprocess.Popen
    children = []

    def launch(*args, **kwargs):
        child = original_popen(*args, **kwargs)
        children.append(child)
        return child

    def fail_after_exit(chunk: str, stream: str) -> None:
        children[0].wait(timeout=3)
        raise ValueError("late")

    monkeypatch.setattr(engine.subprocess, "Popen", launch)
    kwargs = dict(cwd=tmp_path, timeout_seconds=5, on_output=fail_after_exit)
    cmd = ["sh", "-c", "echo a; exit 4"]
    outcome = run_subprocess(cmd, **kwargs) if runner == "sync" else await run_subprocess_async(cmd, **kwargs)
    assert (outcome.termination, outcome.exit_code, outcome.callback_error) == ("exited", 4, "ValueError: late")


def test_sync_callback_must_return_none(tmp_path: Path):
    outcome = run_subprocess(["sh", "-c", "echo a; sleep 30"], cwd=tmp_path, timeout_seconds=30, on_output=lambda t, s: 1)
    assert outcome.termination == "callback-error"
    assert outcome.callback_error == "TypeError: on_output must return None, got int"


def test_sync_runner_reports_awaitable_return_and_closes_it(tmp_path: Path):
    async def inner() -> None:
        pass

    outcome = run_subprocess(["sh", "-c", "echo a; sleep 30"], cwd=tmp_path, timeout_seconds=30, on_output=lambda t, s: inner())
    assert outcome.termination == "callback-error"
    assert outcome.callback_error.startswith("TypeError: on_output returned an awaitable")


def test_sync_runner_refuses_async_callback_before_launch(tmp_path: Path):
    async def cb(chunk: str, stream: str) -> None:
        pass

    with pytest.raises(ValueError, match="async callable"):
        run_subprocess(["sh", "-c", "touch launched"], cwd=tmp_path, timeout_seconds=5, on_output=cb)
    assert not (tmp_path / "launched").exists()


# ── stalled callbacks and teardown ─────────────────────────────────────────


async def _stall(chunk: str, stream: str) -> None:
    await asyncio.Event().wait()


async def test_stalled_callback_on_normal_exit_is_abandoned_within_the_drain_budget(tmp_path: Path):
    started = time.monotonic()
    outcome = await run_subprocess_async(["sh", "-c", "echo a; echo b >&2"], cwd=tmp_path, timeout_seconds=10, on_output=_stall)
    assert time.monotonic() - started < CLEANUP_BUDGET + SLACK
    assert (outcome.termination, outcome.exit_code) == ("exited", 0)
    assert outcome.callback_error == INTERRUPTED
    assert outcome.stdout == "a\n" and outcome.stderr == "b\n"  # capture is independent of delivery
    await _no_tasks_left()


async def test_task_cancel_with_stalled_callback_does_not_deadlock(tmp_path: Path):
    task = asyncio.ensure_future(
        run_subprocess_async(["sh", "-c", "echo a; touch ready; sleep 30"], cwd=tmp_path, timeout_seconds=30, on_output=_stall)
    )
    while not (tmp_path / "ready").exists():
        await asyncio.sleep(0.01)
    started = time.monotonic()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert time.monotonic() - started < CLEANUP_BUDGET + SLACK
    await _no_tasks_left()


async def test_cancel_event_with_stalled_callback_reports_both(tmp_path: Path):
    cancel = threading.Event()
    task = asyncio.ensure_future(run_subprocess_async(
        ["sh", "-c", "echo a; touch ready; sleep 30"], cwd=tmp_path, timeout_seconds=30, on_output=_stall, cancel=cancel,
    ))
    while not (tmp_path / "ready").exists():
        await asyncio.sleep(0.01)
    cancel.set()
    outcome = await task
    assert (outcome.termination, outcome.exit_code, outcome.timed_out) == ("cancelled", -1, False)
    assert outcome.callback_error == INTERRUPTED


async def test_wall_timeout_fires_while_a_callback_backpressures(tmp_path: Path):
    outcome = await run_subprocess_async(["sh", "-c", "echo a; sleep 30"], cwd=tmp_path, timeout_seconds=0.3, on_output=_stall)
    assert (outcome.termination, outcome.timeout_kind, outcome.timed_out) == ("timed-out", "wall", True)
    assert outcome.callback_error == INTERRUPTED
    assert outcome.duration_seconds < 0.3 + CLEANUP_BUDGET + SLACK


# ── deadlines ───────────────────────────────────────────────────────────────


def test_disabled_wall_timeout_still_honors_cancel(tmp_path: Path):
    cancel = threading.Event()
    threading.Timer(0.2, cancel.set).start()
    outcome = run_subprocess(["sh", "-c", "sleep 30"], cwd=tmp_path, timeout_seconds=None, cancel=cancel)
    assert (outcome.termination, outcome.timeout_kind) == ("cancelled", None)


# ── high-level runs ────────────────────────────────────────────────────────


@pytest.fixture
def streaming_cli(tmp_path: Path) -> Path:
    """Prints a JSONL usage record, a partial record, NOISE bytes on stderr, then echoes stdin and lingers."""
    exe = tmp_path / "streaming-cli"
    exe.write_text(
        f"#!{PYTHON}\n"
        "import sys, os, time\n"
        "data = sys.stdin.read()\n"
        "print('{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":7,\"output_tokens\":3}}', flush=True)\n"
        "print('{\"type\":\"turn.compl', end='', flush=True)\n"
        "sys.stderr.write('n' * int(os.environ.get('NOISE', '0'))); sys.stderr.flush()\n"
        "sys.stdout.write('\\n' + data); sys.stdout.flush()\n"
        "time.sleep(float(os.environ.get('LINGER', '0')))\n"
    )
    exe.chmod(0o700)
    return exe


@pytest.fixture
def workdir(tmp_path: Path) -> Path:
    d = tmp_path / "repo"
    d.mkdir()
    return d


def _spec(workdir: Path, exe: Path, **kw) -> RunSpec:
    return RunSpec(harness="codex", prompt="p", workdir=workdir, instructions="projected", executable=str(exe), **kw)


@pytest.mark.parametrize("entrypoint", ["sync", "async"])
async def test_run_streams_and_reports_io_metadata(workdir: Path, streaming_cli: Path, entrypoint: str):
    (workdir / "AGENTS.md").write_text("mine")
    chunks: list[tuple[str, str]] = []
    spec = _spec(
        workdir, streaming_cli, stdin="from stdin\n", max_output_bytes=100, env={"NOISE": "150"},
        on_output=lambda t, s: chunks.append((s, t)),
    )
    result = run(spec) if entrypoint == "sync" else await run_async(spec)
    assert result.termination == "exited"
    assert result.ok, result
    assert (result.tokens_in, result.tokens_out) == (7, 3)  # complete records survive the trailing partial one
    assert result.parse_error is None and result.callback_error is None and result.timeout_kind is None
    assert "".join(t for s, t in chunks if s == "stdout").endswith("\nfrom stdin\n")
    assert "".join(t for s, t in chunks if s == "stderr") == "n" * 150
    assert (result.stderr, result.stderr_bytes, result.stderr_truncated) == ("n" * 100, 150, True)
    assert (result.stdout_bytes, len(result.stdout), result.stdout_truncated) == (102, 100, True)
    assert (workdir / "AGENTS.md").read_text() == "mine"
    assert sorted(p.name for p in workdir.iterdir()) == ["AGENTS.md"]


def test_run_callback_failure_restores_instructions(workdir: Path, streaming_cli: Path):
    (workdir / "AGENTS.md").write_text("mine")

    def boom(chunk: str, stream: str) -> None:
        raise RuntimeError("bad consumer")

    result = run(_spec(workdir, streaming_cli, on_output=boom, env={"LINGER": "30"}, timeout_seconds=30))
    assert (result.termination, result.exit_code, result.timed_out) == ("callback-error", -1, False)
    assert result.callback_error == "RuntimeError: bad consumer"
    assert not result.ok
    assert (workdir / "AGENTS.md").read_text() == "mine"
    assert sorted(p.name for p in workdir.iterdir()) == ["AGENTS.md"]


async def test_run_async_inactivity_timeout_restores_instructions(workdir: Path, streaming_cli: Path):
    spec = _spec(workdir, streaming_cli, env={"LINGER": "30"}, timeout_seconds=None, inactivity_timeout_seconds=1.0)
    result = await run_async(spec)
    assert (result.termination, result.timeout_kind, result.timed_out, result.exit_code) == ("timed-out", "inactivity", True, -1)
    assert result.tokens_in == 7  # what streamed before the watchdog fired is still parsed
    assert not result.ok
    assert list(workdir.iterdir()) == []


def test_run_result_ok_requires_clean_callback_and_parse():
    from harness.base import RunResult

    base = dict(harness="codex", model=None, exit_code=0, duration_seconds=0.0, stdout="", stderr="")
    assert RunResult(**base).ok
    assert not RunResult(**base, callback_error="x").ok
    assert not RunResult(**base, parse_error="x").ok


@pytest.mark.parametrize("harness_name,record", [
    ("codex", '{"type":"turn.completed","usage":{"input_tokens":5,"output_tokens":2}}'),
    ("pi", '{"type":"turn_end","message":{"role":"assistant","usage":{"input":5,"output":2,"cost":{"total":0.5}}}}'),
    ("omp", '{"type":"message_end","message":{"role":"assistant","usage":{"input":5,"output":2,"cost":{"total":0.5}}}}'),
])
def test_jsonl_parsers_keep_complete_records_before_a_partial_tail(tmp_path: Path, harness_name: str, record: str):
    stdout = record + '\n{"type":"agent_end","messa'
    parsed = parse_output(RunSpec(harness=harness_name, prompt="p", workdir=tmp_path), SubprocOutcome(0, 0.1, stdout, "", False))
    assert (parsed["tokens_in"], parsed["tokens_out"]) == (5, 2)


def test_invalid_stdin_type_is_invalid_options(tmp_path: Path):
    with pytest.raises(HarnessError) as exc:
        run(RunSpec(harness="codex", prompt="p", workdir=tmp_path, stdin=b"bytes"))  # type: ignore[arg-type]
    assert exc.value.code == "invalid-options"


def test_setup_failure_with_stdin_still_reaps_owned_child(monkeypatch, tmp_path: Path):
    import harness._subproc as engine

    original_popen = engine.subprocess.Popen
    children = []

    def launch(*args, **kwargs):
        child = original_popen(*args, **kwargs)
        children.append(child)
        return child

    def fail_setup(fd, blocking):
        raise OSError("synthetic descriptor setup failure")

    monkeypatch.setattr(engine.subprocess, "Popen", launch)
    monkeypatch.setattr(engine.os, "set_blocking", fail_setup)
    try:
        with pytest.raises(OSError, match="synthetic descriptor setup failure"):
            run_subprocess(_py("import time; time.sleep(30)"), cwd=tmp_path, timeout_seconds=5, stdin="payload")
        assert children[0].poll() is not None
    finally:
        for child in children:
            if child.poll() is None:
                child.kill()
                child.wait()
