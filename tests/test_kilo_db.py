"""kilo adapter — sqlite parser tests against a DB shaped like kilo's session/message tables."""
import json
import sqlite3

import pytest

from harness.adapters.kilo import KiloAdapter, _read_kilo_session_totals
from harness.pricing import derive_cost


def _init_db(path):
    conn = sqlite3.connect(path)
    conn.executescript(
        """
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
        """
    )
    conn.commit()
    conn.close()


def _assistant(model, tokens_in, tokens_out, cost):
    """Assistant rows carry modelID/providerID; user rows carry a `model` object instead."""
    return json.dumps({
        "role": "assistant",
        "providerID": "openai",
        "modelID": model,
        "tokens": {"input": tokens_in, "output": tokens_out, "reasoning": 0, "cache": {"read": 0, "write": 0}},
        "cost": cost,
    })


def _user(model="gpt-5.4"):
    return json.dumps({"role": "user", "agent": "build", "model": {"providerID": "openai", "modelID": model}})


def _add_session(path, session_id, directory, time_updated, messages):
    conn = sqlite3.connect(path)
    conn.execute(
        "INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated)"
        " VALUES (?, 'proj', NULL, ?, ?, ?, '7.2.24', ?, ?)",
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
    return KiloAdapter().parse_session_log(f"{db_path}#session({workdir.name})")


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
            _user(),
            _assistant("gpt-5.4", 100, 50, 0.01),
            _assistant("gpt-5.4", 25, 10, 0.003),
            '{"role":"user","tokens":{"input":99999,"output":99999},"cost":999}',
        ],
    )

    tokens_in, tokens_out, cost, model = _read_kilo_session_totals(workdir, {"KILO_DB": str(db_path)})
    assert tokens_in == 125
    assert tokens_out == 60
    assert cost == pytest.approx(0.013)
    assert model == "gpt-5.4"


def test_kilo_prefers_most_recent_session(tmp_path):
    db_path = tmp_path / "kilo.db"
    _init_db(db_path)

    workdir = tmp_path / "proj-abc"
    workdir.mkdir()

    _add_session(db_path, "old", str(workdir), 10, messages=[_assistant("gpt-5.4", 999, 999, 9.0)])
    _add_session(db_path, "new", str(workdir), 200, messages=[_assistant("gpt-5.4-mini-fast", 42, 7, 0.001)])

    assert _read_kilo_session_totals(workdir, {"KILO_DB": str(db_path)}) == (42, 7, 0.001, "gpt-5.4-mini-fast")


def test_kilo_zero_cost_is_priced_with_the_session_model(tmp_path):
    db_path = tmp_path / "kilo.db"
    _init_db(db_path)
    workdir = tmp_path / "proj-abc"
    workdir.mkdir()
    _add_session(db_path, "s", str(workdir), 200, messages=[_user(), _assistant("gpt-5.4-mini", 1000, 100, 0)])

    telemetry = _telemetry(db_path, workdir)
    assert telemetry.model == "gpt-5.4-mini"
    assert telemetry.cost_usd == pytest.approx(derive_cost("gpt-5.4-mini", 1000, 100))
    assert telemetry.cost_usd != derive_cost("gpt-5.4", 1000, 100)


@pytest.mark.parametrize("other_model", ["claude-sonnet-4-6", None])
def test_kilo_mixed_model_session_reports_no_model_and_no_estimate(tmp_path, other_model):
    db_path = tmp_path / "kilo.db"
    _init_db(db_path)
    workdir = tmp_path / "proj-abc"
    workdir.mkdir()
    _add_session(
        db_path, "s", str(workdir), 200,
        messages=[_assistant("gpt-5.4-mini", 1000, 100, 0), _assistant(other_model, 10, 1, 0)],
    )

    telemetry = _telemetry(db_path, workdir)
    assert telemetry.model is None
    assert (telemetry.tokens_in, telemetry.tokens_out, telemetry.cost_usd) == (1010, 101, 0.0)


def test_kilo_returns_none_when_db_missing(tmp_path):
    workdir = tmp_path / "proj"
    workdir.mkdir()
    assert _read_kilo_session_totals(workdir, {"KILO_DB": str(tmp_path / "missing.db")}) == (None, None, None, None)
