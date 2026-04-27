"""opencode adapter — exercise the sqlite session-totals query against a fake DB."""
import sqlite3

import pytest

from harness import RunSpec
from harness._subproc import SubprocOutcome
from harness.adapters.opencode import OpenCodeAdapter


def _stub(stdout="", stderr="", exit_code=0):
    return SubprocOutcome(exit_code=exit_code, duration_seconds=1.0, stdout=stdout, stderr=stderr, timed_out=False)


@pytest.fixture
def fake_opencode_db(tmp_path, monkeypatch):
    """Build a sqlite DB that mirrors opencode's session/message schema."""
    db_path = tmp_path / "opencode.db"
    conn = sqlite3.connect(db_path)
    conn.executescript("""
        CREATE TABLE session (
            id TEXT PRIMARY KEY,
            directory TEXT NOT NULL,
            time_updated INTEGER NOT NULL,
            model TEXT
        );
        CREATE TABLE message (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            data TEXT NOT NULL
        );
    """)
    conn.commit()
    conn.close()
    monkeypatch.setenv("OPENCODE_DB", str(db_path))
    return db_path


def _add_session(db_path, session_id, directory, time_updated, messages):
    conn = sqlite3.connect(db_path)
    conn.execute(
        "INSERT INTO session (id, directory, time_updated) VALUES (?, ?, ?)",
        (session_id, directory, time_updated),
    )
    for i, m in enumerate(messages):
        conn.execute(
            "INSERT INTO message (id, session_id, data) VALUES (?, ?, ?)",
            (f"{session_id}-msg{i}", session_id, m),
        )
    conn.commit()
    conn.close()


def test_opencode_sums_session_messages(tmp_path, monkeypatch, fake_opencode_db):
    workdir = tmp_path / "qs-pr335-abc"
    workdir.mkdir()

    _add_session(
        fake_opencode_db,
        "sess-1",
        directory=str(workdir),
        time_updated=100,
        messages=[
            '{"tokens":{"input":1000,"output":300},"cost":0.01}',
            '{"tokens":{"input":500,"output":150},"cost":0.005}',
        ],
    )

    monkeypatch.setattr("harness.adapters.opencode.run_subprocess", lambda *a, **kw: _stub())
    result = OpenCodeAdapter().run(RunSpec(harness="opencode", prompt="x", workdir=workdir))
    assert result.tokens_in == 1500
    assert result.tokens_out == 450
    assert result.cost_usd == pytest.approx(0.015)


def test_opencode_picks_most_recent_session_when_multiple_match(tmp_path, monkeypatch, fake_opencode_db):
    workdir = tmp_path / "qs-pr335-abc"
    workdir.mkdir()

    _add_session(fake_opencode_db, "old", str(workdir), time_updated=10,
                 messages=['{"tokens":{"input":99999,"output":99999},"cost":99.0}'])
    _add_session(fake_opencode_db, "new", str(workdir), time_updated=200,
                 messages=['{"tokens":{"input":42,"output":7},"cost":0.001}'])

    monkeypatch.setattr("harness.adapters.opencode.run_subprocess", lambda *a, **kw: _stub())
    result = OpenCodeAdapter().run(RunSpec(harness="opencode", prompt="x", workdir=workdir))
    assert result.tokens_in == 42
    assert result.tokens_out == 7


def test_opencode_returns_none_when_no_matching_session(tmp_path, monkeypatch, fake_opencode_db):
    workdir = tmp_path / "no-such-dir"
    workdir.mkdir()

    monkeypatch.setattr("harness.adapters.opencode.run_subprocess", lambda *a, **kw: _stub())
    result = OpenCodeAdapter().run(RunSpec(harness="opencode", prompt="x", workdir=workdir))
    assert result.tokens_in is None
    assert result.cost_usd is None


def test_opencode_returns_none_when_db_missing(tmp_path, monkeypatch):
    monkeypatch.setenv("OPENCODE_DB", str(tmp_path / "does-not-exist.db"))
    monkeypatch.setattr("harness.adapters.opencode.run_subprocess", lambda *a, **kw: _stub())
    result = OpenCodeAdapter().run(RunSpec(harness="opencode", prompt="x", workdir=tmp_path))
    assert result.tokens_in is None
