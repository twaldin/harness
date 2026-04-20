"""harness — invoke AI coding-agent CLIs uniformly.

Public API:
    from harness import run, build_command, parse_output, RunSpec, RunResult, BuildCommand, list_adapters
"""
from harness.base import BuildCommand, HarnessError, RunResult, RunSpec
from harness.registry import build_command, list_adapters, parse_output, run

__all__ = [
    "BuildCommand",
    "HarnessError",
    "RunResult",
    "RunSpec",
    "build_command",
    "list_adapters",
    "parse_output",
    "run",
]
__version__ = "0.2.0"
