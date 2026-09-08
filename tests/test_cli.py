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


def test_run_passes_policy_and_backend_defaults(monkeypatch, tmp_path: Path):
    captured = {}

    def fake_run(spec):
        captured["spec"] = spec
        raise SystemExit(0)

    monkeypatch.setattr("harness.cli.run", fake_run)
    runner.invoke(app, ["run", "hi", "--harness", "codex", "--workdir", str(tmp_path)])
    assert captured["spec"].backend == "cli"
    assert captured["spec"].permission_policy == "upstream"

    runner.invoke(app, ["run", "hi", "--harness", "codex", "--workdir", str(tmp_path), "--permission-policy", "bypass"])
    assert captured["spec"].permission_policy == "bypass"


def test_run_rejects_unsupported_backend_without_spawning(monkeypatch, tmp_path: Path):
    def boom(*_a, **_kw):
        raise AssertionError("must not spawn")

    monkeypatch.setattr("harness._subproc.run_subprocess", boom)
    result = runner.invoke(app, ["run", "hi", "--harness", "codex", "--workdir", str(tmp_path), "--backend", "rpc"])
    assert result.exit_code == 2
    assert "unsupported-backend" in result.output
    assert not (tmp_path / "AGENTS.md").exists()


def test_run_rejects_invalid_policy_string(tmp_path: Path):
    result = runner.invoke(app, ["run", "hi", "--harness", "codex", "--workdir", str(tmp_path), "--permission-policy", "yolo"])
    assert result.exit_code != 0
    assert "Invalid value for '--permission-policy'" in result.output
