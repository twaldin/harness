"""Unit tests for qwen and continue-cli adapters (mocked subprocess)."""
import json

import pytest

from harness import RunSpec
from harness._subproc import SubprocOutcome
from harness.adapters.continue_cli import ContinueCliAdapter
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


# --- continue-cli ---------------------------------------------------------


def test_continue_build_command(tmp_path):
    spec = RunSpec(harness="continue-cli", prompt="add types", workdir=tmp_path, model="claude-sonnet-4-6")
    bc = ContinueCliAdapter().build_command(spec)
    assert bc.cmd == "cn"
    assert bc.args == ["-p", "add types", "--model", "claude-sonnet-4-6", "--json"]
    assert bc.env == {}


def test_continue_build_command_default_model(tmp_path):
    spec = RunSpec(harness="continue-cli", prompt="x", workdir=tmp_path)
    bc = ContinueCliAdapter().build_command(spec)
    assert "--model" in bc.args
    assert bc.args[bc.args.index("--model") + 1] == "claude-sonnet-4-6"


def test_continue_writes_instructions_file(tmp_path, monkeypatch):
    monkeypatch.setattr("harness.adapters.continue_cli.run_subprocess", lambda *a, **kw: _stub())
    spec = RunSpec(harness="continue-cli", prompt="x", workdir=tmp_path, instructions="keep it brief")
    ContinueCliAdapter().run(spec)
    assert (tmp_path / "CONTINUE.md").read_text() == "keep it brief"


def test_continue_parses_json_envelope(tmp_path, monkeypatch):
    envelope = {
        "type": "result",
        "result": "done",
        "usage": {"input_tokens": 800, "output_tokens": 200},
        "total_cost_usd": 0.0187,
    }
    monkeypatch.setattr(
        "harness.adapters.continue_cli.run_subprocess",
        lambda *a, **kw: _stub(stdout=json.dumps(envelope)),
    )
    result = ContinueCliAdapter().run(RunSpec(harness="continue-cli", prompt="x", workdir=tmp_path))
    assert result.tokens_in == 800
    assert result.tokens_out == 200
    assert result.cost_usd == pytest.approx(0.0187)
    assert result.raw is not None


def test_continue_handles_garbage_stdout(tmp_path, monkeypatch):
    monkeypatch.setattr(
        "harness.adapters.continue_cli.run_subprocess", lambda *a, **kw: _stub(stdout="not json")
    )
    result = ContinueCliAdapter().run(RunSpec(harness="continue-cli", prompt="x", workdir=tmp_path))
    assert result.raw is None
    assert result.tokens_in is None
    assert result.cost_usd is None


def test_continue_propagates_exit_code(tmp_path, monkeypatch):
    monkeypatch.setattr(
        "harness.adapters.continue_cli.run_subprocess", lambda *a, **kw: _stub(exit_code=2, stderr="boom")
    )
    result = ContinueCliAdapter().run(RunSpec(harness="continue-cli", prompt="x", workdir=tmp_path))
    assert not result.ok
    assert result.exit_code == 2
