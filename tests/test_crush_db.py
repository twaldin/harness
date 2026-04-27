"""crush adapter — sqlite parser tests against a fake DB."""
import sqlite3

from harness.adapters.crush import _read_crush_session_totals


def _init_db(path):
    conn = sqlite3.connect(path)
    conn.executescript(
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
        """
    )
    conn.commit()
    conn.close()


def _add_session(
    path,
    *,
    session_id,
    parent_session_id,
    prompt_tokens,
    completion_tokens,
    cost,
    updated_at,
    model=None,
):
    conn = sqlite3.connect(path)
    conn.execute(
        """
        INSERT INTO sessions (id, parent_session_id, prompt_tokens, completion_tokens, cost, model, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (session_id, parent_session_id, prompt_tokens, completion_tokens, cost, model, updated_at),
    )
    conn.commit()
    conn.close()


def test_crush_reads_latest_root_session(tmp_path):
    data_dir = tmp_path / "crush-data"
    data_dir.mkdir()
    db_path = data_dir / "crush.db"
    _init_db(db_path)

    _add_session(
        db_path,
        session_id="old-root",
        parent_session_id=None,
        prompt_tokens=100,
        completion_tokens=20,
        cost=0.01,
        updated_at=10,
    )
    _add_session(
        db_path,
        session_id="child",
        parent_session_id="old-root",
        prompt_tokens=99999,
        completion_tokens=99999,
        cost=99.0,
        updated_at=11,
    )
    _add_session(
        db_path,
        session_id="new-root",
        parent_session_id=None,
        prompt_tokens=42,
        completion_tokens=7,
        cost=0.001,
        updated_at=200,
    )

    workdir = tmp_path / "repo"
    workdir.mkdir()
    got = _read_crush_session_totals(workdir, {"CRUSH_DATA_DIR": str(data_dir)})
    assert got == (42, 7, 0.001, None)


def test_crush_returns_none_when_db_missing(tmp_path):
    workdir = tmp_path / "repo"
    workdir.mkdir()
    assert _read_crush_session_totals(workdir, {"CRUSH_DATA_DIR": str(tmp_path / "missing")}) == (None, None, None, None)
