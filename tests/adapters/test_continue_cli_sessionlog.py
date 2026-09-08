"""Continue CLI session discovery/telemetry against upstream
`<CONTINUE_GLOBAL_DIR or ~/.continue>/sessions/<uuid>.json`.
Consumes the same fixture as ts/tests/adapters/continue-cli-sessionlog.test.ts."""
from __future__ import annotations

import json
import os
import time
from pathlib import Path

import pytest

import harness.adapters  # noqa: F401
from harness.registry import get_adapter

SESSION_ID = "3b9e7d2c-5a1f-4e8b-9c6d-0f1a2b3c4d5e"
FIXTURE = json.loads(
    (Path(__file__).resolve().parents[1] / "fixtures" / "session-logs" / "continue" / f"{SESSION_ID}.json").read_text()
)


@pytest.fixture
def home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.delenv("CONTINUE_GLOBAL_DIR", raising=False)
    return home


@pytest.fixture
def workdir(tmp_path: Path) -> Path:
    workdir = tmp_path / "repo"
    workdir.mkdir()
    return workdir


@pytest.fixture
def sessions(home: Path) -> Path:
    sessions = home / ".continue" / "sessions"
    sessions.mkdir(parents=True)
    return sessions


def _write_session(directory: Path, workspace_directory: str, session_id: str = SESSION_ID, **overrides) -> Path:
    """Upstream keys sessions by `workspaceDirectory` (the cn process cwd), so the fixture is rewritten per test."""
    path = directory / f"{session_id}.json"
    path.write_text(json.dumps({**FIXTURE, "sessionId": session_id, "workspaceDirectory": workspace_directory, **overrides}))
    return path


def test_selects_newest_session_for_workspace_and_reads_native_usage(workdir: Path, sessions: Path):
    now = time.time()
    log = _write_session(sessions, str(workdir.resolve()))
    os.utime(log, (now - 60, now - 60))
    foreign = _write_session(sessions, "/somewhere/else", "00000000-0000-4000-8000-000000000000")
    os.utime(foreign, (now, now))
    (sessions / "sessions.json").write_text(json.dumps([{"sessionId": SESSION_ID, "title": "t", "dateCreated": "0", "workspaceDirectory": str(workdir.resolve())}]))

    a = get_adapter("continue-cli")
    assert a.session_log_path(workdir) == str(log)
    t = a.parse_session_log(str(log))
    assert (t.tokens_in, t.tokens_out, t.cost_usd, t.model) == (33, 9, 0.005, None)
    assert t.raw == FIXTURE["usage"]


def test_epoch_seconds_cutoff_filters_stale_sessions(workdir: Path, sessions: Path):
    now = time.time()
    log = _write_session(sessions, str(workdir.resolve()))
    os.utime(log, (now - 60, now - 60))
    a = get_adapter("continue-cli")
    assert a.session_log_path(workdir, session_started_after=now - 3600) == str(log)
    assert a.session_log_path(workdir, session_started_after=now - 1) is None


def test_does_not_guess_workspace_identity_by_case_folding(workdir: Path, sessions: Path):
    _write_session(sessions, str(workdir.resolve()).upper())
    assert get_adapter("continue-cli").session_log_path(workdir) is None


def test_continue_global_dir_relocates_sessions(home: Path, workdir: Path, sessions: Path, monkeypatch: pytest.MonkeyPatch):
    _write_session(sessions, str(workdir.resolve()))
    global_dir = home / "continue-global"
    monkeypatch.setenv("CONTINUE_GLOBAL_DIR", str(global_dir))
    a = get_adapter("continue-cli")
    assert a.session_log_path(workdir) is None
    (global_dir / "sessions").mkdir(parents=True)
    expected = _write_session(global_dir / "sessions", str(workdir.resolve()))
    assert a.session_log_path(workdir) == str(expected)


def test_sessions_without_usage_and_missing_files_report_null(workdir: Path, sessions: Path):
    without_usage = {k: v for k, v in FIXTURE.items() if k != "usage"}
    log = sessions / f"{SESSION_ID}.json"
    log.write_text(json.dumps({**without_usage, "workspaceDirectory": str(workdir.resolve())}))
    a = get_adapter("continue-cli")
    t = a.parse_session_log(str(log))
    assert (t.tokens_in, t.tokens_out, t.cost_usd, t.model, t.raw) == (None, None, None, None, None)
    assert a.parse_session_log(str(sessions / "missing.json")).raw is None
