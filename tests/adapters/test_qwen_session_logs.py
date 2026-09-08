"""qwen interactive-session discovery and telemetry against the shared fixtures.

Consumes ``tests/fixtures/session-logs/qwen/discovery.json``;
``ts/tests/adapters/qwen-sessionlog.test.ts`` runs the same cases under Bun.
"""
from __future__ import annotations

import json
import os
import re
from pathlib import Path

import pytest

import harness.adapters  # noqa: F401
from harness.registry import get_adapter

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "session-logs" / "qwen"
FX = json.loads((FIXTURES / "discovery.json").read_text(encoding="utf-8"))
SESSIONS = FX["sessions"]
BASE_MTIME = 1_800_000_000.0
MTIME_OFFSETS = {"noUsage": 0, "main": 60, "unrelated": 120, "sidecar": 180}


def _install(runtime_dir: Path, workdir: Path) -> dict[str, Path]:
    """Lay the fixture out under `<runtime>/projects/<sanitizeCwd(root)>/chats`.

    mtimes are pinned so the unrelated session is the newest transcript, the
    sidecar newer still, and the no-usage session the oldest.
    """
    root = os.path.realpath(workdir)
    project = runtime_dir / "projects" / re.sub(r"[^a-zA-Z0-9]", "-", root)
    files: dict[str, Path] = {}
    for key, entry in [*SESSIONS.items(), ("sidecar", FX["sidecar"])]:
        target = project / entry["file"]
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text((FIXTURES / entry["file"]).read_text(encoding="utf-8").replace("__WORKDIR__", root), encoding="utf-8")
        stamp = BASE_MTIME + MTIME_OFFSETS[key]
        os.utime(target, (stamp, stamp))
        files[key] = target
    return files


def _assert_telemetry(telemetry, expected: dict) -> None:
    assert (telemetry.tokens_in, telemetry.tokens_out, telemetry.model) == (
        expected["tokensIn"],
        expected["tokensOut"],
        expected["model"],
    )
    if expected["costUsd"] is None:
        assert telemetry.cost_usd is None
    else:
        assert telemetry.cost_usd == pytest.approx(expected["costUsd"])


@pytest.fixture
def home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.delenv(FX["sourceQualification"]["homeEnv"], raising=False)
    monkeypatch.delenv(FX["sourceQualification"]["runtimeDirEnv"], raising=False)
    return home


@pytest.fixture
def workdir(tmp_path: Path) -> Path:
    workdir = tmp_path / "repo"
    workdir.mkdir()
    return workdir


def test_old_basename_layouts_are_not_sessions(home: Path, workdir: Path):
    for cli_dir in (".qwen", ".gemini"):
        legacy = home / cli_dir / "tmp" / workdir.name / "logs.json"
        legacy.parent.mkdir(parents=True)
        legacy.write_bytes((FIXTURES / FX["legacyLayout"]["file"]).read_bytes())
    assert get_adapter("qwen").session_log_path(workdir) is None


def test_project_session_wins_and_colliding_project_is_rejected(home: Path, workdir: Path):
    files = _install(home / ".qwen", workdir)
    adapter = get_adapter("qwen")
    assert adapter.session_log_path(workdir) == str(files["main"])

    telemetry = adapter.parse_session_log(str(files["main"]))
    _assert_telemetry(telemetry, SESSIONS["main"]["telemetry"])
    assert [record["uuid"] for record in telemetry.raw] == SESSIONS["main"]["recordUuids"]

    _assert_telemetry(adapter.parse_session_log(str(files["unrelated"])), SESSIONS["unrelated"]["telemetry"])


def test_cutoff_is_epoch_seconds_against_mtime(home: Path, workdir: Path):
    files = _install(home / ".qwen", workdir)
    adapter = get_adapter("qwen")
    assert adapter.session_log_path(workdir, BASE_MTIME + 30) == str(files["main"])
    assert adapter.session_log_path(workdir, BASE_MTIME + 61) is None


def test_missing_usage_stays_null(home: Path, workdir: Path):
    files = _install(home / ".qwen", workdir)
    telemetry = get_adapter("qwen").parse_session_log(str(files["noUsage"]))
    _assert_telemetry(telemetry, SESSIONS["noUsage"]["telemetry"])
    assert telemetry.raw[0]["sessionId"] == SESSIONS["noUsage"]["sessionId"]


def test_runtime_and_home_overrides_select_the_config_root(home: Path, workdir: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    adapter = get_adapter("qwen")
    files = _install(home / ".qwen", workdir)

    monkeypatch.setenv("QWEN_HOME", str(tmp_path / "qwen-home"))
    assert adapter.session_log_path(workdir) is None
    by_home = _install(tmp_path / "qwen-home", workdir)
    assert adapter.session_log_path(workdir) == str(by_home["main"])

    # A relative QWEN_RUNTIME_DIR resolves against the CLI cwd, i.e. the workdir.
    monkeypatch.setenv("QWEN_RUNTIME_DIR", ".qwen-runtime")
    assert adapter.session_log_path(workdir) is None
    by_runtime = _install(workdir / ".qwen-runtime", workdir)
    assert adapter.session_log_path(workdir) == str(by_runtime["main"])

    monkeypatch.delenv("QWEN_RUNTIME_DIR")
    monkeypatch.delenv("QWEN_HOME")
    assert adapter.session_log_path(workdir) == str(files["main"])
