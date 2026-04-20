"""Tests for run_async / run_subprocess_async — non-blocking subprocess execution."""
from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest
import pytest_asyncio

import harness.adapters  # noqa: F401 — populates registry
from harness._subproc import SubprocOutcome, run_subprocess_async
from harness.base import RunSpec
from harness.registry import run_async

FIXTURES_DIR = Path(__file__).parent / "fixtures"


def _load_fixture(name: str) -> dict:
    return json.loads((FIXTURES_DIR / f"{name}.json").read_text())


@pytest.mark.asyncio
async def test_run_async_result_matches_fixture(tmp_path):
    """run_async() returns RunResult with fields matching the claude-code fixture."""
    fx = _load_fixture("claude-code")
    sample = fx["sampleOutput"]
    expected = fx["expectedParsed"]

    spec = RunSpec(
        harness="claude-code",
        prompt=fx["spec"]["prompt"],
        workdir=tmp_path,
        model=fx["spec"].get("model"),
        instructions=fx["spec"].get("instructions"),
        timeout_seconds=fx["spec"].get("timeoutSeconds", 1800),
    )

    mock_outcome = SubprocOutcome(
        exit_code=sample["exitCode"],
        duration_seconds=sample["durationSeconds"],
        stdout=sample["stdout"],
        stderr=sample["stderr"],
        timed_out=sample["timedOut"],
    )

    with patch("harness._subproc.run_subprocess_async", new=AsyncMock(return_value=mock_outcome)):
        result = await run_async(spec)

    assert result.harness == "claude-code"
    assert result.exit_code == sample["exitCode"]
    assert result.stdout == sample["stdout"]
    assert result.stderr == sample["stderr"]
    assert result.timed_out == sample["timedOut"]
    assert result.cost_usd == pytest.approx(expected["costUsd"])
    assert result.tokens_in == expected["tokensIn"]
    assert result.tokens_out == expected["tokensOut"]


@pytest.mark.asyncio
async def test_run_subprocess_async_captures_output(tmp_path):
    outcome = await run_subprocess_async(
        ["sh", "-c", "echo hello && echo bye >&2"],
        cwd=tmp_path,
        timeout_seconds=10,
    )
    assert outcome.exit_code == 0
    assert "hello" in outcome.stdout
    assert "bye" in outcome.stderr
    assert not outcome.timed_out
    assert outcome.duration_seconds >= 0


@pytest.mark.asyncio
async def test_run_subprocess_async_nonzero_exit(tmp_path):
    outcome = await run_subprocess_async(["sh", "-c", "exit 7"], cwd=tmp_path, timeout_seconds=10)
    assert outcome.exit_code == 7
    assert not outcome.timed_out


@pytest.mark.asyncio
async def test_run_subprocess_async_timeout(tmp_path):
    outcome = await run_subprocess_async(["sh", "-c", "sleep 5"], cwd=tmp_path, timeout_seconds=1)
    assert outcome.timed_out
    assert outcome.exit_code == -1


@pytest.mark.asyncio
async def test_run_subprocess_async_extra_env(tmp_path):
    outcome = await run_subprocess_async(
        ["sh", "-c", "echo $HARNESS_ASYNC_VAR"],
        cwd=tmp_path,
        timeout_seconds=10,
        extra_env={"HARNESS_ASYNC_VAR": "async_ok"},
    )
    assert outcome.stdout.strip() == "async_ok"


@pytest.mark.asyncio
async def test_two_parallel_runs_non_blocking(tmp_path):
    """Two concurrent run_subprocess_async() calls finish in ~max(A,B), not A+B."""
    delay = 0.3

    async def job() -> SubprocOutcome:
        return await run_subprocess_async(
            ["sh", "-c", f"sleep {delay} && echo done"],
            cwd=tmp_path,
            timeout_seconds=10,
        )

    start = time.monotonic()
    results = await asyncio.gather(job(), job())
    elapsed = time.monotonic() - start

    # Sequential would take ~0.6s; parallel should finish in ~0.3s (allow 2x slack)
    assert elapsed < delay * 2 + 0.1, f"expected parallel finish ~{delay}s, took {elapsed:.2f}s"
    assert all("done" in r.stdout for r in results)
