"""kilo adapter — sqlite parser tests against a fake DB."""
import sqlite3

import pytest

from harness.adapters.kilo import _read_kilo_session_totals


def _init_db(path):
    conn = sqlite3.connect(path)
    conn.executescript(
        """
        CREATE TABLE session (
            id TEXT PRIMARY KEY,
            directory TEXT NOT NULL,
            time_updated INTEGER NOT NULL
        );
        CREATE TABLE message (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            data TEXT NOT NULL
        );
        """
    )
    conn.commit()
    conn.close()


def _add_session(path, session_id, directory, time_updated, messages):
    conn = sqlite3.connect(path)
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


def test_kilo_sums_assistant_rows_only(tmp_path):
    db_path = tmp_path / "kilo.db"
    _init_db(db_path)

    workdir = tmp_path / "proj-abc"
    workdir.mkdir()

    _add_session(
        db_path,
        "sess-1",
        str(workdir),
        100,
        messages=[
            '{"role":"assistant","tokens":{"input":100,"output":50},"cost":0.01}',
            '{"role":"assistant","tokens":{"input":25,"output":10},"cost":0.003}',
            '{"role":"user","tokens":{"input":99999,"output":99999},"cost":999}',
        ],
    )

    tokens_in, tokens_out, cost = _read_kilo_session_totals(workdir, {"KILO_DB": str(db_path)})
    assert tokens_in == 125
    assert tokens_out == 60
    assert cost == pytest.approx(0.013)


def test_kilo_prefers_most_recent_session(tmp_path):
    db_path = tmp_path / "kilo.db"
    _init_db(db_path)

    workdir = tmp_path / "proj-abc"
    workdir.mkdir()

    _add_session(
        db_path,
        "old",
        str(workdir),
        10,
        messages=['{"role":"assistant","tokens":{"input":999,"output":999},"cost":9.0}'],
    )
    _add_session(
        db_path,
        "new",
        str(workdir),
        200,
        messages=['{"role":"assistant","tokens":{"input":42,"output":7},"cost":0.001}'],
    )

    assert _read_kilo_session_totals(workdir, {"KILO_DB": str(db_path)}) == (42, 7, 0.001)


def test_kilo_returns_none_when_db_missing(tmp_path):
    workdir = tmp_path / "proj"
    workdir.mkdir()
    assert _read_kilo_session_totals(workdir, {"KILO_DB": str(tmp_path / "missing.db")}) == (None, None, None)
