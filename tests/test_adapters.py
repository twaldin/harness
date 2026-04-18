"""Adapter unit tests using mocked subprocess outcomes."""
import json

import pytest

from harness import RunSpec
from harness._subproc import SubprocOutcome
from harness.adapters.claude_code import ClaudeCodeAdapter
from harness.adapters.opencode import OpenCodeAdapter


def _stub_outcome(stdout="", stderr="", exit_code=0, timed_out=False, duration=1.0):
    return SubprocOutcome(
        exit_code=exit_code,
        duration_seconds=duration,
        stdout=stdout,
        stderr=stderr,
        timed_out=timed_out,
    )


def test_claude_code_parses_json_envelope(tmp_path, monkeypatch):
    envelope = {
        "type": "result",
        "result": "fixed it",
        "usage": {"input_tokens": 100, "output_tokens": 50},
        "total_cost_usd": 0.0123,
    }
    monkeypatch.setattr(
        "harness.adapters.claude_code.run_subprocess",
        lambda *a, **kw: _stub_outcome(stdout=json.dumps(envelope)),
    )
    spec = RunSpec(harness="claude-code", prompt="fix", workdir=tmp_path, instructions="be terse")
    result = ClaudeCodeAdapter().run(spec)

    assert result.ok
    assert result.tokens_in == 100
    assert result.tokens_out == 50
    assert result.cost_usd == pytest.approx(0.0123)
    assert (tmp_path / "CLAUDE.md").read_text() == "be terse"


def test_claude_code_handles_garbage_stdout(tmp_path, monkeypatch):
    monkeypatch.setattr(
        "harness.adapters.claude_code.run_subprocess",
        lambda *a, **kw: _stub_outcome(stdout="not json"),
    )
    spec = RunSpec(harness="claude-code", prompt="x", workdir=tmp_path)
    result = ClaudeCodeAdapter().run(spec)

    assert result.ok
    assert result.raw is None
    assert result.tokens_in is None
    assert result.cost_usd is None


def test_claude_code_propagates_exit_code(tmp_path, monkeypatch):
    monkeypatch.setattr(
        "harness.adapters.claude_code.run_subprocess",
        lambda *a, **kw: _stub_outcome(stderr="boom", exit_code=2),
    )
    spec = RunSpec(harness="claude-code", prompt="x", workdir=tmp_path)
    result = ClaudeCodeAdapter().run(spec)
    assert not result.ok
    assert result.exit_code == 2


def test_opencode_writes_instructions(tmp_path, monkeypatch):
    monkeypatch.setenv("OPENCODE_DB", str(tmp_path / "no-such-db"))  # bypass DB query
    monkeypatch.setattr(
        "harness.adapters.opencode.run_subprocess",
        lambda *a, **kw: _stub_outcome(),
    )
    spec = RunSpec(harness="opencode", prompt="x", workdir=tmp_path, instructions="rules")
    result = OpenCodeAdapter().run(spec)
    assert result.ok
    assert (tmp_path / "AGENTS.md").read_text() == "rules"
