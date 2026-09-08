"""Unit tests for qwen and continue-cli adapters (mocked subprocess)."""
import json

import pytest

from harness import HarnessError, RunSpec
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
    assert bc.args == ["-p", "refactor this", "-m", "qwen3-coder", "--output-format", "json"]
    assert bc.env == {}


def test_qwen_build_command_default_model(tmp_path):
    spec = RunSpec(harness="qwen", prompt="x", workdir=tmp_path)
    bc = QwenAdapter().build_command(spec)
    assert "-m" in bc.args
    assert bc.args[bc.args.index("-m") + 1] == "qwen3-coder"


def test_qwen_projects_instructions_for_the_run(tmp_path, monkeypatch):
    seen: dict = {}

    def fake_run(cmd, *, cwd, **kw):
        seen["qwen"] = (cwd / "QWEN.md").read_text()
        return _stub()

    monkeypatch.setattr("harness._subproc.run_subprocess", fake_run)
    spec = RunSpec(harness="qwen", prompt="x", workdir=tmp_path, instructions="be terse")
    QwenAdapter().run(spec)
    assert seen["qwen"] == "be terse"
    assert not (tmp_path / "QWEN.md").exists()


def test_qwen_parses_result_array(tmp_path, monkeypatch):
    payload = [
        {"type": "assistant", "content": "ok"},
        {"type": "result", "usage": {"input_tokens": 500, "output_tokens": 120}},
    ]
    monkeypatch.setattr("harness._subproc.run_subprocess", lambda *a, **kw: _stub(stdout=json.dumps(payload)))
    result = QwenAdapter().run(RunSpec(harness="qwen", prompt="x", workdir=tmp_path))
    assert result.tokens_in == 500
    assert result.tokens_out == 120
    assert result.cost_usd is None
    assert result.raw is not None


def test_qwen_falls_back_to_per_line_json(tmp_path, monkeypatch):
    embedded = json.dumps([{"type": "result", "usage": {"input_tokens": 30, "output_tokens": 10}}])
    stdout = f"preamble\n{embedded}\ntrailing"
    monkeypatch.setattr("harness._subproc.run_subprocess", lambda *a, **kw: _stub(stdout=stdout))
    result = QwenAdapter().run(RunSpec(harness="qwen", prompt="x", workdir=tmp_path))
    assert result.tokens_in == 30
    assert result.tokens_out == 10


def test_qwen_no_stats_returns_none(tmp_path, monkeypatch):
    monkeypatch.setattr(
        "harness._subproc.run_subprocess", lambda *a, **kw: _stub(stdout='{"response":"hi"}')
    )
    result = QwenAdapter().run(RunSpec(harness="qwen", prompt="x", workdir=tmp_path))
    assert result.tokens_in is None
    assert result.tokens_out is None
    assert result.cost_usd is None


def test_qwen_propagates_exit_code(tmp_path, monkeypatch):
    monkeypatch.setattr("harness._subproc.run_subprocess", lambda *a, **kw: _stub(exit_code=1, stderr="err"))
    result = QwenAdapter().run(RunSpec(harness="qwen", prompt="x", workdir=tmp_path))
    assert not result.ok
    assert result.exit_code == 1


# --- continue-cli ---------------------------------------------------------


def test_continue_build_command(tmp_path):
    spec = RunSpec(harness="continue-cli", prompt="add types", workdir=tmp_path, model="anthropic/claude-sonnet-4-6")
    bc = ContinueCliAdapter().build_command(spec)
    assert bc.cmd == "cn"
    assert bc.args == ["-p", "add types", "--model", "anthropic/claude-sonnet-4-6", "--format", "json"]
    assert bc.env == {}
    assert bc.model == "anthropic/claude-sonnet-4-6"


def test_continue_build_command_default_model_delegates_to_upstream_config(tmp_path):
    spec = RunSpec(harness="continue-cli", prompt="x", workdir=tmp_path)
    bc = ContinueCliAdapter().build_command(spec)
    assert bc.args == ["-p", "x", "--format", "json"]
    assert bc.model is None


def test_continue_rejects_bare_native_model_id(tmp_path):
    spec = RunSpec(harness="continue-cli", prompt="x", workdir=tmp_path, model="claude-sonnet-4-6")
    with pytest.raises(HarnessError) as exc:
        ContinueCliAdapter().build_command(spec)
    assert exc.value.code == "unsupported-capability"
    assert "config_file" in str(exc.value)


def test_continue_bypass_maps_to_auto(tmp_path):
    spec = RunSpec(harness="continue-cli", prompt="x", workdir=tmp_path, permission_policy="bypass")
    bc = ContinueCliAdapter().build_command(spec)
    assert bc.args == ["-p", "x", "--auto", "--format", "json"]


def test_continue_instructions_are_passed_as_a_rule(tmp_path):
    spec = RunSpec(harness="continue-cli", prompt="x", workdir=tmp_path, instructions="keep it brief")
    bc = ContinueCliAdapter().build_command(spec)
    assert bc.instructions_file == tmp_path / "CONTINUE.md"
    assert bc.args == ["-p", "x", "--rule", str(tmp_path / "CONTINUE.md"), "--format", "json"]


def test_continue_projects_instructions_for_the_run(tmp_path, monkeypatch):
    seen: dict = {}

    def fake_run(cmd, *, cwd, **kw):
        seen["cn"] = (cwd / "CONTINUE.md").read_text()
        return _stub()

    monkeypatch.setattr("harness._subproc.run_subprocess", fake_run)
    spec = RunSpec(harness="continue-cli", prompt="x", workdir=tmp_path, instructions="keep it brief")
    ContinueCliAdapter().run(spec)
    assert seen["cn"] == "keep it brief"
    assert not (tmp_path / "CONTINUE.md").exists()


def test_continue_config_file_delegates_model_selection(tmp_path):
    spec = RunSpec(harness="continue-cli", prompt="go", workdir=tmp_path, config_file=tmp_path / "cfg.yaml")
    bc = ContinueCliAdapter().build_command(spec)
    assert bc.args == ["-p", "--config", str(tmp_path / "cfg.yaml"), "--format", "json", "go"]
    assert bc.model is None


def test_continue_config_file_rejects_explicit_model(tmp_path):
    spec = RunSpec(harness="continue-cli", prompt="go", workdir=tmp_path, model="gpt-5.4", config_file=tmp_path / "cfg.yaml")
    with pytest.raises(HarnessError) as exc:
        ContinueCliAdapter().build_command(spec)
    assert exc.value.code == "unsupported-capability"


def test_continue_openai_env_requires_caller_config_file(tmp_path):
    spec = RunSpec(harness="continue-cli", prompt="go", workdir=tmp_path, env={"OPENAI_API_KEY": "sk-secret"})
    with pytest.raises(HarnessError) as exc:
        ContinueCliAdapter().build_command(spec)
    assert exc.value.code == "unsupported-capability"
    assert "sk-secret" not in str(exc.value)
    assert list(tmp_path.iterdir()) == []

    with_config = RunSpec(
        harness="continue-cli", prompt="go", workdir=tmp_path, env={"OPENAI_API_KEY": "sk-secret"}, config_file=tmp_path / "c.yaml"
    )
    bc = ContinueCliAdapter().build_command(with_config)
    assert bc.args == ["-p", "--config", str(tmp_path / "c.yaml"), "--format", "json", "go"]
    assert bc.env["OPENAI_API_KEY"] == "sk-secret"


def test_continue_parses_wrapped_headless_response(tmp_path, monkeypatch):
    wrapped = {
        "response": "done",
        "status": "success",
        "note": "Response was not valid JSON, so it was wrapped in a JSON object",
    }
    monkeypatch.setattr(
        "harness._subproc.run_subprocess",
        lambda *a, **kw: _stub(stdout=json.dumps(wrapped) + "\n"),
    )
    result = ContinueCliAdapter().run(RunSpec(harness="continue-cli", prompt="x", workdir=tmp_path))
    assert result.raw == wrapped
    assert (result.tokens_in, result.tokens_out, result.cost_usd) == (None, None, None)


def test_continue_skips_compaction_status_lines_and_ignores_model_usage_fields(tmp_path, monkeypatch):
    final = {"result": "done", "usage": {"input_tokens": 800, "output_tokens": 200}, "total_cost_usd": 0.0187}
    stdout = (
        json.dumps({"status": "info", "message": "Auto-compacting triggered", "contextUsage": "91%"}) + "\n"
        + json.dumps({"status": "success", "message": "Auto-compacted successfully"}) + "\n"
        + json.dumps(final, indent=2) + "\n"
    )
    monkeypatch.setattr("harness._subproc.run_subprocess", lambda *a, **kw: _stub(stdout=stdout))
    result = ContinueCliAdapter().run(RunSpec(harness="continue-cli", prompt="x", workdir=tmp_path))
    assert result.raw == final
    assert (result.tokens_in, result.tokens_out, result.cost_usd) == (None, None, None)


def test_continue_handles_garbage_stdout(tmp_path, monkeypatch):
    monkeypatch.setattr(
        "harness._subproc.run_subprocess", lambda *a, **kw: _stub(stdout="not json")
    )
    result = ContinueCliAdapter().run(RunSpec(harness="continue-cli", prompt="x", workdir=tmp_path))
    assert result.raw is None
    assert result.tokens_in is None
    assert result.cost_usd is None


def test_continue_propagates_exit_code(tmp_path, monkeypatch):
    monkeypatch.setattr(
        "harness._subproc.run_subprocess", lambda *a, **kw: _stub(exit_code=2, stderr="boom")
    )
    result = ContinueCliAdapter().run(RunSpec(harness="continue-cli", prompt="x", workdir=tmp_path))
    assert not result.ok
    assert result.exit_code == 2
