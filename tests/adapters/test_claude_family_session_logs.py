"""Claude Code / OpenClaude transcript discovery against the shared session-log fixtures.

Consumes ``tests/fixtures/session-logs/{claude-code,openclaude}/discovery.json``;
``ts/tests/adapters/*-sessionlog.test.ts`` run the same cases under Bun.
"""
from __future__ import annotations

import json
import os
import shutil
import time
from pathlib import Path

import pytest

import harness.adapters  # noqa: F401
from harness.adapters.claude_code import PROJECT_DIR_NAME_LIMIT, canonical_project_path, encode_project_path
from harness.registry import get_adapter

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "session-logs"
ADAPTERS = ("claude-code", "openclaude")


def _fixture(adapter: str) -> dict:
    return json.loads((FIXTURES / adapter / "discovery.json").read_text(encoding="utf-8"))


def _place(projects: Path, dirname: str, transcript: Path, workdir: Path, name: str = "session.jsonl", mtime: float | None = None) -> str:
    d = projects / dirname
    d.mkdir(parents=True, exist_ok=True)
    dst = d / name
    text = transcript.read_text(encoding="utf-8").replace("/Users/dev/repo.space_underé", canonical_project_path(workdir))
    dst.write_text(text, encoding="utf-8")
    if mtime is not None:
        os.utime(dst, (mtime, mtime))
    return str(dst)


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
    for var in ("CLAUDE_CONFIG_DIR", "OPENCLAUDE_CONFIG_DIR"):
        monkeypatch.delenv(var, raising=False)
    return home


def test_project_path_encoding_matches_upstream_table():
    for case in _fixture("claude-code")["encoding"]:
        assert encode_project_path(case["projectPath"]) == case["encoded"], case["note"]


def test_installed_capture_layout_and_telemetry():
    fx = _fixture("claude-code")
    capture = fx["installedCapture"]
    workdir = f"{capture['privatePathPlaceholder']}/{capture['workdirName']}"
    assert encode_project_path(workdir) == capture["projectDirName"]
    telemetry = get_adapter("claude-code").parse_session_log(str(FIXTURES / "claude-code" / capture["transcript"]))
    _assert_telemetry(telemetry, capture["telemetry"])


@pytest.mark.parametrize("adapter", ADAPTERS)
def test_current_layout_found_and_legacy_layout_ignored(adapter: str, home: Path, tmp_path: Path):
    fx = _fixture(adapter)
    source = fx["sourceQualification"]
    projects = home / source["configDirDefault"] / source["projectsSubdir"]
    workdir = tmp_path / fx["legacyLayout"]["workdirName"]
    workdir.mkdir()
    real = canonical_project_path(workdir)
    transcript = FIXTURES / adapter / fx["transcript"]

    legacy = real.replace("/", "-").replace("_", "-")
    assert legacy != encode_project_path(real)
    _place(projects, legacy, transcript, workdir)
    assert get_adapter(adapter).session_log_path(workdir) is None

    expected = _place(projects, encode_project_path(real), transcript, workdir)
    assert get_adapter(adapter).session_log_path(workdir) == expected
    _assert_telemetry(get_adapter(adapter).parse_session_log(expected), fx["telemetry"])


@pytest.mark.parametrize("adapter", ADAPTERS)
def test_config_root_env_replaces_default_and_foreign_roots_are_ignored(
    adapter: str, home: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    fx = _fixture(adapter)
    source = fx["sourceQualification"]
    workdir = tmp_path / "repo"
    workdir.mkdir()
    encoded = encode_project_path(canonical_project_path(workdir))
    transcript = FIXTURES / adapter / fx["transcript"]

    for foreign in source["foreignConfigDirDefaults"]:
        _place(home / foreign / source["projectsSubdir"], encoded, transcript, workdir)
    foreign_root = tmp_path / "foreign-config"
    _place(foreign_root / source["projectsSubdir"], encoded, transcript, workdir)
    for var in source["foreignConfigDirEnvs"]:
        monkeypatch.setenv(var, str(foreign_root))
    assert get_adapter(adapter).session_log_path(workdir) is None

    default_path = _place(home / source["configDirDefault"] / source["projectsSubdir"], encoded, transcript, workdir)
    assert get_adapter(adapter).session_log_path(workdir) == default_path

    override_root = tmp_path / "override-config"
    override_path = _place(override_root / source["projectsSubdir"], encoded, transcript, workdir)
    monkeypatch.setenv(source["configDirEnv"], str(override_root))
    assert get_adapter(adapter).session_log_path(workdir) == override_path

    monkeypatch.chdir(override_root)
    monkeypatch.setenv(source["configDirEnv"], "")
    assert get_adapter(adapter).session_log_path(workdir) == (override_path if adapter == "claude-code" else default_path)


@pytest.mark.parametrize("adapter", ADAPTERS)
def test_cutoff_filters_stale_logs_instead_of_falling_back(adapter: str, home: Path, tmp_path: Path):
    fx = _fixture(adapter)
    source = fx["sourceQualification"]
    projects = home / source["configDirDefault"] / source["projectsSubdir"]
    workdir = tmp_path / "repo"
    workdir.mkdir()
    encoded = encode_project_path(canonical_project_path(workdir))
    transcript = FIXTURES / adapter / fx["transcript"]
    now = time.time()

    stale = _place(projects, encoded, transcript, workdir, name="stale.jsonl", mtime=now - 1000)
    a = get_adapter(adapter)
    assert a.session_log_path(workdir) == stale
    assert a.session_log_path(workdir, session_started_after=now - 100) is None

    fresh = _place(projects, encoded, transcript, workdir, name="fresh.jsonl", mtime=now - 10)
    assert a.session_log_path(workdir) == fresh
    assert a.session_log_path(workdir, session_started_after=now - 100) == fresh
    assert a.session_log_path(workdir, session_started_after=now - 10) == fresh
    assert a.session_log_path(workdir, session_started_after=now + 100) is None


@pytest.mark.parametrize("adapter", ADAPTERS)
def test_symlinked_and_nfd_workdirs_resolve_to_canonical_project(adapter: str, home: Path, tmp_path: Path):
    fx = _fixture(adapter)
    source = fx["sourceQualification"]
    projects = home / source["configDirDefault"] / source["projectsSubdir"]
    transcript = FIXTURES / adapter / fx["transcript"]
    a = get_adapter(adapter)

    real = tmp_path / "real cafe\u0301"
    workdir = real
    real.mkdir()
    link = tmp_path / "link"
    link.symlink_to(real, target_is_directory=True)
    canonical = canonical_project_path(link)
    assert canonical == canonical_project_path(real)
    assert canonical.endswith("caf\u00e9")

    _place(projects, encode_project_path(str(link)), transcript, workdir)
    assert a.session_log_path(link) is None
    expected = _place(projects, encode_project_path(canonical), transcript, workdir)
    assert a.session_log_path(link) == expected


@pytest.mark.parametrize("adapter", ADAPTERS)
def test_long_paths_use_hash_suffix_and_accept_prefix_siblings(adapter: str, home: Path, tmp_path: Path):
    fx = _fixture(adapter)
    source = fx["sourceQualification"]
    projects = home / source["configDirDefault"] / source["projectsSubdir"]
    transcript = FIXTURES / adapter / fx["transcript"]
    workdir = tmp_path / ("d" * (PROJECT_DIR_NAME_LIMIT + 20))
    workdir.mkdir()
    encoded = encode_project_path(canonical_project_path(workdir))
    assert len(encoded) > PROJECT_DIR_NAME_LIMIT + 1
    prefix = encoded[:PROJECT_DIR_NAME_LIMIT] + "-"
    now = time.time()
    a = get_adapter(adapter)

    sibling = _place(projects, prefix + "otherhash", transcript, workdir, mtime=now - 50)
    assert a.session_log_path(workdir) == sibling
    _place(projects, encoded[:PROJECT_DIR_NAME_LIMIT] + "x-unrelated", transcript, workdir, mtime=now - 1)
    assert a.session_log_path(workdir) == sibling
    _place(projects, prefix + "foreignhash", transcript, tmp_path / "unrelated", mtime=now - 1)
    assert a.session_log_path(workdir) == sibling
    exact = _place(projects, encoded, transcript, workdir, mtime=now - 20)
    assert a.session_log_path(workdir) == exact


def test_gateway_model_cost_stays_null():
    fx = _fixture("openclaude")
    telemetry = get_adapter("openclaude").parse_session_log(str(FIXTURES / "openclaude" / fx["gatewayTranscript"]))
    _assert_telemetry(telemetry, fx["gatewayTelemetry"])
