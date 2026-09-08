"""Adapter registry — dispatches RunSpec.harness to the right Adapter.

Shipped adapters are registered when the `harness` package is imported
(`harness/__init__.py` imports `harness.adapters`), so the registry is
populated immediately after `import harness`.
"""
from __future__ import annotations

from harness._subproc import SubprocOutcome
from harness.base import (
    Adapter,
    Backend,
    BuildCommand,
    Capabilities,
    HarnessError,
    ParsedOutput,
    RunResult,
    RunSpec,
    validate_backend,
)

_REGISTRY: dict[str, type[Adapter]] = {}


def register(name: str, adapter_cls: type[Adapter]) -> None:
    """Register `adapter_cls` under `name`. Re-registering the same class is a
    no-op; a different class under an existing name raises `duplicate-adapter`.
    """
    existing = _REGISTRY.get(name)
    if existing is not None and existing is not adapter_cls:
        raise HarnessError(f"adapter name collision: {name!r} is already registered", code="duplicate-adapter")
    _REGISTRY[name] = adapter_cls


def list_adapters() -> list[str]:
    """Registered harness names, sorted by code point (locale-independent)."""
    return sorted(_REGISTRY)


def _adapter_class(name: str) -> type[Adapter]:
    try:
        return _REGISTRY[name]
    except KeyError:
        available = ", ".join(list_adapters()) or "(none registered)"
        raise HarnessError(f"unknown harness {name!r}; available: {available}", code="unknown-harness") from None


def get_adapter(name: str) -> Adapter:
    return _adapter_class(name)()


def get_capabilities(name: str, backend: Backend = "cli") -> Capabilities:
    """What `name` supports on `backend` in this release. Pure; no CLI probe.

    Raises `unknown-harness` for unregistered names and `unsupported-backend`
    / `invalid-options` for backends that cannot be queried honestly.
    """
    adapter_cls = _adapter_class(name)
    validate_backend(backend)
    policies = ("upstream", "bypass") if adapter_cls.permission_bypass_args is not None else ("upstream",)
    return Capabilities(
        backend="cli",
        permission_policies=policies,
        native_options=adapter_cls.native_options_kind,
        streaming=True,
        cancellation=True,
        sessions=False,
        config_home_env=adapter_cls.config_home_env,
        config_file_flag=adapter_cls.config_file_flag,
    )


def _validated_adapter(spec: RunSpec) -> Adapter:
    """Resolve `spec.harness` and reject unsupported backend/policy/options.

    Runs even for custom adapters whose `build_command` skips validation, so
    every registry entrypoint refuses rpc/sdk and invalid options up front.
    """
    adapter = get_adapter(spec.harness)
    adapter.validate_run_spec(spec)
    return adapter


def build_command(spec: RunSpec) -> BuildCommand:
    """Build the subprocess command without executing it. Pure: nothing is
    written; `prepare_command` applies the plan."""
    adapter = _validated_adapter(spec)
    return adapter._finalized(spec, adapter.build_command(spec))


def parse_output(spec: RunSpec, outcome: SubprocOutcome) -> ParsedOutput:
    """Parse adapter output after execution."""
    return _validated_adapter(spec).parse_output(spec, outcome)


def run(spec: RunSpec) -> RunResult:
    """Full headless invocation: build_command + exec + parse_output."""
    return _validated_adapter(spec).run(spec)


async def run_async(spec: RunSpec) -> RunResult:
    """Non-blocking headless invocation: build_command + async exec + parse_output."""
    return await _validated_adapter(spec).run_async(spec)
