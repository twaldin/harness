"""Per-adapter `get_current_scroll_keys()` parity tests.

Mirrors ts/tests/scroll-keys.test.ts.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

import harness.adapters  # noqa: F401  (registers adapters)
from harness.base import ScrollKeys
from harness.registry import get_adapter


_FULLSCREEN_KEYS = ScrollKeys(line_down="C-M-e", line_up="C-M-y", page_down="NPage", page_up="PPage")


def test_opencode_returns_static_scroll_keys():
    adapter = get_adapter("opencode")
    assert adapter.get_current_scroll_keys() == _FULLSCREEN_KEYS


def _write_settings(home: Path, payload: dict) -> None:
    d = home / ".claude"
    d.mkdir(parents=True, exist_ok=True)
    (d / "settings.json").write_text(json.dumps(payload), encoding="utf-8")


def test_claude_code_fullscreen_returns_keys(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    _write_settings(tmp_path, {"tui": "fullscreen"})
    assert get_adapter("claude-code").get_current_scroll_keys() == _FULLSCREEN_KEYS


def test_claude_code_default_returns_none(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    _write_settings(tmp_path, {"tui": "default"})
    assert get_adapter("claude-code").get_current_scroll_keys() is None


def test_claude_code_absent_returns_none(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    _write_settings(tmp_path, {"theme": "dark"})
    assert get_adapter("claude-code").get_current_scroll_keys() is None


def test_claude_code_no_settings_file_returns_none(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    assert get_adapter("claude-code").get_current_scroll_keys() is None


def test_claude_code_malformed_settings_returns_none(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    d = tmp_path / ".claude"
    d.mkdir(parents=True, exist_ok=True)
    (d / "settings.json").write_text("{not valid json", encoding="utf-8")
    assert get_adapter("claude-code").get_current_scroll_keys() is None


def test_claude_code_reflects_mutation_between_calls(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    adapter = get_adapter("claude-code")
    _write_settings(tmp_path, {"tui": "default"})
    assert adapter.get_current_scroll_keys() is None
    _write_settings(tmp_path, {"tui": "fullscreen"})
    assert adapter.get_current_scroll_keys() == _FULLSCREEN_KEYS


@pytest.mark.parametrize("name", ["codex", "gemini"])
def test_other_adapters_return_none(name):
    assert get_adapter(name).get_current_scroll_keys() is None
