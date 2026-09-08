"""crush adapter — sqlite parser tests against a DB shaped like crush's migrations."""
import sqlite3

import pytest

from harness.adapters.crush import CrushAdapter, _read_crush_session_totals
from harness.pricing import derive_cost

# internal/db/migrations/20250424200609_initial.sql (+ provider column, 20250627).
_SCHEMA = """
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    parent_session_id TEXT,
    title TEXT NOT NULL,
    message_count INTEGER NOT NULL DEFAULT 0,
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    cost REAL NOT NULL DEFAULT 0.0,
    updated_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    parts TEXT NOT NULL DEFAULT '[]',
    model TEXT,
    provider TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    finished_at INTEGER
);
"""


def _init_db(path, schema=_SCHEMA):
    conn = sqlite3.connect(path)
    conn.executescript(schema)
    conn.commit()
    conn.close()


def _add_session(path, *, session_id, parent_session_id, prompt_tokens, completion_tokens, cost, updated_at, models=()):
    conn = sqlite3.connect(path)
    conn.execute(
        "INSERT INTO sessions (id, parent_session_id, title, prompt_tokens, completion_tokens, cost, updated_at, created_at)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (session_id, parent_session_id, session_id, prompt_tokens, completion_tokens, cost, updated_at, updated_at),
    )
    for i, model in enumerate(models):
        conn.execute(
            "INSERT INTO messages (id, session_id, role, model, provider, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (f"{session_id}-u{i}", session_id, "user", model, "openai", updated_at + i, updated_at + i),
        )
        conn.execute(
            "INSERT INTO messages (id, session_id, role, model, provider, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (f"{session_id}-a{i}", session_id, "assistant", model, "openai", updated_at + i, updated_at + i),
        )
    conn.commit()
    conn.close()


def _data_dir(tmp_path):
    data_dir = tmp_path / "crush-data"
    data_dir.mkdir()
    return data_dir


def _telemetry(data_dir):
    return CrushAdapter().parse_session_log(f"{data_dir / 'crush.db'}#session(repo)")


def test_crush_reads_latest_root_session(tmp_path):
    data_dir = _data_dir(tmp_path)
    db_path = data_dir / "crush.db"
    _init_db(db_path)

    _add_session(db_path, session_id="old-root", parent_session_id=None, prompt_tokens=100, completion_tokens=20,
                 cost=0.01, updated_at=10, models=["gpt-5.4"])
    _add_session(db_path, session_id="child", parent_session_id="old-root", prompt_tokens=99999,
                 completion_tokens=99999, cost=99.0, updated_at=11, models=["gpt-5.4"])
    _add_session(db_path, session_id="new-root", parent_session_id=None, prompt_tokens=42, completion_tokens=7,
                 cost=0.001, updated_at=200, models=["claude-sonnet-4-6", "claude-sonnet-4-6"])

    workdir = tmp_path / "repo"
    workdir.mkdir()
    assert _read_crush_session_totals(workdir, {"CRUSH_DATA_DIR": str(data_dir)}) == (42, 7, 0.001, "claude-sonnet-4-6")


def test_crush_totals_survive_missing_messages_table(tmp_path):
    data_dir = _data_dir(tmp_path)
    db_path = data_dir / "crush.db"
    _init_db(db_path, _SCHEMA.split("CREATE TABLE messages")[0])
    _add_session(db_path, session_id="root", parent_session_id=None, prompt_tokens=42, completion_tokens=7,
                 cost=0.001, updated_at=200)

    workdir = tmp_path / "repo"
    workdir.mkdir()
    assert _read_crush_session_totals(workdir, {"CRUSH_DATA_DIR": str(data_dir)}) == (42, 7, 0.001, None)


@pytest.mark.parametrize("other_model", ["claude-sonnet-4-6", None])
def test_crush_mixed_model_session_reports_no_model_and_no_estimate(tmp_path, other_model):
    data_dir = _data_dir(tmp_path)
    db_path = data_dir / "crush.db"
    _init_db(db_path)
    _add_session(db_path, session_id="root", parent_session_id=None, prompt_tokens=1000, completion_tokens=100,
                 cost=0.0, updated_at=200, models=["gpt-5.4-mini", other_model])

    telemetry = _telemetry(data_dir)
    assert telemetry.model is None
    assert (telemetry.tokens_in, telemetry.tokens_out, telemetry.cost_usd) == (1000, 100, 0.0)


def test_crush_zero_cost_is_priced_with_the_session_model(tmp_path):
    data_dir = _data_dir(tmp_path)
    db_path = data_dir / "crush.db"
    _init_db(db_path)
    _add_session(db_path, session_id="root", parent_session_id=None, prompt_tokens=1000, completion_tokens=100,
                 cost=0.0, updated_at=200, models=["gpt-5.4-mini"])

    telemetry = _telemetry(data_dir)
    assert telemetry.model == "gpt-5.4-mini"
    assert telemetry.cost_usd == pytest.approx(derive_cost("gpt-5.4-mini", 1000, 100))
    assert telemetry.cost_usd != derive_cost("gpt-5.4", 1000, 100)


def test_crush_returns_none_when_db_missing(tmp_path):
    workdir = tmp_path / "repo"
    workdir.mkdir()
    assert _read_crush_session_totals(workdir, {"CRUSH_DATA_DIR": str(tmp_path / "missing")}) == (None, None, None, None)
