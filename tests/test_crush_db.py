"""crush adapter — session correlation via the `--verbose` creation log and crush's sqlite schema."""
import sqlite3

import pytest

from harness import RunSpec
from harness._subproc import SubprocOutcome
from harness.adapters.crush import CrushAdapter

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

RUN_ID = "0f4e3c2a-9b1d-4c7e-8a6f-5d2b1c0e9a77"
OTHER_ID = "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"


def _stub(stdout="done", stderr="", exit_code=0):
    return SubprocOutcome(exit_code=exit_code, duration_seconds=1.0, stdout=stdout, stderr=stderr, timed_out=False)


def _created(session_id, *, styled=True):
    """charm log's text record for run.go's `Created session for non-interactive run`."""
    if styled:
        return f"\x1b[32mINFO\x1b[0m Created session for non-interactive run \x1b[2msession_id=\x1b[0m{session_id}\n"
    return f"INFO Created session for non-interactive run session_id={session_id}\n"


def _init_db(path, schema=_SCHEMA):
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.executescript(schema)
    conn.commit()
    conn.close()


def _add_session(path, *, session_id, parent_session_id, prompt_tokens, completion_tokens, cost, updated_at, models=(),
                 provider="openai"):
    conn = sqlite3.connect(path)
    conn.execute(
        "INSERT INTO sessions (id, parent_session_id, title, prompt_tokens, completion_tokens, cost, updated_at, created_at)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (session_id, parent_session_id, session_id, prompt_tokens, completion_tokens, cost, updated_at, updated_at),
    )
    for i, model in enumerate(models):
        conn.execute(
            "INSERT INTO messages (id, session_id, role, model, provider, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (f"{session_id}-u{i}", session_id, "user", model, provider, updated_at + i, updated_at + i),
        )
        conn.execute(
            "INSERT INTO messages (id, session_id, role, model, provider, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (f"{session_id}-a{i}", session_id, "assistant", model, provider, updated_at + i, updated_at + i),
        )
    conn.commit()
    conn.close()


@pytest.fixture
def workdir(tmp_path, monkeypatch):
    monkeypatch.delenv("CRUSH_DATA_DIR", raising=False)
    workdir = tmp_path / "repo"
    workdir.mkdir()
    return workdir


def _parse(workdir, stderr, env=None, stdout="done"):
    spec = RunSpec(harness="crush", prompt="x", workdir=workdir, env=dict(env or {}))
    return CrushAdapter().parse_output(spec, _stub(stdout=stdout, stderr=stderr))


def _telemetry(db_path, session_id):
    return CrushAdapter().parse_session_log(f"{db_path}#session={session_id}")


def test_crush_build_enables_verbose_logs_right_after_run(workdir):
    args = CrushAdapter().build_command(RunSpec(harness="crush", prompt="go", workdir=workdir)).args
    assert args[:4] == ["run", "--verbose", "--data-dir", str(workdir / ".harness" / "crush-data")]


def test_crush_reads_the_session_the_run_logged_as_created(workdir):
    db_path = workdir / ".harness" / "crush-data" / "crush.db"
    _init_db(db_path)
    _add_session(db_path, session_id=RUN_ID, parent_session_id=None, prompt_tokens=100, completion_tokens=20,
                 cost=0.01, updated_at=10, models=["gpt-5.4"])
    _add_session(db_path, session_id="child", parent_session_id=RUN_ID, prompt_tokens=99999,
                 completion_tokens=99999, cost=99.0, updated_at=11, models=["gpt-5.4"])
    # Newer root session: the old latest-root heuristic picked this one.
    _add_session(db_path, session_id=OTHER_ID, parent_session_id=None, prompt_tokens=42, completion_tokens=7,
                 cost=0.001, updated_at=200, models=["claude-sonnet-4-6", "claude-sonnet-4-6"])

    stderr = "\x1b[32mINFO\x1b[0m Running in non-interactive mode\n" + _created(RUN_ID) + "INFO some other session_id=zzz\n"
    assert _parse(workdir, stderr) == {
        "cost_usd": 0.01, "tokens_in": 100, "tokens_out": 20,
        "raw": {"sessionID": RUN_ID, "costSource": "reported"},
    }
    assert _telemetry(db_path, RUN_ID).model == "gpt-5.4"


@pytest.mark.parametrize(
    "stderr",
    [
        "",
        f"INFO Continuing session for non-interactive run session_id={RUN_ID}\n",
        f"session_id={RUN_ID}\n",  # bare key, not the creation record
        _created(RUN_ID) + _created(OTHER_ID, styled=False),
    ],
)
def test_crush_without_exactly_one_created_session_reports_nothing(workdir, stderr):
    db_path = workdir / ".harness" / "crush-data" / "crush.db"
    _init_db(db_path)
    _add_session(db_path, session_id=RUN_ID, parent_session_id=None, prompt_tokens=1, completion_tokens=1,
                 cost=0.1, updated_at=1, models=["gpt-5.4"])
    # The creation record lives on stderr only; stdout never identifies a session.
    assert _parse(workdir, stderr, stdout=_created(RUN_ID)) == {"cost_usd": None, "tokens_in": None, "tokens_out": None, "raw": None}


def test_crush_repeated_creation_record_for_the_same_session_is_fine(workdir):
    db_path = workdir / ".harness" / "crush-data" / "crush.db"
    _init_db(db_path)
    _add_session(db_path, session_id=RUN_ID, parent_session_id=None, prompt_tokens=1, completion_tokens=2,
                 cost=0.0, updated_at=1, models=["gpt-5.4"])
    result = _parse(workdir, _created(RUN_ID) + _created(RUN_ID, styled=False))
    assert result == {"cost_usd": 0.0, "tokens_in": 1, "tokens_out": 2, "raw": {"sessionID": RUN_ID, "costSource": "reported"}}


def test_crush_missing_db_or_session_keeps_identity_with_unavailable_cost(workdir):
    unavailable = {"cost_usd": None, "tokens_in": None, "tokens_out": None,
                   "raw": {"sessionID": RUN_ID, "costSource": "unavailable"}}
    assert _parse(workdir, _created(RUN_ID)) == unavailable
    db_path = workdir / ".harness" / "crush-data" / "crush.db"
    _init_db(db_path)
    _add_session(db_path, session_id=OTHER_ID, parent_session_id=None, prompt_tokens=1, completion_tokens=1,
                 cost=0.1, updated_at=1)
    assert _parse(workdir, _created(RUN_ID)) == unavailable


def test_crush_data_dir_override_resolves_against_the_workdir(workdir, tmp_path, monkeypatch):
    for data_dir in (tmp_path / "shared", workdir / "rel-data"):
        _init_db(data_dir / "crush.db")
        _add_session(data_dir / "crush.db", session_id=RUN_ID, parent_session_id=None,
                     prompt_tokens=len(data_dir.name), completion_tokens=1, cost=0.1, updated_at=1)

    assert _parse(workdir, _created(RUN_ID), {"CRUSH_DATA_DIR": str(tmp_path / "shared")})["tokens_in"] == 6
    assert _parse(workdir, _created(RUN_ID), {"CRUSH_DATA_DIR": "rel-data"})["tokens_in"] == 8
    bc = CrushAdapter().build_command(RunSpec(harness="crush", prompt="x", workdir=workdir, env={"CRUSH_DATA_DIR": "rel-data"}))
    assert bc.args[bc.args.index("--data-dir") + 1] == str(workdir / "rel-data")
    assert bc.directories == ()

    # An explicit empty caller value drops the inherited choice: back to the default.
    monkeypatch.setenv("CRUSH_DATA_DIR", str(tmp_path / "shared"))
    assert _parse(workdir, _created(RUN_ID))["tokens_in"] == 6
    assert _parse(workdir, _created(RUN_ID), {"CRUSH_DATA_DIR": ""})["tokens_in"] is None
    bc = CrushAdapter().build_command(RunSpec(harness="crush", prompt="x", workdir=workdir, env={"CRUSH_DATA_DIR": ""}))
    assert bc.directories == (workdir / ".harness" / "crush-data",)


def test_crush_totals_survive_missing_messages_table(workdir):
    db_path = workdir / "crush.db"
    _init_db(db_path, _SCHEMA.split("CREATE TABLE messages")[0])
    _add_session(db_path, session_id=RUN_ID, parent_session_id=None, prompt_tokens=42, completion_tokens=7,
                 cost=0.001, updated_at=200)
    telemetry = _telemetry(db_path, RUN_ID)
    assert (telemetry.tokens_in, telemetry.tokens_out, telemetry.cost_usd, telemetry.model) == (42, 7, 0.001, None)
    assert telemetry.raw == {"sessionID": RUN_ID, "costSource": "reported"}


@pytest.mark.parametrize(
    ("models", "providers"),
    [
        (["gpt-5.4-mini", "claude-sonnet-4-6"], ["openai", "openai"]),
        (["gpt-5.4-mini", None], ["openai", "openai"]),
        (["gpt-5.4-mini", "gpt-5.4-mini"], ["openai", "anthropic"]),
        (["gpt-5.4-mini", "gpt-5.4-mini"], ["openai", None]),
    ],
)
def test_crush_mixed_model_or_provider_reports_totals_without_a_model_or_estimate(workdir, models, providers):
    db_path = workdir / "crush.db"
    _init_db(db_path)
    _add_session(db_path, session_id=RUN_ID, parent_session_id=None, prompt_tokens=1000, completion_tokens=100,
                 cost=0.0, updated_at=200)
    conn = sqlite3.connect(db_path)
    for i, (model, provider) in enumerate(zip(models, providers)):
        conn.execute(
            "INSERT INTO messages (id, session_id, role, model, provider, created_at, updated_at) VALUES (?, ?, 'assistant', ?, ?, 1, 1)",
            (f"a{i}", RUN_ID, model, provider),
        )
    conn.commit()
    conn.close()

    telemetry = _telemetry(db_path, RUN_ID)
    assert telemetry.model is None
    assert (telemetry.tokens_in, telemetry.tokens_out, telemetry.cost_usd) == (1000, 100, 0.0)
    assert telemetry.raw == {"sessionID": RUN_ID, "costSource": "reported"}


def test_crush_invalid_counters_are_null_individually(workdir):
    db_path = workdir / "crush.db"
    _init_db(db_path, _SCHEMA.replace("INTEGER NOT NULL DEFAULT 0", "").replace("REAL NOT NULL DEFAULT 0.0", ""))
    conn = sqlite3.connect(db_path)
    conn.execute("INSERT INTO sessions (id, title, prompt_tokens, completion_tokens, cost, updated_at, created_at)"
                 " VALUES (?, 't', NULL, -5, 'free', 1, 1)", (RUN_ID,))
    conn.execute("INSERT INTO sessions (id, title, prompt_tokens, completion_tokens, cost, updated_at, created_at)"
                 " VALUES (?, 't', 12.0, 3, NULL, 1, 1)", (OTHER_ID,))
    conn.commit()
    conn.close()

    telemetry = _telemetry(db_path, RUN_ID)
    assert (telemetry.tokens_in, telemetry.tokens_out, telemetry.cost_usd) == (None, None, None)
    assert telemetry.raw == {"sessionID": RUN_ID, "costSource": "unavailable"}
    telemetry = _telemetry(db_path, OTHER_ID)
    assert (telemetry.tokens_in, telemetry.tokens_out, telemetry.cost_usd) == (12, 3, None)


def test_crush_session_log_path_is_never_invented(workdir):
    _init_db(workdir / ".harness" / "crush-data" / "crush.db")
    assert CrushAdapter().session_log_path(workdir) is None


def test_crush_legacy_selector_and_bare_db_yield_nothing(workdir):
    db_path = workdir / "crush.db"
    _init_db(db_path)
    _add_session(db_path, session_id=RUN_ID, parent_session_id=None, prompt_tokens=1, completion_tokens=1,
                 cost=0.1, updated_at=1)
    for path in (str(db_path), f"{db_path}#session(repo)", f"{db_path}#session="):
        telemetry = CrushAdapter().parse_session_log(path)
        assert (telemetry.tokens_in, telemetry.cost_usd, telemetry.model, telemetry.raw) == (None, None, None, None)
