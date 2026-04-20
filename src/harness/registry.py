"""Adapter registry — dispatches RunSpec.harness to the right Adapter."""
from __future__ import annotations

from harness.base import Adapter, BuildCommand, HarnessError, RunResult, RunSpec

# Filled by adapters/__init__.py at import time.
_REGISTRY: dict[str, type[Adapter]] = {}


def register(name: str, adapter_cls: type[Adapter]) -> None:
    if name in _REGISTRY and _REGISTRY[name] is not adapter_cls:
        raise HarnessError(f"adapter name collision: {name}")
    _REGISTRY[name] = adapter_cls


def list_adapters() -> list[str]:
    """Sorted list of registered harness names."""
    return sorted(_REGISTRY)


def get_adapter(name: str) -> Adapter:
    if name not in _REGISTRY:
        available = ", ".join(list_adapters()) or "(none registered)"
        raise HarnessError(f"unknown harness {name!r}; available: {available}")
    return _REGISTRY[name]()


def build_command(spec: RunSpec) -> BuildCommand:
    """Build the subprocess command without executing it."""
    import harness.adapters  # noqa: F401 — side-effect import populates registry

    return get_adapter(spec.harness).build_command(spec)


def parse_output(spec: RunSpec, outcome: object) -> dict:
    """Parse adapter output after execution."""
    import harness.adapters  # noqa: F401 — side-effect import populates registry

    return get_adapter(spec.harness).parse_output(spec, outcome)


def run(spec: RunSpec) -> RunResult:
    """Full headless invocation: build_command + exec + parse_output."""
    import harness.adapters  # noqa: F401 — side-effect import populates registry

    adapter = get_adapter(spec.harness)
    return adapter.run(spec)
