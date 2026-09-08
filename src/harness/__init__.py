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
    OutputCallback,
    OutputStream,
    ParsedOutput,
    PermissionPolicy,
    ReadyState,
    RunResult,
    RunSpec,
    ScrollKeys,
    SessionTelemetry,
    Termination,
    TimeoutKind,
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
from harness._instructions import (
    InstructionProjection,
    PreparedCommand,
    cleanup_command,
    prepare_command,
    project_instructions,
    restore_projected_instructions,
    write_instructions,
)
from harness._subproc import SubprocOutcome, run_subprocess, run_subprocess_async
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
    "OutputCallback",
    "OutputStream",
    "ParsedOutput",
    "PermissionPolicy",
    "ReadyState",
    "RunResult",
    "RunSpec",
    "ScrollKeys",
    "SessionTelemetry",
    "Termination",
    "TimeoutKind",
    "SubprocOutcome",
    "InstructionProjection",
    "PreparedCommand",
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
    "prepare_command",
    "cleanup_command",
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
