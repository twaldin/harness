"""Golden fixture tests — load each fixtures/<name>.json, assert buildCommand and parseOutput.

Fixture JSONs use camelCase keys (matching the SPEC interface). We convert to
snake_case here so the Python types stay idiomatic.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

import harness.adapters  # noqa: F401 — populates registry
from harness._subproc import SubprocOutcome
from harness.base import RunSpec
from harness.registry import get_adapter

FIXTURES_DIR = Path(__file__).parent / "fixtures"


def _load_fixture(name: str) -> dict:
    return json.loads((FIXTURES_DIR / f"{name}.json").read_text())


def _make_spec(raw: dict) -> RunSpec:
    """Build RunSpec from fixture camelCase spec dict."""
    return RunSpec(
        harness=raw["harness"],
        prompt=raw["prompt"],
        workdir=Path(raw["workdir"]),
        model=raw.get("model"),
        instructions=raw.get("instructions"),
        timeout_seconds=raw.get("timeoutSeconds", 1800),
        env=raw.get("env", {}),
    )


def _make_outcome(raw: dict) -> SubprocOutcome:
    """Build SubprocOutcome from fixture sampleOutput dict."""
    return SubprocOutcome(
        exit_code=raw["exitCode"],
        duration_seconds=raw["durationSeconds"],
        stdout=raw["stdout"],
        stderr=raw["stderr"],
        timed_out=raw["timedOut"],
    )


def _normalize_parsed(expected: dict) -> dict:
    """Convert camelCase expectedParsed keys to snake_case, drop non-data fields."""
    mapping = {
        "costUsd": "cost_usd",
        "tokensIn": "tokens_in",
        "tokensOut": "tokens_out",
        "raw": "raw",
    }
    return {mapping[k]: v for k, v in expected.items() if k in mapping}


# ── Fixture: claude-code ────────────────────────────────────────────────────


def test_claude_code_build_command(tmp_path):
    fx = _load_fixture("claude-code")
    spec = _make_spec(fx["spec"])
    spec = RunSpec(
        harness=spec.harness,
        prompt=spec.prompt,
        workdir=tmp_path,  # use tmp so file writes succeed
        model=spec.model,
        instructions=spec.instructions,
        timeout_seconds=spec.timeout_seconds,
        env=spec.env,
    )
    adapter = get_adapter("claude-code")
    bc = adapter.build_command(spec)

    assert bc.cmd == fx["expectedCommand"]["cmd"]
    assert bc.args == fx["expectedCommand"]["args"]
    assert bc.instructions_file == tmp_path / "CLAUDE.md"
    assert (tmp_path / "CLAUDE.md").read_text() == spec.instructions


def test_claude_code_parse_output():
    fx = _load_fixture("claude-code")
    spec = _make_spec(fx["spec"])
    outcome = _make_outcome(fx["sampleOutput"])
    adapter = get_adapter("claude-code")
    parsed = adapter.parse_output(spec, outcome)

    expected = _normalize_parsed(fx["expectedParsed"])
    assert parsed["cost_usd"] == pytest.approx(expected["cost_usd"])
    assert parsed["tokens_in"] == expected["tokens_in"]
    assert parsed["tokens_out"] == expected["tokens_out"]


# ── Fixture: codex ──────────────────────────────────────────────────────────


def test_codex_build_command(tmp_path):
    fx = _load_fixture("codex")
    spec = _make_spec(fx["spec"])
    spec = RunSpec(
        harness=spec.harness,
        prompt=spec.prompt,
        workdir=tmp_path,
        model=spec.model,
        instructions=spec.instructions,
        timeout_seconds=spec.timeout_seconds,
        env=spec.env,
    )
    adapter = get_adapter("codex")
    bc = adapter.build_command(spec)

    expected_args = list(fx["expectedCommand"]["args"])
    # workdir in args will use tmp_path; patch the fixture's workdir value
    fixture_workdir = fx["spec"]["workdir"]
    actual_args = [str(tmp_path) if a == fixture_workdir else a for a in expected_args]

    assert bc.cmd == fx["expectedCommand"]["cmd"]
    assert bc.args == actual_args
    assert bc.instructions_file == tmp_path / "AGENTS.md"


def test_codex_parse_output():
    fx = _load_fixture("codex")
    spec = _make_spec(fx["spec"])
    outcome = _make_outcome(fx["sampleOutput"])
    adapter = get_adapter("codex")
    parsed = adapter.parse_output(spec, outcome)

    expected = _normalize_parsed(fx["expectedParsed"])
    assert parsed["cost_usd"] == expected["cost_usd"]
    assert parsed["tokens_in"] == expected["tokens_in"]
    assert parsed["tokens_out"] == expected["tokens_out"]


# ── Fixture: gemini ─────────────────────────────────────────────────────────


def test_gemini_build_command(tmp_path):
    fx = _load_fixture("gemini")
    spec = _make_spec(fx["spec"])
    spec = RunSpec(
        harness=spec.harness,
        prompt=spec.prompt,
        workdir=tmp_path,
        model=spec.model,
        instructions=spec.instructions,
        timeout_seconds=spec.timeout_seconds,
        env=spec.env,
    )
    adapter = get_adapter("gemini")
    bc = adapter.build_command(spec)

    assert bc.cmd == fx["expectedCommand"]["cmd"]
    assert bc.args == fx["expectedCommand"]["args"]
    assert bc.instructions_file == tmp_path / "GEMINI.md"


def test_gemini_parse_output():
    fx = _load_fixture("gemini")
    spec = _make_spec(fx["spec"])
    outcome = _make_outcome(fx["sampleOutput"])
    adapter = get_adapter("gemini")
    parsed = adapter.parse_output(spec, outcome)

    expected = _normalize_parsed(fx["expectedParsed"])
    assert parsed["cost_usd"] == expected["cost_usd"]
    assert parsed["tokens_in"] == expected["tokens_in"]
    assert parsed["tokens_out"] == expected["tokens_out"]


# ── Fixture: opencode ───────────────────────────────────────────────────────


def test_opencode_build_command(tmp_path):
    fx = _load_fixture("opencode")
    spec = _make_spec(fx["spec"])
    spec = RunSpec(
        harness=spec.harness,
        prompt=spec.prompt,
        workdir=tmp_path,
        model=spec.model,
        instructions=spec.instructions,
        timeout_seconds=spec.timeout_seconds,
        env=spec.env,
    )
    adapter = get_adapter("opencode")
    bc = adapter.build_command(spec)

    fixture_workdir = fx["spec"]["workdir"]
    expected_args = [str(tmp_path) if a == fixture_workdir else a for a in fx["expectedCommand"]["args"]]

    assert bc.cmd == fx["expectedCommand"]["cmd"]
    assert bc.args == expected_args
    assert bc.instructions_file == tmp_path / "AGENTS.md"


def test_opencode_parse_output_no_db(tmp_path, monkeypatch):
    """When no DB exists, all values are null."""
    fx = _load_fixture("opencode")
    spec = _make_spec(fx["spec"])
    spec = RunSpec(
        harness=spec.harness,
        prompt=spec.prompt,
        workdir=tmp_path,
        model=spec.model,
        instructions=spec.instructions,
        timeout_seconds=spec.timeout_seconds,
        env={"OPENCODE_DB": str(tmp_path / "no-such.db")},
    )
    outcome = _make_outcome(fx["sampleOutput"])
    adapter = get_adapter("opencode")
    parsed = adapter.parse_output(spec, outcome)

    assert parsed["cost_usd"] is None
    assert parsed["tokens_in"] is None
    assert parsed["tokens_out"] is None


# ── Fixture: aider ──────────────────────────────────────────────────────────


def test_aider_build_command(tmp_path):
    fx = _load_fixture("aider")
    spec = _make_spec(fx["spec"])
    spec = RunSpec(
        harness=spec.harness,
        prompt=spec.prompt,
        workdir=tmp_path,
        model=spec.model,
        instructions=spec.instructions,
        timeout_seconds=spec.timeout_seconds,
        env=spec.env,
    )
    adapter = get_adapter("aider")
    bc = adapter.build_command(spec)

    fixture_workdir = fx["spec"]["workdir"]
    expected_args = [str(tmp_path) if a == fixture_workdir else a for a in fx["expectedCommand"]["args"]]
    # Remap all fixture workdir occurrences within arg values
    expected_args = [a.replace(fixture_workdir, str(tmp_path)) for a in fx["expectedCommand"]["args"]]

    assert bc.cmd == fx["expectedCommand"]["cmd"]
    assert bc.args == expected_args
    assert bc.instructions_file == tmp_path / ".aider.conf.yml"
    assert (tmp_path / ".agentelo-aider.yml").read_text().strip() == "{}"


def test_aider_parse_output():
    fx = _load_fixture("aider")
    spec = _make_spec(fx["spec"])
    outcome = _make_outcome(fx["sampleOutput"])
    adapter = get_adapter("aider")
    parsed = adapter.parse_output(spec, outcome)

    expected = _normalize_parsed(fx["expectedParsed"])
    assert parsed["cost_usd"] == expected["cost_usd"]
    assert parsed["tokens_in"] == expected["tokens_in"]
    assert parsed["tokens_out"] == expected["tokens_out"]


# ── Fixture: swe-agent ──────────────────────────────────────────────────────


def test_swe_agent_build_command(tmp_path):
    fx = _load_fixture("swe-agent")
    wrapper = tmp_path / "fake-wrapper.py"
    wrapper.write_text("# stub\n")

    spec = RunSpec(
        harness="swe-agent",
        prompt=fx["spec"]["prompt"],
        workdir=tmp_path,
        model=fx["spec"].get("model"),
        instructions=fx["spec"].get("instructions"),
        timeout_seconds=fx["spec"].get("timeoutSeconds", 1800),
        env={"SWE_WRAPPER": str(wrapper)},
    )
    adapter = get_adapter("swe-agent")
    bc = adapter.build_command(spec)

    assert bc.cmd == "python3"
    assert bc.args[0] == str(wrapper)
    assert "--model" in bc.args
    assert bc.args[bc.args.index("--model") + 1] == fx["spec"]["model"]
    assert "--task" in bc.args
    task = bc.args[bc.args.index("--task") + 1]
    assert fx["spec"]["instructions"].rstrip() in task
    assert fx["spec"]["prompt"] in task
    assert bc.instructions_file is None
    assert (tmp_path / ".harness").is_dir()


def test_swe_agent_parse_output(tmp_path):
    fx = _load_fixture("swe-agent")
    traj_data = fx["trajectoryFile"]["content"]
    traj_dir = tmp_path / ".harness"
    traj_dir.mkdir()
    (traj_dir / "swe-traj.json").write_text(json.dumps(traj_data))

    spec = RunSpec(
        harness="swe-agent",
        prompt=fx["spec"]["prompt"],
        workdir=tmp_path,
        model=fx["spec"].get("model"),
        instructions=fx["spec"].get("instructions"),
        timeout_seconds=fx["spec"].get("timeoutSeconds", 1800),
        env={},
    )
    outcome = _make_outcome(fx["sampleOutput"])
    adapter = get_adapter("swe-agent")
    parsed = adapter.parse_output(spec, outcome)

    expected = _normalize_parsed(fx["expectedParsed"])
    assert parsed["cost_usd"] == pytest.approx(expected["cost_usd"])
    assert parsed["tokens_in"] == expected["tokens_in"]
    assert parsed["tokens_out"] == expected["tokens_out"]
