"""harness — invoke AI coding-agent CLIs uniformly.

Public API:
    from harness import run, run_async, build_command, parse_output, RunSpec, RunResult, BuildCommand, list_adapters

Importing this package registers every shipped adapter.
"""
from harness.base import (
    Adapter,
    AgentStatus,
    Backend,
    BuildCommand,
    Capabilities,
    ClaudeCodeOptions,
    CodexOptions,
    ErrorCode,
    HarnessError,
    InstallMeta,
    NativeOptions,
    ParsedOutput,
    PermissionPolicy,
    ReadyState,
    RunResult,
    RunSpec,
    ScrollKeys,
    SessionTelemetry,
    Termination,
)
from harness.pricing import ModelPricing, derive_cost, lookup_pricing
from harness.registry import (
    build_command,
    get_adapter,
    get_capabilities,
    list_adapters,
    parse_output,
    register,
    run,
    run_async,
)
from harness._subproc import (
    InstructionProjection,
    SubprocOutcome,
    project_instructions,
    restore_projected_instructions,
    run_subprocess,
    run_subprocess_async,
    write_instructions,
)
from harness.util import last_lines, last_non_empty_join, strip_ansi

import harness.adapters  # noqa: E402,F401 — registers the shipped adapters

__all__ = [
    "Adapter",
    "AgentStatus",
    "Backend",
    "BuildCommand",
    "Capabilities",
    "ClaudeCodeOptions",
    "CodexOptions",
    "ErrorCode",
    "HarnessError",
    "InstallMeta",
    "NativeOptions",
    "ParsedOutput",
    "PermissionPolicy",
    "ReadyState",
    "RunResult",
    "RunSpec",
    "ScrollKeys",
    "SessionTelemetry",
    "Termination",
    "SubprocOutcome",
    "InstructionProjection",
    "build_command",
    "get_adapter",
    "get_capabilities",
    "list_adapters",
    "parse_output",
    "register",
    "run",
    "run_async",
    "run_subprocess",
    "run_subprocess_async",
    "project_instructions",
    "restore_projected_instructions",
    "write_instructions",
    "ModelPricing",
    "lookup_pricing",
    "derive_cost",
    "strip_ansi",
    "last_lines",
    "last_non_empty_join",
]
__version__ = "0.3.4"
