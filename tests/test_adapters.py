"""Adapter unit tests using mocked subprocess outcomes."""
import json
from pathlib import Path

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


def _observing_run(monkeypatch, seen: dict, outcome: SubprocOutcome):
    """Stand-in subprocess that records what the CLI would see on disk."""

    def fake(cmd, *, cwd, timeout_seconds, extra_env=None, **_kw):
        seen["files"] = {p.name: p.read_text() for p in Path(cwd).iterdir() if p.is_file()}
        return outcome

    monkeypatch.setattr("harness._subproc.run_subprocess", fake)


def test_claude_code_parses_json_envelope(tmp_path, monkeypatch):
    envelope = {
        "type": "result",
        "result": "fixed it",
        "usage": {"input_tokens": 100, "output_tokens": 50},
        "total_cost_usd": 0.0123,
    }
    seen: dict = {}
    _observing_run(monkeypatch, seen, _stub_outcome(stdout=json.dumps(envelope)))
    spec = RunSpec(harness="claude-code", prompt="fix", workdir=tmp_path, instructions="be terse")
    result = ClaudeCodeAdapter().run(spec)

    assert result.ok
    assert result.tokens_in == 100
    assert result.tokens_out == 50
    assert result.cost_usd == pytest.approx(0.0123)
    assert seen["files"] == {"CLAUDE.md": "be terse"}
    assert not (tmp_path / "CLAUDE.md").exists()  # projected only for the run


def test_claude_code_handles_garbage_stdout(tmp_path, monkeypatch):
    monkeypatch.setattr(
        "harness._subproc.run_subprocess",
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
        "harness._subproc.run_subprocess",
        lambda *a, **kw: _stub_outcome(stderr="boom", exit_code=2),
    )
    spec = RunSpec(harness="claude-code", prompt="x", workdir=tmp_path)
    result = ClaudeCodeAdapter().run(spec)
    assert not result.ok
    assert result.exit_code == 2


def test_opencode_projects_instructions_for_the_run(tmp_path, monkeypatch):
    monkeypatch.setenv("OPENCODE_DB", str(tmp_path / "no-such-db"))  # bypass DB query
    seen: dict = {}
    _observing_run(monkeypatch, seen, _stub_outcome())
    spec = RunSpec(harness="opencode", prompt="x", workdir=tmp_path, instructions="rules")
    result = OpenCodeAdapter().run(spec)
    assert result.ok
    assert seen["files"] == {"AGENTS.md": "rules"}
    assert list(tmp_path.iterdir()) == []
