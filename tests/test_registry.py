"""Registry tests — shipped adapters, lookup errors, registration rules."""

import pytest

from harness.base import HarnessError
from harness.registry import get_adapter, register



def test_get_adapter_unknown_raises():
    with pytest.raises(HarnessError) as exc:
        get_adapter("does-not-exist")
    assert exc.value.code == "unknown-harness"


def test_register_same_class_is_idempotent():
    from harness.adapters.claude_code import ClaudeCodeAdapter

    register("claude-code", ClaudeCodeAdapter)
    assert isinstance(get_adapter("claude-code"), ClaudeCodeAdapter)


def test_register_collision_raises():
    from harness.adapters.claude_code import ClaudeCodeAdapter

    class Other(ClaudeCodeAdapter):
        pass

    with pytest.raises(HarnessError) as exc:
        register("claude-code", Other)
    assert exc.value.code == "duplicate-adapter"
    assert isinstance(get_adapter("claude-code"), ClaudeCodeAdapter)


