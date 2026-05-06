"""Core types: RunSpec (input), BuildCommand (pre-exec), RunResult (output), Adapter (ABC)."""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


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
    `model_no_resolve` — pass `model` through exactly as provided, without
                      harness-specific normalization. Escape hatch for odd
                      provider/model combinations.
    """

    harness: str
    prompt: str
    workdir: Path
    model: str | None = None
    instructions: str | None = None
    timeout_seconds: int = 1800
    env: dict[str, str] = field(default_factory=dict)
    model_no_resolve: bool = False


@dataclass
class BuildCommand:
    """What to invoke — without invoking it.

    Returned by Adapter.build_command(). Writing the instructions file is a
    side effect of build_command(), so the file exists before the CLI reads it.
    """

    cmd: str
    args: list[str]
    cwd: Path
    env: dict[str, str]
    instructions_file: Path | None


@dataclass
class SessionTelemetry:
    session_log_path: str | None
    tokens_in: int | None
    tokens_out: int | None
    cost_usd: float | None
    model: str | None
    raw: Any


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
    raw: dict | list | None = None  # adapter-specific structured payload (parsed JSON, session info)

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

    #: Scroll-key routing policy for terminal multiplexer integrations
    #: (for example flt's TUI). Consumers can use this to decide whether
    #: scroll-direction keys (j/k, ctrl-u/d, etc.) should be forwarded
    #: into the CLI or treated as tmux scrollback.
    #:
    #:   None / "tmux"      — always tmux copy-mode scrollback. Default.
    #:   "app"              — always forward into the CLI; this CLI owns
    #:                        its own viewport regardless of mode.
    #:   "fullscreen-aware" — forward to the CLI only when the pane is in
    #:                        alt-screen / fullscreen render mode; else tmux.
    #:                        Consumer check: tmux #{alternate_on}.
    scroll_ownership: str | None = None

    @abstractmethod
    def build_command(self, spec: RunSpec) -> BuildCommand:
        """Build the subprocess command without executing it.

        MAY write files (instructions, config) as a side effect.
        MUST NOT fork a subprocess.
        """

    @abstractmethod
    def parse_output(self, spec: RunSpec, outcome: object) -> dict:
        """Parse adapter output after execution.

        Returns dict with keys: cost_usd, tokens_in, tokens_out, raw.
        MAY read files the CLI wrote (trajectory JSON, sqlite DB).
        MUST NOT block on I/O > 5s.
        """

    def run(self, spec: RunSpec) -> RunResult:
        """Full headless invocation: build_command + exec + parse_output."""
        from harness._subproc import run_subprocess

        bc = self.build_command(spec)
        outcome = run_subprocess(
            [bc.cmd] + bc.args,
            cwd=bc.cwd,
            timeout_seconds=spec.timeout_seconds,
            extra_env={**bc.env, **spec.env},
        )
        parsed = self.parse_output(spec, outcome)
        model: str | None = spec.model or getattr(self, "DEFAULT_MODEL", None)
        return RunResult(
            harness=self.name,
            model=model,
            exit_code=outcome.exit_code,
            duration_seconds=outcome.duration_seconds,
            stdout=outcome.stdout,
            stderr=outcome.stderr,
            timed_out=outcome.timed_out,
            cost_usd=parsed.get("cost_usd"),
            tokens_in=parsed.get("tokens_in"),
            tokens_out=parsed.get("tokens_out"),
            raw=parsed.get("raw"),
        )

    async def run_async(self, spec: RunSpec) -> RunResult:
        """Async headless invocation: build_command + async exec + parse_output."""
        from harness._subproc import run_subprocess_async

        bc = self.build_command(spec)
        outcome = await run_subprocess_async(
            [bc.cmd] + bc.args,
            cwd=bc.cwd,
            timeout_seconds=spec.timeout_seconds,
            extra_env={**bc.env, **spec.env},
        )
        parsed = self.parse_output(spec, outcome)
        model: str | None = spec.model or getattr(self, "DEFAULT_MODEL", None)
        return RunResult(
            harness=self.name,
            model=model,
            exit_code=outcome.exit_code,
            duration_seconds=outcome.duration_seconds,
            stdout=outcome.stdout,
            stderr=outcome.stderr,
            timed_out=outcome.timed_out,
            cost_usd=parsed.get("cost_usd"),
            tokens_in=parsed.get("tokens_in"),
            tokens_out=parsed.get("tokens_out"),
            raw=parsed.get("raw"),
        )

    def session_log_path(self, workdir: Path, session_started_after: float | None = None) -> str | None:
        return None

    def parse_session_log(self, path: str) -> SessionTelemetry:
        return SessionTelemetry(
            session_log_path=path,
            tokens_in=None,
            tokens_out=None,
            cost_usd=None,
            model=None,
            raw=None,
        )

    def __repr__(self) -> str:  # pragma: no cover
        return f"{type(self).__name__}(name={self.name!r})"
