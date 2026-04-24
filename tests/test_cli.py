"""CLI tests — list plus lightweight run wiring tests."""
from pathlib import Path

from typer.testing import CliRunner

from harness.cli import app

runner = CliRunner()


def test_list_includes_shipped_adapters():
    result = runner.invoke(app, ["list"])
    assert result.exit_code == 0
    assert "claude-code" in result.stdout
    assert "opencode" in result.stdout


def test_run_requires_arguments():
    result = runner.invoke(app, ["run"])
    assert result.exit_code != 0


def test_run_passes_model_no_resolve_flag(monkeypatch, tmp_path: Path):
    captured = {}

    class DummyResult:
        harness = "codex"
        model = "gpt-5.4"
        exit_code = 0
        duration_seconds = 0.1
        timed_out = False
        cost_usd = None
        tokens_in = None
        tokens_out = None
        stdout = ""
        stderr = ""
        ok = True

    def fake_run(spec):
        captured["spec"] = spec
        return DummyResult()

    monkeypatch.setattr("harness.cli.run", fake_run)
    result = runner.invoke(
        app,
        [
            "run",
            "write hi",
            "--harness",
            "codex",
            "--workdir",
            str(tmp_path),
            "--model",
            "openai/gpt-5.4",
            "--model-no-resolve",
            "--json",
        ],
    )

    assert result.exit_code == 0
    assert captured["spec"].model_no_resolve is True
    assert captured["spec"].model == "openai/gpt-5.4"
