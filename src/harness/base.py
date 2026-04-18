"""Core types: RunSpec (input), RunResult (output), Adapter (ABC)."""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from pathlib import Path


class HarnessError(RuntimeError):
    """Raised when a harness invocation cannot complete."""


@dataclass
class RunSpec:
    """Everything an adapter needs to invoke its CLI.

    `prompt`        — the user task (becomes the CLI's positional arg or stdin).
    `workdir`       — cwd for the subprocess (the repo or working tree).
    `model`         — model identifier, adapter-specific format.
                      claude-code: "sonnet" / "opus" / "haiku" / "claude-opus-4-7"
                      opencode:    "openai/gpt-5.4" / "anthropic/claude-sonnet-4-6"
                      codex:       "gpt-5.3-codex" / "o3"
    `instructions`  — content for the per-harness instructions file
                      (CLAUDE.md / AGENTS.md / GEMINI.md / .aider.conf.yml).
                      Adapter writes it to the right filename inside `workdir`.
    `timeout_seconds` — wall-clock cap. Adapter SHOULD enforce this.
    `env`           — extra environment variables merged onto os.environ.
    """

    harness: str
    prompt: str
    workdir: Path
    model: str | None = None
    instructions: str | None = None
    timeout_seconds: int = 1800
    env: dict[str, str] = field(default_factory=dict)


@dataclass
class RunResult:
    """Structured outcome of a single harness invocation."""

    harness: str
    model: str | None
    exit_code: int
    duration_seconds: float
    stdout: str
    stderr: str
    timed_out: bool = False
    cost_usd: float | None = None
    tokens_in: int | None = None
    tokens_out: int | None = None
    raw: dict | None = None  # adapter-specific structured payload (parsed JSON, session info)

    @property
    def ok(self) -> bool:
        return self.exit_code == 0 and not self.timed_out


class Adapter(ABC):
    """Subclass per CLI. Each knows how to invoke its tool and parse its output.

    Implementations live in harness/adapters/*.py and self-register via
    `harness.registry.register(name, cls)` at import time.
    """

    #: Short name used in CLI/registry. e.g. "claude-code".
    name: str = ""

    #: Filename used to inject `instructions` into the workdir.
    instructions_filename: str = ""

    @abstractmethod
    def run(self, spec: RunSpec) -> RunResult:
        """Invoke the CLI for `spec` and return a parsed RunResult."""

    def __repr__(self) -> str:  # pragma: no cover
        return f"{type(self).__name__}(name={self.name!r})"
