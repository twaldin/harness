"""Factory Droid session discovery/telemetry against the qualified
`~/.factory/sessions/-<encoded cwd>/<uuid>.{jsonl,settings.json}` layout.
Consumes the same fixtures as ts/tests/adapters/factory-droid-sessionlog.test.ts."""
from __future__ import annotations

import json
import os
import shutil
import time
from pathlib import Path

import pytest

import harness.adapters  # noqa: F401
from harness.adapters.factory_droid import encode_project_dir
from harness.registry import get_adapter

SESSION_ID = "6f1c2e4a-8d3b-4c5e-9a7f-1b2c3d4e5f60"
FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "session-logs" / "factory"


@pytest.fixture
def home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.delenv("FACTORY_HOME_OVERRIDE", raising=False)
    return home


@pytest.fixture
def workdir(tmp_path: Path) -> Path:
    workdir = tmp_path / "my_repo"
    workdir.mkdir()
    return workdir


def _project_dir(home: Path, workdir: Path) -> Path:
    d = home / ".factory" / "sessions" / encode_project_dir(str(workdir.resolve()))
    d.mkdir(parents=True, exist_ok=True)
    return d


def _copy_session(directory: Path, workdir: Path, session_id: str = SESSION_ID, settings: bool = True) -> Path:
    log = directory / f"{session_id}.jsonl"
    log.write_text((FIXTURES / f"{SESSION_ID}.jsonl").read_text().replace("/workspace/repo", str(workdir.resolve())))
    if settings:
        shutil.copy(FIXTURES / f"{SESSION_ID}.settings.json", directory / f"{session_id}.settings.json")
    return log


def test_encode_project_dir_matches_droid():
    assert encode_project_dir("/Users/me/code/my_app/") == "-Users-me-code-my_app"


def test_finds_project_jsonl_and_reads_settings_usage(home: Path, workdir: Path):
    log = _copy_session(_project_dir(home, workdir), workdir)
    a = get_adapter("factory-droid")
    assert a.session_log_path(workdir) == str(log)
    t = a.parse_session_log(str(log))
    assert (t.tokens_in, t.tokens_out, t.cost_usd, t.model) == (210, 44, None, "claude-sonnet-4-5-20250929")
    assert t.raw == json.loads((FIXTURES / f"{SESSION_ID}.settings.json").read_text())


def test_ignores_other_projects_and_honors_epoch_seconds_cutoff(home: Path, workdir: Path):
    now = time.time()
    log = _copy_session(_project_dir(home, workdir), workdir)
    os.utime(log, (now - 60, now - 60))
    other_dir = home / ".factory" / "sessions" / "-Users-someone-else"
    other_dir.mkdir(parents=True)
    other = _copy_session(other_dir, home / "unrelated", "00000000-0000-4000-8000-000000000000")
    os.utime(other, (now, now))
    collision = _copy_session(log.parent, home / "unrelated", "33333333-3333-4333-8333-333333333333")
    os.utime(collision, (now, now))

    a = get_adapter("factory-droid")
    assert a.session_log_path(workdir) == str(log)
    assert a.session_log_path(workdir, session_started_after=now - 3600) == str(log)
    assert a.session_log_path(workdir, session_started_after=now - 1) is None


def test_factory_home_override_replaces_home(home: Path, workdir: Path, monkeypatch: pytest.MonkeyPatch):
    _copy_session(_project_dir(home, workdir), workdir)
    override = home / "override"
    monkeypatch.setenv("FACTORY_HOME_OVERRIDE", str(override))
    a = get_adapter("factory-droid")
    assert a.session_log_path(workdir) is None
    log = _copy_session(_project_dir(override, workdir), workdir)
    assert a.session_log_path(workdir) == str(log)


def test_legacy_flat_sessions_match_only_by_session_start_cwd(home: Path, workdir: Path):
    sessions = home / ".factory" / "sessions"
    sessions.mkdir(parents=True)
    mine = sessions / "11111111-1111-4111-8111-111111111111.jsonl"
    mine.write_text(json.dumps({"type": "session_start", "id": "1", "title": "t", "cwd": str(workdir.resolve())}) + "\n")
    theirs = sessions / "22222222-2222-4222-8222-222222222222.jsonl"
    theirs.write_text(json.dumps({"type": "session_start", "id": "2", "title": "t", "cwd": "/somewhere/else"}) + "\n")
    later = time.time() + 5
    os.utime(theirs, (later, later))
    assert get_adapter("factory-droid").session_log_path(workdir) == str(mine)


def test_missing_settings_falls_back_to_assistant_model_id(home: Path, workdir: Path):
    project_dir = _project_dir(home, workdir)
    log = _copy_session(project_dir, workdir, settings=False)
    a = get_adapter("factory-droid")
    t = a.parse_session_log(str(log))
    assert (t.tokens_in, t.tokens_out, t.cost_usd, t.model, t.raw) == (None, None, None, "claude-sonnet-4-5-20250929", None)
    missing = a.parse_session_log(str(project_dir / "nope.jsonl"))
    assert (missing.tokens_in, missing.model, missing.raw) == (None, None, None)
