"""Core types: RunSpec (input), BuildCommand (pre-exec), RunResult (output), Adapter (ABC)."""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Literal, TypedDict, get_args

from harness.model_normalization import normalize_model_for_harness

if TYPE_CHECKING:
    from harness._subproc import SubprocOutcome

Backend = Literal["cli", "rpc", "sdk"]
PermissionPolicy = Literal["upstream", "bypass"]
ErrorCode = Literal[
    "adapter-error",
    "unknown-harness",
    "duplicate-adapter",
    "unsupported-backend",
    "unsupported-capability",
    "invalid-options",
]
NativeOptionsKind = Literal["claude-code", "codex"]
ClaudeCodeEffort = Literal["low", "medium", "high", "xhigh", "max"]
CodexSandbox = Literal["read-only", "workspace-write", "danger-full-access"]

BACKENDS: tuple[Backend, ...] = get_args(Backend)
PERMISSION_POLICIES: tuple[PermissionPolicy, ...] = get_args(PermissionPolicy)
_CLAUDE_CODE_EFFORTS: tuple[str, ...] = get_args(ClaudeCodeEffort)
_CODEX_SANDBOXES: tuple[str, ...] = get_args(CodexSandbox)


class HarnessError(RuntimeError):
    """Raised when a harness invocation cannot complete.

    `code` is a stable machine-readable classification (see `ErrorCode`);
    the message stays human-oriented and may change.
    """

    code: ErrorCode

    def __init__(self, message: str, code: ErrorCode = "adapter-error") -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class ClaudeCodeOptions:
    """Typed `claude` CLI knobs. `effort` is emitted as `--effort <value>`."""

    kind: Literal["claude-code"] = field(default="claude-code", init=False)
    effort: ClaudeCodeEffort | None = None


@dataclass(frozen=True)
class CodexOptions:
    """Typed `codex exec` knobs. `sandbox` is emitted as `--sandbox <value>`.

    Combining `sandbox` with `permission_policy="bypass"` is rejected: the
    bypass flag disables the sandbox, so the two cannot both be honored.
    """

    kind: Literal["codex"] = field(default="codex", init=False)
    sandbox: CodexSandbox | None = None


NativeOptions = ClaudeCodeOptions | CodexOptions


@dataclass
class RunSpec:
    """Everything an adapter needs to invoke its CLI.

    `prompt`        — the user task (becomes the CLI's positional arg or stdin).
    `workdir`       — cwd for the subprocess (the repo or working tree).
    `model`         — model identifier, adapter-specific format.
                      claude-code: "sonnet" / "opus" / "haiku" / "claude-opus-4-7"
                      opencode:    "openai/gpt-5.4" / "anthropic/claude-sonnet-4-6"
                      codex:       "gpt-5.3-codex" / "o3"
                      None or "" selects the adapter default.
    `instructions`  — content for the per-harness instructions file
                      (CLAUDE.md / AGENTS.md / GEMINI.md / .aider.conf.yml).
                      Adapter writes it to the right filename inside `workdir`.
    `timeout_seconds` — wall-clock cap. Adapter SHOULD enforce this.
    `env`           — extra environment variables merged onto os.environ.
    `model_no_resolve` — pass `model` through exactly as provided, without
                      harness-specific normalization. Escape hatch for odd
                      provider/model combinations.
    `backend`       — execution backend. Only "cli" is implemented; "rpc" and
                      "sdk" are rejected with `unsupported-backend`.
    `permission_policy` — "upstream" (default) injects no permission bypass
                      or auto-approve flags; the CLI keeps its own defaults.
                      "bypass" injects the adapter's known bypass flag and is
                      rejected with `unsupported-capability` when the adapter
                      has no such mapping.
    `native_options` — typed, adapter-specific knobs (`ClaudeCodeOptions`,
                      `CodexOptions`). The kind must match `harness`.
    """

    harness: str
    prompt: str
    workdir: Path
    model: str | None = None
    instructions: str | None = None
    timeout_seconds: int = 1800
    env: dict[str, str] = field(default_factory=dict)
    model_no_resolve: bool = False
    backend: Backend = "cli"
    permission_policy: PermissionPolicy = "upstream"
    native_options: NativeOptions | None = None


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


class ParsedOutput(TypedDict):
    """Return shape of Adapter.parse_output()."""

    cost_usd: float | None
    tokens_in: int | None
    tokens_out: int | None
    raw: object | None


@dataclass(frozen=True)
class Capabilities:
    """What a (harness, backend) pair actually supports in this release.

    Reports implemented behavior only — never probes the installed CLI or
    reads credentials.
    """

    backend: Backend
    permission_policies: tuple[PermissionPolicy, ...]
    native_options: NativeOptionsKind | None
    streaming: bool
    cancellation: bool
    sessions: bool


@dataclass(frozen=True)
class ScrollKeys:
    """tmux send-keys notation for the four scroll directions an app's
    virtualized scrollback responds to. Used by terminal-multiplexer
    consumers (e.g. flt) to decide what chord to forward when the user
    scrolls a pane belonging to this CLI.
    """

    line_down: str
    line_up: str
    page_down: str
    page_up: str


# Session-aware additions for live tmux/PTY consumers (e.g. flt). These are
# pure functions on already-captured pane content — harness stays headless,
# the consumer drives pane capture and timing.

ReadyState = Literal["loading", "dialog", "ready"]
AgentStatus = Literal["running", "idle", "error", "rate-limited", "unknown", "exited", "dialog"]


@dataclass
class SessionTelemetry:
    #: Path to the conversation log file consumers can tail or replay.
    session_log_path: str | None
    tokens_in: int | None
    tokens_out: int | None
    cost_usd: float | None
    model: str | None
    raw: object | None


@dataclass(frozen=True)
class InstallMeta:
    #: What package manager owns this CLI's install.
    package_manager: Literal["npm", "pip", "brew", "cargo", "binary", "unknown"]
    #: argv to install fresh. Empty = not installable via this metadata.
    install_command: tuple[str, ...]
    #: argv to update to latest.
    update_command: tuple[str, ...]
    #: argv to print the version (parsed by the consumer).
    version_command: tuple[str, ...]
    #: Platforms supported. None means darwin + linux.
    platforms: tuple[Literal["darwin", "linux", "win32"], ...] | None = None


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


@dataclass(frozen=True)
class ResolvedSpec:
    """Validated, adapter-resolved view of a RunSpec (see Adapter.resolve_run_spec)."""

    model: str | None
    permission_args: tuple[str, ...]
    native_args: tuple[str, ...]


def validate_backend(backend: object) -> None:
    """Reject backends this release cannot execute. `cli` is the only one implemented."""
    if backend == "cli":
        return
    if backend in BACKENDS:
        raise HarnessError(f"backend {backend!r} is not implemented; only 'cli' is available", code="unsupported-backend")
    raise HarnessError(f"unknown backend {backend!r}; expected one of {', '.join(BACKENDS)}", code="invalid-options")


class Adapter(ABC):
    """Subclass per CLI. Each knows how to invoke its tool and parse its output.

    Implementations live in harness/adapters/*.py and self-register via
    `harness.registry.register(name, cls)` at import time.

    Minimal third-party interface: `name`, `instructions_filename`,
    `DEFAULT_MODEL`, `build_command`, `parse_output`. Custom `build_command`
    implementations MUST call `validate_run_spec` (or `resolve_run_spec`)
    before writing anything, so unsupported backends/policies/options are
    rejected without side effects.
    """

    #: Short name used in CLI/registry. e.g. "claude-code".
    name: str = ""

    #: Filename used to inject `instructions` into the workdir.
    instructions_filename: str = ""

    #: Model selected when `spec.model` is None or empty.
    DEFAULT_MODEL: str | None = None

    #: argv appended only when `spec.permission_policy == "bypass"`. None means
    #: the adapter has no known bypass/auto-approve flag; explicit bypass is then
    #: rejected with `unsupported-capability`. Never injected under "upstream".
    permission_bypass_args: tuple[str, ...] | None = None

    #: Which `NativeOptions` kind this adapter accepts; None accepts none.
    native_options_kind: NativeOptionsKind | None = None

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

    #: Keystrokes that submit a message in this CLI's TUI, e.g. ("Enter",) or
    #: ("Escape", "Enter"). None = unknown; consumer falls back to its own.
    submit_keys: tuple[str, ...] | None = None

    #: When True, paste-buffer writes should collapse "\n" -> " " before send.
    #: None = the adapter does not specify; consumer keeps its own default.
    flatten_on_paste: bool | None = None

    #: Install/update metadata. None = not described by this adapter.
    install_meta: InstallMeta | None = None

    # ---- validation -----------------------------------------------------

    def validate_run_spec(self, spec: RunSpec) -> None:
        """Reject a RunSpec this adapter cannot honor. Pure: no filesystem or
        subprocess side effects. Raises `HarnessError` with a stable `code`.

        Order: backend, permission policy, native options.
        """
        validate_backend(spec.backend)

        policy = spec.permission_policy
        if policy not in PERMISSION_POLICIES:
            raise HarnessError(
                f"unknown permission_policy {policy!r}; expected one of {', '.join(PERMISSION_POLICIES)}",
                code="invalid-options",
            )
        if policy == "bypass" and self.permission_bypass_args is None:
            raise HarnessError(
                f"harness {self.name!r} has no permission bypass mapping; use permission_policy='upstream'",
                code="unsupported-capability",
            )

        native = spec.native_options
        if native is None:
            return
        if type(native) not in (ClaudeCodeOptions, CodexOptions):
            raise HarnessError(
                f"native_options must be ClaudeCodeOptions or CodexOptions, got {type(native).__name__}",
                code="invalid-options",
            )
        if native.kind != spec.harness or native.kind != self.native_options_kind:
            raise HarnessError(
                f"native_options kind {native.kind!r} does not apply to harness {self.name!r}",
                code="invalid-options",
            )
        if isinstance(native, ClaudeCodeOptions):
            if native.effort is not None and native.effort not in _CLAUDE_CODE_EFFORTS:
                raise HarnessError(
                    f"invalid claude-code effort {native.effort!r}; expected one of {', '.join(_CLAUDE_CODE_EFFORTS)}",
                    code="invalid-options",
                )
        else:
            if native.sandbox is not None and native.sandbox not in _CODEX_SANDBOXES:
                raise HarnessError(
                    f"invalid codex sandbox {native.sandbox!r}; expected one of {', '.join(_CODEX_SANDBOXES)}",
                    code="invalid-options",
                )
            if native.sandbox is not None and policy == "bypass":
                raise HarnessError(
                    "codex sandbox conflicts with permission_policy='bypass' (the bypass flag disables the sandbox); choose one",
                    code="invalid-options",
                )

    def resolve_run_spec(self, spec: RunSpec) -> ResolvedSpec:
        """Validate `spec` and resolve the adapter-facing model and extra argv.

        `model`: `spec.model` when non-empty, else `DEFAULT_MODEL`, then
        normalized for this harness (whitespace trimmed; provider prefixes
        adjusted unless `model_no_resolve`).
        """
        self.validate_run_spec(spec)
        model = normalize_model_for_harness(self.name, spec.model or self.DEFAULT_MODEL, resolve=not spec.model_no_resolve)
        permission_args = self.permission_bypass_args if spec.permission_policy == "bypass" else ()
        native_args: tuple[str, ...] = ()
        native = spec.native_options
        if isinstance(native, ClaudeCodeOptions) and native.effort is not None:
            native_args = ("--effort", native.effort)
        elif isinstance(native, CodexOptions) and native.sandbox is not None:
            native_args = ("--sandbox", native.sandbox)
        return ResolvedSpec(model=model, permission_args=permission_args or (), native_args=native_args)

    # ---- headless contract ----------------------------------------------

    def get_current_scroll_keys(self) -> ScrollKeys | None:
        """Return the chord map a consumer should forward right now, or None
        to fall through to tmux scrollback.

        Default: return None. Adapters override when the CLI has a
        virtualized scrollback that needs key forwarding (e.g. opencode
        always; claude-code only in `/tui fullscreen` mode).
        """
        return None

    @abstractmethod
    def build_command(self, spec: RunSpec) -> BuildCommand:
        """Build the subprocess command without executing it.

        MUST call `validate_run_spec`/`resolve_run_spec` before any side effect.
        MAY write files (instructions, config) as a side effect.
        MUST NOT fork a subprocess.
        """

    @abstractmethod
    def parse_output(self, spec: RunSpec, outcome: SubprocOutcome) -> ParsedOutput:
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
        return self._run_result(spec, outcome)

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
        return self._run_result(spec, outcome)

    def _run_result(self, spec: RunSpec, outcome: SubprocOutcome) -> RunResult:
        parsed = self.parse_output(spec, outcome)
        return RunResult(
            harness=self.name,
            model=spec.model or self.DEFAULT_MODEL,
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

    # ---- session-aware (optional; None = not supported by this adapter) --

    def detect_ready(self, pane: str) -> ReadyState | None:
        """Pure pane -> ready/loading/dialog. None when this adapter cannot tell."""
        return None

    def detect_status(self, pane: str) -> AgentStatus | None:
        """Pure pane -> live agent status. None when this adapter cannot tell."""
        return None

    def handle_dialog(self, pane: str) -> list[str] | None:
        """When detect_ready/detect_status report 'dialog', keystrokes to dismiss it; None otherwise."""
        return None

    def session_log_path(self, workdir: Path, session_started_after: float | None = None) -> str | None:
        """Where this CLI persists session data on disk. Pure path resolver.

        `session_started_after` is an epoch timestamp in seconds (TypeScript
        takes milliseconds); only logs modified at/after it are considered
        by adapters that honor the filter.
        """
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
