"""harness — invoke AI coding-agent CLIs uniformly.

Public API:
    from harness import run, RunSpec, RunResult, list_adapters
"""
from harness.base import HarnessError, RunResult, RunSpec
from harness.registry import list_adapters, run

__all__ = ["HarnessError", "RunResult", "RunSpec", "list_adapters", "run"]
__version__ = "0.2.0"
