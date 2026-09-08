"""opencode adapter — native session correlation against a fake sqlite DB.

`opencode run --format json` reports the run's `sessionID` on every event; the
adapter reads exactly that session's assistant rows. These tests pin the
correlation, the DB resolution rules and the null/zero accounting semantics.
"""
import json
import sqlite3
from urllib.parse import quote

import pytest

from harness import RunSpec
from harness._subproc import SubprocOutcome
from harness.adapters.opencode import OpenCodeAdapter

SCHEMA = """
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


def _stub(stdout="", stderr="", exit_code=0):
    return SubprocOutcome(exit_code=exit_code, duration_seconds=1.0, stdout=stdout, stderr=stderr, timed_out=False)


def _events(*session_ids, kind="step_finish"):
    """`--format json` stdout: one envelope per ID, interleaved with plain text."""
    lines = ["opencode banner"]
    for session_id in session_ids:
        lines.append(json.dumps({"type": kind, "timestamp": 1, "sessionID": session_id, "part": {"sessionID": session_id}}))
    return "\n".join(lines) + "\n"


def _assistant(model, tokens_in, tokens_out, cost, provider="openai"):
    """Assistant rows carry modelID/providerID; session.model is not relied on."""
    return json.dumps({
        "role": "assistant",
        "providerID": provider,
        "modelID": model,
        "tokens": {"input": tokens_in, "output": tokens_out, "reasoning": 0, "cache": {"read": 0, "write": 0}},
        "cost": cost,
    })


def _user(model="gpt-5.4"):
    return json.dumps({"role": "user", "agent": "build", "model": {"providerID": "openai", "modelID": model}})


def _init_db(db_path):
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.executescript(SCHEMA)
    conn.commit()
    conn.close()


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


@pytest.fixture
def fake_opencode_db(tmp_path, monkeypatch):
    """An explicit `OPENCODE_DB` mirroring opencode's session/message schema."""
    db_path = tmp_path / "opencode.db"
    _init_db(db_path)
    monkeypatch.setenv("OPENCODE_DB", str(db_path))
    return db_path


@pytest.fixture
def data_dir(tmp_path, monkeypatch):
    """No `OPENCODE_DB`: the run's DB is discovered under `Global.Path.data`."""
    monkeypatch.delenv("OPENCODE_DB", raising=False)
    monkeypatch.delenv("OPENCODE_DISABLE_CHANNEL_DB", raising=False)
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path / "xdg"))
    return tmp_path / "xdg" / "opencode"


def _parse(workdir, stdout, env=None):
    return OpenCodeAdapter().parse_output(RunSpec(harness="opencode", prompt="x", workdir=workdir, env=dict(env or {})), _stub(stdout))


def _telemetry(db_path, session_id):
    return OpenCodeAdapter().parse_session_log(f"{db_path}#session={quote(session_id, safe='')}")


NULL = {"cost_usd": None, "tokens_in": None, "tokens_out": None, "raw": None}


def test_opencode_run_reports_the_exact_session_the_output_named(tmp_path, monkeypatch, fake_opencode_db):
    workdir = tmp_path / "qs-pr335-abc"
    workdir.mkdir()
    _add_session(fake_opencode_db, "ses_run", str(workdir), time_updated=100,
                 messages=[_user(), _assistant("gpt-5.4", 1000, 300, 0.01), _assistant("gpt-5.4", 500, 150, 0.005)])
    # Newer and fatter session in the same directory: the old latest/basename
    # heuristics picked this one; exact-ID correlation must not.
    _add_session(fake_opencode_db, "ses_other", str(workdir), time_updated=200,
                 messages=[_assistant("gpt-5.4", 99999, 99999, 99.0)])

    monkeypatch.setattr("harness._subproc.run_subprocess", lambda *a, **kw: _stub(_events("ses_run", "ses_run", kind="text")))
    result = OpenCodeAdapter().run(RunSpec(harness="opencode", prompt="x", workdir=workdir))
    assert (result.tokens_in, result.tokens_out) == (1500, 450)
    assert result.cost_usd == pytest.approx(0.015)
    assert result.raw == {"sessionID": "ses_run", "costSource": "reported"}


def test_opencode_build_requests_json_events(tmp_path):
    args = OpenCodeAdapter().build_command(RunSpec(harness="opencode", prompt="go", workdir=tmp_path)).args
    assert args[:3] == ["run", "--format", "json"]


@pytest.mark.parametrize(
    "stdout",
    [
        "done",
        '{"type":"text","sessionID":""}\n',
        '{"type":"session.created","sessionID":"ses_a"}\n',  # unknown event type
        'Session ses_a said: {"type":"text","sessionID":"ses_a"}\n',  # not an event line
        '{"type":"text","sessionID":"ses_a"}\n{"type":"step_finish","sessionID":"ses_b"}\n',
        '{"type":"text","sessionID":"ses_a","part":{"sessionID":"ses_b"}}\n',
        '{"type":"text","sessionID":"ses_a","part":{"sessionID":null}}\n',  # present mismatch of any kind
        '{"type":"text","part":{"sessionID":"ses_a"}}\n',  # part-only: envelope ID is required
        '{"type":["text"],"sessionID":"ses_a"}\n',  # non-string type
        '{"type":"text","sessionID":"ses_a"\n',  # malformed JSON only
    ],
)
def test_opencode_without_a_single_native_session_id_reports_nothing(tmp_path, fake_opencode_db, stdout):
    _add_session(fake_opencode_db, "ses_a", str(tmp_path), time_updated=1, messages=[_assistant("gpt-5.4", 1, 1, 0.1)])
    assert _parse(tmp_path, stdout) == NULL


def test_opencode_identity_survives_a_missing_or_foreign_db(tmp_path, monkeypatch, fake_opencode_db):
    _add_session(fake_opencode_db, "ses_a", str(tmp_path), time_updated=1, messages=[_assistant("gpt-5.4", 1, 1, 0.1)])
    unavailable = {"cost_usd": None, "tokens_in": None, "tokens_out": None,
                   "raw": {"sessionID": "ses_missing", "costSource": "unavailable"}}
    assert _parse(tmp_path, _events("ses_missing")) == unavailable

    monkeypatch.setenv("OPENCODE_DB", str(tmp_path / "does-not-exist.db"))
    assert _parse(tmp_path, _events("ses_missing")) == unavailable


def test_opencode_session_without_assistant_rows_is_null_not_zero(tmp_path, fake_opencode_db):
    _add_session(fake_opencode_db, "ses_a", str(tmp_path), time_updated=1, messages=[_user()])
    telemetry = _telemetry(fake_opencode_db, "ses_a")
    assert (telemetry.tokens_in, telemetry.tokens_out, telemetry.cost_usd, telemetry.model) == (None, None, None, None)
    assert telemetry.raw == {"sessionID": "ses_a", "costSource": "unavailable"}


def test_opencode_preserves_reported_zero_cost_and_names_the_unanimous_model(tmp_path, fake_opencode_db):
    _add_session(fake_opencode_db, "ses_a", str(tmp_path), time_updated=1,
                 messages=[_user("gpt-5.4-mini"), _assistant("gpt-5.4-mini", 1000, 100, 0), _assistant("gpt-5.4-mini", 0, 0, 0)])
    telemetry = _telemetry(fake_opencode_db, "ses_a")
    assert (telemetry.tokens_in, telemetry.tokens_out, telemetry.cost_usd) == (1000, 100, 0.0)
    assert telemetry.model == "gpt-5.4-mini"
    assert telemetry.raw == {"sessionID": "ses_a", "costSource": "reported"}


@pytest.mark.parametrize(
    "other",
    [
        _assistant("claude-sonnet-4-6", 10, 1, 0),
        _assistant(None, 10, 1, 0),
        _assistant("gpt-5.4-mini", 10, 1, 0, provider="azure"),
        _assistant("gpt-5.4-mini", 10, 1, 0, provider=""),
    ],
)
def test_opencode_mixed_model_or_provider_reports_totals_without_a_model(tmp_path, fake_opencode_db, other):
    _add_session(fake_opencode_db, "ses_a", str(tmp_path), time_updated=1,
                 messages=[_assistant("gpt-5.4-mini", 1000, 100, 0), other])
    telemetry = _telemetry(fake_opencode_db, "ses_a")
    assert telemetry.model is None
    assert (telemetry.tokens_in, telemetry.tokens_out, telemetry.cost_usd) == (1010, 101, 0.0)


@pytest.mark.parametrize(
    ("bad_row", "expected"),
    [
        ('{"role":"assistant","providerID":"openai","modelID":"m","tokens":{"output":5},"cost":0.1}', (None, 15, 0.2)),
        ('{"role":"assistant","providerID":"openai","modelID":"m","tokens":{"input":1.5,"output":5},"cost":0.1}', (None, 15, 0.2)),
        ('{"role":"assistant","providerID":"openai","modelID":"m","tokens":{"input":-1,"output":5},"cost":0.1}', (None, 15, 0.2)),
        ('{"role":"assistant","providerID":"openai","modelID":"m","tokens":{"input":1,"output":"5"},"cost":0.1}', (11, None, 0.2)),
        ('{"role":"assistant","providerID":"openai","modelID":"m","tokens":{"input":1,"output":5}}', (11, 15, None)),
        ('{"role":"assistant","providerID":"openai","modelID":"m","tokens":{"input":1,"output":5},"cost":null}', (11, 15, None)),
    ],
)
def test_opencode_invalid_field_makes_only_that_field_unavailable(tmp_path, fake_opencode_db, bad_row, expected):
    _add_session(fake_opencode_db, "ses_a", str(tmp_path), time_updated=1, messages=[_assistant("m", 10, 10, 0.1), bad_row])
    telemetry = _telemetry(fake_opencode_db, "ses_a")
    assert (telemetry.tokens_in, telemetry.tokens_out, telemetry.cost_usd) == expected
    assert telemetry.raw["costSource"] == ("reported" if expected[2] is not None else "unavailable")


# ---- DB resolution -----------------------------------------------------------


def test_opencode_discovers_the_unique_channel_db_holding_the_session(tmp_path, data_dir):
    _init_db(data_dir / "opencode.db")
    _init_db(data_dir / "opencode-dev.db")
    (data_dir / "opencode.db-wal").write_bytes(b"")
    (data_dir / "notes.txt").write_text("not a db")
    _add_session(data_dir / "opencode.db", "ses_prod", str(tmp_path), 1, [_assistant("gpt-5.4", 1, 2, 0.1)])
    _add_session(data_dir / "opencode-dev.db", "ses_dev", str(tmp_path), 1, [_assistant("gpt-5.4", 3, 4, 0.2)])

    assert _parse(tmp_path, _events("ses_dev"))["tokens_in"] == 3
    assert _parse(tmp_path, _events("ses_prod"))["tokens_in"] == 1
    assert _parse(tmp_path, _events("ses_none"))["raw"] == {"sessionID": "ses_none", "costSource": "unavailable"}


def test_opencode_ambiguous_or_uninspectable_candidates_fail_closed(tmp_path, data_dir):
    _init_db(data_dir / "opencode.db")
    _init_db(data_dir / "opencode-beta.db")
    _add_session(data_dir / "opencode.db", "ses_a", str(tmp_path), 1, [_assistant("gpt-5.4", 1, 2, 0.1)])
    _add_session(data_dir / "opencode-beta.db", "ses_a", str(tmp_path), 1, [_assistant("gpt-5.4", 1, 2, 0.1)])
    assert _parse(tmp_path, _events("ses_a"))["tokens_in"] is None

    (data_dir / "opencode-beta.db").write_bytes(b"garbage, not sqlite")
    assert _parse(tmp_path, _events("ses_a"))["tokens_in"] is None

    (data_dir / "opencode-beta.db").unlink()
    assert _parse(tmp_path, _events("ses_a"))["tokens_in"] == 1


@pytest.mark.parametrize("flag", ["1", "true"])
def test_opencode_disable_channel_db_reads_only_opencode_db(tmp_path, data_dir, flag):
    _init_db(data_dir / "opencode-dev.db")
    _add_session(data_dir / "opencode-dev.db", "ses_dev", str(tmp_path), 1, [_assistant("gpt-5.4", 3, 4, 0.2)])
    env = {"OPENCODE_DISABLE_CHANNEL_DB": flag}
    assert _parse(tmp_path, _events("ses_dev"), env)["tokens_in"] is None

    _init_db(data_dir / "opencode.db")
    _add_session(data_dir / "opencode.db", "ses_dev", str(tmp_path), 1, [_assistant("gpt-5.4", 1, 2, 0.1)])
    assert _parse(tmp_path, _events("ses_dev"), env)["tokens_in"] == 1


def test_opencode_explicit_db_follows_upstream_path_rules(tmp_path, data_dir):
    _init_db(data_dir / "relative.db")
    _add_session(data_dir / "relative.db", "ses_a", str(tmp_path), 1, [_assistant("gpt-5.4", 1, 2, 0.1)])
    _init_db(tmp_path / "abs.db")
    _add_session(tmp_path / "abs.db", "ses_a", str(tmp_path), 1, [_assistant("gpt-5.4", 5, 6, 0.3)])
    _init_db(data_dir / "opencode.db")
    _add_session(data_dir / "opencode.db", "ses_a", str(tmp_path), 1, [_assistant("gpt-5.4", 9, 9, 0.9)])

    # Relative joins Global.Path.data; absolute is verbatim; both skip discovery.
    assert _parse(tmp_path, _events("ses_a"), {"OPENCODE_DB": "relative.db"})["tokens_in"] == 1
    assert _parse(tmp_path, _events("ses_a"), {"OPENCODE_DB": str(tmp_path / "abs.db")})["tokens_in"] == 5
    # No `~` expansion upstream: a literal `~` is a relative path under the data dir.
    assert _parse(tmp_path, _events("ses_a"), {"OPENCODE_DB": "~/abs.db"})["tokens_in"] is None
    # `:memory:` never produces a readable artifact.
    assert _parse(tmp_path, _events("ses_a"), {"OPENCODE_DB": ":memory:"}) == {
        "cost_usd": None, "tokens_in": None, "tokens_out": None,
        "raw": {"sessionID": "ses_a", "costSource": "unavailable"},
    }
    # An explicit empty caller value is not an override; discovery finds the single match.
    assert _parse(tmp_path, _events("ses_a"), {"OPENCODE_DB": ""})["tokens_in"] is None  # 3 candidates match
    (data_dir / "relative.db").unlink()
    (tmp_path / "abs.db").unlink()
    assert _parse(tmp_path, _events("ses_a"), {"OPENCODE_DB": ""})["tokens_in"] == 9


def test_opencode_data_dir_follows_the_child_environment(tmp_path, monkeypatch):
    monkeypatch.delenv("OPENCODE_DB", raising=False)
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path / "inherited-xdg"))
    workdir = tmp_path / "repo"
    workdir.mkdir()

    home_db = tmp_path / "home" / ".local" / "share" / "opencode" / "opencode.db"
    _init_db(home_db)
    _add_session(home_db, "ses_a", str(workdir), 1, [_assistant("gpt-5.4", 1, 2, 0.1)])
    # Caller HOME with an explicitly empty XDG_DATA_HOME: xdg-basedir falls back to HOME.
    assert _parse(workdir, _events("ses_a"), {"HOME": str(tmp_path / "home"), "XDG_DATA_HOME": ""})["tokens_in"] == 1

    # A relative XDG_DATA_HOME is honored relative to the child's cwd (the workdir).
    rel_db = workdir / "rel-xdg" / "opencode" / "opencode.db"
    _init_db(rel_db)
    _add_session(rel_db, "ses_a", str(workdir), 1, [_assistant("gpt-5.4", 7, 8, 0.7)])
    assert _parse(workdir, _events("ses_a"), {"XDG_DATA_HOME": "rel-xdg"})["tokens_in"] == 7


# ---- session-log selector -------------------------------------------------------


def test_opencode_session_log_path_is_never_invented(tmp_path, fake_opencode_db):
    assert OpenCodeAdapter().session_log_path(tmp_path) is None


def test_opencode_selector_is_split_on_the_last_marker_and_percent_decoded(tmp_path):
    db_path = tmp_path / "odd#session=name.db"
    _init_db(db_path)
    _add_session(db_path, "ses/one two", str(tmp_path), 1, [_assistant("gpt-5.4", 1, 2, 0.1)])
    telemetry = _telemetry(db_path, "ses/one two")
    assert telemetry.session_log_path == f"{db_path}#session=ses%2Fone%20two"
    assert (telemetry.tokens_in, telemetry.tokens_out) == (1, 2)
    assert telemetry.raw == {"sessionID": "ses/one two", "costSource": "reported"}


@pytest.mark.parametrize("suffix", ["", "#session(repo)", "#session=", "#session=%zz", "#session=%E2%82", "#other=ses_a"])
def test_opencode_rejects_bare_legacy_or_malformed_selectors(tmp_path, fake_opencode_db, suffix):
    _add_session(fake_opencode_db, "ses_a", str(tmp_path), 1, [_assistant("gpt-5.4", 1, 2, 0.1)])
    telemetry = OpenCodeAdapter().parse_session_log(f"{fake_opencode_db}{suffix}")
    assert (telemetry.tokens_in, telemetry.tokens_out, telemetry.cost_usd, telemetry.model, telemetry.raw) == (None,) * 5


def test_opencode_selector_for_a_missing_db_keeps_identity(tmp_path):
    telemetry = _telemetry(tmp_path / "missing.db", "ses_a")
    assert telemetry.tokens_in is None
    assert telemetry.raw == {"sessionID": "ses_a", "costSource": "unavailable"}
