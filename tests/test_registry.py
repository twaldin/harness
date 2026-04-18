"""Registry smoke tests — verify shipped adapters register on import."""
import pytest

from harness import list_adapters
from harness.base import HarnessError, RunSpec
from harness.registry import get_adapter, register


def test_shipped_adapters_registered():
    import harness.adapters  # noqa: F401 — side-effect import

    names = list_adapters()
    assert "claude-code" in names
    assert "opencode" in names


def test_get_adapter_unknown_raises():
    with pytest.raises(HarnessError) as exc:
        get_adapter("does-not-exist")
    assert "unknown harness" in str(exc.value)


def test_register_collision_raises():
    import harness.adapters  # noqa: F401

    from harness.adapters.claude_code import ClaudeCodeAdapter

    class Other(ClaudeCodeAdapter):
        pass

    with pytest.raises(HarnessError) as exc:
        register("claude-code", Other)
    assert "collision" in str(exc.value)


def test_runspec_defaults(tmp_path):
    spec = RunSpec(harness="claude-code", prompt="hi", workdir=tmp_path)
    assert spec.timeout_seconds == 1800
    assert spec.env == {}
    assert spec.model is None
    assert spec.instructions is None
