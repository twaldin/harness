"""Unit tests for codex, gemini, aider, swe-agent (mocked subprocess)."""
import json

import pytest

from harness import RunSpec
from harness._subproc import SubprocOutcome
from harness.adapters.aider import AiderAdapter
from harness.adapters.codex import CodexAdapter
from harness.adapters.gemini import GeminiAdapter
from harness.adapters.swe_agent import SweAgentAdapter
from harness.base import HarnessError


def _stub(stdout="", stderr="", exit_code=0, timed_out=False):
    return SubprocOutcome(
        exit_code=exit_code,
        duration_seconds=1.0,
        stdout=stdout,
        stderr=stderr,
        timed_out=timed_out,
    )


# --- codex ----------------------------------------------------------------


def test_codex_sums_turn_completed_usage(tmp_path, monkeypatch):
    stdout = "\n".join([
        json.dumps({"type": "turn.completed", "usage": {"input_tokens": 100, "output_tokens": 40}}),
        "non-json garbage line",
        json.dumps({"type": "turn.completed", "usage": {"input_tokens": 50, "output_tokens": 20}}),
        json.dumps({"type": "other.event", "usage": {"input_tokens": 999}}),
    ])
    monkeypatch.setattr("harness.adapters.codex.run_subprocess", lambda *a, **kw: _stub(stdout=stdout))
    spec = RunSpec(harness="codex", prompt="x", workdir=tmp_path, instructions="rules")
    result = CodexAdapter().run(spec)
    assert result.tokens_in == 150
    assert result.tokens_out == 60
    assert result.cost_usd is None
    assert (tmp_path / "AGENTS.md").read_text() == "rules"


def test_codex_handles_empty_stdout(tmp_path, monkeypatch):
    monkeypatch.setattr("harness.adapters.codex.run_subprocess", lambda *a, **kw: _stub())
    result = CodexAdapter().run(RunSpec(harness="codex", prompt="x", workdir=tmp_path))
    assert result.tokens_in is None
    assert result.tokens_out is None


# --- gemini ---------------------------------------------------------------


def test_gemini_parses_whole_stdout_json(tmp_path, monkeypatch):
    payload = {"stats": {"models": {"gemini-2.5-pro": {"tokens": {"input": 200, "candidates": 70}}}}}
    monkeypatch.setattr(
        "harness.adapters.gemini.run_subprocess", lambda *a, **kw: _stub(stdout=json.dumps(payload))
    )
    spec = RunSpec(harness="gemini", prompt="x", workdir=tmp_path, instructions="r")
    result = GeminiAdapter().run(spec)
    assert result.tokens_in == 200
    assert result.tokens_out == 70
    assert result.raw is not None
    assert (tmp_path / "GEMINI.md").read_text() == "r"


def test_gemini_falls_back_to_per_line_json(tmp_path, monkeypatch):
    embedded = json.dumps({"stats": {"models": {"x": {"tokens": {"input": 5, "candidates": 3}}}}})
    stdout = f"some preamble line\nbanner\n{embedded}\ntrailing junk"
    monkeypatch.setattr("harness.adapters.gemini.run_subprocess", lambda *a, **kw: _stub(stdout=stdout))
    result = GeminiAdapter().run(RunSpec(harness="gemini", prompt="x", workdir=tmp_path))
    assert result.tokens_in == 5
    assert result.tokens_out == 3


def test_gemini_no_stats_means_no_tokens(tmp_path, monkeypatch):
    monkeypatch.setattr(
        "harness.adapters.gemini.run_subprocess", lambda *a, **kw: _stub(stdout='{"foo":"bar"}')
    )
    result = GeminiAdapter().run(RunSpec(harness="gemini", prompt="x", workdir=tmp_path))
    assert result.tokens_in is None
    assert result.tokens_out is None


# --- aider ----------------------------------------------------------------


def test_aider_scrapes_token_summary(tmp_path, monkeypatch):
    stdout = "blah blah\nTokens: 12.4k sent, 850 received.\nDone."
    monkeypatch.setattr("harness.adapters.aider.run_subprocess", lambda *a, **kw: _stub(stdout=stdout))
    spec = RunSpec(harness="aider", prompt="x", workdir=tmp_path, instructions="cfg yaml")
    result = AiderAdapter().run(spec)
    assert result.tokens_in == 12400
    assert result.tokens_out == 850
    # aider config files written
    assert (tmp_path / ".agentelo-aider.yml").read_text().strip() == "{}"
    assert (tmp_path / ".aider.conf.yml").read_text() == "cfg yaml"


def test_aider_handles_thousands_separators(tmp_path, monkeypatch):
    stdout = "Tokens: 1,234 sent, 5,678 received."
    monkeypatch.setattr("harness.adapters.aider.run_subprocess", lambda *a, **kw: _stub(stdout=stdout))
    result = AiderAdapter().run(RunSpec(harness="aider", prompt="x", workdir=tmp_path))
    assert result.tokens_in == 1234
    assert result.tokens_out == 5678


def test_aider_no_token_line_returns_none(tmp_path, monkeypatch):
    monkeypatch.setattr("harness.adapters.aider.run_subprocess", lambda *a, **kw: _stub(stdout="no info"))
    result = AiderAdapter().run(RunSpec(harness="aider", prompt="x", workdir=tmp_path))
    assert result.tokens_in is None
    assert result.tokens_out is None


# --- swe-agent ------------------------------------------------------------


def test_swe_agent_requires_wrapper(tmp_path, monkeypatch):
    monkeypatch.setattr("harness.adapters.swe_agent.run_subprocess", lambda *a, **kw: _stub())
    monkeypatch.setattr("pathlib.Path.home", lambda: tmp_path / "fake-home")  # no agentelo wrapper here
    monkeypatch.delenv("SWE_WRAPPER", raising=False)
    spec = RunSpec(harness="swe-agent", prompt="x", workdir=tmp_path)
    with pytest.raises(HarnessError) as exc:
        SweAgentAdapter().run(spec)
    assert "wrapper not found" in str(exc.value)


def test_swe_agent_reads_trajectory(tmp_path, monkeypatch):
    wrapper = tmp_path / "wrapper.py"
    wrapper.write_text("# stub\n")

    def fake_run(cmd, **kw):
        # Simulate the wrapper writing a trajectory.
        traj = {
            "info": {"model_stats": {"instance_cost": 0.42}},
            "messages": [
                {"extra": {"response": {"usage": {"prompt_tokens": 100, "completion_tokens": 30}}}},
                {"extra": {"response": {"usage": {"input_tokens": 50, "output_tokens": 20}}}},
            ],
        }
        (tmp_path / ".harness").mkdir(exist_ok=True)
        (tmp_path / ".harness" / "swe-traj.json").write_text(json.dumps(traj))
        return _stub()

    monkeypatch.setattr("harness.adapters.swe_agent.run_subprocess", fake_run)
    spec = RunSpec(harness="swe-agent", prompt="x", workdir=tmp_path, env={"SWE_WRAPPER": str(wrapper)})
    result = SweAgentAdapter().run(spec)
    assert result.tokens_in == 150
    assert result.tokens_out == 50
    assert result.cost_usd == pytest.approx(0.42)


def test_swe_agent_folds_instructions_into_prompt(tmp_path, monkeypatch):
    wrapper = tmp_path / "wrapper.py"
    wrapper.write_text("")

    captured: dict = {}

    def fake_run(cmd, **kw):
        captured["cmd"] = cmd
        return _stub()

    monkeypatch.setattr("harness.adapters.swe_agent.run_subprocess", fake_run)
    spec = RunSpec(
        harness="swe-agent",
        prompt="fix the bug",
        workdir=tmp_path,
        instructions="be careful",
        env={"SWE_WRAPPER": str(wrapper)},
    )
    SweAgentAdapter().run(spec)

    task_idx = captured["cmd"].index("--task")
    task_value = captured["cmd"][task_idx + 1]
    assert "be careful" in task_value
    assert "fix the bug" in task_value
