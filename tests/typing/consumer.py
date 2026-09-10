"""Type-check against an installed wheel, never execute provider calls here."""
from pathlib import Path

from harness import (
    BuildCommand,
    RunResult,
    RunSpec,
    SessionCapabilities,
    build_command,
    get_session_capabilities,
    run_async,
)

spec = RunSpec(harness="codex", prompt="synthetic", workdir=Path.cwd())
command: BuildCommand = build_command(spec)
capabilities: SessionCapabilities = get_session_capabilities("pi", "rpc")


async def consume() -> int:
    result: RunResult = await run_async(spec)
    return result.exit_code


# A typed consumer must reject a string deadline. Strict mypy reports an unused
# ignore if this constructor silently degrades to Any.
RunSpec(harness="codex", prompt="synthetic", workdir=Path.cwd(), timeout_seconds="60")  # type: ignore[arg-type]
