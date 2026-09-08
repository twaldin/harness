"""Core types: RunSpec (input), BuildCommand (pre-exec), RunResult (output), Adapter (ABC)."""
from __future__ import annotations

import asyncio
import os
from abc import ABC, abstractmethod
from dataclasses import dataclass, field, replace
from pathlib import Path
from threading import Event
from typing import TYPE_CHECKING, Awaitable, Callable, Literal, TypedDict, get_args

from harness.model_normalization import normalize_model_for_harness

if TYPE_CHECKING:
    from harness._subproc import SubprocOutcome

Backend = Literal["cli", "rpc", "sdk"]
PermissionPolicy = Literal["upstream", "bypass"]
Termination = Literal["exited", "signaled", "timed-out", "cancelled", "launch-failed", "callback-error"]
TimeoutKind = Literal["wall", "inactivity"]
OutputStream = Literal["stdout", "stderr"]
#: Receives decoded output chunks as they arrive. Chunk boundaries are
#: arbitrary (not line or JSONL framed); order is preserved per stream and
#: unspecified across streams. Synchronous callbacks must return None and
#: return promptly: they run cooperatively on the reading thread (`run`) or
#: the caller's event loop (`run_async`) and cannot be preempted. Async
#: callbacks are awaited one at a time on the caller's event loop; reading
#: pauses (backpressure) until the awaited callback settles.
OutputCallback = Callable[[str, OutputStream], "None | Awaitable[None]"]
#: Default per-stream capture cap in raw bytes (1 MiB).
DEFAULT_MAX_OUTPUT_BYTES = 1_048_576
ErrorCode = Literal[
    "adapter-error",
    "unknown-harness",
    "duplicate-adapter",
    "unsupported-backend",
    "unsupported-capability",
    "invalid-options",
    "instruction-conflict",
    "launch-failed",
    "protocol-error",
    "session-closed",
]
NativeOptionsKind = Literal["claude-code", "codex", "cline", "copilot", "amp", "mistral-vibe"]
ClaudeCodeEffort = Literal["low", "medium", "high", "xhigh", "max"]
CodexSandbox = Literal["read-only", "workspace-write", "danger-full-access"]
#: Signal the runner sends the owned process group once before escalating to
#: SIGKILL. SIGTERM is the default; adapters whose CLI only shuts down
#: cleanly on SIGINT declare it through `Adapter.graceful_signal`.
GracefulSignal = Literal["SIGTERM", "SIGINT"]

BACKENDS: tuple[Backend, ...] = get_args(Backend)
PERMISSION_POLICIES: tuple[PermissionPolicy, ...] = get_args(PermissionPolicy)
GRACEFUL_SIGNALS: tuple[GracefulSignal, ...] = get_args(GracefulSignal)
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


@dataclass(frozen=True)
class ClineOptions:
    """Typed `cline` CLI knobs. `provider` is emitted as `--provider <value>`
    and `auto_approve` as `--auto-approve true|false`, in that order.

    Both omitted: upstream configuration decides (no provider or approval
    flags are injected). An explicit `auto_approve` combined with
    `permission_policy="bypass"` is rejected: bypass is itself
    `--auto-approve true`, so the two would either duplicate or contradict.
    """

    kind: Literal["cline"] = field(default="cline", init=False)
    provider: str | None = None
    auto_approve: bool | None = None


@dataclass(frozen=True)
class CopilotOptions:
    """Typed `copilot` CLI tool-permission rules.

    Each `allow_tools` entry is emitted as `--allow-tool=<rule>` and each
    `deny_tools` entry as `--deny-tool=<rule>`, allows first, in the given
    order. Rules are passed through verbatim (upstream grammar such as
    `shell(git:*)`); members must be non-blank strings without NUL bytes.
    Lists are accepted alongside tuples for decoded-JSON parity. `deny_tools`
    may accompany `permission_policy="bypass"`: upstream applies deny rules
    over `--allow-all`.
    """

    kind: Literal["copilot"] = field(default="copilot", init=False)
    allow_tools: tuple[str, ...] | list[str] | None = None
    deny_tools: tuple[str, ...] | list[str] | None = None


@dataclass(frozen=True)
class AmpOptions:
    """Typed `amp` CLI knobs. `mode` is emitted as `--mode <value>`.

    Amp resolves the value against its built-in and plugin agent modes at
    runtime (key or label), so it is a non-blank, NUL-free string passed
    through verbatim rather than an enum. Omitted: upstream config decides.
    """

    kind: Literal["amp"] = field(default="amp", init=False)
    mode: str | None = None


@dataclass(frozen=True)
class VibeOptions:
    """Typed `vibe` (Mistral Vibe) CLI knobs. `agent` is emitted as
    `--agent=<name>` and `trust` as a bare `--trust` when True, in that order.

    `trust` marks the workdir as a trusted workspace so `vibe` reads its
    `AGENTS.md`; a non-empty `RunSpec.instructions` therefore requires
    `trust=True` and is otherwise rejected with `unsupported-capability`
    rather than projected silently. `trust=False` injects nothing.
    """

    kind: Literal["mistral-vibe"] = field(default="mistral-vibe", init=False)
    agent: str | None = None
    trust: bool | None = None


NativeOptions = ClaudeCodeOptions | CodexOptions | ClineOptions | CopilotOptions | AmpOptions | VibeOptions


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
                      (CLAUDE.md / AGENTS.md / GEMINI.md / ...). Planned by
                      `build_command`, projected into `workdir` by
                      `prepare_command` and restored by `cleanup_command`.
    `timeout_seconds` — wall-clock cap in seconds (default 1800). None
                      disables it; zero expires immediately after launch.
    `env`           — caller environment additions layered over the adapter's
                      own additions; the inherited process environment is
                      applied at execution. Never mutated by harness.
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
                      `CodexOptions`, `ClineOptions`, `CopilotOptions`,
                      `AmpOptions`, `VibeOptions`). The kind must match `harness`.
    `executable`    — overrides the adapter's default program: a bare binary
                      name resolved on PATH or an absolute path. Relative
                      paths containing separators are rejected.
    `config_home`   — absolute directory exported through the adapter's
                      `config_home_env` variable (e.g. CLAUDE_CONFIG_DIR).
                      Rejected with `unsupported-capability` when the adapter
                      declares no such variable.
    `config_file`   — absolute path passed verbatim through the adapter's
                      `config_file_flag` (e.g. `--settings`). Never opened,
                      copied or created by harness.
    `cancel`        — optional threading.Event. Setting it returns a cancelled
                      result after owned-process cleanup; a set event launches
                      nothing. Async Task.cancel instead propagates CancelledError.
    `stdin`         — UTF-8 text written to the child's stdin, then EOF. None
                      or "" closes stdin immediately. Never rewritten; there is
                      no prompt/approval channel.
    `on_output`     — `OutputCallback` receiving decoded stdout/stderr chunks
                      as they arrive (see `OutputCallback`). `run` accepts
                      synchronous callbacks only; `run_async` also awaits
                      async callbacks on the caller's event loop. A raised
                      callback stops the run with `termination="callback-error"`.
    `inactivity_timeout_seconds` — optional watchdog: seconds without any raw
                      stdout/stderr byte before the run is stopped with
                      `termination="timed-out"`, `timeout_kind="inactivity"`.
                      Silence alone is not failure: None (default) disables it.
                      Time spent waiting on an outstanding callback is excluded.
    `max_output_bytes` — per-stream capture cap in raw bytes (default 1 MiB).
                      Output beyond it is read and discarded, `RunResult`
                      flags `stdout_truncated` / `stderr_truncated`, and
                      callbacks still receive everything.
    """

    harness: str
    prompt: str
    workdir: Path
    model: str | None = None
    instructions: str | None = None
    timeout_seconds: float | None = 1800
    env: dict[str, str] = field(default_factory=dict)
    model_no_resolve: bool = False
    backend: Backend = "cli"
    permission_policy: PermissionPolicy = "upstream"
    native_options: NativeOptions | None = None
    executable: str | None = None
    config_home: Path | None = None
    config_file: Path | None = None
    cancel: Event | None = None
    stdin: str | None = None
    on_output: OutputCallback | None = None
    inactivity_timeout_seconds: float | None = None
    max_output_bytes: int = DEFAULT_MAX_OUTPUT_BYTES


@dataclass
class BuildCommand:
    """What to invoke — without invoking it.

    Returned by Adapter.build_command(). Building is pure with respect to the
    filesystem: nothing is written. `instructions_file` / `instruction_content`
    plan the projection that `prepare_command` performs and `cleanup_command`
    reverts; `directories` lists artifact parents prepare creates on demand.
    """

    cmd: str
    args: list[str]
    cwd: Path
    env: dict[str, str]
    instructions_file: Path | None
    instruction_content: str | None = None
    directories: tuple[Path, ...] = ()
    #: Model selection reported on `RunResult.model`: the requested model or
    #: the adapter default; None when selection is delegated to a
    #: caller-supplied config file.
    model: str | None = None
    #: Signal the runner sends the owned process group once before its
    #: SIGKILL escalation (see `Adapter.graceful_signal`); None keeps the
    #: default SIGTERM.
    graceful_signal: GracefulSignal | None = None


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
    config_home_env: str | None
    config_file_flag: str | None


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
    """Structured outcome of a single harness invocation.

    `stdout` / `stderr` hold the first `max_output_bytes` raw bytes of each
    stream decoded as UTF-8; `stdout_bytes` / `stderr_bytes` count everything
    the child wrote. `*_truncated` reports a cap hit or output lost to forced
    pipe closure. `callback_error` records an `on_output` failure or a
    callback still pending when teardown finished; `parse_error` records a
    `parse_output` exception (metrics and `raw` are then None). `timeout_kind`
    distinguishes the wall clock from the inactivity watchdog.
    """

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
    termination: Termination | None = None
    signal: str | None = None
    launch_error: str | None = None
    stdout_bytes: int = 0
    stderr_bytes: int = 0
    stdout_truncated: bool = False
    stderr_truncated: bool = False
    callback_error: str | None = None
    timeout_kind: TimeoutKind | None = None
    parse_error: str | None = None

    @property
    def ok(self) -> bool:
        return self.exit_code == 0 and not self.timed_out and self.callback_error is None and self.parse_error is None


@dataclass(frozen=True)
class ResolvedSpec:
    """Validated, adapter-resolved view of a RunSpec (see Adapter.resolve_run_spec)."""

    model: str | None
    permission_args: tuple[str, ...]
    native_args: tuple[str, ...]
    #: `(config_file_flag, config_file)` when `spec.config_file` is set, else empty.
    config_args: tuple[str, ...]


def absolute_workdir(workdir: Path | str) -> Path:
    """`workdir` as an absolute path against the current process cwd, without
    resolving symlinks or changing the global cwd."""
    if not isinstance(workdir, (str, os.PathLike)):
        raise HarnessError("workdir must be a path", code="invalid-options")
    text = os.fspath(workdir)
    if not isinstance(text, str) or not text or "\0" in text:
        raise HarnessError("workdir must be a non-empty path without NUL bytes", code="invalid-options")
    return Path(workdir).absolute()


def validate_backend(backend: object) -> None:
    """Reject backends this release cannot execute. `cli` is the only one implemented."""
    if backend == "cli":
        return
    if backend in BACKENDS:
        raise HarnessError(f"backend {backend!r} is not implemented; only 'cli' is available", code="unsupported-backend")
    raise HarnessError(f"unknown backend {backend!r}; expected one of {', '.join(BACKENDS)}", code="invalid-options")


def _absolute_option(name: str, value: object) -> Path:
    """`RunSpec.config_home` / `config_file` must be absolute, NUL-free paths."""
    if not isinstance(value, (str, os.PathLike)):
        raise HarnessError(f"{name} must be a path, got {type(value).__name__}", code="invalid-options")
    text = os.fspath(value)
    if not text or "\0" in text:
        raise HarnessError(f"{name} must be a non-empty path without NUL bytes", code="invalid-options")
    path = Path(text)
    if not path.is_absolute():
        raise HarnessError(f"{name} must be an absolute path, got {text!r}", code="invalid-options")
    return path


def _validate_tool_rules(name: str, rules: object) -> None:
    """`CopilotOptions.allow_tools` / `deny_tools`: None, or a tuple/list of
    non-blank, NUL-free strings (empty collections are valid)."""
    if rules is None:
        return
    if not isinstance(rules, (tuple, list)):
        raise HarnessError(f"copilot {name} must be a tuple or list of strings, got {type(rules).__name__}", code="invalid-options")
    for rule in rules:
        if not isinstance(rule, str) or not rule.strip() or "\0" in rule:
            raise HarnessError(f"copilot {name} entries must be non-blank strings without NUL bytes, got {rule!r}", code="invalid-options")


def snapshot_run_spec(spec: RunSpec) -> RunSpec:
    """Copy `spec` with its own `env` dict so later caller mutation cannot leak
    into an in-flight run."""
    return replace(spec, env=dict(spec.env))


def _validate_run_io(spec: RunSpec, *, synchronous: bool = False) -> None:
    """Apply the runner's I/O option rules to a RunSpec as `invalid-options`.

    `synchronous` additionally rejects async `on_output` callbacks, which
    the blocking entry point cannot await.
    """
    from harness._subproc import require_sync_callback, validate_io_options

    try:
        validate_io_options(
            timeout_seconds=spec.timeout_seconds,
            inactivity_timeout_seconds=spec.inactivity_timeout_seconds,
            max_output_bytes=spec.max_output_bytes,
            stdin=spec.stdin,
            on_output=spec.on_output,
        )
        if synchronous:
            require_sync_callback(spec.on_output)
    except (TypeError, ValueError) as exc:
        raise HarnessError(str(exc), code="invalid-options") from None



class Adapter(ABC):
    """Subclass per CLI. Each knows how to invoke its tool and parse its output.

    Implementations live in harness/adapters/*.py and self-register via
    `harness.registry.register(name, cls)` at import time.

    Minimal third-party interface: `name`, `instructions_filename`,
    `DEFAULT_MODEL`, `build_command`, `parse_output`. Custom `build_command`
    implementations MUST call `validate_run_spec` (or `resolve_run_spec`)
    first and return `finalize_command(...)`, so unsupported backends,
    policies and options are rejected and executable/config/env overrides are
    applied uniformly. Building never touches the filesystem.
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

    #: Environment variable that relocates the CLI's config/state home
    #: (e.g. CLAUDE_CONFIG_DIR). None: `RunSpec.config_home` is rejected.
    config_home_env: str | None = None

    #: Flag that passes a caller-selected config file path (e.g. --settings).
    #: None: `RunSpec.config_file` is rejected.
    config_file_flag: str | None = None

    #: Signal the runner sends this CLI's process group once when a run must
    #: stop (timeout, cancellation, leftover cleanup) before the bounded
    #: SIGKILL escalation. None: the default SIGTERM. Declare "SIGINT" only
    #: when the CLI shuts down cleanly on SIGINT but not on SIGTERM.
    graceful_signal: GracefulSignal | None = None

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

        Order: backend, permission policy, native options, executable,
        config_home, config_file, workdir, run I/O options (timeouts,
        stdin, on_output, max_output_bytes).
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
        if native is not None:
            self._validate_native_options(spec, native)

        executable = spec.executable
        if executable is not None:
            if not isinstance(executable, str) or not executable or "\0" in executable:
                raise HarnessError("executable must be a non-empty string without NUL bytes", code="invalid-options")
            separators = os.sep + (os.altsep or "")
            if not os.path.isabs(executable) and any(ch in executable for ch in separators):
                raise HarnessError(
                    f"executable {executable!r} is a relative path; use a bare binary name or an absolute path",
                    code="invalid-options",
                )

        if spec.config_home is not None:
            if self.config_home_env is None:
                raise HarnessError(
                    f"harness {self.name!r} has no config_home mapping; leave config_home unset",
                    code="unsupported-capability",
                )
            home = _absolute_option("config_home", spec.config_home)
            explicit = spec.env.get(self.config_home_env)
            if explicit is not None and explicit != str(home):
                raise HarnessError(
                    f"config_home conflicts with env[{self.config_home_env!r}]; set one of them",
                    code="invalid-options",
                )

        if spec.config_file is not None:
            if self.config_file_flag is None:
                raise HarnessError(
                    f"harness {self.name!r} has no config_file mapping; leave config_file unset",
                    code="unsupported-capability",
                )
            _absolute_option("config_file", spec.config_file)
        absolute_workdir(spec.workdir)
        _validate_run_io(spec)

    def _validate_native_options(self, spec: RunSpec, native: object) -> None:
        if type(native) not in (ClaudeCodeOptions, CodexOptions, ClineOptions, CopilotOptions, AmpOptions, VibeOptions):
            raise HarnessError(
                f"native_options must be ClaudeCodeOptions, CodexOptions, ClineOptions, CopilotOptions, AmpOptions or VibeOptions, got {type(native).__name__}",
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
        elif isinstance(native, CopilotOptions):
            _validate_tool_rules("allow_tools", native.allow_tools)
            _validate_tool_rules("deny_tools", native.deny_tools)
        elif isinstance(native, CodexOptions):
            if native.sandbox is not None and native.sandbox not in _CODEX_SANDBOXES:
                raise HarnessError(
                    f"invalid codex sandbox {native.sandbox!r}; expected one of {', '.join(_CODEX_SANDBOXES)}",
                    code="invalid-options",
                )
            if native.sandbox is not None and spec.permission_policy == "bypass":
                raise HarnessError(
                    "codex sandbox conflicts with permission_policy='bypass' (the bypass flag disables the sandbox); choose one",
                    code="invalid-options",
                )
        elif isinstance(native, ClineOptions):
            provider = native.provider
            if provider is not None and (not isinstance(provider, str) or not provider or "\0" in provider):
                raise HarnessError("cline provider must be None or a non-empty string without NUL bytes", code="invalid-options")
            auto_approve = native.auto_approve
            if auto_approve is not None and type(auto_approve) is not bool:
                raise HarnessError(
                    f"cline auto_approve must be None or a bool, got {type(auto_approve).__name__}",
                    code="invalid-options",
                )
            if auto_approve is not None and spec.permission_policy == "bypass":
                raise HarnessError(
                    "cline auto_approve conflicts with permission_policy='bypass' (bypass is --auto-approve true); choose one",
                    code="invalid-options",
                )
        elif isinstance(native, AmpOptions):
            mode = native.mode
            if mode is not None and (not isinstance(mode, str) or not mode.strip() or "\0" in mode):
                raise HarnessError("amp mode must be None or a non-blank string without NUL bytes", code="invalid-options")
        elif isinstance(native, VibeOptions):
            agent = native.agent
            if agent is not None and (not isinstance(agent, str) or not agent.strip() or "\0" in agent):
                raise HarnessError("mistral-vibe agent must be None or a non-blank string without NUL bytes", code="invalid-options")
            trust = native.trust
            if trust is not None and type(trust) is not bool:
                raise HarnessError(
                    f"mistral-vibe trust must be None or a bool, got {type(trust).__name__}",
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
        elif isinstance(native, ClineOptions):
            if native.provider is not None:
                native_args += ("--provider", native.provider)
            if native.auto_approve is not None:
                native_args += ("--auto-approve", "true" if native.auto_approve else "false")
        elif isinstance(native, CopilotOptions):
            native_args = (
                *(f"--allow-tool={rule}" for rule in native.allow_tools or ()),
                *(f"--deny-tool={rule}" for rule in native.deny_tools or ()),
            )
        elif isinstance(native, AmpOptions) and native.mode is not None:
            native_args = ("--mode", native.mode)
        elif isinstance(native, VibeOptions):
            if native.agent is not None:
                native_args += (f"--agent={native.agent}",)
            if native.trust is True:
                native_args += ("--trust",)
        config_args: tuple[str, ...] = ()
        if spec.config_file is not None:
            config_args = (self.config_file_flag, str(Path(spec.config_file)))  # type: ignore[assignment]
        return ResolvedSpec(model=model, permission_args=permission_args or (), native_args=native_args, config_args=config_args)

    def planned_instructions_file(self, spec: RunSpec) -> Path | None:
        """Absolute path `prepare_command` will project `spec.instructions` to,
        or None when this adapter has no instructions file or none were given."""
        if spec.instructions is None or not self.instructions_filename:
            return None
        return absolute_workdir(spec.workdir) / self.instructions_filename

    def reported_model(self, spec: RunSpec) -> str | None:
        """Model selection reported on `BuildCommand.model` / `RunResult.model`:
        the requested model or the adapter default. Adapters that delegate
        selection to a caller config file override this to return None."""
        return spec.model or self.DEFAULT_MODEL

    def finalize_command(
        self,
        spec: RunSpec,
        *,
        cmd: str,
        args: list[str],
        env: dict[str, str] | None = None,
        directories: tuple[Path, ...] = (),
        graceful_signal: GracefulSignal | None = None,
    ) -> BuildCommand:
        """Assemble the `BuildCommand` every builder returns. Pure.

        Applies `spec.executable`, the absolute cwd, env layering
        (adapter additions, then `spec.env`, then the config-home variable),
        the planned instructions projection, artifact directories, the
        reported model and the graceful signal (`graceful_signal` when given,
        else this adapter's declaration). Idempotent, so registry entrypoints
        re-apply it to third-party output.
        """
        cwd = absolute_workdir(spec.workdir)
        merged = {**(env or {}), **spec.env}
        if spec.config_home is not None and self.config_home_env is not None:
            merged[self.config_home_env] = str(Path(spec.config_home))
        instructions_file = self.planned_instructions_file(spec)
        signal_name = self.graceful_signal if graceful_signal is None else graceful_signal
        if signal_name is not None and signal_name not in GRACEFUL_SIGNALS:
            raise HarnessError(
                f"harness {self.name!r} declares graceful_signal {signal_name!r}; expected one of {', '.join(GRACEFUL_SIGNALS)}",
                code="adapter-error",
            )
        return BuildCommand(
            cmd=spec.executable or cmd,
            args=list(args),
            cwd=cwd,
            env=merged,
            instructions_file=instructions_file,
            instruction_content=spec.instructions if instructions_file is not None else None,
            directories=tuple(cwd / d for d in directories),
            model=self.reported_model(spec),
            graceful_signal=signal_name,
        )

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

        MUST call `validate_run_spec`/`resolve_run_spec` first and return
        `finalize_command(...)`. MUST NOT write files or fork a subprocess;
        `prepare_command` performs the planned filesystem work.
        """

    @abstractmethod
    def parse_output(self, spec: RunSpec, outcome: SubprocOutcome) -> ParsedOutput:
        """Parse adapter output after execution.

        Returns dict with keys: cost_usd, tokens_in, tokens_out, raw.
        MAY read files the CLI wrote (trajectory JSON, sqlite DB).
        MUST NOT block on I/O > 5s.
        """

    def _finalized(self, spec: RunSpec, built: BuildCommand) -> BuildCommand:
        """Re-apply the finalizer to any builder output (no-op for built-ins)."""
        return self.finalize_command(
            spec, cmd=built.cmd, args=built.args, env=built.env, directories=built.directories,
            graceful_signal=built.graceful_signal,
        )

    def run(self, spec: RunSpec) -> RunResult:
        """Full headless invocation: build_command + prepare + exec + parse_output + cleanup."""
        from harness._instructions import cleanup_command, prepare_command
        from harness._subproc import run_subprocess

        spec = snapshot_run_spec(spec)
        bc = self._finalized(spec, self.build_command(spec))
        _validate_run_io(spec, synchronous=True)
        prepared = prepare_command(bc)
        cleanup_safe = False
        try:
            try:
                outcome = run_subprocess(
                    [bc.cmd] + bc.args,
                    cwd=bc.cwd,
                    timeout_seconds=spec.timeout_seconds,
                    extra_env=bc.env,
                    stdin=spec.stdin,
                    on_output=spec.on_output,
                    inactivity_timeout_seconds=spec.inactivity_timeout_seconds,
                    max_output_bytes=spec.max_output_bytes,
                    cancel=spec.cancel,
                    graceful_signal=bc.graceful_signal or "SIGTERM",
                )
            except (ValueError, NotImplementedError, KeyboardInterrupt, SystemExit):
                # Validation precedes launch; control-flow exceptions follow teardown.
                cleanup_safe = True
                raise
            cleanup_safe = True
            return self._run_result(spec, bc, outcome)
        finally:
            if cleanup_safe:
                cleanup_command(prepared)

    async def run_async(self, spec: RunSpec) -> RunResult:
        """Async headless invocation: build_command + prepare + async exec + parse_output + cleanup."""
        from harness._instructions import cleanup_command, prepare_command
        from harness._subproc import run_subprocess_async

        spec = snapshot_run_spec(spec)
        bc = self._finalized(spec, self.build_command(spec))
        _validate_run_io(spec)
        prepared = prepare_command(bc)
        cleanup_safe = False
        try:
            try:
                outcome = await run_subprocess_async(
                    [bc.cmd] + bc.args,
                    cwd=bc.cwd,
                    timeout_seconds=spec.timeout_seconds,
                    extra_env=bc.env,
                    stdin=spec.stdin,
                    on_output=spec.on_output,
                    inactivity_timeout_seconds=spec.inactivity_timeout_seconds,
                    max_output_bytes=spec.max_output_bytes,
                    cancel=spec.cancel,
                    graceful_signal=bc.graceful_signal or "SIGTERM",
                )
            except asyncio.CancelledError as error:
                # The engine chains a teardown failure as the cancellation's cause.
                cleanup_safe = error.__cause__ is None
                raise
            except (ValueError, NotImplementedError, KeyboardInterrupt, SystemExit):
                cleanup_safe = True
                raise
            cleanup_safe = True
            return self._run_result(spec, bc, outcome)
        finally:
            if cleanup_safe:
                cleanup_command(prepared)

    def _run_result(self, spec: RunSpec, built: BuildCommand, outcome: SubprocOutcome) -> RunResult:
        parsed: ParsedOutput | dict = {}
        parse_error = None
        try:
            parsed = self.parse_output(spec, outcome)
        except Exception as exc:
            # Terminal stdout/stderr survive a parser failure; only the
            # metrics become unknown. Direct `parse_output` stays strict.
            parse_error = f"{type(exc).__name__}: {exc}"
        return RunResult(
            harness=self.name,
            model=built.model,
            exit_code=outcome.exit_code,
            duration_seconds=outcome.duration_seconds,
            stdout=outcome.stdout,
            stderr=outcome.stderr,
            timed_out=outcome.timed_out,
            termination=outcome.termination,
            signal=outcome.signal,
            launch_error=outcome.launch_error,
            cost_usd=parsed.get("cost_usd"),
            tokens_in=parsed.get("tokens_in"),
            tokens_out=parsed.get("tokens_out"),
            raw=parsed.get("raw"),
            stdout_bytes=outcome.stdout_bytes,
            stderr_bytes=outcome.stderr_bytes,
            stdout_truncated=outcome.stdout_truncated,
            stderr_truncated=outcome.stderr_truncated,
            callback_error=outcome.callback_error,
            timeout_kind=outcome.timeout_kind,
            parse_error=parse_error,
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
