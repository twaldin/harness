import harness.adapters  # noqa: F401
from harness.registry import get_adapter


def test_scroll_ownership_adapter_defaults_and_overrides():
    assert get_adapter("opencode").scroll_ownership == "app"
    assert get_adapter("claude-code").scroll_ownership == "fullscreen-aware"
    assert get_adapter("codex").scroll_ownership is None
