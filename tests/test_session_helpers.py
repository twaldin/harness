"""Optional session-aware hooks ported from the TypeScript adapters: pane
classification, dialog keystrokes, install metadata, session-log parsers.
"""
from __future__ import annotations

import json
import os
import time
from pathlib import Path

import pytest

from harness import get_adapter, last_lines, last_non_empty_join, strip_ansi


# ── util ────────────────────────────────────────────────────────────────────


def test_strip_ansi_and_tail_helpers():
    pane = "\x1b[32mgreen\x1b[0m  \n\n  second \n\x1b[1mthird\x1b[0m\n"
    assert strip_ansi(pane) == "green  \n\n  second \nthird\n"
    assert last_lines(pane, 2) == ["third", ""]
    assert last_non_empty_join(pane, 2) == "second\nthird"
    assert last_non_empty_join(pane, 10) == "green\nsecond\nthird"


# ── pane classification edges ───────────────────────────────────────────────


def test_claude_code_pane_states():
    a = get_adapter("claude-code")
    ready = "Claude Code v2\n\x1b[2m>\x1b[0m \n"
    assert a.detect_ready(ready) == "ready"
    assert a.detect_status(ready) == "idle"
    assert a.detect_status("Thinking (12s · ↑1.2k ↓300)\n") == "running"
    dialog = "WARNING: bypass permissions mode\n 1. No, exit\n 2. Yes, I accept\n"
    assert a.detect_ready(dialog) == "dialog"
    assert a.handle_dialog(dialog) == ["2", "Enter"]
    assert a.handle_dialog("Do you trust the files in this folder?") == ["Enter"]
    assert a.detect_status("You have hit your limit for today") == "rate-limited"


def test_codex_pane_states():
    a = get_adapter("codex")
    ready = "model: gpt-5  75% left\n› \n"
    assert a.detect_ready(ready) == "ready"
    assert a.detect_status(ready) == "idle"
    assert a.detect_status("Working (3s · esc to interrupt)") == "running"
    assert a.detect_ready("Update available 1.2.3") == "dialog"
    assert a.handle_dialog("Update available 1.2.3") == ["Down", "Enter"]


def test_pi_status_ignores_model_output_words():
    a = get_adapter("pi")
    assert a.detect_status("FAILED test_x\nerror: boom\nrate limit mentioned in docs") == "idle"
    assert a.detect_status("⠋ Working...") == "running"
    assert a.detect_status("Rate limit reached, retry in 30 seconds") == "rate-limited"
    assert a.detect_ready("↑39k ↓6.4k R84k $0.428 (sub) 14.7%/272k (auto)\nUpdate Available") == "ready"
    assert a.detect_ready("Update Available") == "dialog"
    assert a.handle_dialog("Update Available") is None


def test_kilo_dialogs_are_discriminated_by_button_row():
    a = get_adapter("kilo")
    allow = "Permission required\n\n  Allow once   Allow always   Reject\n"
    confirm = "Permission required\n\n  Confirm   Cancel\n"
    assert a.detect_ready(allow) == "dialog"
    assert a.handle_dialog(allow) == ["Right", "Enter"]
    assert a.handle_dialog(confirm) == ["Enter"]
    assert a.detect_status(confirm) == "dialog"
    assert a.detect_ready("Ask anything...") == "ready"


def test_gemini_dialogs_and_idle():
    a = get_adapter("gemini")
    assert a.detect_status("Apply this change?") == "dialog"
    assert a.handle_dialog("Action Required: Allow tool?") == ["Enter"]
    assert a.detect_status("Type your message") == "idle"
    assert a.detect_status("⠋ Thinking...") == "running"
    assert a.detect_status("resource exhausted") == "rate-limited"


def test_qwen_auth_dialog_is_left_to_user():
    a = get_adapter("qwen")
    pane = "Qwen OAuth has been Discontinued\nswitch to API Key"
    assert a.detect_ready(pane) == "dialog"
    assert a.handle_dialog(pane) is None


def test_opencode_update_banner_and_idle():
    a = get_adapter("opencode")
    assert a.detect_ready("Ask anything\nopencode 1.2.3") == "ready"
    assert a.detect_ready("Ask anything\n(no version)") == "loading"
    assert a.detect_status("Ask anything\nupgrade now") == "dialog"
    assert a.handle_dialog("a new version of opencode is available") == ["Escape"]


# ── session-log parsers ported from TypeScript ─────────────────────────────


def _write(path: Path, text: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def test_codex_session_log_uses_last_cumulative_token_count(tmp_path: Path):
    lines = [
        {"type": "session.created", "model": "gpt-5.4"},
        {"type": "event_msg", "payload": {"type": "token_count", "info": {"total_token_usage": {"input_tokens": 100, "output_tokens": 10}}}},
        {"type": "event_msg", "payload": {"type": "token_count", "info": {"total_token_usage": {"input_tokens": 250, "output_tokens": 40}}}},
    ]
    log = _write(tmp_path / "s.jsonl", "\n".join(json.dumps(x) for x in lines))
    t = get_adapter("codex").parse_session_log(str(log))
    assert (t.tokens_in, t.tokens_out, t.model) == (250, 40, "gpt-5.4")
    assert t.cost_usd == pytest.approx(250 / 1e6 * 3.0 + 40 / 1e6 * 12.0)


def test_codex_session_log_path_honors_epoch_seconds_cutoff(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    old = _write(tmp_path / ".codex" / "sessions" / "2026" / "01" / "01" / "old.jsonl", "{}")
    new = _write(tmp_path / ".codex" / "sessions" / "2026" / "02" / "02" / "new.jsonl", "{}")
    now = time.time()
    os.utime(old, (now - 7200, now - 7200))
    os.utime(new, (now - 60, now - 60))
    a = get_adapter("codex")
    assert a.session_log_path(tmp_path) == str(new)
    assert a.session_log_path(tmp_path, session_started_after=now - 3600) == str(new)
    assert a.session_log_path(tmp_path, session_started_after=now + 3600) is None


def test_pi_session_log_sums_usage_and_prefers_reported_cost(tmp_path: Path):
    lines = [
        {"type": "model_change", "modelId": "anthropic/claude-sonnet-4-6"},
        {"type": "turn_end", "message": {"role": "assistant", "usage": {"input": 10, "output": 5, "cost": {"total": 0.01}}}},
        {"type": "turn_end", "message": {"role": "assistant", "usage": {"input": 20, "output": 5, "cost": {"total": 0.02}}}},
    ]
    log = _write(tmp_path / "p.jsonl", "\n".join(json.dumps(x) for x in lines))
    t = get_adapter("pi").parse_session_log(str(log))
    assert (t.tokens_in, t.tokens_out, t.model) == (30, 10, "anthropic/claude-sonnet-4-6")
    assert t.cost_usd == pytest.approx(0.03)


def test_pi_session_log_path_encoding(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    workdir = tmp_path / "my_repo"
    workdir.mkdir()
    encoded = "-" + str(workdir.resolve()).replace("/", "-") + "--"
    log = _write(tmp_path / ".pi" / "agent" / "sessions" / encoded / "1_abc.jsonl", "{}")
    assert get_adapter("pi").session_log_path(workdir) == str(log)


def test_gemini_session_log_parses_stats_envelope(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    workdir = tmp_path / "proj"
    workdir.mkdir()
    payload = {"stats": {"models": {"gemini-2.5-pro": {"tokens": {"input": 1000, "candidates": 100}}}}}
    log = _write(tmp_path / ".gemini" / "tmp" / "proj" / "logs.json", json.dumps(payload))
    a = get_adapter("gemini")
    assert a.session_log_path(workdir) == str(log)
    t = a.parse_session_log(str(log))
    assert (t.tokens_in, t.tokens_out, t.model) == (1000, 100, "gemini-2.5-pro")
    assert t.cost_usd == pytest.approx(1000 / 1e6 * 1.25 + 100 / 1e6 * 10.0)
    other = _write(tmp_path / "other.json", json.dumps([{"role": "user"}]))
    assert a.parse_session_log(str(other)).raw == [{"role": "user"}]


def test_swe_agent_session_log_prefers_headless_trajectory(tmp_path: Path):
    workdir = tmp_path / "wd"
    traj = {"info": {"model_stats": {"instance_cost": 0.5, "gpt-5.4": {}}}, "messages": []}
    log = _write(workdir / ".harness" / "swe-traj.json", json.dumps(traj))
    _write(workdir / "mini-traj.json", "{}")
    a = get_adapter("swe-agent")
    assert a.session_log_path(workdir) == str(log)
    t = a.parse_session_log(str(log))
    assert (t.cost_usd, t.model, t.tokens_in) == (0.5, "gpt-5.4", None)
