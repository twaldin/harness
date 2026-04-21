"""Unit tests for qwen adapter (mocked subprocess)."""
import json

import pytest

from harness import RunSpec
from harness._subproc import SubprocOutcome
from harness.adapters.qwen import QwenAdapter


def _stub(stdout="", stderr="", exit_code=0, timed_out=False):
    return SubprocOutcome(
        exit_code=exit_code,
        duration_seconds=1.0,
        stdout=stdout,
        stderr=stderr,
        timed_out=timed_out,
    )


# --- qwen -----------------------------------------------------------------


def test_qwen_build_command(tmp_path):
    spec = RunSpec(harness="qwen", prompt="refactor this", workdir=tmp_path, model="qwen3-coder")
    bc = QwenAdapter().build_command(spec)
    assert bc.cmd == "qwen"
    assert bc.args == ["-p", "refactor this", "-y", "-m", "qwen3-coder", "--output-format", "json"]
    assert bc.env == {}


def test_qwen_build_command_default_model(tmp_path):
    spec = RunSpec(harness="qwen", prompt="x", workdir=tmp_path)
    bc = QwenAdapter().build_command(spec)
    assert "-m" in bc.args
    assert bc.args[bc.args.index("-m") + 1] == "qwen3-coder"


def test_qwen_writes_instructions_file(tmp_path, monkeypatch):
    monkeypatch.setattr("harness.adapters.qwen.run_subprocess", lambda *a, **kw: _stub())
    spec = RunSpec(harness="qwen", prompt="x", workdir=tmp_path, instructions="be terse")
    QwenAdapter().run(spec)
    assert (tmp_path / "QWEN.md").read_text() == "be terse"


def test_qwen_parses_stats_models(tmp_path, monkeypatch):
    payload = {"response": "ok", "stats": {"models": {"qwen3-coder": {"tokens": {"input": 500, "candidates": 120}}}}}
    monkeypatch.setattr("harness.adapters.qwen.run_subprocess", lambda *a, **kw: _stub(stdout=json.dumps(payload)))
    result = QwenAdapter().run(RunSpec(harness="qwen", prompt="x", workdir=tmp_path))
    assert result.tokens_in == 500
    assert result.tokens_out == 120
    assert result.cost_usd is None
    assert result.raw is not None


def test_qwen_falls_back_to_per_line_json(tmp_path, monkeypatch):
    embedded = json.dumps({"stats": {"models": {"qwen3-coder": {"tokens": {"input": 30, "candidates": 10}}}}})
    stdout = f"preamble\n{embedded}\ntrailing"
    monkeypatch.setattr("harness.adapters.qwen.run_subprocess", lambda *a, **kw: _stub(stdout=stdout))
    result = QwenAdapter().run(RunSpec(harness="qwen", prompt="x", workdir=tmp_path))
    assert result.tokens_in == 30
    assert result.tokens_out == 10


def test_qwen_no_stats_returns_none(tmp_path, monkeypatch):
    monkeypatch.setattr(
        "harness.adapters.qwen.run_subprocess", lambda *a, **kw: _stub(stdout='{"response":"hi"}')
    )
    result = QwenAdapter().run(RunSpec(harness="qwen", prompt="x", workdir=tmp_path))
    assert result.tokens_in is None
    assert result.tokens_out is None
    assert result.cost_usd is None


def test_qwen_propagates_exit_code(tmp_path, monkeypatch):
    monkeypatch.setattr("harness.adapters.qwen.run_subprocess", lambda *a, **kw: _stub(exit_code=1, stderr="err"))
    result = QwenAdapter().run(RunSpec(harness="qwen", prompt="x", workdir=tmp_path))
    assert not result.ok
    assert result.exit_code == 1
