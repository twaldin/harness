from __future__ import annotations

import hashlib
import json
import os
import re
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
    root = str(workdir.resolve())

    def materialize(source: Path, destination: Path) -> None:
        destination.parent.mkdir(parents=True, exist_ok=True)
        escaped = json.dumps(root, ensure_ascii=False)[1:-1]
        text = source.read_text().replace("__WORKDIR__", escaped).replace("/Users/dev/repo.space_underé", escaped).replace("/workspace/repo", escaped)
        destination.write_text(text.replace("__PROJECT_HASH__", hashlib.sha256(root.encode()).hexdigest()))

    if adapter == "continue-cli":
        source = fixtures / "continue" / "3b9e7d2c-5a1f-4e8b-9c6d-0f1a2b3c4d5e.json"
        materialize(source, home / ".continue" / "sessions" / source.name)
    elif adapter == "factory-droid":
        directory = home / ".factory" / "sessions" / ("-" + root.strip("/").replace("/", "-"))
        for source in (fixtures / "factory").iterdir():
            materialize(source, directory / source.name)
    elif adapter in {"qwen", "gemini"}:
        source_dir = fixtures / adapter
        case = json.loads((source_dir / "discovery.json").read_text())["sessions"]["main"]
        if adapter == "qwen":
            directory = home / ".qwen" / "projects" / re.sub(r"[^a-zA-Z0-9]", "-", root) / "chats"
        else:
            materialize(source_dir / "projects.json", home / ".gemini" / "projects.json")
            directory = home / ".gemini" / "tmp" / "repo" / "chats"
        materialize(source_dir / case["file"], directory / Path(case["file"]).name)
    elif adapter in {"openclaude", "claude-code"}:
        encoded = re.sub(r"[^a-zA-Z0-9]", "-", root)
        directory = home / (".openclaude" if adapter == "openclaude" else ".claude") / "projects" / encoded
        materialize(fixtures / adapter / "session.jsonl", directory / "session.jsonl")
    return home, workdir


def _setup_sqlite_fixture(tmp_path: Path, adapter: str) -> Path:
    """Two sessions per DB: the run's own (`s1`) and a newer, fatter decoy the
    old latest-row heuristics would have picked. Returns the DB path."""
    workdir = tmp_path / "repo"
    workdir.mkdir(parents=True, exist_ok=True)

    if adapter == "crush":
        d = workdir / ".harness" / "crush-data"
        d.mkdir(parents=True, exist_ok=True)
        db_path = d / "crush.db"
        db = sqlite3.connect(db_path)
        db.executescript(
            """
            CREATE TABLE sessions (
                id TEXT PRIMARY KEY,
                parent_session_id TEXT,
                prompt_tokens INTEGER,
                completion_tokens INTEGER,
                cost REAL,
                updated_at INTEGER
            );
            CREATE TABLE messages (
                id TEXT PRIMARY KEY, session_id TEXT, role TEXT, model TEXT, provider TEXT, created_at INTEGER
            );
            INSERT INTO sessions (id, parent_session_id, prompt_tokens, completion_tokens, cost, updated_at)
            VALUES ('s1', NULL, 70, 11, 0.004, 1);
            INSERT INTO sessions (id, parent_session_id, prompt_tokens, completion_tokens, cost, updated_at)
            VALUES ('s2', NULL, 99999, 99999, 99.0, 2);
            INSERT INTO messages VALUES ('m1', 's1', 'assistant', 'gpt-5.4', 'openai', 1);
            INSERT INTO messages VALUES ('m2', 's2', 'assistant', 'gpt-5.4', 'openai', 2);
            """
        )
        db.commit()
        db.close()
    else:
        d = workdir / ".harness" / "kilo"
        d.mkdir(parents=True, exist_ok=True)
        db_path = d / "kilo.db"
        db = sqlite3.connect(db_path)
        db.executescript(
            """
            CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT NOT NULL, time_updated INTEGER NOT NULL);
            CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, data TEXT NOT NULL);
            INSERT INTO session (id, directory, time_updated) VALUES ('s1', '/tmp/repo', 1);
            INSERT INTO session (id, directory, time_updated) VALUES ('s2', '/tmp/repo', 2);
            INSERT INTO message (id, session_id, data)
            VALUES ('m1', 's1', '{"role":"assistant","providerID":"openai","modelID":"gpt-5.4","tokens":{"input":90,"output":30},"cost":0.004}');
            INSERT INTO message (id, session_id, data)
            VALUES ('m2', 's2', '{"role":"assistant","providerID":"openai","modelID":"gpt-5.4","tokens":{"input":99999,"output":99999},"cost":99.0}');
            """
        )
        db.commit()
        db.close()
    return db_path


@pytest.mark.parametrize("adapter", ["continue-cli", "factory-droid", "qwen", "gemini", "openclaude", "claude-code"])
def test_session_log_path_and_parse_parity_home(adapter: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    if shutil.which("bun") is None:
        pytest.skip("bun not available")

    home, workdir = _setup_home_fixture(tmp_path, adapter)
    monkeypatch.setenv("HOME", str(home))
    for key in ("CLAUDE_CONFIG_DIR", "OPENCLAUDE_CONFIG_DIR", "GEMINI_CLI_HOME", "QWEN_HOME", "QWEN_RUNTIME_DIR", "FACTORY_HOME_OVERRIDE", "CONTINUE_GLOBAL_DIR"):
        monkeypatch.delenv(key, raising=False)

    env = os.environ.copy()
    env["HOME"] = str(home)

    py_adapter = get_adapter(adapter)
    py_path = py_adapter.session_log_path(workdir)
    assert py_path is not None
    ts_path = _ts_call(adapter, "sessionLogPath", str(workdir), env)
    assert py_path == ts_path

    py_parsed = _py_telemetry_dict(py_adapter.parse_session_log(py_path))
    ts_parsed = _ts_call(adapter, "parseSessionLog", py_path, env)
    assert py_parsed == ts_parsed
    cutoff = Path(py_path).stat().st_mtime + 1
    assert py_adapter.session_log_path(workdir, cutoff) is None
    proc = subprocess.run(
        ["bun", "ts/scripts/session-telemetry.ts", adapter, "sessionLogPath", str(workdir), str(cutoff * 1000)],
        cwd=Path(__file__).resolve().parents[2], env=env, capture_output=True, text=True, check=True,
    )
    assert json.loads(proc.stdout) is None


@pytest.mark.parametrize("adapter", ["crush", "kilo"])
def test_session_log_path_and_parse_parity_sqlite(adapter: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    if shutil.which("bun") is None:
        pytest.skip("bun not available")

    db_path = _setup_sqlite_fixture(tmp_path, adapter)
    workdir = db_path.parents[2]
    home = tmp_path / "home"
    home.mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("HOME", str(home))

    env = os.environ.copy()
    env["HOME"] = str(home)

    # The DB alone cannot identify a run's session: both runtimes decline to
    # invent a path and only parse an explicit exact-ID selector.
    py_adapter = get_adapter(adapter)
    assert py_adapter.session_log_path(workdir) is None
    assert _ts_call(adapter, "sessionLogPath", str(workdir), env) is None

    selector = f"{db_path}#session=s1"
    py_parsed = _py_telemetry_dict(py_adapter.parse_session_log(selector))
    ts_parsed = _ts_call(adapter, "parseSessionLog", selector, env)
    assert py_parsed == ts_parsed
    expected_tokens = (70, 11) if adapter == "crush" else (90, 30)
    assert (py_parsed["tokensIn"], py_parsed["tokensOut"]) == expected_tokens
    assert py_parsed["costUsd"] == 0.004
    assert py_parsed["model"] == "gpt-5.4"
    assert py_parsed["raw"] == {"sessionID": "s1", "costSource": "reported"}

    for stale in (str(db_path), f"{db_path}#session(repo)"):
        py_stale = _py_telemetry_dict(py_adapter.parse_session_log(stale))
        assert py_stale == _ts_call(adapter, "parseSessionLog", stale, env)
        assert (py_stale["tokensIn"], py_stale["raw"]) == (None, None)


@pytest.mark.parametrize(
    ("models", "expected_model", "expected_cost"),
    [
        (["gpt-5.4-mini"], "gpt-5.4-mini", 0.00056),
        (["gpt-5.4-mini", "gpt-5.4"], None, None),
        (["gpt-5.4-mini", None], None, None),
        ([None, "gpt-5.4-mini"], None, None),
        ([], None, None),
    ],
)
def test_codex_rollout_model_pricing_parity(models, expected_model, expected_cost, tmp_path: Path):
    if shutil.which("bun") is None:
        pytest.skip("bun not available")
    events = [{"type": "turn_context", "payload": {} if model is None else {"model": model}} for model in models]
    events.extend([
        {"type": "event_msg", "payload": {"type": "token_count", "info": {
            "total_token_usage": {"input_tokens": 500, "output_tokens": 50}}}},
        {"type": "event_msg", "payload": {"type": "token_count", "info": {
            "total_token_usage": {"input_tokens": 1000, "output_tokens": 100}}}},
    ])
    path = tmp_path / "codex.jsonl"
    path.write_text("\n".join(json.dumps(event) for event in events), encoding="utf-8")
    py_result = _py_telemetry_dict(get_adapter("codex").parse_session_log(str(path)))
    ts_result = _ts_call("codex", "parseSessionLog", str(path), os.environ.copy())
    assert py_result == ts_result
    assert (py_result["tokensIn"], py_result["tokensOut"], py_result["model"]) == (1000, 100, expected_model)
    if expected_cost is None:
        assert py_result["costUsd"] is None
    else:
        assert py_result["costUsd"] == pytest.approx(expected_cost)


@pytest.mark.parametrize("case", json.loads(
    (Path(__file__).resolve().parents[1] / "fixtures/session-logs/telemetry-cases.json").read_text()
), ids=lambda case: case["name"])
def test_native_telemetry_boundaries_in_both_runtimes(case: dict, tmp_path: Path):
    if shutil.which("bun") is None:
        pytest.skip("bun not available")
    path = tmp_path / "session.jsonl"
    text = case["text"] if "text" in case else "\n".join(json.dumps(record) for record in case["records"])
    path.write_text(text + "\n")
    for adapter in case["adapters"]:
        py_result = _py_telemetry_dict(get_adapter(adapter).parse_session_log(str(path)))
        ts_result = _ts_call(adapter, "parseSessionLog", str(path), os.environ.copy())
        for result in (py_result, ts_result):
            for key, expected in case["expected"].items():
                assert result[key] == (pytest.approx(expected) if key == "costUsd" and expected is not None else expected)
