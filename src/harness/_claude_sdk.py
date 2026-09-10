"""Claude Agent SDK worker for `claude-code` / `sdk` live sessions.

Executed as a file by `harness.sessions._ProcessSession` (never imported by the
package): `python _claude_sdk.py '<options JSON>'`. The host speaks the shared
JSONL request protocol on stdin (`get_state`, `prompt`, `abort`, `approval`)
and reads correlated `response` frames, wrapped native events (`sdk_event`),
identity updates (`sdk_reference`), turn settlements (`sdk_settled`) and fatal
failures (`sdk_failure`) on stdout.

The native side is `claude_agent_sdk.ClaudeSDKClient` (pinned 0.2.152) driving
Claude Code CLI 2.1.259 through `_CliTransport`, an implementation of the
SDK's exported `Transport` ABC that owns the CLI child. Owning the transport
(rather than wrapping the SDK's private `SubprocessCLITransport`) keeps the
native stdout framing strict: every line must be one JSON object; a partial
line at EOF or a non-JSON line is a protocol error, never skipped. The SDK
keeps the control protocol (initialize, hooks, `can_use_tool`, interrupt);
the transport only tees each raw native message to the host before the SDK's
dataclass parser sees it and captures the correlated interrupt receipt.

The CLI argv and environment reproduce exactly what SDK 0.2.152's
`SubprocessCLITransport._build_command` / `connect` produce for the option set
this worker uses (empty `--system-prompt`, `--permission-prompt-tool stdio`,
`--session-id=<uuid>` or `--resume=<absolute transcript>`, `--settings`,
`--include-partial-messages` (streaming `stream_event` deltas, so an
interrupt can land on partial output), `--setting-sources=`,
`--input-format stream-json`; `CLAUDE_CODE_ENTRYPOINT`,
`CLAUDE_AGENT_SDK_VERSION`, `PWD` set, `CLAUDECODE` removed). Nothing is
discovered: the SDK package, the CLI executable and the config directory are
the caller's explicit selections, qualified before the CLI is launched.

Identity: a fresh session selects its UUID up front (`--session-id`); a resume
passes the caller's transcript path (`--resume=`) and keeps the transcript's
ID. The transcript path of a fresh session is unknown until a native hook
(Stop, or SessionStart) reports it, at which point `sdk_reference` updates the
host. Every hook input is exposed as `claude_session_hook`.

Exit status is the native disposal outcome only: 0 when the SDK client and
the CLI child were released, 1 otherwise. Protocol or native failures are
reported through `sdk_failure` first, then disposed the same way.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import signal
import sys
import uuid
from collections.abc import AsyncIterator, Coroutine
from types import ModuleType
from typing import Any

MAX_BYTES = 1_048_576
SDK_VERSION = "0.2.152"
CLI_VERSION = "2.1.259"
SDK_PACKAGE = "claude_agent_sdk"
#: Bound on the `claude --version` probe (spawn + output).
VERSION_PROBE_SECONDS = 10.0
#: Budget for native disposal plus the final stdout flush, kept under the
#: host's 500 ms SIGTERM grace.
DISPOSE_SECONDS = 0.35
FLUSH_SECONDS = 0.1
#: How long a stdout EOF may precede the CLI's exit before it is `disconnected`.
EXIT_GRACE_SECONDS = 0.5
REJECT_MESSAGE = "Rejected by the harness caller via respond_approval"
#: Hooks whose input carries the native session identity (session_id,
#: transcript_path, cwd). SessionStart did not fire before the first prompt in
#: the owner's qualification; Stop fires after every completed turn.
IDENTITY_HOOKS = ("SessionStart", "Stop")
CONTROL_TYPES = frozenset(
    {"control_request", "control_response", "control_cancel_request", "keep_alive"}
)
SETTING_SOURCES = ("user", "project", "local")
_VERSION_RE = re.compile(r"\s*([0-9]+\.[0-9]+\.[0-9]+)(?:\s|$)")
_UUID_RE = re.compile(
    r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
)


class WorkerError(Exception):
    """Startup or protocol failure with a message for the host's stderr capture."""


def _same_dir(a: str, b: str) -> bool:
    if a == b:
        return True
    try:
        return os.path.realpath(a) == os.path.realpath(b)
    except OSError:
        return False


def _text(error: BaseException) -> str:
    text = str(error)
    return text if text else type(error).__name__


def _signal_name(returncode: int) -> str:
    try:
        return signal.Signals(-returncode).name
    except ValueError:
        return f"SIG{-returncode}"


# ── options ─────────────────────────────────────────────────────────────────


class Options:
    """Validated launch options (camelCase JSON from the host)."""

    def __init__(self, raw: object) -> None:
        if not isinstance(raw, dict):
            raise WorkerError("worker options must be a JSON object")
        self.package_root = self._path(raw, "packageRoot")
        self.cli_path = self._path(raw, "cliPath")
        self.config_dir = self._path(raw, "configDir")
        self.cwd = self._path(raw, "cwd")
        self.settings_file = (
            self._path(raw, "settingsFile")
            if raw.get("settingsFile") is not None
            else None
        )
        model = raw.get("model")
        if model is not None and (not isinstance(model, str) or not model):
            raise WorkerError("model must be null or a non-empty string")
        self.model = model
        sources = raw.get("settingSources")
        if (
            not isinstance(sources, list)
            or any(s not in SETTING_SOURCES for s in sources)
            or len(set(sources)) != len(sources)
        ):
            raise WorkerError(
                "settingSources must be a duplicate-free list drawn from user, project, local"
            )
        self.setting_sources: list[str] = list(sources)
        resume = raw.get("resume")
        self.resume_id: str | None = None
        self.resume_file: str | None = None
        if resume is not None:
            if not isinstance(resume, dict):
                raise WorkerError("resume must be null or an object")
            session_id = resume.get("sessionId")
            if (
                not isinstance(session_id, str)
                or _UUID_RE.fullmatch(session_id) is None
            ):
                raise WorkerError("resume.sessionId must be a UUID")
            self.resume_id = session_id
            self.resume_file = self._path(resume, "sessionFile")
            workdir = self._path(resume, "workdir")
            if not _same_dir(workdir, self.cwd):
                raise WorkerError(
                    f"resume.workdir {workdir!r} does not match cwd {self.cwd!r}"
                )

    @staticmethod
    def _path(raw: dict[str, object], key: str) -> str:
        value = raw.get(key)
        if (
            not isinstance(value, str)
            or not value
            or "\0" in value
            or not os.path.isabs(value)
        ):
            raise WorkerError(f"{key} must be an absolute NUL-free path")
        return value


# ── native qualification ────────────────────────────────────────────────────


def _load_sdk(package_root: str) -> ModuleType:
    """Import the caller-selected SDK package and verify that this exact
    directory (no ambient installation) at the pinned version was imported."""
    sys.path.insert(0, os.path.dirname(package_root))
    try:
        import claude_agent_sdk
    except ImportError as exc:
        raise WorkerError(
            f"cannot import {SDK_PACKAGE} from {package_root}: {exc}"
        ) from None
    location = os.path.dirname(os.path.realpath(claude_agent_sdk.__file__))
    if location != os.path.realpath(package_root):
        raise WorkerError(
            f"imported {SDK_PACKAGE} from {location}, not the selected packageRoot {package_root}"
        )
    version = getattr(claude_agent_sdk, "__version__", None)
    if version != SDK_VERSION:
        raise WorkerError(
            f"{SDK_PACKAGE} {version!r} at {package_root} is not the qualified {SDK_VERSION}"
        )
    return claude_agent_sdk


async def _probe_cli_version(cli_path: str, cwd: str) -> None:
    """Exact-version qualification of the selected executable, bounded."""
    try:
        proc = await asyncio.create_subprocess_exec(
            cli_path,
            "--version",
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=cwd,
        )
    except OSError as exc:
        raise WorkerError(
            f"cannot execute cliPath {cli_path!r}: {exc.strerror or exc}"
        ) from None

    async def read_output(stream: asyncio.StreamReader) -> bytes:
        try:
            await stream.readexactly(65_537)
        except asyncio.IncompleteReadError as exc:
            return exc.partial
        raise WorkerError(f"{cli_path} --version exceeded the 64 KiB output bound")

    assert proc.stdout is not None and proc.stderr is not None
    readers = [
        asyncio.create_task(read_output(proc.stdout)),
        asyncio.create_task(read_output(proc.stderr)),
    ]
    try:
        stdout, stderr = await asyncio.wait_for(
            asyncio.gather(*readers), VERSION_PROBE_SECONDS
        )
        await asyncio.wait_for(proc.wait(), 0.2)
    except BaseException:
        if proc.returncode is None:
            proc.kill()
            await asyncio.wait_for(proc.wait(), 0.2)
        raise
    finally:
        for reader in readers:
            reader.cancel()
        await asyncio.gather(*readers, return_exceptions=True)
    if proc.returncode != 0:
        detail = stderr.decode("utf-8", "replace").strip()[:500]
        raise WorkerError(
            f"{cli_path} --version exited with code {proc.returncode}"
            + (f": {detail}" if detail else "")
        )
    match = _VERSION_RE.match(stdout.decode("utf-8", "replace"))
    if match is None:
        raise WorkerError(f"{cli_path} --version printed no version: {stdout[:200]!r}")
    if match.group(1) != CLI_VERSION:
        raise WorkerError(
            f"{cli_path} is Claude Code {match.group(1)}, not the qualified {CLI_VERSION}"
        )


def _cli_argv(options: Options, session_id: str) -> list[str]:
    argv = [
        options.cli_path,
        "--output-format",
        "stream-json",
        "--verbose",
        "--system-prompt",
        "",
    ]
    if options.model is not None:
        argv += ["--model", options.model]
    argv += ["--permission-prompt-tool", "stdio"]
    if options.resume_file is not None:
        argv.append(f"--resume={options.resume_file}")
    else:
        argv.append(f"--session-id={session_id}")
    if options.settings_file is not None:
        argv += ["--settings", options.settings_file]
    argv.append("--include-partial-messages")
    argv.append(f"--setting-sources={','.join(options.setting_sources)}")
    argv += ["--input-format", "stream-json"]
    return argv


def _cli_env(options: Options) -> dict[str, str]:
    env = {key: value for key, value in os.environ.items() if key != "CLAUDECODE"}
    env["CLAUDE_CODE_ENTRYPOINT"] = "sdk-py"
    env["CLAUDE_CONFIG_DIR"] = options.config_dir
    env["CLAUDE_AGENT_SDK_VERSION"] = SDK_VERSION
    env["PWD"] = options.cwd
    return env


# ── native transport ────────────────────────────────────────────────────────


class _Interrupt:
    """One armed native interrupt: the SDK's control request ID once written
    and the correlated control response once read."""

    def __init__(self) -> None:
        self.request_id: str | None = None
        self.response: dict[str, object] | None = None


def _make_transport(
    sdk: ModuleType, worker: Worker, argv: list[str], env: dict[str, str], cwd: str
) -> Any:
    """Build the transport against the loaded SDK's exported `Transport` ABC.
    The SDK is imported from a caller-selected path at runtime, so the
    resulting class is necessarily untyped here."""
    connection_error: type[Exception] = sdk.CLIConnectionError

    class _CliTransport(sdk.Transport):  # type: ignore[misc]  # dynamically loaded base
        def __init__(self) -> None:
            self._proc: asyncio.subprocess.Process | None = None
            self._ready = False
            self._lock = asyncio.Lock()
            self._interrupt: _Interrupt | None = None

        # -- Transport ABC --------------------------------------------------

        async def connect(self) -> None:
            try:
                self._proc = await asyncio.create_subprocess_exec(
                    *argv,
                    stdin=asyncio.subprocess.PIPE,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=None,  # inherited: native diagnostics reach the host's stderr capture
                    cwd=cwd,
                    env=env,
                    limit=MAX_BYTES + 1,
                )
            except OSError as exc:
                raise connection_error(
                    f"failed to launch {argv[0]!r}: {exc.strerror or exc}"
                ) from None
            self._ready = True

        async def write(self, data: str) -> None:
            async with self._lock:
                proc = self._proc
                if (
                    not self._ready
                    or proc is None
                    or proc.stdin is None
                    or proc.stdin.is_closing()
                ):
                    raise connection_error("native stdin is closed")
                if proc.returncode is not None:
                    raise connection_error(
                        f"native claude exited with code {proc.returncode}"
                    )
                if self._interrupt is not None and self._interrupt.request_id is None:
                    self._correlate_request(data)
                try:
                    proc.stdin.write(data.encode("utf-8"))
                    await proc.stdin.drain()
                except (
                    BrokenPipeError,
                    ConnectionResetError,
                    OSError,
                    RuntimeError,
                ) as exc:
                    self._ready = False
                    raise connection_error(
                        f"native stdin write failed: {_text(exc)}"
                    ) from None

        def read_messages(self) -> AsyncIterator[dict[str, object]]:
            return self._read()

        async def close(self) -> None:
            """Bounded disposal (well under the host's 500 ms grace): stdin EOF,
            then SIGTERM, then SIGKILL on the child only; the host owns the
            process group."""
            proc = self._proc
            self._ready = False
            if proc is None:
                return
            await self._end_stdin()
            if await self._wait_exit(0.1):
                return
            proc.terminate()
            if await self._wait_exit(0.1):
                return
            proc.kill()
            if not await self._wait_exit(0.1):
                raise WorkerError(
                    f"native claude {proc.pid} survived SIGKILL within the disposal budget"
                )

        def is_ready(self) -> bool:
            return self._ready

        async def end_input(self) -> None:
            async with self._lock:
                await self._end_stdin()

        # -- worker surface -------------------------------------------------

        def arm_interrupt(self) -> _Interrupt:
            self._interrupt = _Interrupt()
            return self._interrupt

        def disarm_interrupt(self) -> None:
            self._interrupt = None

        # -- internals ------------------------------------------------------

        async def _end_stdin(self) -> None:
            proc = self._proc
            if proc is None or proc.stdin is None or proc.stdin.is_closing():
                return
            try:
                proc.stdin.close()
                await proc.stdin.wait_closed()
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass

        async def _wait_exit(self, timeout: float) -> bool:
            assert self._proc is not None
            if self._proc.returncode is not None:
                return True
            try:
                await asyncio.wait_for(self._proc.wait(), timeout)
            except asyncio.TimeoutError:
                return False
            return True

        def _correlate_request(self, data: str) -> None:
            try:
                frame = json.loads(data)
            except ValueError:
                return
            if not isinstance(frame, dict) or frame.get("type") != "control_request":
                return
            request = frame.get("request")
            request_id = frame.get("request_id")
            if (
                isinstance(request, dict)
                and request.get("subtype") == "interrupt"
                and isinstance(request_id, str)
            ):
                assert self._interrupt is not None
                self._interrupt.request_id = request_id

        async def _read(self) -> AsyncIterator[dict[str, object]]:
            proc = self._proc
            if proc is None or proc.stdout is None:
                raise connection_error("native claude is not connected")
            stream = proc.stdout
            while True:
                try:
                    line = await stream.readuntil(b"\n")
                except asyncio.LimitOverrunError:
                    worker.fail(
                        "protocol-error",
                        f"native frame exceeds {MAX_BYTES} bytes without a newline",
                    )
                    return
                except asyncio.IncompleteReadError as exc:
                    if exc.partial.strip(b"\r"):
                        worker.fail(
                            "protocol-error",
                            "native stdout ended inside an incomplete JSON frame",
                        )
                        return
                    break
                except (OSError, ValueError) as exc:
                    worker.fail(
                        "protocol-error", f"native stdout read failed: {_text(exc)}"
                    )
                    return
                line = line.rstrip(b"\r\n")
                if not line:
                    continue
                try:
                    message = json.loads(line.decode("utf-8"))
                except (UnicodeDecodeError, ValueError) as exc:
                    worker.fail(
                        "protocol-error",
                        f"native stdout line is not valid JSON: {_text(exc)}",
                        {"line": line[:200].decode("utf-8", "replace")},
                    )
                    return
                if not isinstance(message, dict):
                    worker.fail(
                        "protocol-error",
                        f"native stdout line is a JSON {type(message).__name__}, not an object",
                    )
                    return
                kind = message.get("type")
                if kind == "control_response":
                    self._observe_response(message)
                elif kind not in CONTROL_TYPES:
                    worker.on_native_message(message)
                yield message
            await self._classify_eof()

        def _observe_response(self, message: dict[str, object]) -> None:
            armed = self._interrupt
            if armed is None or armed.request_id is None:
                return
            response = message.get("response")
            if (
                isinstance(response, dict)
                and response.get("request_id") == armed.request_id
            ):
                armed.response = response

        async def _classify_eof(self) -> None:
            proc = self._proc
            if proc is None or worker.closing:
                return
            exited = await self._wait_exit(EXIT_GRACE_SECONDS)
            if worker.closing:
                return
            if not exited:
                worker.fail(
                    "disconnected",
                    "native stdout closed while claude kept running",
                    {"exit_code": None, "signal": None},
                )
                return
            code = proc.returncode
            assert code is not None
            if code < 0:
                worker.fail(
                    "signaled",
                    f"native claude was killed by {_signal_name(code)}",
                    {"exit_code": None, "signal": _signal_name(code)},
                )
            else:
                worker.fail(
                    "exited",
                    f"native claude exited with code {code}",
                    {"exit_code": code, "signal": None},
                )

    return _CliTransport()


# ── worker ──────────────────────────────────────────────────────────────────


class _Turn:
    def __init__(self, prompt: str) -> None:
        self.prompt = prompt
        self.raw_result: dict[str, object] | None = None
        self.consumed: asyncio.Future[dict[str, object]] = (
            asyncio.get_running_loop().create_future()
        )


class Worker:
    def __init__(self, options: Options) -> None:
        self.options = options
        self.session_id = options.resume_id or str(uuid.uuid4())
        self.transcript: str | None = options.resume_file
        self.closing = False
        self.failed = False
        self._loop = asyncio.get_running_loop()
        self._writer: asyncio.StreamWriter | None = None
        self._reader: asyncio.StreamReader | None = None
        self._read_transport: asyncio.ReadTransport | None = None
        # SDK handles: loaded from a caller-selected path, untyped by construction.
        self._sdk: ModuleType | None = None
        self._client: Any = None
        self._transport: Any = None
        self._turn: _Turn | None = None
        self._tasks: set[asyncio.Task[None]] = set()
        self._approvals: dict[str, asyncio.Future[str]] = {}
        self._approval_seq = 0

    # ---- output -----------------------------------------------------------

    def send(self, frame: dict[str, object]) -> None:
        """Write one frame. The pipe backlog is bounded like the OMP bridge:
        overflow is a fatal worker failure, never silent buffering."""
        writer = self._writer
        if self.closing or writer is None:
            return
        line = (
            json.dumps(frame).encode("utf-8") + b"\n"
        )  # ASCII-escaped: lone surrogates from native output stay representable
        if (
            len(line) > MAX_BYTES
            or writer.transport.get_write_buffer_size() + len(line) > MAX_BYTES
        ):
            self.failed = True
            sys.stderr.write(
                "claude sdk worker: output exceeded the 1 MiB transport bound\n"
            )
            self.request_shutdown()
            raise WorkerError("worker output exceeded the 1 MiB transport bound")
        writer.write(line)

    def respond(
        self, request: dict[str, object], success: bool, payload: object
    ) -> None:
        frame: dict[str, object] = {
            "type": "response",
            "id": request["id"],
            "command": request["type"],
            "success": success,
        }
        frame["data" if success else "error"] = payload
        self.send(frame)

    def fail(self, status: str, error: str, raw: object = None) -> None:
        """Single fatal failure: report it to the host, then dispose."""
        if self.failed or self.closing:
            return
        self.failed = True
        frame: dict[str, object] = {
            "type": "sdk_failure",
            "status": status,
            "error": error,
        }
        if raw is not None:
            frame["raw"] = raw
        try:
            self.send(frame)
        except WorkerError:
            pass  # already on stderr; the host sees the exit
        sys.stderr.write(f"claude sdk worker: {status}: {error}\n")
        self.request_shutdown()

    def request_shutdown(self) -> None:
        self.closing = True
        if self._read_transport is not None:
            self._read_transport.close()

    # ---- native callbacks -------------------------------------------------

    def on_native_message(self, message: dict[str, object]) -> None:
        """Raw tee, before the SDK parses the message."""
        if self.closing:
            return
        self.send({"type": "sdk_event", "event": message})
        if message.get("type") != "result":
            return
        turn = self._turn
        if turn is None:
            self.fail("protocol-error", "native result arrived outside a turn", message)
        elif turn.raw_result is not None:
            self.fail(
                "protocol-error",
                "native claude emitted a second result in one turn",
                message,
            )
        else:
            turn.raw_result = message

    async def _on_hook(
        self, hook_input: object, tool_use_id: object, _context: object
    ) -> dict[str, object]:
        if self.closing:
            return {}
        if not isinstance(hook_input, dict):
            self.fail("protocol-error", "native hook input is not an object")
            return {}
        session_id = hook_input.get("session_id")
        if session_id != self.session_id:
            self.fail(
                "protocol-error",
                f"native hook reported session {session_id!r}, expected {self.session_id!r}",
                hook_input,
            )
            return {}
        cwd = hook_input.get("cwd")
        if not isinstance(cwd, str) or not _same_dir(cwd, self.options.cwd):
            self.fail(
                "protocol-error",
                f"native hook reported cwd {cwd!r}, expected {self.options.cwd!r}",
                hook_input,
            )
            return {}
        transcript = hook_input.get("transcript_path")
        if not isinstance(transcript, str) or not os.path.isabs(transcript):
            self.fail(
                "protocol-error",
                f"native hook reported no absolute transcript_path: {transcript!r}",
                hook_input,
            )
            return {}
        if self.options.resume_file is not None and not _same_dir(
            transcript, self.options.resume_file
        ):
            self.fail(
                "protocol-error",
                f"native claude continued transcript {transcript!r}, not the resumed {self.options.resume_file!r}",
                hook_input,
            )
            return {}
        if transcript != self.transcript:
            self.transcript = transcript
            self.send(
                {
                    "type": "sdk_reference",
                    "sessionId": self.session_id,
                    "sessionFile": transcript,
                    "workdir": self.options.cwd,
                }
            )
        self.send(
            {
                "type": "sdk_event",
                "event": {"type": "claude_session_hook", "input": hook_input},
            }
        )
        return {}

    async def _can_use_tool(
        self, tool_name: str, tool_input: dict[str, object], context: Any
    ) -> Any:
        sdk = self._sdk
        assert sdk is not None
        self._approval_seq += 1
        approval_id = f"approval-{self._approval_seq}"
        tool_use_id = context.tool_use_id
        native_context = {
            "suggestions": [update.to_dict() for update in context.suggestions],
            "tool_use_id": tool_use_id,
            "agent_id": context.agent_id,
            "blocked_path": context.blocked_path,
            "decision_reason": context.decision_reason,
            "title": context.title,
            "display_name": context.display_name,
            "description": context.description,
        }
        future: asyncio.Future[str] = self._loop.create_future()
        self._approvals[approval_id] = future
        self.send(
            {
                "type": "sdk_event",
                "event": {
                    "type": "claude_permission",
                    "id": approval_id,
                    "tool_name": tool_name,
                    "input": tool_input,
                    "tool_use_id": tool_use_id,
                    "context": native_context,
                },
            }
        )
        try:
            response = await future
        except asyncio.CancelledError:
            # The CLI withdrew the request (control_cancel_request) or the
            # session is closing; a turn settlement cancels and reports first.
            if self._approvals.pop(approval_id, None) is not None:
                self.send(
                    {
                        "type": "sdk_event",
                        "event": {
                            "type": "claude_permission_cancelled",
                            "id": approval_id,
                            "tool_use_id": tool_use_id,
                        },
                    }
                )
            raise
        if response == "once":
            return sdk.PermissionResultAllow()  # original input, no permission updates
        return sdk.PermissionResultDeny(message=REJECT_MESSAGE)

    def _cancel_approvals(self) -> None:
        for approval_id, future in list(self._approvals.items()):
            del self._approvals[approval_id]
            future.cancel()
            self.send(
                {
                    "type": "sdk_event",
                    "event": {
                        "type": "claude_permission_cancelled",
                        "id": approval_id,
                        "tool_use_id": None,
                    },
                }
            )

    # ---- commands ---------------------------------------------------------

    def _spawn(self, coro: Coroutine[object, object, None]) -> asyncio.Task[None]:
        task = self._loop.create_task(coro)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        return task

    def _command(self, request: object) -> None:
        if (
            not isinstance(request, dict)
            or not isinstance(request.get("id"), str)
            or not isinstance(request.get("type"), str)
        ):
            raise WorkerError(
                "invalid worker request: expected an object with string 'id' and 'type'"
            )
        kind = request["type"]
        if kind == "get_state":
            self.respond(
                request,
                True,
                {
                    "sessionId": self.session_id,
                    "sessionFile": self.transcript,
                    "isStreaming": self._turn is not None,
                },
            )
        elif kind == "prompt":
            message = request.get("message")
            if not isinstance(message, str) or not message:
                self.respond(
                    request, False, "prompt requires a non-empty string 'message'"
                )
            elif self._turn is not None:
                self.respond(request, False, "a turn is already active")
            else:
                self._turn = _Turn(message)
                self.respond(request, True, {})
                self._spawn(self._run_turn(self._turn))
        elif kind == "abort":
            self._spawn(self._abort(request))
        elif kind == "approval":
            approval_id = request.get("approvalId")
            response = request.get("response")
            if response not in ("once", "reject"):
                self.respond(
                    request,
                    False,
                    f"approval response must be 'once' or 'reject', got {response!r}",
                )
                return
            future = (
                self._approvals.pop(approval_id, None)
                if isinstance(approval_id, str)
                else None
            )
            if future is None:
                self.respond(
                    request,
                    False,
                    f"no pending native permission request {approval_id!r}",
                )
                return
            future.set_result(response)
            self.respond(request, True, {})
        else:
            raise WorkerError(f"unsupported worker request type {kind!r}")

    async def _run_turn(self, turn: _Turn) -> None:
        frame: dict[str, object] = {"type": "sdk_settled"}
        try:
            await self._client.query(turn.prompt)
            frame["result"] = await turn.consumed
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            frame["error"] = _text(exc)
        if self.closing:
            return
        self._cancel_approvals()
        self._turn = None
        self.send(frame)

    async def _abort(self, request: dict[str, object]) -> None:
        if self._turn is None:
            self.respond(request, False, "no active turn to interrupt")
            return
        armed = self._transport.arm_interrupt()
        try:
            await self._client.interrupt()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self.respond(request, False, f"native interrupt failed: {_text(exc)}")
            return
        finally:
            self._transport.disarm_interrupt()
        response = armed.response
        receipt = response.get("response") if response is not None else None
        if not isinstance(receipt, dict) or not isinstance(
            receipt.get("still_queued"), list
        ):
            self.respond(
                request,
                False,
                f"native interrupt returned no supported receipt (still_queued list expected): {receipt!r}",
            )
            return
        if receipt["still_queued"]:
            self.fail(
                "protocol-error",
                f"native interrupt left queued work behind: {receipt['still_queued']!r}",
                receipt,
            )
            self.respond(request, False, "native interrupt left queued work behind")
            return
        self.send(
            {
                "type": "sdk_event",
                "event": {"type": "claude_interrupt", "receipt": receipt},
            }
        )
        self.respond(request, True, receipt)

    # ---- SDK consumption --------------------------------------------------

    async def _consume(self) -> None:
        """Drain the SDK's parsed message stream for the whole session so its
        read loop (which also serves hooks and permissions) never stalls."""
        sdk = self._sdk
        assert sdk is not None
        try:
            async for message in self._client.receive_messages():
                if not isinstance(message, sdk.ResultMessage):
                    continue
                turn = self._turn
                if turn is None or turn.raw_result is None:
                    self.fail(
                        "protocol-error",
                        "SDK parsed a result no raw native result preceded",
                    )
                    return
                if not turn.consumed.done():
                    turn.consumed.set_result(turn.raw_result)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            if not self.closing:
                self.fail(*_classify_sdk_error(sdk, exc))
            return
        if not self.closing:
            self.fail(
                "disconnected", "SDK message stream ended while the session was open"
            )

    # ---- lifecycle --------------------------------------------------------

    async def _open_stdio(self) -> None:
        reader = asyncio.StreamReader(limit=MAX_BYTES + 1)
        self._read_transport, _ = await self._loop.connect_read_pipe(
            lambda: asyncio.StreamReaderProtocol(reader),
            os.fdopen(os.dup(0), "rb", buffering=0),
        )
        self._reader = reader
        transport, protocol = await self._loop.connect_write_pipe(
            asyncio.streams.FlowControlMixin, os.fdopen(os.dup(1), "wb", buffering=0)
        )
        transport.set_write_buffer_limits(high=MAX_BYTES)
        self._writer = asyncio.StreamWriter(transport, protocol, None, self._loop)

    async def _connect(self) -> None:
        options = self.options
        await _probe_cli_version(options.cli_path, options.cwd)
        sdk = _load_sdk(options.package_root)
        self._sdk = sdk
        client_options = sdk.ClaudeAgentOptions(
            can_use_tool=self._can_use_tool,
            hooks={
                event: [sdk.HookMatcher(hooks=[self._on_hook])]
                for event in IDENTITY_HOOKS
            },
        )
        self._transport = _make_transport(
            sdk,
            self,
            _cli_argv(options, self.session_id),
            _cli_env(options),
            options.cwd,
        )
        client = sdk.ClaudeSDKClient(options=client_options, transport=self._transport)
        await client.connect()
        self._client = client

    async def _serve(self) -> None:
        reader = self._reader
        assert reader is not None
        while not self.closing:
            try:
                line = await reader.readuntil(b"\n")
            except asyncio.LimitOverrunError:
                raise WorkerError(
                    "worker request exceeds the 1 MiB transport bound"
                ) from None
            except asyncio.IncompleteReadError:
                return
            line = line.rstrip(b"\r\n")
            if not line:
                continue
            try:
                request = json.loads(line.decode("utf-8"))
            except (UnicodeDecodeError, ValueError) as exc:
                raise WorkerError(
                    f"worker request is not valid JSON: {_text(exc)}"
                ) from None
            self._command(request)

    async def _dispose(self) -> bool:
        """Release native resources; True when everything was released."""
        self.closing = True
        for task in list(self._tasks):
            task.cancel()
        for future in self._approvals.values():
            future.cancel()
        self._approvals.clear()
        for task in list(self._tasks):
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass
        if self._client is None:
            return True
        try:
            await asyncio.wait_for(self._client.disconnect(), DISPOSE_SECONDS)
        except asyncio.TimeoutError:
            sys.stderr.write(
                f"claude sdk worker: native disposal exceeded {DISPOSE_SECONDS}s\n"
            )
            return False
        except Exception as exc:
            sys.stderr.write(
                f"claude sdk worker: native disposal failed: {_text(exc)}\n"
            )
            return False
        return True

    async def _flush_output(self) -> None:
        writer = self._writer
        if writer is None:
            return
        self._writer = None
        writer.transport.set_write_buffer_limits(high=0, low=0)
        try:
            await asyncio.wait_for(writer.drain(), FLUSH_SECONDS)
        except (asyncio.TimeoutError, ConnectionError):
            pass
        writer.close()

    async def run(self) -> int:
        await self._open_stdio()
        for sig in (signal.SIGTERM, signal.SIGINT):
            self._loop.add_signal_handler(sig, self.request_shutdown)
        connected = False
        try:
            if not self.closing:
                await self._connect()
                connected = True
                self._spawn(self._consume())
                await self._serve()
        except Exception as exc:
            detail = (
                str(exc)
                if isinstance(exc, WorkerError)
                else f"{type(exc).__name__}: {_text(exc)}"
            )
            if not connected:
                sys.stderr.write(f"claude sdk worker: startup failed: {detail}\n")
                await self._flush_output()
                return 1
            self.fail("protocol-error", detail)
        disposed = await self._dispose()
        await self._flush_output()
        return 0 if disposed else 1


def _classify_sdk_error(sdk: ModuleType, exc: Exception) -> tuple[str, str, object]:
    """Map an SDK stream exception onto the host's failure statuses."""
    if isinstance(exc, sdk.ProcessError):
        code = getattr(exc, "exit_code", None)
        raw: dict[str, object] = {"exit_code": code, "signal": None}
        data = getattr(exc, "data", None)
        if isinstance(data, dict):
            raw["result"] = data
        if isinstance(code, int) and code < 0:
            raw["exit_code"] = None
            raw["signal"] = _signal_name(code)
            return "signaled", _text(exc), raw
        return "exited", _text(exc), raw
    if isinstance(exc, sdk.CLIConnectionError):
        return "disconnected", _text(exc), None
    return "protocol-error", f"{type(exc).__name__}: {_text(exc)}", None


def main() -> int:
    if len(sys.argv) != 2:
        sys.stderr.write("claude sdk worker: usage: _claude_sdk.py '<options JSON>'\n")
        return 2
    try:
        options = Options(json.loads(sys.argv[1]))
    except (ValueError, WorkerError) as exc:
        sys.stderr.write(f"claude sdk worker: invalid options: {exc}\n")
        return 2

    async def run() -> int:
        return await Worker(options).run()

    return asyncio.run(run())


if __name__ == "__main__":
    sys.exit(main())
