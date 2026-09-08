"""kilo adapter — native session correlation against a DB shaped like kilo's session/message tables.

The shared accounting rules (validity, unanimity, zero, selectors) are pinned
in test_opencode_db.py; these tests cover kilo's own DB resolution — the
builder-pinned per-workdir DB versus caller overrides — and the exact-ID
selection inside it.
"""
import json
import sqlite3

import pytest

from harness import RunSpec
from harness._subproc import SubprocOutcome
from harness.adapters.kilo import KiloAdapter

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


def _events(*session_ids):
    return "".join(json.dumps({"type": "step_finish", "timestamp": 1, "sessionID": s}) + "\n" for s in session_ids)


def _assistant(model, tokens_in, tokens_out, cost, provider="openai"):
    """Assistant rows carry modelID/providerID; user rows carry a `model` object instead."""
    return json.dumps({
        "role": "assistant",
        "providerID": provider,
        "modelID": model,
        "tokens": {"input": tokens_in, "output": tokens_out, "reasoning": 0, "cache": {"read": 0, "write": 0}},
        "cost": cost,
    })


def _user(model="gpt-5.4"):
    return json.dumps({"role": "user", "agent": "build", "model": {"providerID": "openai", "modelID": model}})


def _init_db(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.executescript(SCHEMA)
    conn.commit()
    conn.close()


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


@pytest.fixture
def workdir(tmp_path, monkeypatch):
    monkeypatch.delenv("KILO_DB", raising=False)
    monkeypatch.delenv("KILO_DISABLE_CHANNEL_DB", raising=False)
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path / "xdg"))
    workdir = tmp_path / "proj-abc"
    workdir.mkdir()
    return workdir


def _parse(workdir, stdout, env=None):
    return KiloAdapter().parse_output(RunSpec(harness="kilo", prompt="x", workdir=workdir, env=dict(env or {})), _stub(stdout))


def _build(workdir, env=None):
    return KiloAdapter().build_command(RunSpec(harness="kilo", prompt="x", workdir=workdir, env=dict(env or {})))


def test_kilo_sums_only_the_named_sessions_assistant_rows(workdir):
    db_path = workdir / ".harness" / "kilo" / "kilo.db"
    _init_db(db_path)
    _add_session(
        db_path, "ses_run", str(workdir), 100,
        messages=[
            _user(),
            _assistant("gpt-5.4", 100, 50, 0.01),
            _assistant("gpt-5.4", 25, 10, 0.003),
            '{"role":"user","tokens":{"input":99999,"output":99999},"cost":999}',
        ],
    )
    # Newer session in the same workdir: never picked by recency any more.
    _add_session(db_path, "ses_new", str(workdir), 200, messages=[_assistant("gpt-5.4-mini-fast", 42, 7, 0.001)])

    result = _parse(workdir, _events("ses_run", "ses_run"))
    assert (result["tokens_in"], result["tokens_out"]) == (125, 60)
    assert result["cost_usd"] == pytest.approx(0.013)
    assert result["raw"] == {"sessionID": "ses_run", "costSource": "reported"}
    assert KiloAdapter().parse_session_log(f"{db_path}#session=ses_new").model == "gpt-5.4-mini-fast"


def test_kilo_without_identity_reports_nothing_even_with_a_populated_db(workdir):
    db_path = workdir / ".harness" / "kilo" / "kilo.db"
    _init_db(db_path)
    _add_session(db_path, "ses_a", str(workdir), 1, messages=[_assistant("gpt-5.4", 1, 1, 0.1)])
    null = {"cost_usd": None, "tokens_in": None, "tokens_out": None, "raw": None}
    assert _parse(workdir, "plain output\n") == null
    assert _parse(workdir, _events("ses_a", "ses_b")) == null


def test_kilo_missing_db_keeps_identity_with_unavailable_cost(workdir):
    assert _parse(workdir, _events("ses_a")) == {
        "cost_usd": None, "tokens_in": None, "tokens_out": None,
        "raw": {"sessionID": "ses_a", "costSource": "unavailable"},
    }


def test_kilo_builder_pins_the_per_workdir_db_only_without_an_override(workdir, monkeypatch):
    default = workdir / ".harness" / "kilo" / "kilo.db"
    bc = _build(workdir)
    assert bc.env["KILO_DB"] == str(default)
    assert bc.directories == (default.parent,)

    # A caller's relative KILO_DB stays verbatim (upstream resolves it against
    # Global.Path.data); nothing is planned for it.
    bc = _build(workdir, {"KILO_DB": "mine.db"})
    assert bc.env["KILO_DB"] == "mine.db"
    assert bc.directories == ()

    # An explicit empty value reaches the child as-is (caller env wins), so the
    # builder neither pins its default nor plans a directory.
    bc = _build(workdir, {"KILO_DB": ""})
    assert bc.env["KILO_DB"] == ""
    assert bc.directories == ()

    monkeypatch.setenv("KILO_DB", "/inherited/kilo.db")
    bc = _build(workdir)
    assert bc.env["KILO_DB"] == "/inherited/kilo.db"
    assert bc.directories == ()


def test_kilo_reader_resolves_overrides_like_upstream(workdir, tmp_path, monkeypatch):
    data_dir = tmp_path / "xdg" / "kilo"
    _init_db(data_dir / "mine.db")
    _add_session(data_dir / "mine.db", "ses_a", str(workdir), 1, messages=[_assistant("gpt-5.4", 1, 2, 0.1)])
    _init_db(tmp_path / "abs.db")
    _add_session(tmp_path / "abs.db", "ses_a", str(workdir), 1, messages=[_assistant("gpt-5.4", 5, 6, 0.5)])
    _init_db(workdir / ".harness" / "kilo" / "kilo.db")
    _add_session(workdir / ".harness" / "kilo" / "kilo.db", "ses_a", str(workdir), 1, messages=[_assistant("gpt-5.4", 9, 9, 0.9)])

    assert _parse(workdir, _events("ses_a"), {"KILO_DB": "mine.db"})["tokens_in"] == 1
    assert _parse(workdir, _events("ses_a"), {"KILO_DB": str(tmp_path / "abs.db")})["tokens_in"] == 5
    assert _parse(workdir, _events("ses_a"), {"KILO_DB": ":memory:"})["tokens_in"] is None
    assert _parse(workdir, _events("ses_a"))["tokens_in"] == 9

    monkeypatch.setenv("KILO_DB", str(tmp_path / "abs.db"))
    assert _parse(workdir, _events("ses_a"))["tokens_in"] == 5
    # Inherited empty value: the builder pinned its default, so the reader uses it.
    monkeypatch.setenv("KILO_DB", "")
    assert _parse(workdir, _events("ses_a"))["tokens_in"] == 9


def test_kilo_explicit_empty_override_discovers_the_channel_db(workdir, tmp_path):
    data_dir = tmp_path / "xdg" / "kilo"
    _init_db(workdir / ".harness" / "kilo" / "kilo.db")
    _add_session(workdir / ".harness" / "kilo" / "kilo.db", "ses_a", str(workdir), 1, messages=[_assistant("gpt-5.4", 9, 9, 0.9)])
    # Legacy channel filename kept by kilo's fallback; discovery is by exact row, not name.
    _init_db(data_dir / "opencode-dev.db")
    _add_session(data_dir / "opencode-dev.db", "ses_a", str(workdir), 1, messages=[_assistant("gpt-5.4", 1, 2, 0.1)])

    # XDG value newline-stripped like upstream kilo.
    env = {"KILO_DB": "", "XDG_DATA_HOME": f"{tmp_path / 'xdg'}\n"}
    assert _parse(workdir, _events("ses_a"), env)["tokens_in"] == 1
    assert _parse(workdir, _events("ses_a"), {**env, "KILO_DISABLE_CHANNEL_DB": "1"})["tokens_in"] is None

    _init_db(data_dir / "kilo.db")
    _add_session(data_dir / "kilo.db", "ses_a", str(workdir), 1, messages=[_assistant("gpt-5.4", 3, 4, 0.3)])
    assert _parse(workdir, _events("ses_a"), env)["tokens_in"] is None  # two candidates hold the session
    assert _parse(workdir, _events("ses_a"), {**env, "KILO_DISABLE_CHANNEL_DB": "true"})["tokens_in"] == 3


def test_kilo_session_log_path_is_never_invented(workdir):
    _init_db(workdir / ".harness" / "kilo" / "kilo.db")
    assert KiloAdapter().session_log_path(workdir) is None


@pytest.mark.parametrize("other_model", ["claude-sonnet-4-6", None])
def test_kilo_mixed_model_session_reports_totals_without_a_model_or_estimate(workdir, other_model):
    db_path = workdir / "kilo.db"
    _init_db(db_path)
    _add_session(db_path, "ses_a", str(workdir), 1,
                 messages=[_assistant("gpt-5.4-mini", 1000, 100, 0), _assistant(other_model, 10, 1, 0)])
    telemetry = KiloAdapter().parse_session_log(f"{db_path}#session=ses_a")
    assert telemetry.model is None
    assert (telemetry.tokens_in, telemetry.tokens_out, telemetry.cost_usd) == (1010, 101, 0.0)
    assert telemetry.raw == {"sessionID": "ses_a", "costSource": "reported"}


def test_kilo_legacy_selector_and_bare_db_yield_nothing(workdir):
    db_path = workdir / "kilo.db"
    _init_db(db_path)
    _add_session(db_path, "ses_a", str(workdir), 1, messages=[_assistant("gpt-5.4", 1, 1, 0.1)])
    for path in (str(db_path), f"{db_path}#session({workdir.name})"):
        telemetry = KiloAdapter().parse_session_log(path)
        assert (telemetry.tokens_in, telemetry.cost_usd, telemetry.model, telemetry.raw) == (None, None, None, None)
