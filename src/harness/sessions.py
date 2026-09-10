"""Live sessions — an owned child driven over JSONL, a caller-owned
OpenCode / OpenHands server driven over HTTP plus a live event stream,
or Amp threads driven through one-shot workers.

Six (harness, backend) pairs share one public surface:

- `pi` / `rpc`: `pi --mode rpc`, the native JSONL protocol on stdio.
- `omp` / `sdk`: an owned Bun child running the sibling `_omp_sdk.mjs` bridge,
  which loads the caller-installed `@oh-my-pi/pi-coding-agent` SDK from
  `OmpSdkOptions.package_root` and speaks the same request framing
  (`get_state` / `prompt` / `abort` responses). Native SDK events arrive
  wrapped as `{"type": "sdk_event", "event": {...}}` and are delivered with
  the native event as `raw`; the bridge's own `{"type": "sdk_settled"}` frame
  is the authoritative end of a turn and never enters an event queue.
- `claude-code` / `sdk`: an owned Python child running the sibling
  `_claude_sdk.py` worker, which loads the caller-installed
  `claude_agent_sdk` package (`ClaudeSdkOptions.package_root`, pinned
  version) and drives the caller-selected Claude Code executable
  (`cli_path`, exact version) through `ClaudeSDKClient`. Same framing as the
  OMP bridge plus: every raw native message is an `sdk_event` (control
  frames excluded), `sdk_settled` carries the native `result`, native
  permission prompts surface as `claude_permission` events answered with
  `respond_approval`, identity hooks surface as `claude_session_hook` and
  update `reference.session_file`, and a fatal native failure arrives as
  `sdk_failure`. Identity is *selected* at open (a fresh UUID passed as the
  native session ID, or the resumed transcript's ID) and only *observed* on
  the first native hook / init / result; `reference.session_file` stays None
  for a fresh session until a native hook reports the transcript path.
- `opencode` / `rpc`: direct HTTP requests plus the `GET /event` SSE stream of
  an `opencode serve` instance the caller already runs and owns
  (`OpenCodeOptions.endpoint`). No process is spawned; see `_opencode`.
- `openhands` / `rpc`: direct HTTP requests plus the `/sockets/session/{id}`
  WebSocket of an OpenHands Agent Server 1.45.0 the caller already runs and
  owns (`OpenHandsOptions.endpoint`). Nothing is spawned; see `_openhands`.
- `amp` / `sdk`: one finite Node worker (`_amp_sdk.mjs`) per operation, loading
  the caller-installed `@ampcode/sdk` from `AmpSdkOptions.package_root` and
  driving the pinned native CLI at `AmpSdkOptions.cli_path`. See `_amp`.

`open_session(spec)` spawns the child in its own POSIX process group (or opens
the HTTP transport), completes the identity handshake and returns a
`LiveSession`. Each `start_turn(prompt)` sends one prompt; the native event
stream is delivered through the turn's bounded async iterator and the turn
settles on the backend's terminal signal (Pi `agent_settled`, bridge
`sdk_settled`, OpenCode's synchronous prompt response plus `session.status`
idle) together with the prompt acknowledgement and any in-flight abort
acknowledgement. Frames that arrive while no turn is active flow through
`LiveSession.events`.

Only the Pi RPC protocol shipped with @earendil-works/pi-coding-agent 0.85.1
(`agent_settled` terminal event) is supported. `agent_end` is retained as the
completion payload but never treated as the end of a turn: the agent may still
retry, compact or continue after it. Local extension / slash prompts and
input-hook interceptions have no guaranteed terminal event; `timeout_seconds`
bounds them.

Transport or protocol failures invalidate the handle: the owned process group
receives SIGTERM, then SIGKILL after 500 ms, and pipes are drained for at most
one further second before the active turn settles with the failure status. The
SDK bridge / worker disposes its native session on SIGTERM/EOF and exits 0
only when that succeeded; a non-zero exit or a forced SIGKILL during
`close()` is reported as `adapter-error` after cleanup. A Claude worker that
loses its native child reports `sdk_failure` (status `exited` / `signaled` /
`disconnected` / `protocol-error`, native exit metadata in the frame's `raw`)
and the turn settles with that status; `SessionTurnResult.exit_code` /
`signal` always describe the owned worker, never the native child. An
OpenCode / OpenHands failure only closes the client-side connections: the
server and its session history belong to the caller and are never aborted,
disposed or deleted by this module.
"""
from __future__ import annotations

import abc
import asyncio
import json
import math
import os
import re
import signal
import sys
from collections import deque
from dataclasses import dataclass, field, replace
from pathlib import Path, PurePath
from typing import Coroutine, Literal
from urllib.parse import urlsplit

from harness._instructions import PreparedCommand, cleanup_command, prepare_command
from harness.base import (
    BACKENDS,
    PERMISSION_POLICIES,
    Backend,
    BuildCommand,
    ErrorCode,
    HarnessError,
    PermissionPolicy,
    absolute_workdir,
)
from harness.registry import _adapter_class

SessionTurnStatus = Literal[
    "completed",
    "agent-error",
    "stuck",
    "interrupted",
    "protocol-error",
    "disconnected",
    "timed-out",
    "closed",
    "exited",
    "signaled",
]

#: Byte cap on queued-but-unconsumed events per turn / idle stream (1 MiB).
DEFAULT_MAX_BUFFER_BYTES = 1_048_576
#: Largest single JSONL frame / SSE event / WebSocket message / HTTP JSON
#: body (bytes) accepted by this client. The OpenHands server's own frame
#: budget is larger (4 MiB); anything above this client cap is a protocol
#: failure here regardless of what the server would emit.
MAX_FRAME_BYTES = 1_048_576
#: Pi distribution whose RPC protocol this module is qualified against.
SUPPORTED_PI_DISTRIBUTION = "@earendil-works/pi-coding-agent 0.85.1"
#: OMP SDK distribution the `_omp_sdk.mjs` bridge is qualified against.
SUPPORTED_OMP_SDK_DISTRIBUTION = "@oh-my-pi/pi-coding-agent 18.1.14"
#: Exact `claude_agent_sdk` package version the `_claude_sdk.py` worker loads
#: from `ClaudeSdkOptions.package_root`; any other is `launch-failed`.
SUPPORTED_CLAUDE_SDK_DISTRIBUTION = "claude-agent-sdk 0.2.152"
#: Exact `claude --version` the worker requires of `ClaudeSdkOptions.cli_path`
#: before the native session is launched; any other is `launch-failed`.
SUPPORTED_CLAUDE_CLI_VERSION = "2.1.259"
#: Amp TypeScript SDK the `_amp_sdk.mjs` worker is qualified against.
SUPPORTED_AMP_SDK_DISTRIBUTION = "@ampcode/sdk 0.1.0-20260823161614-g3631dc6"
#: Native Amp CLI the worker verifies through `--version` before any thread call.
SUPPORTED_AMP_CLI_VERSION = "0.0.1788883237-g0b98e3"
#: Endpoint used when neither `spec.env` nor the process env sets `AMP_URL`.
DEFAULT_AMP_ENDPOINT = "https://ampcode.com"
#: Exact `GET /global/health` version of the OpenCode server this module is
#: qualified against (anomalyco/opencode v1.18.29); any other is rejected.
SUPPORTED_OPENCODE_SERVER_VERSION = "1.18.29"
#: Exact `GET /server_info` version (server, sdk, tools and workspace
#: packages alike) of the OpenHands Agent Server this module is qualified
#: against (OpenHands/software-agent-sdk v1.45.0); any other is rejected.
SUPPORTED_OPENHANDS_SERVER_VERSION = "1.45.0"

_READ_SIZE = 65536
_TICK = 0.02
_TERM_GRACE = 0.5
_DRAIN_BUDGET = 1.0
#: Qualified (harness, backend) pairs; every other combination is rejected.
#: `openhands` is session-only: it has no CLI adapter and no one-shot run.
_SESSION_BACKENDS: dict[str, Backend] = {"pi": "rpc", "omp": "sdk", "opencode": "rpc", "openhands": "rpc", "claude-code": "sdk", "amp": "sdk"}
_SDK_WORKER = Path(__file__).with_name("_omp_sdk.mjs")
_CLAUDE_WORKER = Path(__file__).with_name("_claude_sdk.py")
#: Child environment the SDK bridge owns (both pinned to `agent_dir` so the
#: selected profile is also the config root); conflicting caller entries are
#: rejected. `bun --no-env-file` only silences Bun's own dotenv loading; the
#: SDK still reads the selected profile / project / HOME dotenv files.
_SDK_OWNED_ENV = ("PI_CODING_AGENT_DIR", "PI_CONFIG_DIR")
#: Child environment the Claude worker owns (pinned to `config_dir`); a
#: conflicting caller entry is rejected. The worker inherits everything else.
_CLAUDE_OWNED_ENV = "CLAUDE_CONFIG_DIR"

OmpSdkAuth = Literal["local", "environment"]
OpenCodeAuth = Literal["none", "basic"]
ClaudeSettingSource = Literal["user", "project", "local"]
_CLAUDE_SETTING_SOURCES: tuple[ClaudeSettingSource, ...] = ("user", "project", "local")
#: Native reply literals accepted by `LiveSession.respond_approval` (OpenCode
#: and Claude). OpenCode's third literal `always` mutates the instance-wide
#: approved rules shared by every client of the caller's server and is
#: rejected as unsupported; Claude likewise gets no persistent rule, updated
#: input or permission-mode change through this channel.
OpenCodeApprovalResponse = Literal["once", "reject"]
#: Claude session identity: the native session ID is a UUID.
_UUID = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
#: OpenCode session identity as the server validates it: `ses_` prefix plus a
#: non-empty safe alphanumeric body (upstream checks the prefix only; the
#: full ID is verified with `GET /session/{id}`, never prefix-matched).
_OPENCODE_SESSION_ID = re.compile(r"ses_[0-9A-Za-z]+")
_CONTROL_CHARS = re.compile(r"[\x00-\x1f\x7f]")
#: Server-side profile name as both OpenHands profile stores validate it
#: (`PROFILE_NAME_PATTERN`): 1–64 chars, leading alphanumeric, then
#: alphanumerics, '.', '_' or '-'. Applied to `agent_profile` before any I/O
#: and to the referenced LLM profile name before it is fetched.
_OPENHANDS_PROFILE_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}")
#: Canonical lowercase hyphenated UUID, the only conversation identity form
#: the OpenHands server emits and this module generates.
_OPENHANDS_UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
_PRINTABLE_ASCII = re.compile(r"[\x21-\x7e]+")
#: Amp thread identity: `T-` plus a canonical lowercase UUID, never a prefix.
_AMP_SESSION_ID = re.compile(r"T-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
AmpEffort = Literal["none", "minimal", "low", "medium", "high", "xhigh", "max"]
AmpVisibility = Literal["private", "unlisted", "workspace", "group"]
_AMP_EFFORTS: tuple[str, ...] = ("none", "minimal", "low", "medium", "high", "xhigh", "max")
_AMP_VISIBILITIES: tuple[str, ...] = ("private", "unlisted", "workspace", "group")


# ── public types ────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class SessionReference:
    """Native identity of a session.

    `session_id`   — the full native session ID (never a prefix). Claude: the
                     UUID *selected* at open (fresh) or the resumed
                     transcript's UUID, confirmed against every native
                     event / hook that names one.
    `session_file` — absolute path of the native session log, or None while the
                     agent has not persisted the session yet. Always None for
                     OpenCode and Amp, whose history lives on a server.
                     Claude: None until a native hook reports transcript_path;
                     the exact supplied transcript on resume.
    `workdir`      — absolute directory the session was opened in. For
                     OpenCode this is the literal server-side directory.
    `endpoint`     — normalized OpenCode server or Amp service origin
                     (AMP_URL, default https://ampcode.com). None for
                     pi / omp / claude-code, which reject endpoint-bearing
                     references on resume.
    """

    session_id: str
    session_file: Path | None
    workdir: Path
    endpoint: str | None = None


@dataclass(frozen=True)
class OmpSdkOptions:
    """Where the `omp` / `sdk` bridge finds the caller's SDK and profile.

    Nothing here is guessed: every field is required and validated before any
    side effect.

    `package_root` — absolute directory of the caller-installed
                     `@oh-my-pi/pi-coding-agent` package the bridge imports.
    `agent_dir`    — absolute caller-selected profile directory; exported to
                     the child as `PI_CODING_AGENT_DIR`.
    `auth`         — "local" opens the profile credential database;
                     "environment" uses an in-memory credential database.
                     Both retain upstream environment/dotenv/models.yml auth.
    """

    package_root: Path
    agent_dir: Path
    auth: OmpSdkAuth


@dataclass(frozen=True)
class ClaudeSdkOptions:
    """Where the `claude-code` / `sdk` worker finds the caller's SDK, Claude
    Code executable and configuration. Nothing is guessed, discovered,
    installed or copied: every field is the caller's explicit selection.

    `package_root`    — absolute directory of the caller-installed
                        `claude_agent_sdk` package (named exactly that). The
                        worker puts its parent first on `sys.path`, imports
                        the package and requires that this directory at
                        version 0.2.152 is what was imported; the interpreter
                        (`SessionSpec.executable`) must provide the SDK's own
                        dependencies.
    `cli_path`        — absolute Claude Code executable; `--version` must
                        report exactly 2.1.259 (bounded probe) before the
                        native session is launched.
    `config_dir`      — absolute caller-selected `CLAUDE_CONFIG_DIR`,
                        exported to the worker and the CLI. The rest of the
                        environment is inherited; this is not a sandbox.
    `setting_sources` — exact native `--setting-sources` selection from
                        "user" / "project" / "local" (empty allowed, no
                        duplicates, omission invalid). `SessionSpec.instructions`
                        (projected `CLAUDE.md`) requires "project".
    `settings_file`   — optional absolute settings JSON passed as `--settings`.
    """

    package_root: Path
    cli_path: Path
    config_dir: Path
    setting_sources: tuple[ClaudeSettingSource, ...]
    settings_file: Path | None = None


@dataclass(frozen=True)
class OpenCodeOptions:
    """Where the caller's `opencode serve` instance is and how to authenticate.

    `endpoint` — absolute `http(s)://host[:port]` origin, nothing else (no
                 credentials, path, query or fragment); a single trailing
                 slash is tolerated and dropped. Scheme and host are
                 lowercased and a default port is dropped, matching the
                 TypeScript `URL.origin` form recorded in `SessionReference`.
    `auth`     — "none" sends no credentials; "basic" sends HTTP Basic auth
                 built from `username` / `password`, both required and
                 non-empty (username without ':'; neither with control
                 characters). Both are rejected with "none".

    Nothing is inferred: no default host, port, username, proxy or
    environment lookup. The password never appears in `repr`.
    """

    endpoint: str
    auth: OpenCodeAuth
    username: str | None = None
    password: str | None = field(default=None, repr=False)

@dataclass(frozen=True)
class OpenHandsOptions:
    """Where the caller's OpenHands Agent Server is, how to authenticate and
    which server-side agent profile to launch. Every field is required.

    `endpoint`      — absolute `http(s)://host[:port]` origin, normalized like
                      `OpenCodeOptions.endpoint` (no credentials, path, query
                      or fragment). No redirects, proxies or netrc.
    `api_key`       — session API key sent as `X-Session-API-Key` on every
                      HTTP request and as the first WebSocket frame
                      (`{"type": "auth", "session_api_key": ...}`), never in a
                      URL. Non-empty printable ASCII without whitespace
                      (0x21–0x7E); diagnostics never contain it and it is
                      hidden from `repr`. No ambient / environment lookup.
    `agent_profile` — exact name of the caller-selected server-side agent
                      profile (`GET /api/agent-profiles/{name}`); matches the
                      server's profile-name pattern. Nothing is listed,
                      discovered or seeded; the profile must be a native
                      `openhands` profile whose LLM profile's model equals
                      `SessionSpec.model`. Provider credentials stay on the
                      caller's server and are never read or copied.
    `confirm_no_unwanted_callbacks` — must be exactly True: the caller attests
                      the server has no webhook / callback configuration it
                      does not want triggered by this conversation. The
                      pinned server offers no way to verify or disable
                      server-level webhooks per conversation; this module
                      registers none and checks nothing.
    """

    endpoint: str
    api_key: str = field(repr=False)
    agent_profile: str
    confirm_no_unwanted_callbacks: bool



@dataclass(frozen=True)
class AmpSdkOptions:
    """Where the `amp` / `sdk` worker finds the caller's SDK and CLI and how
    it drives threads. Nothing is guessed or probed at validation; the worker
    verifies the CLI version and thread identity before any prompt.

    `package_root`  — absolute directory of the caller-installed `@ampcode/sdk`
                      package the worker imports.
    `cli_path`      — absolute path of the pinned native `amp` CLI the SDK
                      executes; nothing is looked up on PATH.
    `executor`      — only "local".
    `mode`          — non-blank, NUL-free native agent mode passed verbatim
                      (the SDK would otherwise select `medium` silently).
    `effort`        — optional native effort level.
    `visibility`    — optional visibility of a newly created thread; rejected
                      with `resume` (an existing thread's visibility is never
                      changed here).
    `settings_file` — optional absolute caller settings file for the CLI.

    Any other Amp knob (model, permission bypass, other executors) has no
    mapping and is rejected explicitly.
    """

    package_root: Path
    cli_path: Path
    executor: Literal["local"]
    mode: str
    effort: AmpEffort | None = None
    visibility: AmpVisibility | None = None
    settings_file: Path | None = None


@dataclass
class SessionSpec:
    """Everything needed to open a live session.

    `harness`         — "pi" / "opencode" / "openhands" (rpc), or "omp" /
                        "amp" / "claude-code" (sdk). Other registered harnesses
                        raise `unsupported-backend`; unknown names
                        `unknown-harness`. "openhands" exists only here:
                        it has no CLI adapter / one-shot run.
    `workdir`         — cwd for the child (absolute against the process cwd).
                        OpenCode / OpenHands: the explicit absolute POSIX
                        directory on the server, retained literally (no local
                        resolution, existence check or preparation);
                        noncanonical forms (`.`/`..` segments, empty segments,
                        trailing slash) are `invalid-options`.
    `backend`         — "rpc" with "pi" / "opencode" / "openhands" or "sdk"
                        with "omp" / "amp" / "claude-code"; other pairings and
                        "cli" raise `unsupported-backend`.
    `model`           — trimmed native selector for Pi / OMP / Claude;
                        OpenCode requires provider/model. None preserves
                        native selection; empty is invalid. Amp rejects model
                        because amp_sdk.mode owns routing.
                        OpenHands: REQUIRED exact native selector that must
                        equal the selected profile's `config.model`; it is
                        never normalized, defaulted or sent to the server.
    `env`             — additions layered over the inherited environment. The
                        omp sdk backend owns `PI_CODING_AGENT_DIR` and
                        `PI_CONFIG_DIR` (both agent_dir); Claude owns
                        `CLAUDE_CONFIG_DIR` (config_dir). Conflicting explicit
                        entries reject. Amp reads AMP_URL from the overlay or
                        inherited environment and pins AMP_SKIP_UPDATE_CHECK=1.
                        OpenCode / OpenHands reject a non-empty env.
    `executable`      — bare binary name or absolute path; default "pi" for
                        pi, "bun" for omp, "node" for amp, and
                        sys.executable for claude-code (an interpreter with
                        the selected SDK dependencies). This selects the
                        worker runtime, not the native SDK CLI.
                        OpenCode / OpenHands reject it.
    `permission_policy` — only "upstream"; "bypass" raises `unsupported-capability`.
    `instructions`    — projected to the adapter's instructions file
                        (`AGENTS.md`; `CLAUDE.md` for claude-code, which
                        requires "project" in `claude_sdk.setting_sources`)
                        under the workdir lease for the life of the process
                        tree. Rejected for OpenCode / OpenHands (no local
                        filesystem to project into).
    `resume`          — existing session to continue. Pi / OMP require
                        `session_file`; the file header is verified before
                        spawn and the native `get_state` ID after startup.
                        Claude requires an existing absolute transcript whose
                        native records name the exact UUID and the same
                        workdir; the worker resumes that file and verifies
                        the ID and transcript against every native hook.
                        OpenCode requires `session_file=None`, the same
                        `endpoint` / `workdir` and a full `ses_` ID, verified
                        with `GET /session/{id}` before anything else.
                        OpenHands requires `session_file=None`, the same
                        `endpoint` / `workdir` and the full canonical UUID,
                        verified with `GET /api/conversations/{uuid}` (never
                        created when missing). Amp requires `session_file=None`,
                        the same `workdir`, the computed `AMP_URL` endpoint
                        and a full `T-` UUID, verified through the SDK before
                        the first turn.
    `omp_sdk`         — required with harness "omp", rejected otherwise.
    `claude_sdk`      — required with harness "claude-code", rejected otherwise.
    `amp_sdk`         — required with harness "amp", rejected otherwise.
    `opencode`        — required with harness "opencode", rejected otherwise.
    `openhands`       — required with harness "openhands", rejected otherwise.
    `timeout_seconds` — wall-clock cap per turn (default 1800). None disables
                        it. Expiry tears the session down (`timed-out`).
    `request_timeout_seconds` — cap on every correlated request (default 30).
                        OpenCode: bounds every HTTP request except the
                        long-running prompt response (bounded by
                        `timeout_seconds`), the SSE handshake and the
                        settlement after an interrupt. OpenHands: bounds
                        every HTTP request, the WebSocket handshake / first
                        sync frame, user-message submission through its echo,
                        and settlement after an interrupt; the run itself is
                        bounded by `timeout_seconds`. Amp: bounds the open
                        worker and each turn's native initialization.
    `max_buffer_bytes` — cap on queued, unconsumed event bytes per turn and for
                        the idle stream (default 1 MiB). Overflow is never
                        silent: the session fails with `protocol-error`.
    """

    harness: str
    workdir: Path
    backend: Backend
    model: str | None = None
    env: dict[str, str] = field(default_factory=dict)
    executable: str | None = None
    permission_policy: PermissionPolicy = "upstream"
    instructions: str | None = None
    resume: SessionReference | None = None
    timeout_seconds: float | None = 1800
    request_timeout_seconds: float = 30
    max_buffer_bytes: int = DEFAULT_MAX_BUFFER_BYTES
    omp_sdk: OmpSdkOptions | None = None
    opencode: OpenCodeOptions | None = None
    openhands: OpenHandsOptions | None = None
    amp_sdk: AmpSdkOptions | None = None
    claude_sdk: ClaudeSdkOptions | None = None


@dataclass(frozen=True)
class SessionCapabilities:
    """Operations a (harness, backend) pair supports for live sessions."""

    backend: Backend
    events: bool
    interrupt: bool
    follow_up: bool
    resume: bool
    concurrent_turns: bool
    approval: bool


@dataclass(frozen=True)
class SessionEvent:
    """One native frame. `raw` is the parsed JSON object, untouched: the Pi
    RPC frame, native SDK event unwrapped from sdk_event (OMP / Claude)
    or amp_event (Amp), the OpenCode SSE event (`{"id", "type", "properties"}`)
    or the whole OpenHands session-socket envelope
    (`{"type", "seq"?, "event"?, ...}`). Claude also reports claude_permission /
    claude_permission_cancelled / claude_session_hook / claude_interrupt;
    permission request_id is explicitly bridge-local."""

    backend: Literal["rpc", "sdk"]
    harness: Literal["pi", "omp", "opencode", "openhands", "claude-code", "amp"]
    session_id: str
    turn_id: str | None
    request_id: str | None
    type: str
    raw: dict[str, object]


@dataclass(frozen=True)
class SessionTurnResult:
    """Terminal outcome of one turn.

    `raw` is the last `agent_end` payload, the rejecting `response` frame,
    the failing sdk_settled bridge frame, the native Claude result (or
    sdk_failure frame), or the native Amp result carried by amp_done.
    Native cumulative usage is retained, never aggregated.
    exit_code / signal describe the owned process leader while known;
    Claude native exit diagnostics remain inside sdk_failure raw. Amp instead
    reports the native turn exit and stderr capture carried by amp_done.
    """

    session_id: str
    turn_id: str
    status: SessionTurnStatus
    raw: dict[str, object] | None
    error: str | None
    exit_code: int | None
    signal: str | None
    stderr: str
    stderr_bytes: int
    stderr_truncated: bool
    events_truncated: bool


class _SessionEvents:
    """Single-consumer async iterator over `SessionEvent`s with a byte budget."""

    def __init__(self, cap: int) -> None:
        self._cap = cap
        self._items: deque[tuple[SessionEvent, int]] = deque()
        self._bytes = 0
        self._closed = False
        self._waiter: asyncio.Future[None] | None = None
        self._iterating = False
        self.truncated = False

    def _push(self, event: SessionEvent, size: int) -> bool:
        """Queue `event`; False when it would exceed the budget (not queued)."""
        if self._closed:
            return True
        # A waiting consumer already owns this delivery, as with a resolved
        # iterator promise in TypeScript; it does not occupy buffered capacity.
        if self._waiter is not None and not self._waiter.done() and not self._items:
            size = 0
        if self._bytes + size > self._cap:
            self.truncated = True
            return False
        self._items.append((event, size))
        self._bytes += size
        self._wake()
        return True

    def _close(self) -> None:
        self._closed = True
        self._wake()

    def _wake(self) -> None:
        if self._waiter is not None and not self._waiter.done():
            self._waiter.set_result(None)

    def __aiter__(self) -> _SessionEvents:
        if self._iterating:
            raise HarnessError("session events are single-consumer; the iterator is already in use", code="unsupported-capability")
        self._iterating = True
        return self

    async def __anext__(self) -> SessionEvent:
        while True:
            if self._items:
                event, size = self._items.popleft()
                self._bytes -= size
                return event
            if self._closed:
                raise StopAsyncIteration
            if self._waiter is not None:
                raise HarnessError("session events are single-consumer; another consumer is waiting", code="unsupported-capability")
            self._waiter = asyncio.get_running_loop().create_future()
            try:
                await self._waiter
            finally:
                self._waiter = None


@dataclass(frozen=True)
class SessionTurn:
    """Handle returned by `LiveSession.start_turn`."""

    id: str
    events: _SessionEvents
    _result: asyncio.Future[SessionTurnResult] = field(repr=False, compare=False)

    @property
    def result(self) -> asyncio.Future[SessionTurnResult]:
        """Settles exactly once with a `SessionTurnResult`; never raises.
        Cancelling the returned future does not disturb the turn."""
        return asyncio.shield(self._result)


# ── validation ──────────────────────────────────────────────────────────────


def get_session_capabilities(name: str, backend: Backend = "rpc") -> SessionCapabilities:
    """Live-session operations `name` supports on `backend`. Pure.

    Raises `unknown-harness` for unregistered names, `unsupported-backend` for
    registered harnesses without a session backend, for cli and for a
    backend the harness is not qualified on, and `invalid-options` for
    unknown backends.
    """
    _require_session_harness(name)
    _validate_session_backend(name, backend)
    return SessionCapabilities(
        backend=_SESSION_BACKENDS[name],
        events=True,
        interrupt=True,
        follow_up=True,
        resume=True,
        concurrent_turns=False,
        approval=name in ("opencode", "claude-code"),
    )


def _require_session_harness(name: str) -> None:
    """`unknown-harness` unless `name` is a CLI adapter or a session-only
    harness (`openhands`, which registers nothing in the CLI registry)."""
    if name not in _SESSION_BACKENDS:
        _adapter_class(name)


def _validate_session_backend(name: str, backend: object) -> None:
    if backend not in BACKENDS:
        raise HarnessError(f"unknown backend {backend!r}; expected one of {', '.join(BACKENDS)}", code="invalid-options")
    if backend == "cli":
        raise HarnessError("backend cli has no live sessions; select rpc or sdk for a supported harness", code="unsupported-backend")
    expected = _SESSION_BACKENDS.get(name)
    if expected is None:
        raise HarnessError(f"harness {name!r} has no live session support; qualified harnesses: {', '.join(_SESSION_BACKENDS)}", code="unsupported-backend")
    if backend != expected:
        raise HarnessError(f"harness {name!r} has no {backend} session support; use backend {expected!r}", code="unsupported-backend")


def _finite(name: str, value: object, *, minimum: float, exclusive: bool) -> None:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise HarnessError(f"{name} must be a finite number", code="invalid-options")
    if value < minimum or (exclusive and value == minimum):
        bound = "positive" if exclusive else "non-negative"
        raise HarnessError(f"{name} must be {bound}, got {value!r}", code="invalid-options")


def _validate_reference(reference: object) -> SessionReference:
    """Pi / OMP / Claude resume identity: a persisted session log under a
    matching workdir."""
    if not isinstance(reference, SessionReference):
        raise HarnessError("resume must be a SessionReference", code="invalid-options")
    if not isinstance(reference.session_id, str) or not reference.session_id:
        raise HarnessError("resume.session_id must be a non-empty native session ID", code="invalid-options")
    if reference.endpoint is not None:
        raise HarnessError("resume.endpoint names an OpenCode server; process-backed sessions resume from session_file only", code="invalid-options")
    if reference.session_file is None:
        raise HarnessError("resume requires session_file; the agent has not persisted this session yet", code="invalid-options")
    file = reference.session_file
    if not isinstance(file, (str, os.PathLike)) or not os.fspath(file) or "\0" in os.fspath(file):
        raise HarnessError("resume.session_file must be a NUL-free path", code="invalid-options")
    if not os.path.isabs(os.fspath(file)):
        raise HarnessError(f"resume.session_file {os.fspath(file)!r} must be absolute", code="invalid-options")
    workdir = absolute_workdir(reference.workdir)
    if not os.path.isabs(os.fspath(reference.workdir)):
        raise HarnessError(f"resume.workdir {os.fspath(reference.workdir)!r} must be absolute", code="invalid-options")
    return SessionReference(session_id=reference.session_id, session_file=Path(file), workdir=workdir)


def _validate_opencode_reference(reference: object, endpoint: str, workdir: Path) -> SessionReference:
    """OpenCode resume identity: full `ses_` ID on the same endpoint / server
    directory, no local file. The session itself is verified over HTTP."""
    if not isinstance(reference, SessionReference):
        raise HarnessError("resume must be a SessionReference", code="invalid-options")
    session_id = reference.session_id
    if not isinstance(session_id, str) or _OPENCODE_SESSION_ID.fullmatch(session_id) is None:
        raise HarnessError("resume.session_id must be a full OpenCode session ID ('ses_' followed by alphanumerics)", code="invalid-options")
    if reference.session_file is not None:
        raise HarnessError("resume.session_file must be None for OpenCode; history lives on the server", code="invalid-options")
    if reference.endpoint is None:
        raise HarnessError("resume.endpoint is required for OpenCode sessions", code="invalid-options")
    normalized = _normalize_endpoint(reference.endpoint, "resume.endpoint")
    if normalized != endpoint:
        raise HarnessError(f"resume.endpoint {normalized!r} does not match opencode.endpoint {endpoint!r}", code="invalid-options")
    if not isinstance(reference.workdir, (str, PurePath)) or _posix_dir(reference.workdir) != _posix_dir(workdir):
        raise HarnessError(f"resume.workdir {os.fspath(reference.workdir)!r} does not match the session workdir {_posix_dir(workdir)!r}", code="invalid-options")
    return SessionReference(session_id=session_id, session_file=None, workdir=workdir, endpoint=endpoint)


def _validate_openhands_reference(reference: object, endpoint: str, workdir: Path) -> SessionReference:
    """OpenHands resume identity: the full canonical conversation UUID on the
    same endpoint / server directory, no local file. The conversation itself
    is verified with `GET /api/conversations/{uuid}` and never created."""
    if not isinstance(reference, SessionReference):
        raise HarnessError("resume must be a SessionReference", code="invalid-options")
    session_id = reference.session_id
    if not isinstance(session_id, str) or _OPENHANDS_UUID.fullmatch(session_id) is None:
        raise HarnessError("resume.session_id must be the full canonical lowercase OpenHands conversation UUID", code="invalid-options")
    if reference.session_file is not None:
        raise HarnessError("resume.session_file must be None for OpenHands; history lives on the server", code="invalid-options")
    if reference.endpoint is None:
        raise HarnessError("resume.endpoint is required for OpenHands sessions", code="invalid-options")
    normalized = _normalize_endpoint(reference.endpoint, "resume.endpoint")
    if normalized != endpoint:
        raise HarnessError(f"resume.endpoint {normalized!r} does not match openhands.endpoint {endpoint!r}", code="invalid-options")
    if not isinstance(reference.workdir, (str, PurePath)) or _posix_dir(reference.workdir) != _posix_dir(workdir):
        raise HarnessError(f"resume.workdir {os.fspath(reference.workdir)!r} does not match the session workdir {_posix_dir(workdir)!r}", code="invalid-options")
    return SessionReference(session_id=session_id, session_file=None, workdir=workdir, endpoint=endpoint)


def _posix_dir(value: str | PurePath) -> str:
    return value.as_posix() if isinstance(value, PurePath) else value


def _validate_server_workdir(value: object) -> Path:
    """Remote (OpenCode / OpenHands) server directory: absolute, canonical
    POSIX, retained literally."""
    if not isinstance(value, (str, PurePath)):
        raise HarnessError("workdir must be a path", code="invalid-options")
    raw = _posix_dir(value)
    if not raw.startswith("/") or _CONTROL_CHARS.search(raw) is not None:
        raise HarnessError(f"workdir {raw!r} must be an absolute POSIX directory on the server", code="invalid-options")
    if raw != "/":
        segments = raw[1:].split("/")
        if any(segment in ("", ".", "..") for segment in segments):
            raise HarnessError(
                f"workdir {raw!r} must be canonical: no empty, '.' or '..' segments and no trailing slash",
                code="invalid-options",
            )
    return Path(raw)


def _normalize_endpoint(value: object, field: str = "opencode.endpoint") -> str:
    """`http(s)://host[:port]` origin, lowercase scheme / host, default port
    dropped; anything beyond the origin is rejected rather than trimmed."""
    if not isinstance(value, str) or not value:
        raise HarnessError(f"{field} must be a non-empty http(s) origin", code="invalid-options")
    if _CONTROL_CHARS.search(value) is not None or any(ch.isspace() for ch in value):
        raise HarnessError(f"{field} must not contain whitespace or control characters", code="invalid-options")
    if "\\" in value:
        raise HarnessError(f"{field} must not contain backslashes", code="invalid-options")
    if "?" in value or "#" in value:
        raise HarnessError(f"{field} must not carry a query or fragment", code="invalid-options")
    try:
        parts = urlsplit(value)
        port = parts.port
        hostname = parts.hostname
    except ValueError:
        raise HarnessError(f"{field} is not a valid URL", code="invalid-options") from None
    scheme = parts.scheme.lower()
    if scheme not in ("http", "https"):
        raise HarnessError(f"{field} must use http or https", code="invalid-options")
    if parts.username is not None or parts.password is not None or "@" in parts.netloc:
        raise HarnessError(f"{field} must not embed credentials; authenticate through the harness options", code="invalid-options")
    if not hostname or parts.netloc.endswith(":"):
        raise HarnessError(f"{field} has no host", code="invalid-options")
    if parts.path not in ("", "/"):
        raise HarnessError(f"{field} must be an origin without a path", code="invalid-options")
    host = parts.netloc.lower()
    if port is not None:
        host = host.rsplit(":", 1)[0]
        if port != (80 if scheme == "http" else 443):
            host = f"{host}:{port}"
    return f"{scheme}://{host}"


def _same_dir(a: str, b: Path) -> bool:
    if a == str(b):
        return True
    try:
        return os.path.realpath(a) == os.path.realpath(b)
    except OSError:
        return False


def _verify_session_header(reference: SessionReference, backend: Backend) -> None:
    """Read the exact native header, allowing OMP's single title preamble."""
    assert reference.session_file is not None
    path = reference.session_file
    try:
        with open(path, "rb") as fh:
            for index in range(2):
                line = fh.readline(MAX_FRAME_BYTES + 1)
                if len(line) > MAX_FRAME_BYTES:
                    raise ValueError("header exceeds byte bound")
                header = json.loads(line.decode("utf-8"))
                if index == 0 and backend == "sdk" and isinstance(header, dict) and header.get("type") == "title":
                    continue
                break
    except OSError as exc:
        raise HarnessError(f"cannot read resume.session_file {path}: {exc.strerror or exc}", code="invalid-options") from None
    except (UnicodeDecodeError, ValueError):
        raise HarnessError(f"resume.session_file {path} does not start with a bounded JSON session header", code="invalid-options") from None
    if not isinstance(header, dict) or header.get("type") != "session":
        raise HarnessError(f"resume.session_file {path} header is not type 'session'", code="invalid-options")
    if header.get("id") != reference.session_id:
        raise HarnessError(
            f"resume.session_file {path} belongs to session {header.get('id')!r}, not {reference.session_id!r}",
            code="invalid-options",
        )
    cwd = header.get("cwd")
    if not isinstance(cwd, str) or not _same_dir(cwd, reference.workdir):
        raise HarnessError(f"resume.session_file {path} was recorded in {cwd!r}, not {str(reference.workdir)!r}", code="invalid-options")


def _verify_claude_transcript(reference: SessionReference) -> None:
    """Bounded scan of a Claude JSONL transcript for its identity: the first
    native record carrying both `sessionId` (or `session_id`) and `cwd` must
    name the exact resumed UUID and the same workdir; any record naming a
    different session or directory rejects. Nothing is written or touched."""
    assert reference.session_file is not None
    path = reference.session_file
    identity = False
    scanned = 0
    try:
        with open(path, "rb") as fh:
            while scanned < MAX_FRAME_BYTES:
                line = fh.readline(MAX_FRAME_BYTES - scanned + 1)
                scanned += len(line)
                if not line:
                    break
                if scanned > MAX_FRAME_BYTES or not line.endswith(b"\n"):
                    raise ValueError("identity scan exceeds byte bound or ends in a partial record")
                stripped = line.strip()
                if not stripped:
                    continue
                record = json.loads(stripped.decode("utf-8"), parse_constant=_reject_constant)
                if not isinstance(record, dict):
                    raise ValueError("record is not a JSON object")
                session_id = record.get("sessionId", record.get("session_id"))
                cwd = record.get("cwd")
                if session_id is not None and session_id != reference.session_id:
                    raise HarnessError(
                        f"resume.session_file {path} belongs to session {session_id!r}, not {reference.session_id!r}",
                        code="invalid-options",
                    )
                if cwd is not None and (not isinstance(cwd, str) or not _same_dir(cwd, reference.workdir)):
                    raise HarnessError(f"resume.session_file {path} was recorded in {cwd!r}, not {str(reference.workdir)!r}", code="invalid-options")
                if session_id is not None and cwd is not None:
                    identity = True
                    break
    except OSError as exc:
        raise HarnessError(f"cannot read resume.session_file {path}: {exc.strerror or exc}", code="invalid-options") from None
    except (UnicodeDecodeError, ValueError):
        raise HarnessError(f"resume.session_file {path} is not a bounded Claude JSONL transcript", code="invalid-options") from None
    if not identity:
        raise HarnessError(
            f"resume.session_file {path} has no native record naming its session ID and cwd within the first {MAX_FRAME_BYTES} bytes",
            code="invalid-options",
        )


def _validate_session_spec(spec: SessionSpec) -> SessionSpec:
    """Validate and snapshot `spec` (absolute workdir, trimmed model, copied env)."""
    if not isinstance(spec, SessionSpec):
        raise HarnessError("open_session requires a SessionSpec", code="invalid-options")
    _require_session_harness(spec.harness)
    _validate_session_backend(spec.harness, spec.backend)
    if spec.permission_policy not in PERMISSION_POLICIES:
        raise HarnessError(
            f"unknown permission_policy {spec.permission_policy!r}; expected one of {', '.join(PERMISSION_POLICIES)}",
            code="invalid-options",
        )
    if spec.permission_policy == "bypass":
        raise HarnessError(f"{spec.harness} {spec.backend} sessions have no permission bypass mapping; use permission_policy='upstream'", code="unsupported-capability")
    model = spec.model
    if model is not None:
        if not isinstance(model, str):
            raise HarnessError("model must be None or a string", code="invalid-options")
        model = model.strip()
        if not model or "\0" in model:
            raise HarnessError("model must be a non-empty string without NUL bytes", code="invalid-options")
    if not isinstance(spec.env, dict) or any(
        not isinstance(k, str) or not isinstance(v, str) or "\0" in k or "\0" in v or "=" in k or not k for k, v in spec.env.items()
    ):
        raise HarnessError("env must map non-empty NUL-free names (without '=') to strings", code="invalid-options")
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
    if spec.instructions is not None and not isinstance(spec.instructions, str):
        raise HarnessError("instructions must be None or a string", code="invalid-options")
    if spec.timeout_seconds is not None:
        _finite("timeout_seconds", spec.timeout_seconds, minimum=0, exclusive=False)
    _finite("request_timeout_seconds", spec.request_timeout_seconds, minimum=0, exclusive=True)
    buffer = spec.max_buffer_bytes
    if isinstance(buffer, bool) or not isinstance(buffer, int) or not 0 <= buffer <= 9007199254740991:
        raise HarnessError(f"max_buffer_bytes must be a non-negative safe integer, got {buffer!r}", code="invalid-options")
    if spec.harness == "opencode":
        return _validate_opencode_spec(spec, model)
    if spec.harness == "openhands":
        return _validate_openhands_spec(spec, model)
    if spec.opencode is not None:
        raise HarnessError(f"opencode applies only to opencode rpc sessions, not {spec.harness} {spec.backend}", code="invalid-options")
    if spec.openhands is not None:
        raise HarnessError(f"openhands applies only to openhands rpc sessions, not {spec.harness} {spec.backend}", code="invalid-options")
    if spec.harness == "amp":
        return _validate_amp_spec(spec, model)
    if spec.amp_sdk is not None:
        raise HarnessError(f"amp_sdk applies only to amp sdk sessions, not {spec.harness} {spec.backend}", code="invalid-options")
    workdir = absolute_workdir(spec.workdir)
    resume = _validate_reference(spec.resume) if spec.resume is not None else None
    if resume is not None and not _same_dir(str(resume.workdir), workdir):
        raise HarnessError(
            f"resume.workdir {str(resume.workdir)!r} does not match the session workdir {str(workdir)!r}",
            code="invalid-options",
        )
    if resume is not None and spec.harness == "claude-code" and _UUID.fullmatch(resume.session_id) is None:
        raise HarnessError(f"resume.session_id {resume.session_id!r} must be a Claude session UUID", code="invalid-options")
    omp_sdk = _validate_omp_sdk(spec)
    claude_sdk = _validate_claude_sdk(spec)
    if spec.harness == "claude-code" and not spec.executable and not sys.executable:
        raise HarnessError("claude-code sdk sessions need executable: sys.executable is empty in this interpreter", code="invalid-options")
    return replace(spec, workdir=workdir, model=model, env=dict(spec.env), resume=resume, omp_sdk=omp_sdk, claude_sdk=claude_sdk)


def _validate_opencode_spec(spec: SessionSpec, model: str | None) -> SessionSpec:
    """OpenCode owns no process: everything process-shaped is rejected before
    any network side effect, and the server directory is kept literally."""
    if spec.env:
        raise HarnessError("env applies to spawned children; opencode sessions talk to a caller-owned server and reject a non-empty env", code="invalid-options")
    if spec.executable is not None:
        raise HarnessError("executable applies to spawned children; opencode sessions spawn nothing", code="invalid-options")
    if spec.instructions is not None:
        raise HarnessError("instructions cannot be projected into an OpenCode server directory; leave instructions unset", code="invalid-options")
    if spec.omp_sdk is not None:
        raise HarnessError("omp_sdk applies only to omp sdk sessions, not opencode rpc", code="invalid-options")
    if spec.openhands is not None:
        raise HarnessError("openhands applies only to openhands rpc sessions, not opencode rpc", code="invalid-options")
    if spec.claude_sdk is not None:
        raise HarnessError("claude_sdk applies only to claude-code sdk sessions, not opencode rpc", code="invalid-options")
    if spec.amp_sdk is not None:
        raise HarnessError("amp_sdk applies only to amp sdk sessions, not opencode rpc", code="invalid-options")
    if model is not None:
        provider, _, model_id = model.partition("/")
        if not provider or not model_id:
            raise HarnessError(f"model {model!r} must be 'provider/model' for opencode (both parts non-empty)", code="invalid-options")
    opencode = _validate_opencode_options(spec.opencode)
    workdir = _validate_server_workdir(spec.workdir)
    resume = _validate_opencode_reference(spec.resume, opencode.endpoint, workdir) if spec.resume is not None else None
    return replace(spec, workdir=workdir, model=model, env={}, resume=resume, opencode=opencode)


def _validate_openhands_spec(spec: SessionSpec, model: str | None) -> SessionSpec:
    """OpenHands owns no process either: process-shaped options are rejected
    before any network side effect, the model selector is mandatory and the
    server directory is kept literally."""
    if spec.env:
        raise HarnessError("env applies to spawned children; openhands sessions talk to a caller-owned server and reject a non-empty env", code="invalid-options")
    if spec.executable is not None:
        raise HarnessError("executable applies to spawned children; openhands sessions spawn nothing", code="invalid-options")
    if spec.instructions is not None:
        raise HarnessError("instructions cannot be projected into an OpenHands server directory; leave instructions unset", code="invalid-options")
    if spec.omp_sdk is not None:
        raise HarnessError("omp_sdk applies only to omp sdk sessions, not openhands rpc", code="invalid-options")
    if spec.claude_sdk is not None:
        raise HarnessError("claude_sdk applies only to claude-code sdk sessions, not openhands rpc", code="invalid-options")
    if spec.amp_sdk is not None:
        raise HarnessError("amp_sdk applies only to amp sdk sessions, not openhands rpc", code="invalid-options")
    if spec.opencode is not None:
        raise HarnessError("opencode applies only to opencode rpc sessions, not openhands rpc", code="invalid-options")
    if model is None:
        raise HarnessError("model is required for openhands sessions: the exact native selector the selected profile's LLM uses", code="invalid-options")
    openhands = _validate_openhands_options(spec.openhands)
    workdir = _validate_server_workdir(spec.workdir)
    resume = _validate_openhands_reference(spec.resume, openhands.endpoint, workdir) if spec.resume is not None else None
    return replace(spec, workdir=workdir, model=model, env={}, resume=resume, openhands=openhands)


def _validate_openhands_options(options: object) -> OpenHandsOptions:
    """Every field explicit and well-formed; the key is never echoed."""
    if not isinstance(options, OpenHandsOptions):
        raise HarnessError("openhands rpc sessions require openhands=OpenHandsOptions(endpoint, api_key, agent_profile, confirm_no_unwanted_callbacks)", code="invalid-options")
    if options.confirm_no_unwanted_callbacks is not True:
        raise HarnessError(
            "openhands.confirm_no_unwanted_callbacks must be exactly True: the caller attests the server has no unwanted webhook / callback configuration;"
            " the pinned server cannot verify or disable server-level webhooks per conversation",
            code="invalid-options",
        )
    endpoint = _normalize_endpoint(options.endpoint, "openhands.endpoint")
    api_key = options.api_key
    if not isinstance(api_key, str) or _PRINTABLE_ASCII.fullmatch(api_key) is None:
        raise HarnessError("openhands.api_key must be a non-empty printable ASCII token without whitespace", code="invalid-options")
    profile = options.agent_profile
    if not isinstance(profile, str) or _OPENHANDS_PROFILE_NAME.fullmatch(profile) is None:
        raise HarnessError(
            "openhands.agent_profile must be the exact server-side profile name: 1-64 characters, leading letter or digit, then letters, digits, '.', '_' or '-'",
            code="invalid-options",
        )
    return OpenHandsOptions(endpoint=endpoint, api_key=api_key, agent_profile=profile, confirm_no_unwanted_callbacks=True)


def _validate_opencode_options(options: object) -> OpenCodeOptions:
    if not isinstance(options, OpenCodeOptions):
        raise HarnessError("opencode rpc sessions require opencode=OpenCodeOptions(endpoint, auth)", code="invalid-options")
    endpoint = _normalize_endpoint(options.endpoint)
    if options.auth not in ("none", "basic"):
        raise HarnessError(f"opencode.auth must be 'none' or 'basic', got {options.auth!r}", code="invalid-options")
    username, password = options.username, options.password
    if options.auth == "none":
        if username is not None or password is not None:
            raise HarnessError("opencode.username / password apply only to auth='basic'", code="invalid-options")
        return OpenCodeOptions(endpoint=endpoint, auth="none")
    if not isinstance(username, str) or not username or ":" in username or _CONTROL_CHARS.search(username) is not None:
        raise HarnessError("opencode.username must be a non-empty string without ':' or control characters for auth='basic'", code="invalid-options")
    if not isinstance(password, str) or not password or _CONTROL_CHARS.search(password) is not None:
        raise HarnessError("opencode.password must be a non-empty string without control characters for auth='basic'", code="invalid-options")
    return OpenCodeOptions(endpoint=endpoint, auth="basic", username=username, password=password)


def _absolute_option(name: str, value: object) -> Path:
    if not isinstance(value, (str, os.PathLike)) or not os.fspath(value) or "\0" in os.fspath(value):
        raise HarnessError(f"{name} must be a non-empty NUL-free path", code="invalid-options")
    if not os.path.isabs(os.fspath(value)):
        raise HarnessError(f"{name} {os.fspath(value)!r} must be absolute", code="invalid-options")
    return Path(value)


def _validate_omp_sdk(spec: SessionSpec) -> OmpSdkOptions | None:
    """Snapshot `spec.omp_sdk`: required for omp, rejected otherwise.
    Nothing is defaulted or probed; a package that fails to load is the
    bridge's startup error (`launch-failed`), not a guess made here."""
    options = spec.omp_sdk
    if spec.harness != "omp":
        if options is not None:
            raise HarnessError(f"omp_sdk applies only to omp sdk sessions, not {spec.harness} {spec.backend}", code="invalid-options")
        return None
    if not isinstance(options, OmpSdkOptions):
        raise HarnessError("omp sdk sessions require omp_sdk=OmpSdkOptions(package_root, agent_dir, auth)", code="invalid-options")
    package_root = _absolute_option("omp_sdk.package_root", options.package_root)
    agent_dir = _absolute_option("omp_sdk.agent_dir", options.agent_dir)
    if options.auth not in ("local", "environment"):
        raise HarnessError(f"omp_sdk.auth must be 'local' or 'environment', got {options.auth!r}", code="invalid-options")
    for key in _SDK_OWNED_ENV:
        if key in spec.env and spec.env[key] != str(agent_dir):
            raise HarnessError(f"env[{key!r}]={spec.env[key]!r} conflicts with omp_sdk.agent_dir {str(agent_dir)!r}; omit it", code="invalid-options")
    for key in ("OMP_PROFILE", "PI_PROFILE"):
        if key in spec.env and spec.env[key] != "default":
            raise HarnessError(f"env[{key!r}] conflicts with the explicit SDK profile path; omit it", code="invalid-options")
    return OmpSdkOptions(package_root=package_root, agent_dir=agent_dir, auth=options.auth)


def _validate_claude_sdk(spec: SessionSpec) -> ClaudeSdkOptions | None:
    """Snapshot `spec.claude_sdk`: required for claude-code, rejected
    otherwise. Purely structural: a missing / wrong-version SDK or executable
    is the worker's startup failure (`launch-failed`)."""
    options = spec.claude_sdk
    if spec.harness != "claude-code":
        if options is not None:
            raise HarnessError(f"claude_sdk applies only to claude-code sdk sessions, not {spec.harness} {spec.backend}", code="invalid-options")
        return None
    if not isinstance(options, ClaudeSdkOptions):
        raise HarnessError(
            "claude-code sdk sessions require claude_sdk=ClaudeSdkOptions(package_root, cli_path, config_dir, setting_sources)",
            code="invalid-options",
        )
    package_root = _absolute_option("claude_sdk.package_root", options.package_root)
    cli_path = _absolute_option("claude_sdk.cli_path", options.cli_path)
    config_dir = _absolute_option("claude_sdk.config_dir", options.config_dir)
    sources = options.setting_sources
    if isinstance(sources, (str, bytes)) or not isinstance(sources, (list, tuple)):
        raise HarnessError("claude_sdk.setting_sources must be a sequence drawn from 'user', 'project', 'local' (empty allowed)", code="invalid-options")
    for source in sources:
        if source not in _CLAUDE_SETTING_SOURCES:
            raise HarnessError(f"claude_sdk.setting_sources entry {source!r} is not one of 'user', 'project', 'local'", code="invalid-options")
    if len(set(sources)) != len(sources):
        raise HarnessError("claude_sdk.setting_sources must not repeat a source", code="invalid-options")
    settings_file = _absolute_option("claude_sdk.settings_file", options.settings_file) if options.settings_file is not None else None
    if _CLAUDE_OWNED_ENV in spec.env and spec.env[_CLAUDE_OWNED_ENV] != str(config_dir):
        raise HarnessError(
            f"env[{_CLAUDE_OWNED_ENV!r}]={spec.env[_CLAUDE_OWNED_ENV]!r} conflicts with claude_sdk.config_dir {str(config_dir)!r}; omit it",
            code="invalid-options",
        )
    if spec.instructions is not None and "project" not in sources:
        raise HarnessError(
            "instructions are projected to CLAUDE.md, which Claude only reads with 'project' in claude_sdk.setting_sources; add it or omit instructions",
            code="invalid-options",
        )
    return ClaudeSdkOptions(
        package_root=package_root,
        cli_path=cli_path,
        config_dir=config_dir,
        setting_sources=tuple(sources),
        settings_file=settings_file,
    )
def _amp_endpoint(env: dict[str, str]) -> str:
    """Origin the Amp CLI will talk to: `AMP_URL` from `env`, else the
    inherited process environment, else `DEFAULT_AMP_ENDPOINT`; normalized
    like `opencode.endpoint` so references compare exactly."""
    value = env.get("AMP_URL", os.environ.get("AMP_URL", DEFAULT_AMP_ENDPOINT))
    return _normalize_endpoint(value, "env['AMP_URL']")


def _validate_amp_reference(reference: object, endpoint: str, workdir: Path) -> SessionReference:
    """Amp resume identity: full `T-` UUID on the same endpoint and workdir,
    no local file. The thread itself is verified by the worker before use."""
    if not isinstance(reference, SessionReference):
        raise HarnessError("resume must be a SessionReference", code="invalid-options")
    session_id = reference.session_id
    if not isinstance(session_id, str) or _AMP_SESSION_ID.fullmatch(session_id) is None:
        raise HarnessError("resume.session_id must be a full Amp thread ID ('T-' followed by a lowercase UUID)", code="invalid-options")
    if reference.session_file is not None:
        raise HarnessError("resume.session_file must be None for Amp; thread history lives on the Amp service", code="invalid-options")
    if reference.endpoint is None:
        raise HarnessError("resume.endpoint is required for Amp sessions", code="invalid-options")
    normalized = _normalize_endpoint(reference.endpoint, "resume.endpoint")
    if normalized != endpoint:
        raise HarnessError(f"resume.endpoint {normalized!r} does not match the AMP_URL endpoint {endpoint!r}", code="invalid-options")
    if not isinstance(reference.workdir, (str, os.PathLike)) or not os.path.isabs(os.fspath(reference.workdir)):
        raise HarnessError(f"resume.workdir {reference.workdir!r} must be absolute", code="invalid-options")
    if not _same_dir(os.fspath(reference.workdir), workdir):
        raise HarnessError(
            f"resume.workdir {os.fspath(reference.workdir)!r} does not match the session workdir {str(workdir)!r}",
            code="invalid-options",
        )
    return SessionReference(session_id=session_id, session_file=None, workdir=workdir, endpoint=endpoint)


def _validate_amp_options(options: object, resuming: bool) -> AmpSdkOptions:
    if not isinstance(options, AmpSdkOptions):
        raise HarnessError("amp sdk sessions require amp_sdk=AmpSdkOptions(package_root, cli_path, executor, mode)", code="invalid-options")
    package_root = _absolute_option("amp_sdk.package_root", options.package_root)
    cli_path = _absolute_option("amp_sdk.cli_path", options.cli_path)
    if options.executor != "local":
        raise HarnessError(f"amp_sdk.executor must be 'local', got {options.executor!r}; no other executor is qualified", code="unsupported-capability")
    mode = options.mode
    if not isinstance(mode, str) or not mode.strip() or "\0" in mode:
        raise HarnessError("amp_sdk.mode must be a non-blank string without NUL bytes; the SDK would otherwise select 'medium' silently", code="invalid-options")
    effort = options.effort
    if effort is not None and effort not in _AMP_EFFORTS:
        raise HarnessError(f"amp_sdk.effort must be one of {', '.join(_AMP_EFFORTS)}, got {effort!r}", code="invalid-options")
    visibility = options.visibility
    if visibility is not None:
        if visibility not in _AMP_VISIBILITIES:
            raise HarnessError(f"amp_sdk.visibility must be one of {', '.join(_AMP_VISIBILITIES)}, got {visibility!r}", code="invalid-options")
        if resuming:
            raise HarnessError("amp_sdk.visibility applies to thread creation only; an existing thread's visibility is never changed on resume", code="invalid-options")
    settings_file = None if options.settings_file is None else _absolute_option("amp_sdk.settings_file", options.settings_file)
    return AmpSdkOptions(
        package_root=package_root,
        cli_path=cli_path,
        executor="local",
        mode=mode,
        effort=effort,
        visibility=visibility,
        settings_file=settings_file,
    )


def _validate_amp_spec(spec: SessionSpec, model: str | None) -> SessionSpec:
    """Amp threads: the worker runtime is `executable` (Node), the CLI comes
    from `amp_sdk.cli_path`; there is no model flag and no mapped env owner
    besides the update check the worker pins."""
    if spec.claude_sdk is not None:
        raise HarnessError("claude_sdk applies only to claude-code sdk sessions, not amp sdk", code="invalid-options")
    if spec.omp_sdk is not None:
        raise HarnessError("omp_sdk applies only to omp sdk sessions, not amp sdk", code="invalid-options")
    if model is not None:
        raise HarnessError("model is not supported for amp; amp_sdk.mode selects routing", code="invalid-options")
    skip = spec.env.get("AMP_SKIP_UPDATE_CHECK")
    if skip is not None and skip != "1":
        raise HarnessError(f"env['AMP_SKIP_UPDATE_CHECK']={skip!r} conflicts with the worker's pinned value '1'; omit it", code="invalid-options")
    endpoint = _amp_endpoint(spec.env)
    workdir = absolute_workdir(spec.workdir)
    resume = _validate_amp_reference(spec.resume, endpoint, workdir) if spec.resume is not None else None
    amp_sdk = _validate_amp_options(spec.amp_sdk, resume is not None)
    return replace(spec, workdir=workdir, model=None, env=dict(spec.env), resume=resume, amp_sdk=amp_sdk)


def _build(spec: SessionSpec) -> BuildCommand:
    adapter_cls = _adapter_class(spec.harness)
    env = dict(spec.env)
    resume = None
    if spec.backend == "sdk" and spec.resume is not None:
        assert spec.resume.session_file is not None
        resume = {
            "sessionId": spec.resume.session_id,
            "sessionFile": str(spec.resume.session_file),
            "workdir": str(spec.resume.workdir),
        }
    if spec.harness == "claude-code":
        assert spec.claude_sdk is not None
        launch = {
            "packageRoot": str(spec.claude_sdk.package_root),
            "cliPath": str(spec.claude_sdk.cli_path),
            "configDir": str(spec.claude_sdk.config_dir),
            "settingSources": list(spec.claude_sdk.setting_sources),
            "settingsFile": None if spec.claude_sdk.settings_file is None else str(spec.claude_sdk.settings_file),
            "cwd": str(spec.workdir),
            "model": spec.model,
            "resume": resume,
        }
        cmd = spec.executable or sys.executable
        args = [str(_CLAUDE_WORKER), json.dumps(launch)]
        env[_CLAUDE_OWNED_ENV] = str(spec.claude_sdk.config_dir)
    elif spec.backend == "sdk":
        assert spec.omp_sdk is not None
        launch = {
            "packageRoot": str(spec.omp_sdk.package_root),
            "agentDir": str(spec.omp_sdk.agent_dir),
            "auth": spec.omp_sdk.auth,
            "cwd": str(spec.workdir),
            "model": spec.model,
            "resume": resume,
        }
        cmd = spec.executable or "bun"
        args = ["--no-env-file", str(_SDK_WORKER), json.dumps(launch)]
        for key in _SDK_OWNED_ENV:
            env[key] = str(spec.omp_sdk.agent_dir)
    else:
        cmd = spec.executable or "pi"
        args = ["--mode", "rpc"]
        if spec.model is not None:
            args += ["--model", spec.model]
        if spec.resume is not None:
            assert spec.resume.session_file is not None
            args += ["--session", str(spec.resume.session_file)]
    instructions_file = spec.workdir / adapter_cls.instructions_filename if spec.instructions is not None else None
    return BuildCommand(
        cmd=cmd,
        args=args,
        cwd=spec.workdir,
        env=env,
        instructions_file=instructions_file,
        instruction_content=spec.instructions if instructions_file is not None else None,
        model=spec.model,
    )


# ── internals ───────────────────────────────────────────────────────────────


class _Rejected(ValueError):
    pass


def _reject_constant(name: str) -> None:
    raise _Rejected(f"non-standard JSON constant {name}")


def _stringify(value: object) -> str:
    return value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)


@dataclass
class _Failure:
    status: SessionTurnStatus
    error: str | None


@dataclass
class _Pending:
    id: str
    command: str
    turn: _Turn | None
    future: asyncio.Future[dict[str, object] | None]
    timer: asyncio.TimerHandle


@dataclass
class _TurnBase:
    """State every backend keeps for the active turn."""

    handle: SessionTurn
    finished: bool = False
    timer: asyncio.TimerHandle | None = None


@dataclass
class _Turn(_TurnBase):
    prompt_id: str = ""
    settled: bool = False
    prompt_response: dict[str, object] | None = None
    abort_id: str | None = None
    abort_response: dict[str, object] | None = None
    last_end: dict[str, object] | None = None
    #: sdk: the `sdk_settled` bridge frame that reported an error, if any.
    sdk_failure: dict[str, object] | None = None
    #: claude-code: native `result` events observed during the turn (exactly
    #: one is required at settlement), the settled native result and the
    #: `sdk_failure` frame, if any.
    native_results: int = 0
    native_result: dict[str, object] | None = None
    failure_frame: dict[str, object] | None = None


class _Stderr:
    """Bounded prefix capture of the child's stderr."""

    def __init__(self, cap: int) -> None:
        self.cap = cap
        self.total = 0
        self.truncated = False
        self._prefix = bytearray()

    def feed(self, chunk: bytes) -> None:
        self.total += len(chunk)
        room = self.cap - len(self._prefix)
        if room >= len(chunk):
            self._prefix += chunk
        else:
            if room > 0:
                self._prefix += chunk[:room]
            self.truncated = True

    def text(self) -> str:
        return self._prefix.decode("utf-8", "replace")


class LiveSession(abc.ABC):
    """An open live session. Create with `open_session`.

    One turn at a time; the next `start_turn` after a settled result is a
    follow-up in the same native session. Use as an async context manager or
    call `close()`; both are idempotent and safe to call concurrently.

    Backends implement the transport; this base owns the turn slot, the
    bounded event queues, single-shot failure / teardown and the result shape.
    """

    def __init__(self, spec: SessionSpec) -> None:
        self._spec = spec
        self._loop = asyncio.get_running_loop()
        self._reference: SessionReference | None = None
        self._idle = _SessionEvents(spec.max_buffer_bytes)
        self._active: _TurnBase | None = None
        self._failure: _Failure | None = None
        self._teardown_task: asyncio.Task[None] | None = None
        self._tasks: list[asyncio.Task[None]] = []
        self._turn_seq = 0
        self._abandoned = False
        #: Observed leader exit / stderr; stay at their zero values for
        #: backends without a child (no exit, no stderr, no fabricated telemetry).
        self._returncode: int | None = None
        self._stderr = _Stderr(spec.max_buffer_bytes)

    # ---- public surface ---------------------------------------------------

    @property
    def spec(self) -> SessionSpec:
        """Validated snapshot of the opening spec (own env copy)."""
        return replace(self._spec, env=dict(self._spec.env))

    @property
    def reference(self) -> SessionReference:
        assert self._reference is not None
        return self._reference

    @property
    def events(self) -> _SessionEvents:
        """Frames that arrive while no turn is active (single consumer)."""
        return self._idle

    @property
    def closed(self) -> bool:
        return self._failure is not None

    @property
    def active(self) -> SessionTurn | None:
        return None if self._active is None or self._active.finished else self._active.handle

    async def __aenter__(self) -> LiveSession:
        return self

    async def __aexit__(self, *_exc: object) -> None:
        await self.close()

    def start_turn(self, prompt: str) -> SessionTurn:
        """Reserve the turn slot and send `prompt`. Synchronous: the slot is
        taken before this returns, the write happens on the event loop.

        Prompts are forwarded verbatim. Pi handles local extension / slash
        commands and input-hook interceptions without a guaranteed terminal
        event; such turns end only through `timeout_seconds` (`timed-out`).
        """
        if not isinstance(prompt, str) or "\0" in prompt:
            raise HarnessError("prompt must be a string without NUL bytes", code="invalid-options")
        if not prompt.strip():
            raise HarnessError("prompt must not be empty", code="invalid-options")
        self._check_open()
        if self._busy():
            raise HarnessError("a turn is already active; await its result before starting another", code="unsupported-capability")
        self._turn_seq += 1
        handle = SessionTurn(id=f"turn-{self._turn_seq}", events=_SessionEvents(self._spec.max_buffer_bytes), _result=self._loop.create_future())
        turn = self._begin_turn(handle, prompt)
        self._active = turn
        if self._spec.timeout_seconds is not None:
            turn.timer = self._loop.call_later(self._spec.timeout_seconds, self._on_turn_timeout, turn)
        return handle

    async def interrupt(self) -> None:
        """Abort the active turn and wait for it to settle. The turn reports
        `interrupted` only when the backend confirms the abort; a turn that
        completed normally in the meantime stays `completed`. Cancelling the
        caller closes the session (teardown completes before propagating)."""
        self._check_open()
        turn = self._active
        if turn is None or turn.finished:
            raise HarnessError("no active turn to interrupt", code="unsupported-capability")
        try:
            await self._abort(turn)
            await asyncio.shield(turn.handle._result)
        except asyncio.CancelledError:
            self._fail("closed", "interrupt caller cancelled")
            assert self._teardown_task is not None
            await self._uncancellable(self._teardown_task)
            raise

    async def respond_approval(self, request_id: str, response: OpenCodeApprovalResponse) -> None:
        """Answer an outstanding native permission request (`approval`
        capability): OpenCode `permission.asked` (see `_opencode`) or a Claude
        `claude_permission` event (see `_ProcessSession`). OpenHands has no
        approval channel here: a native `waiting_for_confirmation` fails the
        turn explicitly instead."""
        raise HarnessError(f"{self._spec.harness} {self._spec.backend} sessions have no approval channel; permissions stay upstream", code="unsupported-capability")

    async def close(self) -> None:
        """Release the transport (owned process group, or client connections),
        settle the active turn as `closed`. Raises if teardown could not fully
        release resources; cancellation waits for teardown before propagating."""
        self._fail("closed", None)
        assert self._teardown_task is not None
        await self._uncancellable(self._teardown_task)

    # ---- backend hooks ----------------------------------------------------

    @abc.abstractmethod
    def _begin_turn(self, handle: SessionTurn, prompt: str) -> _TurnBase:
        """Create the backend turn for `handle` and schedule the prompt; the
        base installs it as the active turn and arms `timeout_seconds`."""

    @abc.abstractmethod
    async def _abort(self, turn: _TurnBase) -> None:
        """Request the native abort of `turn` (idempotent per turn)."""

    @abc.abstractmethod
    async def _teardown(self) -> None:
        """Release every owned resource after `_fail`; settle the active turn
        with the recorded failure and close the idle stream. Must complete
        even when awaited under cancellation."""

    @abc.abstractmethod
    def _abandon(self) -> None:
        """Caller gave up during open: tear down now or as soon as possible."""

    # ---- shared helpers ---------------------------------------------------

    def _check_open(self) -> None:
        if self._failure is not None:
            detail = self._failure.status if self._failure.error is None else f"{self._failure.status}: {self._failure.error}"
            raise HarnessError(f"session is closed ({detail})", code="session-closed")

    def _busy(self) -> bool:
        return self._active is not None and not self._active.finished

    def _spawn(self, coro: Coroutine[object, object, None]) -> asyncio.Task[None]:
        task = self._loop.create_task(coro)
        self._tasks.append(task)
        task.add_done_callback(self._tasks.remove)
        return task

    async def _uncancellable(self, task: asyncio.Task[None]) -> None:
        """Await `task` to completion even if this coroutine is cancelled;
        the cancellation propagates afterwards, chained to any task error."""
        cancelled: asyncio.CancelledError | None = None
        while not task.done():
            try:
                await asyncio.shield(task)
            except asyncio.CancelledError as exc:
                cancelled = exc
            except BaseException:
                pass  # task finished with an error; re-raised by result() below
        if cancelled is not None:
            raise cancelled from (None if task.cancelled() else task.exception())
        return task.result()

    def _fail(self, status: SessionTurnStatus, error: str | None) -> None:
        """Record the single failure that invalidates the handle and start teardown."""
        if self._failure is not None:
            return
        self._failure = _Failure(status, error)
        self._teardown_task = self._loop.create_task(self._teardown())

    def _on_turn_timeout(self, turn: _TurnBase) -> None:
        if turn.finished:
            return
        self._fail("timed-out", f"turn {turn.handle.id} exceeded timeout_seconds={self._spec.timeout_seconds}")

    def _enqueue(self, event: SessionEvent, turn: _TurnBase | None, size: int) -> None:
        """Queue `event` on the turn or idle stream; overflow fails the session."""
        queue = self._idle if turn is None else turn.handle.events
        if not queue._push(event, size):
            where = "idle event stream" if turn is None else f"turn {turn.handle.id}"
            self._fail("protocol-error", f"{where} exceeded max_buffer_bytes={self._spec.max_buffer_bytes} of unconsumed events")

    def _finish(self, turn: _TurnBase, status: SessionTurnStatus, raw: dict[str, object] | None, error: str | None) -> None:
        turn.finished = True
        if turn.timer is not None:
            turn.timer.cancel()
        result = SessionTurnResult(
            session_id=self.reference.session_id,
            turn_id=turn.handle.id,
            status=status,
            raw=raw,
            error=error,
            exit_code=self._returncode,
            signal=_signal_name(self._returncode),
            stderr=self._stderr.text(),
            stderr_bytes=self._stderr.total,
            stderr_truncated=self._stderr.truncated,
            events_truncated=turn.handle.events.truncated,
        )
        if not turn.handle._result.done():
            turn.handle._result.set_result(result)
        turn.handle.events._close()


class _ProcessSession(LiveSession):
    """An owned session child: `pi --mode rpc`, the OMP SDK bridge or the
    Claude SDK worker."""

    _active: _Turn | None

    def __init__(self, spec: SessionSpec, prepared: PreparedCommand) -> None:
        super().__init__(spec)
        self._prepared = prepared
        self._sdk = spec.backend == "sdk"
        self._claude = spec.harness == "claude-code"
        self._child = "claude sdk worker" if self._claude else "omp sdk bridge" if self._sdk else "pi"
        #: claude-code: bridge approval IDs announced by `claude_permission`
        #: and not yet answered, cancelled or ended with their turn.
        self._approvals: set[str] = set()
        self._proc: asyncio.subprocess.Process | None = None
        self._pending: dict[str, _Pending] = {}
        self._write_lock = asyncio.Lock()
        self._exited = asyncio.Event()
        self._request_seq = 0
        self._prelude: list[tuple[dict[str, object], str, int]] = []
        self._prelude_bytes = 0

    # ---- public surface ---------------------------------------------------

    async def respond_approval(self, request_id: str, response: OpenCodeApprovalResponse) -> None:
        """Answer a Claude `claude_permission` event (`request_id` is its
        bridge-local `id`). `once` allows the call with its original input;
        `reject` denies it with a fixed message. No persistent rule, updated
        input, permission-mode change or bypass can be granted here: `always`
        is refused before any request. The worker validates the ID again;
        unknown, already answered, cancelled or ended requests are
        `invalid-options`. Cancelling the caller closes the session."""
        if not self._claude:
            await super().respond_approval(request_id, response)
            return
        if not isinstance(request_id, str) or not request_id:
            raise HarnessError("request_id must be the non-empty id of a claude_permission event", code="invalid-options")
        if response == "always":
            raise HarnessError(
                "approval response 'always' would persist a native permission rule; only 'once' and 'reject' are supported",
                code="unsupported-capability",
            )
        if response not in ("once", "reject"):
            raise HarnessError(f"approval response must be 'once' or 'reject', got {response!r}", code="invalid-options")
        self._check_open()
        if request_id not in self._approvals:
            raise HarnessError(f"no outstanding permission request {request_id!r} on session {self.reference.session_id}", code="invalid-options")
        # Reserve before yielding; concurrent callers cannot reply twice.
        self._approvals.discard(request_id)
        self._request_seq += 1
        pending = self._register(f"req-{self._request_seq}", "approval", None)
        try:
            await self._send({"id": pending.id, "type": "approval", "approvalId": request_id, "response": response})
            reply = await asyncio.shield(pending.future)
        except asyncio.CancelledError:
            self._fail("closed", "approval caller cancelled")
            assert self._teardown_task is not None
            await self._uncancellable(self._teardown_task)
            raise
        if reply is None:
            self._check_open()
            raise HarnessError(f"approval {request_id!r} was not acknowledged before the session closed", code="session-closed")
        if reply["success"] is False:
            raise HarnessError(f"approval {request_id!r} rejected by the worker: {_stringify(reply.get('error') or 'no error given')}", code="invalid-options")

    # ---- backend hooks ----------------------------------------------------

    def _begin_turn(self, handle: SessionTurn, prompt: str) -> _Turn:
        self._request_seq += 1
        request_id = f"req-{self._request_seq}"
        turn = _Turn(handle=handle, prompt_id=request_id)
        self._register(request_id, "prompt", turn)
        self._spawn(self._send({"id": request_id, "type": "prompt", "message": prompt}))
        return turn

    async def _abort(self, turn: _TurnBase) -> None:
        """Pi confirms with stopReason aborted or an acknowledged abort with no
        assistant message; the write completes even if the caller is cancelled."""
        assert isinstance(turn, _Turn)
        if turn.abort_id is None:
            self._request_seq += 1
            turn.abort_id = f"req-{self._request_seq}"
            self._register(turn.abort_id, "abort", turn)
            await self._uncancellable(self._loop.create_task(self._send({"id": turn.abort_id, "type": "abort"})))
        if self._claude:
            pending = self._pending.get(turn.abort_id)
            if pending is not None:
                await asyncio.shield(pending.future)
            response = turn.abort_response
            if response is not None and response["success"] is False:
                raise HarnessError(f"interrupt failed: {_stringify(response.get('error') or 'no error given')}", code="adapter-error")

    def _busy(self) -> bool:
        return super()._busy() or any(p.turn is not None for p in self._pending.values())

    def _abandon(self) -> None:
        self._abandoned = True
        if self._proc is not None:
            self._fail("closed", None)

    # ---- requests ---------------------------------------------------------

    def _register(self, request_id: str, command: str, turn: _Turn | None) -> _Pending:
        timeout = self._spec.request_timeout_seconds
        pending = _Pending(
            id=request_id,
            command=command,
            turn=turn,
            future=self._loop.create_future(),
            timer=self._loop.call_later(timeout, self._on_request_timeout, request_id),
        )
        self._pending[request_id] = pending
        return pending

    def _on_request_timeout(self, request_id: str) -> None:
        pending = self._pending.get(request_id)
        if pending is None:
            return
        self._fail("protocol-error", f"{pending.command} request {request_id} received no response within {self._spec.request_timeout_seconds}s")

    async def _send(self, payload: dict[str, object]) -> None:
        data = json.dumps(payload).encode("utf-8") + b"\n"
        try:
            async with self._write_lock:
                if self._failure is not None:
                    return
                assert self._proc is not None and self._proc.stdin is not None
                self._proc.stdin.write(data)
                await self._proc.stdin.drain()
        except (BrokenPipeError, ConnectionResetError, OSError, RuntimeError) as exc:
            if self._failure is None:
                await self._classify_transport_loss(f"stdin write failed: {type(exc).__name__}: {exc}")

    # ---- frame handling ---------------------------------------------------

    def _handle_line(self, line: bytes) -> None:
        if self._failure is not None:
            return
        if len(line) > MAX_FRAME_BYTES:
            self._fail("protocol-error", f"frame of {len(line)} bytes exceeds {MAX_FRAME_BYTES}")
            return
        try:
            text = line.decode("utf-8")
        except UnicodeDecodeError as exc:
            self._fail("protocol-error", f"frame is not valid UTF-8: {exc.reason} at byte {exc.start}")
            return
        try:
            frame = json.loads(text, parse_constant=_reject_constant)
        except ValueError as exc:
            self._fail("protocol-error", f"frame is not valid JSON: {exc}")
            return
        if not isinstance(frame, dict):
            self._fail("protocol-error", f"frame is a JSON {type(frame).__name__}, not an object")
            return
        kind = frame.get("type")
        if not isinstance(kind, str) or not kind:
            self._fail("protocol-error", "frame has no string 'type'")
            return
        turn = self._active if self._active is not None and not self._active.finished else None
        pending: _Pending | None = None
        if kind == "response":
            pending = self._match_response(frame)
            if pending is None:
                return
            turn = pending.turn or turn
        elif self._sdk:
            # The bridge speaks exactly three frame types: correlated
            # responses, wrapped native events and its own settlement; the
            # Claude worker adds identity updates and fatal failures.
            if kind == "sdk_settled":
                self._settle_sdk(turn, frame)
                return
            if self._claude and kind == "sdk_failure":
                self._fail_sdk(turn, frame)
                return
            if self._claude and kind == "sdk_reference":
                self._deliver(frame, kind, None, len(line))
                return
            if kind != "sdk_event":
                self._fail("protocol-error", f"unexpected {kind!r} frame from the {self._child}")
                return
            event = frame.get("event")
            if not isinstance(event, dict) or not isinstance(event.get("type"), str) or not event["type"]:
                self._fail("protocol-error", "sdk_event frame has no event object with a non-empty string 'type'")
                return
            frame, kind = event, event["type"]
        if pending is None or pending.command != "get_state":
            self._deliver(frame, kind, turn, len(line))
        if pending is not None:
            self._resolve(pending, frame)
        elif turn is not None:
            self._observe(turn, frame, kind)

    def _match_response(self, frame: dict[str, object]) -> _Pending | None:
        request_id = frame.get("id")
        if not isinstance(request_id, str):
            self._fail("protocol-error", f"response without a string id (command {frame.get('command')!r}): {frame.get('error') or 'unexpected response'}")
            return None
        pending = self._pending.get(request_id)
        if pending is None:
            self._fail("protocol-error", f"unexpected or duplicate response for request {request_id!r}")
            return None
        if frame.get("command") != pending.command:
            self._fail("protocol-error", f"response for request {request_id!r} names command {frame.get('command')!r}, expected {pending.command!r}")
            return None
        if not isinstance(frame.get("success"), bool):
            self._fail("protocol-error", f"response for request {request_id!r} has no boolean 'success'")
            return None
        return pending

    def _deliver(self, frame: dict[str, object], kind: str, turn: _Turn | None, size: int) -> None:
        if self._reference is None:
            # Handshake in progress: idle frames wait for the native identity.
            if self._prelude_bytes + size > self._spec.max_buffer_bytes:
                self._fail("protocol-error", "events before session identity exceeded max_buffer_bytes")
                return
            self._prelude_bytes += size
            self._prelude.append((frame, kind, size))
            return
        if self._claude:
            if kind == "sdk_reference":
                self._apply_reference(frame)
                return
            if not self._admit_claude(frame, kind, turn):
                return
        request_id = frame.get("id")
        event = SessionEvent(
            backend=self._spec.backend,  # type: ignore[arg-type]  # validated: rpc or sdk
            harness=self._spec.harness,  # type: ignore[arg-type]  # validated: pi, omp or claude-code
            session_id=self._reference.session_id,
            turn_id=None if turn is None else turn.handle.id,
            request_id=request_id if isinstance(request_id, str) else None,
            type=kind,
            raw=frame,
        )
        self._enqueue(event, turn, size)

    def _admit_claude(self, frame: dict[str, object], kind: str, turn: _Turn | None) -> bool:
        """Claude events must belong to the selected session; native results
        are counted per turn and bridge permission events tracked for
        `respond_approval`. False when the session failed instead."""
        assert self._reference is not None
        session_id = frame.get("session_id")
        if session_id is not None and session_id != self._reference.session_id:
            self._fail("protocol-error", f"native {kind!r} event names session {session_id!r}, not the selected {self._reference.session_id!r}")
            return False
        if kind == "result":
            if turn is None:
                self._fail("protocol-error", "native result arrived while no turn was active")
                return False
            turn.native_results += 1
        elif kind == "claude_permission":
            approval = frame.get("id")
            if not isinstance(approval, str) or not approval:
                self._fail("protocol-error", "claude_permission event has no string id")
                return False
            if turn is None:
                self._fail("protocol-error", f"claude_permission {approval!r} arrived while no turn was active")
                return False
            if approval in self._approvals:
                self._fail("protocol-error", f"duplicate claude_permission id {approval!r}")
                return False
            self._approvals.add(approval)
        elif kind == "claude_permission_cancelled":
            approval = frame.get("id")
            if isinstance(approval, str):
                self._approvals.discard(approval)
        return True

    def _apply_reference(self, frame: dict[str, object]) -> None:
        """`sdk_reference`: the worker observed the native transcript path of
        the already selected session (same ID and workdir required)."""
        reference = self._reference
        assert reference is not None
        if frame.get("sessionId") != reference.session_id:
            self._fail("protocol-error", f"sdk_reference names session {frame.get('sessionId')!r}, not the selected {reference.session_id!r}")
            return
        workdir = frame.get("workdir")
        if not isinstance(workdir, str) or not _same_dir(workdir, reference.workdir):
            self._fail("protocol-error", f"sdk_reference names workdir {workdir!r}, not {str(reference.workdir)!r}")
            return
        file = frame.get("sessionFile")
        if not isinstance(file, str) or not file or "\0" in file or not os.path.isabs(file):
            self._fail("protocol-error", f"sdk_reference sessionFile {file!r} is not an absolute path")
            return
        self._reference = replace(reference, session_file=Path(file))

    def _fail_sdk(self, turn: _Turn | None, frame: dict[str, object]) -> None:
        """`sdk_failure`: the worker lost its native side; the status is the
        worker's classification and the frame (native exit metadata in `raw`)
        becomes the active turn's result payload."""
        status = _SDK_FAILURE_STATUSES.get(frame.get("status"))  # type: ignore[arg-type]  # any JSON value
        error = frame.get("error")
        if status is None or not isinstance(error, str) or not error:
            self._fail("protocol-error", f"sdk_failure frame without a known status and non-empty error: {_stringify(frame)[:500]}")
            return
        if turn is not None:
            turn.failure_frame = frame
        self._fail(status, error)

    def _resolve(self, pending: _Pending, frame: dict[str, object]) -> None:
        del self._pending[pending.id]
        pending.timer.cancel()
        if not pending.future.done():
            pending.future.set_result(frame)
        turn = pending.turn
        if turn is None or turn.finished:
            return
        if pending.id == turn.prompt_id:
            turn.prompt_response = frame
        elif pending.id == turn.abort_id:
            turn.abort_response = frame
        self._maybe_finish(turn)

    def _observe(self, turn: _Turn, frame: dict[str, object], kind: str) -> None:
        if kind == "agent_end":
            turn.last_end = frame
        elif kind == "agent_settled" and not self._sdk:
            # Native `agent_settled` from the SDK is just an event: the bridge's
            # `sdk_settled` is the only authority on SDK turn completion.
            turn.settled = True
            self._maybe_finish(turn)

    def _settle_sdk(self, turn: _Turn | None, frame: dict[str, object]) -> None:
        error = frame.get("error")
        if error is not None and (not isinstance(error, str) or not error):
            self._fail("protocol-error", "sdk_settled 'error' must be a non-empty string when present")
            return
        if turn is None:
            return  # settlement of a turn that already finished (e.g. a rejected prompt)
        if error is not None:
            turn.sdk_failure = frame
        elif self._claude and not self._settle_claude(turn, frame):
            return
        turn.settled = True
        self._maybe_finish(turn)

    def _settle_claude(self, turn: _Turn, frame: dict[str, object]) -> bool:
        """The settlement must carry the exact native `result` of this session
        and follow exactly one native result event."""
        assert self._reference is not None
        result = frame.get("result")
        if not isinstance(result, dict) or result.get("type") != "result":
            self._fail("protocol-error", "sdk_settled carries no native result object of type 'result'")
            return False
        if result.get("session_id") != self._reference.session_id:
            self._fail("protocol-error", f"native result names session {result.get('session_id')!r}, not the selected {self._reference.session_id!r}")
            return False
        if turn.native_results != 1:
            self._fail("protocol-error", f"sdk_settled after {turn.native_results} native result events; exactly one is required")
            return False
        turn.native_result = result
        return True

    def _maybe_finish(self, turn: _Turn) -> None:
        if turn.finished or self._failure is not None:
            return
        response = turn.prompt_response
        if response is None:
            return
        if turn.abort_id is not None and turn.abort_response is None:
            return
        if response["success"] is False:
            self._finish(turn, "agent-error", response, f"prompt rejected: {_stringify(response.get('error') or 'no error given')}")
            return
        if not turn.settled:
            return
        if turn.sdk_failure is not None:
            self._finish(turn, "agent-error", turn.sdk_failure, f"sdk turn failed: {turn.sdk_failure['error']}")
            return
        if self._claude:
            assert turn.native_result is not None
            status, error = _classify_claude_result(turn.native_result)
            self._finish(turn, status, turn.native_result, error)
            return
        status, error = self._classify(turn)
        self._finish(turn, status, turn.last_end, error)

    def _finish(self, turn: _TurnBase, status: SessionTurnStatus, raw: dict[str, object] | None, error: str | None) -> None:
        self._approvals.clear()
        super()._finish(turn, status, raw, error)

    def _classify(self, turn: _Turn) -> tuple[SessionTurnStatus, str | None]:
        message = _last_assistant(turn.last_end)
        if message is None:
            aborted = turn.abort_response is not None and turn.abort_response.get("success") is True
            return ("interrupted", None) if aborted else ("completed", None)
        reason = message.get("stopReason")
        if reason == "error":
            detail = message.get("errorMessage")
            return "agent-error", detail if isinstance(detail, str) and detail else "assistant stopReason error"
        if reason == "aborted":
            return "interrupted", None
        return "completed", None

    # ---- child I/O --------------------------------------------------------

    async def _read_stdout(self) -> None:
        assert self._proc is not None and self._proc.stdout is not None
        stream = self._proc.stdout
        buffer = bytearray()
        while True:
            try:
                chunk = await stream.read(_READ_SIZE)
            except Exception as exc:
                self._fail("protocol-error", f"stdout read failed: {type(exc).__name__}: {exc}")
                return
            if not chunk:
                break
            buffer += chunk
            start = 0
            while True:
                newline = buffer.find(b"\n", start)
                if newline < 0:
                    break
                end = newline - 1 if newline > start and buffer[newline - 1] == 0x0D else newline
                if end > start:
                    self._handle_line(bytes(buffer[start:end]))
                start = newline + 1
            del buffer[:start]
            if len(buffer) > MAX_FRAME_BYTES:
                self._fail("protocol-error", f"frame exceeds {MAX_FRAME_BYTES} bytes without a newline")
                buffer.clear()
        if self._failure is not None:
            return
        if buffer.strip(b"\r"):
            self._fail("protocol-error", "stdout ended inside an incomplete JSON frame")
            return
        await self._classify_transport_loss("stdout closed")

    async def _classify_transport_loss(self, detail: str) -> None:
        """Unexpected EOF/EPIPE: a natural exit within the grace window is
        `exited`/`signaled`; a live child that stopped talking is `disconnected`."""
        if not self._exited.is_set():
            try:
                await asyncio.wait_for(self._exited.wait(), _TERM_GRACE)
            except asyncio.TimeoutError:
                pass
        if self._failure is not None:
            return
        code = self._returncode
        if code is None:
            self._fail("disconnected", f"{detail} while {self._child} kept running")
        elif code < 0:
            self._fail("signaled", f"{self._child} was killed by {_signal_name(code)}")
        else:
            self._fail("exited", f"{self._child} exited with code {code}")

    async def _read_stderr(self) -> None:
        assert self._proc is not None and self._proc.stderr is not None
        stream = self._proc.stderr
        while True:
            try:
                chunk = await stream.read(_READ_SIZE)
            except Exception:
                return
            if not chunk:
                return
            self._stderr.feed(chunk)

    async def _watch_exit(self) -> None:
        assert self._proc is not None
        self._returncode = await self._proc.wait()
        self._exited.set()

    # ---- teardown ---------------------------------------------------------

    def _signal_group(self, sig: int) -> tuple[bool, PermissionError | None]:
        """(group still exists, EPERM seen). macOS can report EPERM for a
        group whose leader is mid-exit; treat it as alive and retry."""
        assert self._proc is not None
        try:
            os.killpg(self._proc.pid, sig)
        except ProcessLookupError:
            return False, None
        except PermissionError as exc:
            return True, exc
        return True, None

    async def _teardown(self) -> None:
        failure = self._failure
        assert failure is not None and self._proc is not None
        proc = self._proc
        for pending in self._pending.values():
            pending.timer.cancel()
        if self._active is not None and self._active.timer is not None:
            self._active.timer.cancel()
        stdin_error: Exception | None = None
        try:
            if proc.stdin is not None:
                proc.stdin.close()
        except Exception as exc:
            stdin_error = exc
        group_exists, group_error = self._signal_group(signal.SIGTERM)
        grace_end = self._loop.time() + _TERM_GRACE
        drain_end = grace_end + _DRAIN_BUDGET
        escalated = False
        readers = [t for t in self._tasks if not t.done()]
        while True:
            now = self._loop.time()
            if group_exists and not escalated and now >= grace_end:
                group_exists, group_error = self._signal_group(signal.SIGKILL)
                escalated = group_error is None
            readers = [t for t in readers if not t.done()]
            if not group_exists and self._exited.is_set() and not readers:
                break
            if now >= drain_end:
                break
            await asyncio.sleep(min(_TICK, drain_end - now))
            group_exists, group_error = self._signal_group(0)
        for task in readers:
            # A pipe still open past the drain budget is held by something
            # outside our group; stop waiting for its EOF.
            task.cancel()
        if not self._exited.is_set():
            try:
                await asyncio.wait_for(self._exited.wait(), max(0.0, drain_end - self._loop.time()))
            except asyncio.TimeoutError:
                pass
        for task in list(self._tasks):
            if task.done():
                continue
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass
        for pending in list(self._pending.values()):
            if not pending.future.done():
                pending.future.set_result(None)
        self._pending.clear()
        turn = self._active
        if turn is not None and not turn.finished:
            self._finish(turn, failure.status, turn.failure_frame if turn.failure_frame is not None else turn.last_end, failure.error)
        self._idle._close()
        # Preserve the lease when live resources could not be released safely.
        if group_error is not None:
            raise group_error
        if not self._exited.is_set():
            raise HarnessError(f"{self._child} process {proc.pid} could not be reaped within the teardown budget", code="adapter-error")
        cleanup_command(self._prepared)
        code = self._returncode
        if self._sdk and failure.status not in ("exited", "signaled") and code not in (0, -signal.SIGTERM):
            # The bridge unsubscribes and disposes the SDK session on SIGTERM/EOF
            # and exits 0 only when that succeeded; anything else is a real
            # disposal failure the caller must see, not a silent success. Death
            # by our own SIGTERM means it had not yet installed handlers, i.e.
            # nothing existed to dispose.
            assert code is not None
            if code >= 0:
                detail = f"exit code {code}"
            elif escalated:
                detail = f"did not dispose within {_TERM_GRACE}s and was killed by {_signal_name(code)}"
            else:
                detail = f"killed by {_signal_name(code)}"
            stderr = self._stderr.text().strip()
            raise HarnessError(
                f"{self._child} failed to dispose the session: {detail}" + (f"; stderr: {stderr[:2000]}" if stderr else ""),
                code="adapter-error",
            )
        if stdin_error is not None:
            raise stdin_error

    # ---- startup ----------------------------------------------------------

    async def _startup(self, argv: list[str], env: dict[str, str]) -> None:
        try:
            self._proc = await asyncio.create_subprocess_exec(
                *argv,
                cwd=str(self._spec.workdir),
                env=env,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                start_new_session=True,
            )
        except OSError as exc:
            cleanup_command(self._prepared)
            raise HarnessError(f"failed to launch {argv[0]!r}: {exc.strerror or exc}", code="launch-failed") from None
        self._spawn(self._watch_exit())
        self._spawn(self._read_stdout())
        self._spawn(self._read_stderr())
        if self._abandoned:
            self._fail("closed", None)
        self._request_seq += 1
        request_id = f"req-{self._request_seq}"
        pending = self._register(request_id, "get_state", None)
        await self._send({"id": request_id, "type": "get_state"})
        response = await asyncio.shield(pending.future)
        if response is None:
            await self._raise_startup_failure()
        assert response is not None
        try:
            self._reference = self._reference_from_state(response)
        except HarnessError as exc:
            self._fail("protocol-error", str(exc))
            await self._raise_startup_failure()
        # The handshake response is consumed here (it became `reference`);
        # any other frame that arrived meanwhile is an idle event.
        prelude, self._prelude = self._prelude, []
        self._prelude_bytes = 0
        for frame, kind, size in prelude:
            if frame is not response:
                self._deliver(frame, kind, None, size)

    async def _raise_startup_failure(self) -> None:
        assert self._failure is not None and self._teardown_task is not None
        failure = self._failure
        cleanup_error: BaseException | None = None
        try:
            await self._teardown_task
        except Exception as exc:
            cleanup_error = exc
        code: ErrorCode
        if failure.status == "closed":
            code = "session-closed"
        elif failure.status in ("exited", "signaled", "disconnected"):
            code = "launch-failed"
        else:
            code = "protocol-error"
        detail = f"{self._child} startup failed ({failure.status}" + (f": {failure.error})" if failure.error else ")")
        if self._returncode is not None:
            detail += f"; exit code {self._returncode}"
        stderr = self._stderr.text().strip()
        if stderr:
            detail += f"; stderr: {stderr[:2000]}"
        raise HarnessError(detail, code=code) from cleanup_error

    def _reference_from_state(self, response: dict[str, object]) -> SessionReference:
        if response.get("success") is not True:
            raise HarnessError(f"get_state failed: {_stringify(response.get('error') or 'no error given')}")
        data = response.get("data")
        if not isinstance(data, dict):
            raise HarnessError("get_state response has no data object")
        session_id = data.get("sessionId")
        if not isinstance(session_id, str) or not session_id:
            raise HarnessError("get_state reported no sessionId")
        session_file = data.get("sessionFile")
        if session_file is not None and (
            not isinstance(session_file, str) or not Path(session_file).is_absolute() or "\0" in session_file
        ):
            raise HarnessError("get_state sessionFile must be an absolute path or null")
        if data.get("isStreaming") is not False:
            raise HarnessError("get_state reported isStreaming != false at startup")
        resume = self._spec.resume
        if resume is not None and session_id != resume.session_id:
            raise HarnessError(f"{self._child} resumed session {session_id!r}, expected {resume.session_id!r}")
        if self._claude and _UUID.fullmatch(session_id) is None:
            raise HarnessError(f"{self._child} selected a non-UUID session ID {session_id!r}")
        return SessionReference(
            session_id=session_id,
            session_file=Path(session_file) if session_file else None,
            workdir=self._spec.workdir,
        )


def _last_assistant(end: dict[str, object] | None) -> dict[str, object] | None:
    if end is None:
        return None
    messages = end.get("messages")
    if not isinstance(messages, list):
        return None
    for message in reversed(messages):
        if isinstance(message, dict) and message.get("role") == "assistant":
            return message
    return None


def _signal_name(returncode: int | None) -> str | None:
    if returncode is None or returncode >= 0:
        return None
    try:
        return signal.Signals(-returncode).name
    except ValueError:
        return f"SIG{-returncode}"


#: `sdk_failure.status` values the Claude worker may report.
_SDK_FAILURE_STATUSES: dict[str, SessionTurnStatus] = {
    "protocol-error": "protocol-error",
    "disconnected": "disconnected",
    "exited": "exited",
    "signaled": "signaled",
}


def _classify_claude_result(result: dict[str, object]) -> tuple[SessionTurnStatus, str | None]:
    """Native `result` message -> turn status. An abort the CLI confirms
    (`terminal_reason` aborted_streaming / aborted_tools) is `interrupted`
    even though such results also carry `is_error`; sending an abort alone
    never implies it (a completion race stays `completed`)."""
    if result.get("terminal_reason") in ("aborted_streaming", "aborted_tools"):
        return "interrupted", None
    if result.get("is_error") or result.get("subtype") != "success":
        return "agent-error", _claude_result_error(result)
    return "completed", None


def _claude_result_error(result: dict[str, object]) -> str:
    errors = result.get("errors")
    if isinstance(errors, list):
        texts = [e.strip() for e in errors if isinstance(e, str) and e.strip()]
        if texts:
            return "; ".join(texts)
    text = result.get("result")
    if isinstance(text, str) and text.strip():
        return text.strip()
    subtype = result.get("subtype")
    if isinstance(subtype, str) and subtype and subtype != "success":
        return subtype
    return "native result reported an error"


async def open_session(spec: SessionSpec) -> LiveSession:
    """Open the live session for `spec`: spawn the session child (`pi --mode
    rpc`, the OMP Bun bridge, or the native Python Claude SDK worker),
    connect to the caller-owned OpenCode or OpenHands server, or open the Amp
    Node worker. Each backend verifies its explicit native identity before
    accepting turns.

    Validation (harness, backend, options, resume header) happens before any
    filesystem, process or network side effect. Instructions are projected
    under the workdir lease and restored when the session closes. Cancellation
    while opening tears the child / transport down before `CancelledError`
    propagates. The parent environment is copied, never mutated.
    """
    spec = _validate_session_spec(spec)
    if spec.harness == "opencode":
        from harness._opencode import open_opencode_session  # optional httpx dependency

        return await open_opencode_session(spec)
    if spec.harness == "openhands":
        from harness._openhands import open_openhands_session  # optional httpx + websockets dependencies

        return await open_openhands_session(spec)
    if sys.platform not in ("darwin", "linux"):
        raise NotImplementedError("Owned subprocess groups require macOS or Linux")
    if spec.harness == "amp":
        from harness._amp import open_amp_session

        return await open_amp_session(spec)
    if spec.resume is not None:
        if spec.harness == "claude-code":
            _verify_claude_transcript(spec.resume)
        else:
            _verify_session_header(spec.resume, spec.backend)
    built = _build(spec)
    prepared = prepare_command(built)
    session = _ProcessSession(spec, prepared)
    env = os.environ.copy()
    env.update(built.env)
    await _await_startup(session, session._startup([built.cmd] + built.args, env))
    return session


async def _await_startup(session: LiveSession, startup: Coroutine[object, object, None]) -> None:
    """Run `startup` shielded so the transport is never orphaned; a cancelled
    caller abandons the session, which tears it down before propagating."""
    task = asyncio.get_running_loop().create_task(startup)
    try:
        await asyncio.shield(task)
    except asyncio.CancelledError as cancelled:
        session._abandon()
        try:
            await session._uncancellable(task)
        except BaseException:
            pass  # repeated cancellation or startup error; teardown decides below
        teardown = session._teardown_task
        if teardown is not None:
            try:
                await session._uncancellable(teardown)
            except BaseException:
                pass
            if teardown.exception() is not None:
                raise cancelled from teardown.exception()
        raise


__all__ = [
    "ClaudeSdkOptions",
    "ClaudeSettingSource",
    "AmpEffort",
    "AmpSdkOptions",
    "AmpVisibility",
    "LiveSession",
    "OmpSdkOptions",
    "OpenCodeApprovalResponse",
    "OpenCodeAuth",
    "OpenCodeOptions",
    "OpenHandsOptions",
    "SessionCapabilities",
    "SessionEvent",
    "SessionReference",
    "SessionSpec",
    "SessionTurn",
    "SessionTurnResult",
    "SessionTurnStatus",
    "get_session_capabilities",
    "open_session",
]
