"""Real optional Cline SDK, synthetic loopback provider; no provider account."""
from __future__ import annotations

import asyncio
from dataclasses import replace
import json
import os
from pathlib import Path
import signal
import subprocess
import sys

import pytest

from harness import ClineSdkOptions, HarnessError, SessionSpec, open_session

ROOT = Path(__file__).parent
SDK = ROOT.parent / "ts/node_modules/@cline/sdk"
CASES = json.loads((ROOT / "cline_sdk_cases.json").read_text())
pytestmark = pytest.mark.skipif(sys.platform not in ("darwin", "linux") or not SDK.exists(), reason="POSIX and optional Cline SDK development dependency required")


@pytest.fixture
def configuration(tmp_path):
    providers = []

    def make(scenario):
        directory = tmp_path / scenario
        workdir = directory / "work"
        workdir.mkdir(parents=True)
        home = directory / "home"
        home.mkdir()
        provider = subprocess.Popen(
            [sys.executable, str(ROOT / "helpers/cline_provider.py"), str(workdir), scenario],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            start_new_session=True,
        )
        providers.append(provider)
        endpoint = json.loads(provider.stdout.readline())["endpoint"]
        config = directory / "config"
        settings = config / "data/settings"
        settings.mkdir(parents=True)
        (settings / "providers.json").write_text(json.dumps({"version": 1, "modes": {}, "lastUsedProvider": "openai-compatible", "providers": {
            "openai-compatible": {"settings": {"provider": "openai-compatible", "model": "synthetic", "apiKey": "synthetic", "baseUrl": endpoint}, "updatedAt": "2026-09-10T00:00:00Z", "tokenSource": "manual"},
        }}))
        return SessionSpec(
            "cline", workdir, "sdk", executable=os.environ.get("HARNESS_TEST_NODE", "node"), model="synthetic", timeout_seconds=12, request_timeout_seconds=10,
            env={"HOME": str(home), "NODE_OPTIONS": "--import=" + (ROOT / "helpers/cline_faults.mjs").as_uri(), "HARNESS_TEST_CLINE_PACKAGE_ROOT": str(SDK), "HARNESS_TEST_CLINE_SCENARIO": scenario},
            cline_sdk=ClineSdkOptions(package_root=SDK, config_dir=config, provider="openai-compatible", features="builtin-only", approval="callback"),
        )

    yield make
    for provider in providers:
        provider.stdin.close()
        try:
            provider.wait(timeout=5)
        except subprocess.TimeoutExpired:
            assert provider.poll() is None and os.getpgid(provider.pid) == provider.pid
            os.killpg(provider.pid, signal.SIGKILL)
            provider.wait(timeout=2)
        provider.stdout.close()
        provider.stderr.close()


async def collect(turn):
    return [event async for event in turn.events]


@pytest.mark.parametrize("case", CASES, ids=[case["name"] for case in CASES])
async def test_native_cline_contract(configuration, case):
    spec = configuration(case["name"])
    session = await open_session(spec)
    events = []
    operation = None
    try:
        turn = session.start_turn(case["name"])
        for_event = turn.events
        async for event in for_event:
            events.append(event)
            if event.type == "cline_permission":
                await session.respond_approval(event.raw["id"], case.get("reply", "once"))
            native = event.raw.get("payload", {}).get("event", {})
            if native.get("contentType") == "tool" and native.get("type") == "content_update" and case.get("operation") and operation is None:
                operation = asyncio.create_task(session.interrupt() if case["operation"] == "interrupt" else session.close())
        result = await turn.result
        if operation:
            await operation
        assert result.status == case["status"]
        assert result.session_id == session.reference.session_id
        future = next(event for event in events if event.type == "future_native_event")
        assert future.raw["payload"]["future"] == {"preserved": True}
        if case["name"] == "success":
            assert result.raw["text"] == "synthetic native reply"
            assert result.raw["usage"]["inputTokens"] == 11
            assert result.raw["usage"]["outputTokens"] == 3
        if case["name"] == "command-error":
            tool = next(event.raw["payload"]["event"] for event in events if event.type == "agent_event" and event.raw["payload"]["event"].get("contentType") == "tool" and event.raw["payload"]["event"]["type"] == "content_end")
            assert tool["output"][0]["success"] is False
        if case["name"] == "partial-wire":
            assert any(event.raw.get("payload", {}).get("event", {}).get("contentType") == "text" for event in events)
        if case["name"] == "worker-loss":
            assert result.signal == "SIGKILL"
    finally:
        await session.close()
    assert not (spec.workdir / ".harness-run.lock").exists()
    if case["name"] in {"interrupt", "close", "worker-loss"}:
        await asyncio.sleep(3.2)
    assert not (spec.workdir / "survived").exists()


async def test_native_cline_followup_resume_and_identity_refusal(configuration):
    spec = replace(configuration("followup"), instructions="Cline-owned instruction sentinel 8f26")
    instruction_file = spec.workdir / "CLINE.md"
    instruction_file.write_text("original caller instructions")
    session = await open_session(spec)
    try:
        for prompt in ("original-history", "followup-history"):
            turn = session.start_turn(prompt)
            await collect(turn)
            assert (await turn.result).status == "completed"
        reference = session.reference
    finally:
        await session.close()
    assert instruction_file.read_text() == "original caller instructions"
    session = await open_session(replace(spec, resume=reference))
    try:
        assert session.reference == reference
        turn = session.start_turn("resumed-history")
        await collect(turn)
        result = await turn.result
        assert result.status == "completed"
        assert result.raw["usage"]["inputTokens"] == 11  # per-turn, never summed snapshots
    finally:
        await session.close()
    requests = [json.loads(line) for line in (spec.workdir / "provider-requests.jsonl").read_text().splitlines()]
    history = json.dumps(requests[-1]["messages"])
    assert "original-history" in history and "followup-history" in history and "resumed-history" in history
    assert spec.instructions in history
    assert instruction_file.read_text() == "original caller instructions"
    manifest = json.loads(reference.session_file.read_text())
    assert manifest["metadata"]["usage"]["inputTokens"] == 33
    assert manifest["metadata"]["usage"]["outputTokens"] == 9
    before = reference.session_file.read_bytes()
    with pytest.raises(HarnessError):
        await open_session(replace(spec, resume=replace(reference, session_id="unknown-exact-id")))
    assert reference.session_file.read_bytes() == before
    manifest["cwd"] = str(spec.workdir.parent)
    reference.session_file.write_text(json.dumps(manifest))
    with pytest.raises(HarnessError):
        await open_session(replace(spec, resume=reference))
    assert not (spec.workdir / ".harness-run.lock").exists()


async def test_cline_rejects_unsupported_features_and_missing_dependency(configuration):
    spec = configuration("invalid")
    with pytest.raises(HarnessError) as unsupported:
        await open_session(replace(spec, cline_sdk=replace(spec.cline_sdk, features="native-hooks")))
    assert unsupported.value.code == "unsupported-capability"
    with pytest.raises(HarnessError) as missing:
        await open_session(replace(spec, cline_sdk=replace(spec.cline_sdk, package_root=spec.workdir / "missing-sdk")))
    assert missing.value.code == "launch-failed"
    assert not (spec.workdir / ".harness-run.lock").exists()
