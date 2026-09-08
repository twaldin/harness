"""gemini interactive-session discovery and telemetry against the shared fixtures.

Consumes ``tests/fixtures/session-logs/gemini/discovery.json``;
``ts/tests/adapters/gemini-sessionlog.test.ts`` runs the same cases under Bun.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path

import pytest

import harness.adapters  # noqa: F401
from harness.registry import get_adapter

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "session-logs" / "gemini"
FX = json.loads((FIXTURES / "discovery.json").read_text(encoding="utf-8"))
SESSIONS = FX["sessions"]
BASE_MTIME = 1_800_000_000.0
MTIME_OFFSETS = {"noUsage": 0, "main": 60, "unrelated": 120}


def _materialize(source: Path, target: Path, root: str) -> Path:
    text = source.read_text(encoding="utf-8")
    text = text.replace("__PROJECT_HASH__", hashlib.sha256(root.encode()).hexdigest()).replace("__WORKDIR__", root)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(text, encoding="utf-8")
    return target


def _install(gemini_dir: Path, workdir: Path, *, registry: bool = True, marker: bool = True, identifier: str | None = None) -> dict[str, Path]:
    """Lay the fixture out as gemini-cli would: registry, ownership marker and chats.

    mtimes are pinned so the unrelated session is the newest file on disk and
    the no-usage session is the oldest.
    """
    root = os.path.realpath(workdir)
    identifier = identifier or FX["registrySlug"]
    if registry:
        _materialize(FIXTURES / FX["registry"], gemini_dir / FX["registry"], root)
    project = gemini_dir / "tmp" / identifier
    if marker:
        project.mkdir(parents=True, exist_ok=True)
        (project / ".project_root").write_text(root, encoding="utf-8")
    files: dict[str, Path] = {}
    for key, session in SESSIONS.items():
        files[key] = _materialize(FIXTURES / session["file"], project / session["file"], root)
        stamp = BASE_MTIME + MTIME_OFFSETS[key]
        os.utime(files[key], (stamp, stamp))
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
    return home


@pytest.fixture
def workdir(tmp_path: Path) -> Path:
    workdir = tmp_path / "repo"
    workdir.mkdir()
    return workdir


def test_old_basename_layout_is_not_a_session(home: Path, workdir: Path):
    legacy = home / ".gemini" / "tmp" / workdir.name / "logs.json"
    legacy.parent.mkdir(parents=True)
    legacy.write_bytes((FIXTURES / FX["legacyLayout"]["file"]).read_bytes())
    assert get_adapter("gemini").session_log_path(workdir) is None


def test_registered_session_wins_and_unrelated_project_is_rejected(home: Path, workdir: Path):
    files = _install(home / ".gemini", workdir)
    adapter = get_adapter("gemini")
    assert adapter.session_log_path(workdir) == str(files["main"])

    telemetry = adapter.parse_session_log(str(files["main"]))
    _assert_telemetry(telemetry, SESSIONS["main"]["telemetry"])
    messages = telemetry.raw["messages"]
    assert [m["id"] for m in messages] == SESSIONS["main"]["messageIds"]
    assert messages[-1]["toolCalls"][0]["status"] == "success"
    assert telemetry.raw["lastUpdated"] == SESSIONS["main"]["lastUpdated"]

    _assert_telemetry(adapter.parse_session_log(str(files["unrelated"])), SESSIONS["unrelated"]["telemetry"])


def test_cutoff_is_epoch_seconds_against_mtime(home: Path, workdir: Path):
    files = _install(home / ".gemini", workdir)
    adapter = get_adapter("gemini")
    assert adapter.session_log_path(workdir, BASE_MTIME + 30) == str(files["main"])
    assert adapter.session_log_path(workdir, BASE_MTIME + 61) is None


def test_missing_usage_stays_null(home: Path, workdir: Path):
    files = _install(home / ".gemini", workdir)
    telemetry = get_adapter("gemini").parse_session_log(str(files["noUsage"]))
    _assert_telemetry(telemetry, SESSIONS["noUsage"]["telemetry"])
    assert telemetry.raw["sessionId"] == SESSIONS["noUsage"]["sessionId"]


def test_gemini_cli_home_selects_the_config_root(home: Path, workdir: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    adapter = get_adapter("gemini")
    files = _install(home / ".gemini", workdir)
    alt = tmp_path / "alt-home"
    monkeypatch.setenv("GEMINI_CLI_HOME", str(alt))
    assert adapter.session_log_path(workdir) is None

    alt_files = _install(alt / ".gemini", workdir)
    assert adapter.session_log_path(workdir) == str(alt_files["main"])
    monkeypatch.delenv("GEMINI_CLI_HOME")
    assert adapter.session_log_path(workdir) == str(files["main"])


def test_marker_and_hash_directories_resolve_without_registry(home: Path, workdir: Path, monkeypatch: pytest.MonkeyPatch):
    adapter = get_adapter("gemini")
    by_marker = _install(home / ".gemini", workdir, registry=False, identifier="repo-1")
    assert adapter.session_log_path(workdir) == str(by_marker["main"])

    hashed = hashlib.sha256(os.path.realpath(workdir).encode()).hexdigest()
    other_home = home / "pre-registry"
    by_hash = _install(other_home / ".gemini", workdir, registry=False, marker=False, identifier=hashed)
    monkeypatch.setenv("GEMINI_CLI_HOME", str(other_home))
    assert adapter.session_log_path(workdir) == str(by_hash["main"])
