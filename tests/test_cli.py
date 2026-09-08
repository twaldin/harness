"""CLI tests — observable command selection, execution JSON and validation."""
import json
import os
from pathlib import Path

import pytest
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


@pytest.mark.parametrize("policy", ["upstream", "bypass", "yolo"])
def test_run_json_exposes_execution_and_cli_choices(monkeypatch, tmp_path: Path, policy: str):
    binary = tmp_path / "codex"
    binary.write_text('#!/bin/sh\ntouch invoked\ncp AGENTS.md observed-instructions\nprintf "%s\\n" "$@"\nexit 7\n')
    binary.chmod(0o755)
    monkeypatch.setenv("PATH", f"{tmp_path}{os.pathsep}{os.environ.get('PATH', '')}")
    instructions = tmp_path / "instructions.txt"
    instructions.write_text("Use the supplied project instructions.")
    result = runner.invoke(app, [
        "run", "write hi", "--harness", "codex", "--workdir", str(tmp_path),
        "--model", "openai/gpt-5.4", "--model-no-resolve",
        "--permission-policy", policy, "--instructions", str(instructions), "--json",
    ])
    if policy == "yolo":
        assert result.exit_code == 2
        assert not (tmp_path / "invoked").exists()
        assert not (tmp_path / "AGENTS.md").exists()
        return
    assert (tmp_path / "invoked").exists()
    assert (tmp_path / "observed-instructions").read_text() == instructions.read_text()
    assert result.exit_code == 1
    payload = json.loads(result.stdout[result.stdout.index("{"):])
    args = payload["stdout"].splitlines()
    assert args[args.index("-m") + 1] == "openai/gpt-5.4"
    assert ("--dangerously-bypass-approvals-and-sandbox" in args) == (policy == "bypass")
    assert payload["exit_code"] == 7
    assert payload["termination"] == "exited"
    assert payload["timed_out"] is False


def test_run_rejects_unsupported_backend_without_spawning(monkeypatch, tmp_path: Path):
    def boom(*_a, **_kw):
        raise AssertionError("must not spawn")

    monkeypatch.setattr("harness._subproc.run_subprocess", boom)
    result = runner.invoke(app, ["run", "hi", "--harness", "codex", "--workdir", str(tmp_path), "--backend", "rpc"])
    assert result.exit_code == 2
    assert "unsupported-backend" in result.output
    assert not (tmp_path / "AGENTS.md").exists()
