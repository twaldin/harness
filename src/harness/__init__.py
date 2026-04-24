"""harness — invoke AI coding-agent CLIs uniformly.

Public API:
    from harness import run, run_async, build_command, parse_output, RunSpec, RunResult, BuildCommand, list_adapters
"""
from harness.base import BuildCommand, HarnessError, RunResult, RunSpec
from harness.registry import build_command, list_adapters, parse_output, run, run_async
from harness._subproc import (
    InstructionProjection,
    project_instructions,
    restore_projected_instructions,
    write_instructions,
)

__all__ = [
    "BuildCommand",
    "HarnessError",
    "RunResult",
    "RunSpec",
    "build_command",
    "project_instructions",
    "restore_projected_instructions",
    "InstructionProjection",
    "write_instructions",
    "list_adapters",
    "parse_output",
    "run",
    "run_async",
]
__version__ = "0.3.0"
