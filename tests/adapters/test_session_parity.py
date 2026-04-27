from __future__ import annotations

import json
import os
import shutil
import sqlite3
import subprocess
from pathlib import Path

import pytest

import harness.adapters  # noqa: F401
from harness.registry import get_adapter


def _ts_call(adapter: str, method: str, arg: str, env: dict[str, str]) -> object:
    proc = subprocess.run(
        ["bun", "ts/scripts/session-telemetry.ts", adapter, method, arg],
        cwd=Path(__file__).resolve().parents[2],
        env=env,
        capture_output=True,
        text=True,
        check=True,
    )
    return json.loads(proc.stdout.strip())


def _py_telemetry_dict(obj) -> dict[str, object]:
    return {
        "sessionLogPath": obj.session_log_path,
        "tokensIn": obj.tokens_in,
        "tokensOut": obj.tokens_out,
        "costUsd": obj.cost_usd,
        "model": obj.model,
        "raw": obj.raw,
    }


def _setup_home_fixture(tmp_path: Path, adapter: str) -> tuple[Path, Path]:
    home = tmp_path / "home"
    workdir = tmp_path / "repo"
    home.mkdir(parents=True, exist_ok=True)
    workdir.mkdir(parents=True, exist_ok=True)
    fixtures = Path(__file__).resolve().parents[1] / "fixtures" / "session-logs"

    if adapter == "continue-cli":
        d = home / ".continue" / "sessions" / workdir.name
        d.mkdir(parents=True, exist_ok=True)
        shutil.copy(fixtures / "continue" / "session.json", d / "session.json")
    elif adapter == "factory-droid":
        d = home / ".factory" / "sessions" / workdir.name
        d.mkdir(parents=True, exist_ok=True)
        shutil.copy(fixtures / "factory" / "session.json", d / "session.json")
    elif adapter == "qwen":
        d = home / ".qwen" / "tmp" / workdir.name
        d.mkdir(parents=True, exist_ok=True)
        shutil.copy(fixtures / "qwen" / "logs.json", d / "logs.json")
    elif adapter in {"openclaude", "claude-code"}:
        encoded = str(workdir).replace("/", "-").replace("_", "-")
        d = home / ".claude" / "projects" / encoded
        d.mkdir(parents=True, exist_ok=True)
        src = fixtures / ("openclaude" if adapter == "openclaude" else "claude-code") / "session.jsonl"
        shutil.copy(src, d / "session.jsonl")
    return home, workdir


def _setup_sqlite_fixture(tmp_path: Path, adapter: str) -> Path:
    workdir = tmp_path / "repo"
    workdir.mkdir(parents=True, exist_ok=True)

    if adapter == "crush":
        d = workdir / ".harness" / "crush-data"
        d.mkdir(parents=True, exist_ok=True)
        db = sqlite3.connect(d / "crush.db")
        db.executescript(
            """
            CREATE TABLE sessions (
                id TEXT PRIMARY KEY,
                parent_session_id TEXT,
                prompt_tokens INTEGER,
                completion_tokens INTEGER,
                cost REAL,
                model TEXT,
                updated_at INTEGER
            );
            INSERT INTO sessions (id, parent_session_id, prompt_tokens, completion_tokens, cost, model, updated_at)
            VALUES ('s1', NULL, 70, 11, 0.004, 'gpt-5.4', 1);
            """
        )
        db.commit()
        db.close()
    elif adapter == "kilo":
        d = workdir / ".harness" / "kilo"
        d.mkdir(parents=True, exist_ok=True)
        db = sqlite3.connect(d / "kilo.db")
        db.executescript(
            """
            CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT NOT NULL, time_updated INTEGER NOT NULL);
            CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, data TEXT NOT NULL);
            INSERT INTO session (id, directory, time_updated) VALUES ('s1', '/tmp/repo', 1);
            INSERT INTO message (id, session_id, data)
            VALUES ('m1', 's1', '{"role":"assistant","tokens":{"input":90,"output":30},"cost":0.004}');
            """
        )
        db.commit()
        db.close()
    return workdir


@pytest.mark.parametrize("adapter", ["continue-cli", "factory-droid", "qwen", "openclaude", "claude-code"])
def test_session_log_path_and_parse_parity_home(adapter: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    if shutil.which("bun") is None:
        pytest.skip("bun not available")

    home, workdir = _setup_home_fixture(tmp_path, adapter)
    monkeypatch.setenv("HOME", str(home))

    env = os.environ.copy()
    env["HOME"] = str(home)

    py_adapter = get_adapter(adapter)
    py_path = py_adapter.session_log_path(workdir)
    ts_path = _ts_call(adapter, "sessionLogPath", str(workdir), env)
    assert py_path == ts_path

    py_parsed = _py_telemetry_dict(py_adapter.parse_session_log(py_path))
    ts_parsed = _ts_call(adapter, "parseSessionLog", py_path, env)
    assert py_parsed == ts_parsed


@pytest.mark.parametrize("adapter", ["crush", "kilo"])
def test_session_log_path_and_parse_parity_sqlite(adapter: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    if shutil.which("bun") is None:
        pytest.skip("bun not available")

    workdir = _setup_sqlite_fixture(tmp_path, adapter)
    home = tmp_path / "home"
    home.mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("HOME", str(home))

    env = os.environ.copy()
    env["HOME"] = str(home)

    py_adapter = get_adapter(adapter)
    py_path = py_adapter.session_log_path(workdir)
    ts_path = _ts_call(adapter, "sessionLogPath", str(workdir), env)
    assert py_path == ts_path

    py_parsed = _py_telemetry_dict(py_adapter.parse_session_log(py_path))
    ts_parsed = _ts_call(adapter, "parseSessionLog", py_path, env)
    assert py_parsed == ts_parsed
