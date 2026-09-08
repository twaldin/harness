"""opencode adapter — exercise the sqlite session-totals query against a fake DB."""
import json
import sqlite3

import pytest

from harness import RunSpec
from harness._subproc import SubprocOutcome
from harness.adapters.opencode import OpenCodeAdapter
from harness.pricing import derive_cost


def _stub(stdout="", stderr="", exit_code=0):
    return SubprocOutcome(exit_code=exit_code, duration_seconds=1.0, stdout=stdout, stderr=stderr, timed_out=False)


def _assistant(model, tokens_in, tokens_out, cost):
    """Assistant rows carry modelID/providerID; session.model is not relied on."""
    return json.dumps({
        "role": "assistant",
        "providerID": "openai",
        "modelID": model,
        "tokens": {"input": tokens_in, "output": tokens_out, "reasoning": 0, "cache": {"read": 0, "write": 0}},
        "cost": cost,
    })


def _user(model="gpt-5.4"):
    return json.dumps({"role": "user", "agent": "build", "model": {"providerID": "openai", "modelID": model}})


@pytest.fixture
def fake_opencode_db(tmp_path, monkeypatch):
    """Build a sqlite DB that mirrors opencode's session/message schema (packages/core/src/session/sql.ts)."""
    db_path = tmp_path / "opencode.db"
    conn = sqlite3.connect(db_path)
    conn.executescript("""
        CREATE TABLE session (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            parent_id TEXT,
            slug TEXT NOT NULL,
            directory TEXT NOT NULL,
            title TEXT NOT NULL,
            version TEXT NOT NULL,
            time_created INTEGER NOT NULL,
            time_updated INTEGER NOT NULL
        );
        CREATE TABLE message (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            time_created INTEGER NOT NULL,
            time_updated INTEGER NOT NULL,
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
        "INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated)"
        " VALUES (?, 'proj', NULL, ?, ?, ?, '1.14.46', ?, ?)",
        (session_id, session_id, directory, session_id, time_updated, time_updated),
    )
    for i, m in enumerate(messages):
        conn.execute(
            "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
            (f"{session_id}-msg{i}", session_id, time_updated + i, time_updated + i, m),
        )
    conn.commit()
    conn.close()


def _telemetry(db_path, workdir):
    return OpenCodeAdapter().parse_session_log(f"{db_path}#session({workdir.name})")


def test_opencode_sums_session_messages(tmp_path, monkeypatch, fake_opencode_db):
    workdir = tmp_path / "qs-pr335-abc"
    workdir.mkdir()

    _add_session(
        fake_opencode_db,
        "sess-1",
        directory=str(workdir),
        time_updated=100,
        messages=[
            _user(),
            _assistant("gpt-5.4", 1000, 300, 0.01),
            _assistant("gpt-5.4", 500, 150, 0.005),
        ],
    )

    monkeypatch.setattr("harness._subproc.run_subprocess", lambda *a, **kw: _stub())
    result = OpenCodeAdapter().run(RunSpec(harness="opencode", prompt="x", workdir=workdir))
    assert result.tokens_in == 1500
    assert result.tokens_out == 450
    assert result.cost_usd == pytest.approx(0.015)


def test_opencode_picks_most_recent_session_when_multiple_match(tmp_path, monkeypatch, fake_opencode_db):
    workdir = tmp_path / "qs-pr335-abc"
    workdir.mkdir()

    _add_session(fake_opencode_db, "old", str(workdir), time_updated=10,
                 messages=[_assistant("gpt-5.4", 99999, 99999, 99.0)])
    _add_session(fake_opencode_db, "new", str(workdir), time_updated=200,
                 messages=[_assistant("gpt-5.4", 42, 7, 0.001)])

    monkeypatch.setattr("harness._subproc.run_subprocess", lambda *a, **kw: _stub())
    result = OpenCodeAdapter().run(RunSpec(harness="opencode", prompt="x", workdir=workdir))
    assert result.tokens_in == 42
    assert result.tokens_out == 7


def test_opencode_reports_the_single_session_model_and_prices_zero_cost_with_it(tmp_path, fake_opencode_db):
    workdir = tmp_path / "qs-pr335-abc"
    workdir.mkdir()
    _add_session(fake_opencode_db, "s", str(workdir), time_updated=200,
                 messages=[_user("gpt-5.4-mini"), _assistant("gpt-5.4-mini", 1000, 100, 0)])

    telemetry = _telemetry(fake_opencode_db, workdir)
    assert telemetry.model == "gpt-5.4-mini"
    assert telemetry.cost_usd == pytest.approx(derive_cost("gpt-5.4-mini", 1000, 100))
    assert telemetry.cost_usd != derive_cost("gpt-5.4", 1000, 100)


@pytest.mark.parametrize("other_model", ["claude-sonnet-4-6", None])
def test_opencode_mixed_model_session_reports_no_model_and_no_estimate(tmp_path, fake_opencode_db, other_model):
    workdir = tmp_path / "qs-pr335-abc"
    workdir.mkdir()
    _add_session(fake_opencode_db, "s", str(workdir), time_updated=200,
                 messages=[_assistant("gpt-5.4-mini", 1000, 100, 0), _assistant(other_model, 10, 1, 0)])

    telemetry = _telemetry(fake_opencode_db, workdir)
    assert telemetry.model is None
    assert (telemetry.tokens_in, telemetry.tokens_out, telemetry.cost_usd) == (1010, 101, 0.0)


def test_opencode_returns_none_when_no_matching_session(tmp_path, monkeypatch, fake_opencode_db):
    workdir = tmp_path / "no-such-dir"
    workdir.mkdir()

    monkeypatch.setattr("harness._subproc.run_subprocess", lambda *a, **kw: _stub())
    result = OpenCodeAdapter().run(RunSpec(harness="opencode", prompt="x", workdir=workdir))
    assert result.tokens_in is None
    assert result.cost_usd is None


def test_opencode_returns_none_when_db_missing(tmp_path, monkeypatch):
    monkeypatch.setenv("OPENCODE_DB", str(tmp_path / "does-not-exist.db"))
    monkeypatch.setattr("harness._subproc.run_subprocess", lambda *a, **kw: _stub())
    result = OpenCodeAdapter().run(RunSpec(harness="opencode", prompt="x", workdir=tmp_path))
    assert result.tokens_in is None
