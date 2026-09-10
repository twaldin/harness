"""Caller-owned OpenHands Agent Server HTTP/WebSocket conformance; synthetic peer only."""
from __future__ import annotations

import asyncio
import json
import re
import sys
from contextlib import asynccontextmanager
from dataclasses import replace
from pathlib import Path

import pytest

from harness import HarnessError, OpenHandsOptions, SessionSpec, get_adapter, get_session_capabilities, open_session

TESTS = Path(__file__).parent
CASES = json.loads((TESTS / "openhands_cases.json").read_text())
WORKDIR = Path("/synthetic/server/work")
KEY = "fixture-api-key"
MODEL = "synthetic/fixture"
PROFILE_ID = "11111111-1111-4111-8111-111111111111"
MISSING_ID = "33333333-3333-4333-8333-333333333333"
UUID_RE = r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"
#: Startup variants rejected before anything is created on the server.
PRE_CREATE_VARIANTS = ("wrong-version", "redirect", "acp-profile", "wrong-model")


@asynccontextmanager
async def peer(tmp_path, variant="normal"):
    trace = tmp_path / "requests.jsonl"
    child = await asyncio.create_subprocess_exec(
        sys.executable, "-I", str(TESTS / "helpers/openhands_server.py"),
        "--lifetime", "60", "--trace", str(trace), "--variant", variant,
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    try:
        endpoint = (await asyncio.wait_for(child.stdout.readline(), 5)).decode().strip()
        assert endpoint.startswith("http://127.0.0.1:")
        options = OpenHandsOptions(endpoint=endpoint, api_key=KEY, agent_profile="fixture-agent", confirm_no_unwanted_callbacks=True)
        yield SessionSpec("openhands", WORKDIR, "rpc", model=MODEL, openhands=options, timeout_seconds=3, request_timeout_seconds=1), trace, child
    finally:
        child.stdin.close()
        try:
            await asyncio.wait_for(child.wait(), 3)
        except asyncio.TimeoutError:
            # This unreaped Process object, not a name/PID search, owns the child.
            child.kill()
            await child.wait()
            pytest.fail("owned synthetic peer failed to stop after stdin EOF")
        errors = (await child.stderr.read()).decode()
        assert child.returncode == 0, errors
        assert not errors, errors


async def nudge(child, byte: bytes) -> None:
    """Test-only stdin acknowledgement: HTTP and the socket are independent
    channels, so server write order cannot prove client receipt."""
    child.stdin.write(byte)
    await child.stdin.drain()


def requests(trace):
    return [json.loads(line) for line in trace.read_text().splitlines()] if trace.exists() else []


def paths(trace, suffix):
    return [request for request in requests(trace) if request["path"].endswith(suffix) and not request["upgrade"]]


def inner(event):
    payload = event.raw.get("event")
    return payload if isinstance(payload, dict) else {}


def is_running_event(event) -> bool:
    return event.type == "ConversationStateUpdateEvent" and inner(event).get("key") == "execution_status" and inner(event).get("value") == "running"


def is_final_state(event, status: str) -> bool:
    payload = inner(event)
    return event.type == "ConversationStateUpdateEvent" and payload.get("key") == "full_state" and payload["value"]["execution_status"] == status


def echo_text(event) -> str | None:
    payload = inner(event)
    if event.type != "MessageEvent" or payload.get("source") != "user":
        return None
    return "".join(part["text"] for part in payload["llm_message"]["content"] if part.get("type") == "text")


def assert_caller_server_preserved(trace):
    """Every request stays on the qualified read/create/send/run/interrupt routes and uploads no credentials."""
    seen = requests(trace)
    assert seen, "expected traced requests"
    for request in seen:
        path, method, body = request["path"], request["method"], request["body"]
        assert method in ("GET", "POST"), request
        assert not request["expose_secrets"], request
        if request["upgrade"]:
            assert method == "GET" and path.startswith("/sockets/session/"), request
            assert "session_api_key" not in request["query"] and "after_seq" not in request["query"], request
            continue
        if path in ("/server_info", "/api/agent-profiles/fixture-agent", "/api/profiles/fixture-llm"):
            assert method == "GET" and body is None, request
            continue
        assert path.startswith("/api/conversations"), request
        assert not any(part in path for part in ("pause", "confirmation", "secrets", "switch", "init", "settings", "goal", "fork", "navigate", "condense", "plugin", "profile", "search", "count")), request
        if method == "GET":
            assert body is None
            continue
        serialized = json.dumps(body)
        assert KEY not in serialized and "api_key" not in serialized and "secret" not in serialized, request
        if path == "/api/conversations":
            assert set(body) == {"conversation_id", "agent_profile_id", "workspace", "worktree", "autotitle"}, body
            assert body["agent_profile_id"] == PROFILE_ID
            assert body["workspace"] == {"kind": "LocalWorkspace", "working_dir": str(WORKDIR)}
            assert body["worktree"] is False and body["autotitle"] is False
        elif path.endswith("/events"):
            assert set(body) == {"role", "content", "run"} and body["role"] == "user" and body["run"] is False, body
            assert len(body["content"]) == 1 and set(body["content"][0]) == {"type", "text"} and body["content"][0]["type"] == "text", body
        else:
            assert path.endswith(("/run", "/interrupt")) and body is None, request


@pytest.mark.parametrize("case", CASES, ids=[case["prompt"] for case in CASES])
async def test_shared_protocol_case(tmp_path, case):
    async with peer(tmp_path) as (spec, trace, child):
        spec = replace(spec, timeout_seconds=case.get("timeout_seconds", spec.timeout_seconds))
        async with await open_session(spec) as session:
            turn = session.start_turn(case["prompt"])
            events = []
            async for event in turn.events:
                events.append(event)
                if case.get("partial") and is_running_event(event):
                    await nudge(child, b"\x01")
            result = await turn.result
            assert result.status == case["status"]
            assert result.session_id == session.reference.session_id
            assert result.turn_id == turn.id
            assert all(event.harness == "openhands" and event.backend == "rpc" for event in events)
            assert all(event.session_id == session.reference.session_id and event.turn_id == turn.id for event in events)
            for event in events:
                if event.raw["type"] in ("durable", "transient"):
                    assert event.type == inner(event)["kind"] and event.request_id == inner(event)["id"]
                else:
                    assert event.type == event.raw["type"]
            if "event_types" in case:
                assert [event.type for event in events] == case["event_types"]
            if case.get("partial"):
                assert any(is_running_event(event) for event in events), "received running transition must survive failure"
            if not case.get("no_echo"):
                echo = next(event for event in events if echo_text(event) == case["prompt"])
                assert echo.raw["type"] == "durable" and isinstance(echo.raw["seq"], int)
            if case.get("unknown_event"):
                assert next(event.raw for event in events if event.type == "SyntheticFutureEvent")["event"]["nested"] == {"value": 42}
                assert next(event.raw for event in events if event.type == "item_started")["attempt"] == 1
            if "error_envelope" in case:
                assert events[-1].raw == case["error_envelope"]
            if "terminal" in case:
                assert result.raw["state"]["execution_status"] == case["terminal"]
                assert result.raw["state"]["id"] == session.reference.session_id
                assert result.raw["state"]["stats"]["usage_to_metrics"]["agent"]["accumulated_token_usage"]["prompt_tokens"] == 7
                assert result.raw["terminal_event"]["kind"] == "ConversationStateUpdateEvent"
                assert result.raw["terminal_event"]["key"] == "execution_status" and result.raw["terminal_event"]["value"] == case["terminal"]
                assert any(is_final_state(event, case["terminal"]) for event in events)
            if "text" in case:
                reply = next(inner(event) for event in events if event.type == "MessageEvent" and inner(event)["source"] == "agent")
                assert reply["llm_message"]["content"][0]["text"] == case["text"]
            if "http_status" in case:
                assert result.raw["http_status"] == case["http_status"]
                assert str(case["http_status"]) in result.error
            if "error" in case:
                assert result.error == case["error"]
            if case.get("closes_session"):
                assert session.closed
            elif "terminal" in case or "http_status" in case:
                # Native outcomes and HTTP rejections are turn results; the transport stays usable.
                assert not session.closed
            assert result.exit_code is None and result.signal is None
        assert child.returncode is None
        assert_caller_server_preserved(trace)
        assert not paths(trace, "/interrupt")
        if case.get("no_run"):
            assert not paths(trace, "/run")


async def test_followup_resume_identity_and_local_only_close(tmp_path):
    async with peer(tmp_path) as (spec, trace, child):
        session = await open_session(spec)
        reference = session.reference
        assert reference.workdir == WORKDIR and reference.session_file is None
        assert reference.endpoint == spec.openhands.endpoint
        assert re.fullmatch(UUID_RE, reference.session_id)
        ids = []
        prompt_tokens = []
        for _ in range(2):
            turn = session.start_turn("success")
            events = [event async for event in turn.events]
            result = await turn.result
            assert result.status == "completed" and result.session_id == reference.session_id
            echo = next(event for event in events if echo_text(event) == "success")
            ids.append(echo.request_id)
            assert result.raw["state"]["last_user_message_id"] == echo.request_id
            prompt_tokens.append(result.raw["state"]["stats"]["usage_to_metrics"]["agent"]["accumulated_token_usage"]["prompt_tokens"])
        assert ids[0] != ids[1]
        # Native stats are cumulative; the harness reports them untouched.
        assert prompt_tokens == [7, 14]
        await asyncio.gather(session.close(), session.close())
        assert child.returncode is None
        equivalent = replace(reference, endpoint=reference.endpoint.upper() + "/")
        async with await open_session(replace(spec, resume=equivalent)) as resumed:
            assert resumed.reference == reference
            turn = resumed.start_turn("success")
            async for _ in turn.events:
                pass
            result = await turn.result
            assert result.status == "completed"
            assert result.raw["state"]["stats"]["usage_to_metrics"]["agent"]["accumulated_token_usage"]["prompt_tokens"] == 21
        creates = [request for request in requests(trace) if request["method"] == "POST" and request["path"] == "/api/conversations"]
        assert len(creates) == 1 and creates[0]["body"]["conversation_id"] == reference.session_id
        assert len(paths(trace, "/events")) == 3 and len(paths(trace, "/run")) == 3
        assert [request["path"] for request in requests(trace) if request["upgrade"]] == [f"/sockets/session/{reference.session_id}"] * 2
        assert_caller_server_preserved(trace)


async def test_interrupt_and_followup(tmp_path):
    async with peer(tmp_path) as (spec, trace, child):
        async with await open_session(spec) as session:
            turn = session.start_turn("hang")
            with pytest.raises(HarnessError) as error:
                session.start_turn("concurrent")
            assert error.value.code == "unsupported-capability"
            async for event in turn.events:
                if is_running_event(event):
                    await nudge(child, b"\x01")
                    await session.interrupt()
            result = await turn.result
            assert result.status == "interrupted"
            assert result.raw["state"]["execution_status"] == "paused"
            assert not session.closed
            followup = session.start_turn("success")
            async for _ in followup.events:
                pass
            assert (await followup.result).status == "completed"
        assert len(paths(trace, "/interrupt")) == 1
        assert len(paths(trace, "/events")) == 2
        assert_caller_server_preserved(trace)


async def test_interrupt_acknowledged_without_paused_is_a_protocol_failure(tmp_path):
    async with peer(tmp_path) as (spec, trace, child):
        async with await open_session(spec) as session:
            turn = session.start_turn("interrupt-ack-only")
            async for event in turn.events:
                if is_running_event(event):
                    await nudge(child, b"\x01")
                    await session.interrupt()
            assert (await turn.result).status == "protocol-error"
            assert session.closed
        assert len(paths(trace, "/interrupt")) == 1
        assert child.returncode is None


async def test_normal_finish_racing_interrupt_stays_completed(tmp_path):
    async with peer(tmp_path) as (spec, trace, child):
        async with await open_session(spec) as session:
            turn = session.start_turn("interrupt-race")
            async for event in turn.events:
                if is_running_event(event):
                    await nudge(child, b"\x01")
                    await session.interrupt()
            result = await turn.result
            assert result.status == "completed"
            assert result.raw["state"]["execution_status"] == "finished"
        assert len(paths(trace, "/interrupt")) == 1

@pytest.mark.parametrize("prompt", ["interrupt-http-error", "interrupt-http-timeout", "interrupt-http-disconnect"])
async def test_native_finish_survives_failed_interrupt_request(tmp_path, prompt, caplog):
    async with peer(tmp_path) as (spec, trace, child):
        async with await open_session(spec) as session:
            turn = session.start_turn(prompt)
            interrupted = None
            async for event in turn.events:
                if is_running_event(event):
                    await nudge(child, b"\x01")
                    interrupted = asyncio.create_task(session.interrupt())
                if is_final_state(event, "finished"):
                    await nudge(child, b"\x03")
            assert interrupted is not None
            await interrupted
            result = await turn.result
            assert result.status == "completed"
            assert result.raw["state"]["execution_status"] == "finished"
            assert session.closed
            with pytest.raises(HarnessError):
                session.start_turn("must not follow a failed interrupt mutation")
        assert len(paths(trace, "/interrupt")) == 1
        assert len(paths(trace, "/run")) == 1
        assert child.returncode is None
    assert not [record for record in caplog.records if record.name == "asyncio" and record.levelno >= 40]



async def test_late_paused_frames_after_finish_keep_completed(tmp_path):
    async with peer(tmp_path) as (spec, trace, child):
        async with await open_session(spec) as session:
            turn = session.start_turn("interrupt-late-paused")
            async for event in turn.events:
                if is_running_event(event):
                    await nudge(child, b"\x01")
                    await session.interrupt()
            result = await turn.result
            # The finished barrier latched while the interrupt request was pending;
            # paused frames arriving before its acknowledgement never rewrite it.
            assert result.status == "completed"
            assert result.raw["state"]["execution_status"] == "finished"
        assert len(paths(trace, "/interrupt")) == 1


def order(trace, *suffixes):
    seen = [request["path"] for request in requests(trace) if not request["upgrade"]]
    return [next(index for index, path in enumerate(seen) if path.endswith(suffix)) for suffix in suffixes]


async def test_immediate_interrupt_awaits_owned_run_and_paused_barrier(tmp_path):
    async with peer(tmp_path) as (spec, trace, child):
        async with await open_session(spec) as session:
            turn = session.start_turn("hang-eager")
            await session.interrupt()
            events = [event async for event in turn.events]
            result = await turn.result
            assert result.status == "interrupted"
            assert result.raw["state"]["execution_status"] == "paused"
            assert any(echo_text(event) == "hang-eager" for event in events)
            assert any(is_running_event(event) for event in events)
            assert not session.closed
            followup = session.start_turn("success")
            async for _ in followup.events:
                pass
            assert (await followup.result).status == "completed"
        assert len(paths(trace, "/interrupt")) == 1
        # The interrupt targets the caller's own accepted run, never an earlier state.
        submitted, accepted, interrupted = order(trace, "/events", "/run", "/interrupt")
        assert submitted < accepted < interrupted
        assert child.returncode is None


async def test_immediate_interrupt_with_rejected_run_never_interrupts(tmp_path):
    async with peer(tmp_path) as (spec, trace, _):
        async with await open_session(spec) as session:
            turn = session.start_turn("run-busy")
            await session.interrupt()
            async for _ in turn.events:
                pass
            result = await turn.result
            assert result.status == "agent-error" and result.raw["http_status"] == 409
        assert not paths(trace, "/interrupt")
        assert len(paths(trace, "/run")) == 1


async def drain_until_finished(session) -> None:
    async for event in session.events:
        if is_final_state(event, "finished"):
            return
    pytest.fail("idle stream closed before the remote run finished")


async def test_active_close_preserves_remote_work_and_busy_resume_never_appends(tmp_path):
    async with peer(tmp_path) as (spec, trace, child):
        session = await open_session(spec)
        reference = session.reference
        turn = session.start_turn("close-active")
        async for event in turn.events:
            if is_running_event(event):
                await nudge(child, b"\x01")
                await asyncio.gather(session.close(), session.close())
        assert (await turn.result).status == "closed"
        assert child.returncode is None
        with pytest.raises(HarnessError) as error:
            session.start_turn("after close")
        assert error.value.code == "session-closed"
        assert not paths(trace, "/interrupt") and not paths(trace, "/pause")
        sent = len(paths(trace, "/events"))
        # The server keeps running the turn; resume observes that honestly and
        # never appends into the still-running work.
        resumed = await open_session(replace(spec, resume=reference))
        try:
            assert resumed.reference == reference
            busy = resumed.start_turn("success")
            # An immediate interrupt must not reach the foreign run either.
            await resumed.interrupt()
            async for _ in busy.events:
                pass
            result = await busy.result
            assert result.status == "agent-error" and "running" in result.error
            assert not resumed.closed
            assert len(paths(trace, "/events")) == sent
            assert not paths(trace, "/interrupt")
            await nudge(child, b"\x02")
            await asyncio.wait_for(drain_until_finished(resumed), 5)
            followup = resumed.start_turn("success")
            async for _ in followup.events:
                pass
            assert (await followup.result).status == "completed"
        finally:
            await resumed.close()
        assert len(paths(trace, "/events")) == sent + 1
        assert not paths(trace, "/interrupt")
        assert_caller_server_preserved(trace)


async def test_turn_deadline_closes_transport_without_server_interrupt(tmp_path):
    async with peer(tmp_path) as (spec, trace, child):
        async with await open_session(replace(spec, timeout_seconds=0.1)) as session:
            turn = session.start_turn("hang")
            async for _ in turn.events:
                pass
            assert (await turn.result).status == "timed-out"
            assert session.closed
        assert child.returncode is None
        assert not paths(trace, "/interrupt")
        assert_caller_server_preserved(trace)


async def test_unconsumed_queue_overflow_is_visible(tmp_path):
    async with peer(tmp_path) as (spec, trace, _):
        async with await open_session(replace(spec, max_buffer_bytes=4096)) as session:
            turn = session.start_turn("overflow")
            result = await turn.result
            assert result.status == "protocol-error" and result.events_truncated
            events = [event async for event in turn.events]
            assert any(is_running_event(event) for event in events)
        assert_caller_server_preserved(trace)


@pytest.mark.parametrize(
    "variant,code",
    [
        ("wrong-version", "unsupported-backend"),
        ("redirect", "launch-failed"),
        ("acp-profile", "unsupported-capability"),
        ("wrong-model", "protocol-error"),
        ("wrong-workdir", "protocol-error"),
        ("wrong-identity", "protocol-error"),
        ("profile-mismatch", "protocol-error"),
        ("collision", "protocol-error"),
        ("unknown-status", "protocol-error"),
        ("ws-redirect", "launch-failed"),
        ("ws-reject", "launch-failed"),
    ],
)
async def test_startup_rejects_unqualified_server(tmp_path, variant, code):
    async with peer(tmp_path, variant) as (spec, trace, child):
        with pytest.raises(HarnessError) as error:
            await open_session(spec)
        assert error.value.code == code
        assert child.returncode is None
        seen = requests(trace)
        assert not paths(trace, "/events") and not paths(trace, "/run")
        assert not any(request["path"] == "/sockets/redirected" for request in seen)
        creates = [request for request in seen if request["method"] == "POST"]
        if variant in PRE_CREATE_VARIANTS:
            assert not creates and not any(request["upgrade"] for request in seen), "unqualified servers are rejected before anything is created"
        else:
            assert len(creates) == 1 and creates[0]["path"] == "/api/conversations", "identity is verified once, never retried with a new UUID"


async def test_wrong_credentials_do_not_fallback_or_leak(tmp_path):
    async with peer(tmp_path) as (spec, trace, _):
        secret = "synthetic-wrong-secret"
        wrong = replace(spec.openhands, api_key=secret)
        with pytest.raises(HarnessError) as error:
            await open_session(replace(spec, openhands=wrong))
        assert error.value.code == "launch-failed"
        assert secret not in str(error.value) and secret not in repr(wrong)
        assert [request["path"] for request in requests(trace)] == ["/server_info", "/api/agent-profiles/fixture-agent"]


async def test_validation_precedes_all_network_effects(tmp_path):
    async with peer(tmp_path) as (spec, trace, _):
        for override in (
            {"instructions": "must not write"},
            {"env": {"HOME": str(tmp_path)}},
            {"executable": sys.executable},
            {"permission_policy": "bypass"},
            {"openhands": None},
            {"model": None},
            {"model": "   "},
            {"omp_sdk": spec.openhands},
            {"claude_sdk": spec.openhands},
            {"backend": "sdk"},
            {"backend": "cli"},
        ):
            with pytest.raises(HarnessError):
                await open_session(replace(spec, **override))
        for field, value in (
            ("confirm_no_unwanted_callbacks", False),
            ("confirm_no_unwanted_callbacks", "true"),
            ("confirm_no_unwanted_callbacks", 1),
            ("api_key", ""),
            ("api_key", "a b"),
            ("api_key", "a\nb"),
            ("api_key", "clé"),
            ("agent_profile", ""),
            ("agent_profile", ".hidden"),
            ("agent_profile", "a/b"),
            ("agent_profile", "x" * 65),
            ("agent_profile", "sp ace"),
        ):
            with pytest.raises(HarnessError) as error:
                await open_session(replace(spec, openhands=replace(spec.openhands, **{field: value})))
            assert error.value.code == "invalid-options", (field, value)
            assert "a\nb" not in str(error.value) and "clé" not in str(error.value)
        for endpoint in ("", "http://user:secret@localhost:3000", "http://localhost:3000/path", "http://localhost:3000?x=1", "ftp://localhost", "ws://localhost:3000"):
            with pytest.raises(HarnessError):
                await open_session(replace(spec, openhands=replace(spec.openhands, endpoint=endpoint)))
        with pytest.raises(HarnessError) as error:
            await open_session(replace(spec, openhands=replace(spec.openhands, endpoint="http://synthetic:fixture-api-key@[")))
        assert error.value.code == "invalid-options"
        assert "fixture-api-key" not in str(error.value)
        assert requests(trace) == []
        assert not (tmp_path / "AGENTS.md").exists()
    capabilities = get_session_capabilities("openhands", "rpc")
    assert capabilities.approval is False
    assert capabilities.follow_up and capabilities.resume and not capabilities.concurrent_turns
    for backend in ("sdk", "cli"):
        with pytest.raises(HarnessError) as error:
            get_session_capabilities("openhands", backend)
        assert error.value.code == "unsupported-backend"
    with pytest.raises(HarnessError) as error:
        get_session_capabilities("openhands-unknown", "rpc")
    assert error.value.code == "unknown-harness"
    # Session-only harness: the one-shot registry never learns a fake CLI adapter.
    with pytest.raises(HarnessError) as error:
        get_adapter("openhands")
    assert error.value.code == "unknown-harness"


async def test_resume_rejects_mismatch_before_network_and_never_creates(tmp_path):
    async with peer(tmp_path) as (spec, trace, _):
        async with await open_session(spec) as session:
            reference = session.reference
        before = requests(trace)
        for wrong in (
            replace(reference, endpoint="http://127.0.0.1:1"),
            replace(reference, workdir=Path("/synthetic/other")),
            replace(reference, session_file=tmp_path / "invented-history"),
            replace(reference, session_id="ses_not_a_uuid"),
            replace(reference, session_id=""),
        ):
            with pytest.raises(HarnessError) as error:
                await open_session(replace(spec, resume=wrong))
            assert error.value.code == "invalid-options"
        assert requests(trace) == before
        with pytest.raises(HarnessError) as error:
            await open_session(replace(spec, resume=replace(reference, session_id=MISSING_ID)))
        assert error.value.code == "launch-failed"
        later = requests(trace)[len(before):]
        assert any(request["method"] == "GET" and request["path"] == f"/api/conversations/{MISSING_ID}" for request in later)
        assert not any(request["method"] == "POST" or request["upgrade"] for request in later), "a missing conversation is never re-created or subscribed"


async def test_approval_channel_is_explicitly_unsupported(tmp_path):
    async with peer(tmp_path) as (spec, trace, _):
        async with await open_session(spec) as session:
            with pytest.raises(HarnessError) as error:
                await session.respond_approval("synthetic-request", "once")
            assert error.value.code == "unsupported-capability"
        assert not paths(trace, "/events") and not any("confirmation" in request["path"] for request in requests(trace))


async def test_oversized_conversation_lookup_is_a_protocol_failure(tmp_path):
    async with peer(tmp_path, "oversize-http") as (spec, trace, child):
        # Whether the identity re-check runs at open or before the first turn,
        # a >1 MiB JSON body is a protocol failure, never parsed leniently.
        try:
            session = await open_session(spec)
        except HarnessError as error:
            assert error.code == "protocol-error"
        else:
            async with session:
                turn = session.start_turn("success")
                async for _ in turn.events:
                    pass
                assert (await turn.result).status == "protocol-error"
        assert not paths(trace, "/events")
        assert child.returncode is None


async def test_missing_optional_dependency_is_explicit(tmp_path, monkeypatch):
    async with peer(tmp_path) as (spec, trace, _):
        # A None entry makes `import httpx` raise ImportError, as an absent extra would.
        monkeypatch.setitem(sys.modules, "httpx", None)
        monkeypatch.setitem(sys.modules, "websockets", None)
        with pytest.raises(HarnessError) as error:
            await open_session(spec)
        assert error.value.code == "launch-failed"
        assert "openhands" in str(error.value)
        assert requests(trace) == []
