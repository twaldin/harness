"""Shared adapter fixtures — one generic loop over tests/fixtures/<name>.json.

Every registered adapter needs a fixture and every fixture an adapter. Each
fixture pins, for both language implementations:

* `expectedCommand`  — the exact normalized command plan (`build_command`),
* `capabilities`     — what `get_capabilities` declares, and therefore which
                       spec fields the adapter must reject,
* `expectedParsed`   — what `parse_output` yields for `sampleOutput` once the
                       declared `artifacts` (sqlite DBs, trajectory files) exist,
* `expectedParsedWithoutArtifacts` — the explicit all-null result when they don't,
* a real `run` through `fixtures/fixture_cli.py`, a deterministic substitute
  for the CLI that records what it observed and replays `sampleOutput`.

Fixture JSONs use camelCase keys (matching the SPEC interface) and the
placeholders `<workdir>` / `<root>` for the fresh temporary directories each
test creates; Python maps those to snake_case dataclasses here.
"""
from __future__ import annotations

import json
import os
import sqlite3
import stat
import shlex
import sys
from pathlib import Path

import pytest

from harness import (
    BuildCommand,
    AmpOptions,
    ClaudeCodeOptions,
    ClineOptions,
    CodexOptions,
    CopilotOptions,
    HarnessError,
    RunSpec,
    SubprocOutcome,
    VibeOptions,
    build_command,
    get_capabilities,
    list_adapters,
    parse_output,
    run,
    run_async,
)
from harness.base import Capabilities

FIXTURES_DIR = Path(__file__).parent / "fixtures"
FIXTURE_CLI = FIXTURES_DIR / "fixture_cli.py"
FIXTURE_NAMES = sorted(p.stem for p in FIXTURES_DIR.glob("*.json"))
FIXTURE_KEYS = {"spec", "expectedCommand", "capabilities", "sampleOutput", "expectedParsed"}
ARTIFACT_KEYS = FIXTURE_KEYS | {"artifacts", "expectedParsedWithoutArtifacts"}
VARIANTS = [
    (f"{name}/{variant['name']}", variant)
    for name in FIXTURE_NAMES
    for variant in json.loads((FIXTURES_DIR / f"{name}.json").read_text()).get("cases", [])
]
RUN_CASE_NAMES = FIXTURE_NAMES + [name for name, variant in VARIANTS if "expectedError" not in variant]
ERROR_CASE_NAMES = [name for name, variant in VARIANTS if "expectedError" in variant]
LOCK = ".harness-run.lock"
#: Ambient state that would change a command plan or a parser result.
AMBIENT_ENV = ("OPENCODE_DB", "OPENCODE_DISABLE_CHANNEL_DB", "KILO_DB", "KILO_DISABLE_CHANNEL_DB", "KILO_CONFIG_CONTENT", "CRUSH_DATA_DIR", "SWE_WRAPPER", "XDG_DATA_HOME", "CLINE_TOOL_APPROVAL_MODE")
#: Spec fields where JSON `null` is a real value rather than "not provided".
NULLABLE_SPEC_FIELDS = {"timeoutSeconds", "inactivityTimeoutSeconds", "stdin"}
NATIVE_OPTION_TYPES = {
    "claude-code": ClaudeCodeOptions, "codex": CodexOptions, "cline": ClineOptions, "copilot": CopilotOptions, "amp": AmpOptions,
    "mistral-vibe": VibeOptions,
}
NATIVE_OPTION_NAMES = {"autoApprove": "auto_approve", "allowTools": "allow_tools", "denyTools": "deny_tools"}


def _substitute(value, mapping: dict[str, str]):
    if isinstance(value, str):
        for placeholder, path in mapping.items():
            value = value.replace(placeholder, path)
        return value
    if isinstance(value, list):
        return [_substitute(item, mapping) for item in value]
    if isinstance(value, dict):
        return {key: _substitute(item, mapping) for key, item in value.items()}
    return value


def _load_fixture(case_id: str, root: Path, workdir: Path) -> dict:
    name, _, variant_name = case_id.partition("/")
    fixture = json.loads((FIXTURES_DIR / f"{name}.json").read_text(encoding="utf-8"))
    variants = fixture.pop("cases", [])
    assert len({variant["name"] for variant in variants}) == len(variants), f"{name}: duplicate case names"
    expected_keys = ARTIFACT_KEYS if "artifacts" in fixture else FIXTURE_KEYS
    assert set(fixture) == expected_keys, f"{name}.json keys {sorted(fixture)}; expected {sorted(expected_keys)}"
    if variant_name:
        variant = next(variant for variant in variants if variant["name"] == variant_name)
        assert set(variant) <= {"name", "spec", "sampleOutput", "expectedParsed", "artifacts", "expectedCommand", "expectedError", "expectedParseError"}
        fixture = {
            **fixture,
            **{key: value for key, value in variant.items() if key not in ("name", "spec")},
            "spec": {**fixture["spec"], **variant.get("spec", {})},
        }
    return _substitute(fixture, {"<workdir>": str(workdir), "<root>": str(root)})


def _native_options(raw: object):
    """Fixture `nativeOptions` → the typed dataclass for its `kind`. Values pass
    through untouched so the adapter's validator sees exactly the fixture's
    collection and member types; an unknown key is `invalid-options`, as a
    caller constructing the dataclass would find out."""
    if not isinstance(raw, dict) or raw.get("kind") not in NATIVE_OPTION_TYPES:
        return raw
    fields = {NATIVE_OPTION_NAMES.get(key, key): value for key, value in raw.items() if key != "kind"}
    try:
        return NATIVE_OPTION_TYPES[raw["kind"]](**fields)
    except TypeError as exc:
        raise HarnessError(f"nativeOptions {raw!r}: {exc}", code="invalid-options") from None


def _make_spec(raw: dict, workdir: Path, **overrides) -> RunSpec:
    names = {
        "timeoutSeconds": "timeout_seconds", "modelNoResolve": "model_no_resolve",
        "permissionPolicy": "permission_policy", "nativeOptions": "native_options",
        "configHome": "config_home", "configFile": "config_file",
    }
    # A variant can only override base keys, so `null` stands in for "not
    # provided" except where the contract gives null a meaning of its own.
    fields = {names.get(key, key): value for key, value in raw.items() if value is not None or key in NULLABLE_SPEC_FIELDS}
    if "native_options" in fields:
        fields["native_options"] = _native_options(fields["native_options"])
    fields["workdir"] = workdir
    fields["env"] = dict(raw.get("env", {}))
    fields.update(overrides)
    return RunSpec(**fields)


def _make_outcome(raw: dict) -> SubprocOutcome:
    return SubprocOutcome(
        exit_code=raw["exitCode"],
        duration_seconds=raw["durationSeconds"],
        stdout=raw["stdout"],
        stderr=raw["stderr"],
        timed_out=raw["timedOut"],
    )


def _expected_command(raw: dict) -> BuildCommand:
    instructions_file = raw["instructionsFile"]
    return BuildCommand(
        cmd=raw["cmd"],
        args=list(raw["args"]),
        cwd=Path(raw["cwd"]),
        env=dict(raw["env"]),
        instructions_file=Path(instructions_file) if instructions_file is not None else None,
        instruction_content=raw.get("instructionContent"),
        directories=tuple(Path(d) for d in raw["directories"]),
        model=raw["model"],
        graceful_signal=raw.get("gracefulSignal"),
    )


def _expected_capabilities(raw: dict) -> Capabilities:
    return Capabilities(
        backend=raw["backend"],
        permission_policies=tuple(raw["permissionPolicies"]),
        native_options=raw["nativeOptions"],
        streaming=raw["streaming"],
        cancellation=raw["cancellation"],
        sessions=raw["sessions"],
        config_home_env=raw["configHomeEnv"],
        config_file_flag=raw["configFileFlag"],
    )


def _expected_parsed(raw: dict) -> dict:
    return {"cost_usd": raw["costUsd"], "tokens_in": raw["tokensIn"], "tokens_out": raw["tokensOut"], "raw": raw["raw"]}


def _write_artifacts(artifacts: list[dict]) -> None:
    for artifact in artifacts:
        path = Path(artifact["path"])
        path.parent.mkdir(parents=True, exist_ok=True)
        if artifact["kind"] == "sqlite":
            conn = sqlite3.connect(path)
            for statement in artifact["sql"]:
                conn.execute(statement)
            conn.commit()
            conn.close()
            path.chmod(0o444)
        elif artifact["kind"] == "json":
            path.write_text(json.dumps(artifact["content"]), encoding="utf-8")
        else:
            raise AssertionError(f"unknown artifact kind {artifact['kind']!r}")


def _prepare_spec_inputs(fixture: dict, root: Path) -> None:
    """Files the builder itself requires to exist (swe-agent checks its wrapper)."""
    wrapper = fixture["spec"].get("env", {}).get("SWE_WRAPPER")
    if wrapper is not None:
        Path(wrapper).write_text("# stub wrapper; never executed\n", encoding="utf-8")


@pytest.fixture
def case(request: pytest.FixtureRequest, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> dict:
    """A fixture resolved against a fresh root/workdir pair with ambient state cleared."""
    for key in AMBIENT_ENV:
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("HOME", str(tmp_path / "ambient-home"))
    workdir = tmp_path / "repo"
    workdir.mkdir()
    fixture = _load_fixture(request.param, tmp_path, workdir)
    _prepare_spec_inputs(fixture, tmp_path)
    return {"name": fixture["spec"]["harness"], "root": tmp_path, "workdir": workdir, **fixture}


def _cases(names: list[str]):
    return pytest.mark.parametrize("case", names, indirect=True, ids=names)


def test_registry_matches_fixtures():
    assert list_adapters() == FIXTURE_NAMES


@_cases(RUN_CASE_NAMES)
def test_build_command_matches_fixture(case: dict):
    workdir: Path = case["workdir"]
    spec = _make_spec(case["spec"], workdir)
    expected = _expected_command(case["expectedCommand"])
    if expected.instructions_file is not None:
        expected.instruction_content = spec.instructions
    before = sorted(workdir.iterdir())

    built = build_command(spec)

    assert built == expected
    assert sorted(workdir.iterdir()) == before
    assert spec.env == case["spec"].get("env", {})  # never mutated


@_cases(FIXTURE_NAMES)
def test_capabilities_match_fixture(case: dict, tmp_path: Path):
    workdir: Path = case["workdir"]
    caps = case["capabilities"]
    assert get_capabilities(case["name"]) == _expected_capabilities(caps)

    def build(**overrides) -> BuildCommand:
        return build_command(_make_spec(case["spec"], workdir, **overrides))

    def rejects(code: str, **overrides) -> None:
        with pytest.raises(HarnessError) as exc:
            build(**overrides)
        assert exc.value.code == code
        assert sorted(workdir.iterdir()) == []

    if "bypass" not in caps["permissionPolicies"]:
        rejects("unsupported-capability", permission_policy="bypass")

    home = tmp_path / "config-home"
    if caps["configHomeEnv"] is not None:
        assert build(config_home=home).env[caps["configHomeEnv"]] == str(home)
    else:
        rejects("unsupported-capability", config_home=home)

    config_file = tmp_path / "config-file"
    if caps["configFileFlag"] is not None:
        args = build(config_file=config_file, model=None).args
        assert args[args.index(caps["configFileFlag"]) + 1] == str(config_file)
    else:
        rejects("unsupported-capability", config_file=config_file)

    for options in (ClaudeCodeOptions(), CodexOptions(), ClineOptions(), CopilotOptions(), AmpOptions(), VibeOptions()):
        if options.kind != caps["nativeOptions"]:
            rejects("invalid-options", native_options=options)

    for backend in ("rpc", "sdk"):
        rejects("unsupported-backend", backend=backend)


@_cases(RUN_CASE_NAMES)
def test_parse_output_matches_fixture(case: dict):
    _write_artifacts(case.get("artifacts", []))
    spec = _make_spec(case["spec"], case["workdir"])
    if case.get("expectedParseError", False):
        with pytest.raises(Exception):
            parse_output(spec, _make_outcome(case["sampleOutput"]))
        return
    parsed = parse_output(spec, _make_outcome(case["sampleOutput"]))
    assert parsed == _expected_parsed(case["expectedParsed"])


@_cases([name for name in FIXTURE_NAMES if "artifacts" in json.loads((FIXTURES_DIR / f"{name}.json").read_text())])
def test_parse_output_without_artifacts_is_explicitly_null(case: dict):
    spec = _make_spec(case["spec"], case["workdir"])
    parsed = parse_output(spec, _make_outcome(case["sampleOutput"]))
    assert parsed == _expected_parsed(case["expectedParsedWithoutArtifacts"])


@_cases(ERROR_CASE_NAMES)
def test_invalid_case_rejects_before_preparation(case: dict):
    with pytest.raises(HarnessError) as exc:
        build_command(_make_spec(case["spec"], case["workdir"]))
    assert exc.value.code == case["expectedError"]
    assert list(case["workdir"].iterdir()) == []


def _substitute_cli(root: Path) -> Path:
    """Shell wrapper that execs the shared fixture CLI; usable as `RunSpec.executable`."""
    exe = root / "bin" / "fixture-cli"
    exe.parent.mkdir()
    exe.write_text(f'#!/bin/sh\nexec {shlex.quote(sys.executable)} {shlex.quote(str(FIXTURE_CLI))} "$@"\n', encoding="utf-8")
    exe.chmod(exe.stat().st_mode | stat.S_IXUSR)
    return exe


@pytest.mark.parametrize("entrypoint", ["run", "run_async"])
@_cases(RUN_CASE_NAMES)
async def test_run_executes_fixture_cli(case: dict, entrypoint: str):
    root: Path = case["root"]
    workdir: Path = case["workdir"]
    expected = _expected_command(case["expectedCommand"])
    sample = case["sampleOutput"]
    artifacts = case.get("artifacts", [])
    record_path = root / "record.json"
    manifest = root / "run.json"
    manifest.write_text(json.dumps({
        "record": str(record_path),
        "envKeys": sorted(expected.env),
        "artifacts": artifacts,
        "stdout": sample["stdout"],
        "stderr": sample["stderr"],
        "exitCode": sample["exitCode"],
    }), encoding="utf-8")
    spec = _make_spec(
        case["spec"],
        workdir,
        executable=str(_substitute_cli(root)),
        env={**case["spec"].get("env", {}), "HARNESS_FIXTURE_RUN": str(manifest)},
    )

    result = run(spec) if entrypoint == "run" else await run_async(spec)

    # Lifecycle metadata shared by every adapter.
    assert result.harness == case["name"]
    assert result.model == expected.model
    assert (result.exit_code, result.timed_out, result.termination) == (sample["exitCode"], False, "exited")
    assert (result.signal, result.launch_error, result.callback_error) == (None, None, None)
    if case.get("expectedParseError", False):
        assert isinstance(result.parse_error, str)
    else:
        assert result.parse_error is None
    assert (result.stdout, result.stderr) == (sample["stdout"], sample["stderr"])
    assert (result.stdout_truncated, result.stderr_truncated) == (False, False)
    assert result.ok == (sample["exitCode"] == 0 and not case.get("expectedParseError", False))

    # What the substitute CLI observed at launch.
    seen = json.loads(record_path.read_text(encoding="utf-8"))
    assert seen["cwd"] == os.path.realpath(workdir)
    assert seen["argv"] == expected.args
    assert seen["env"] == expected.env
    assert LOCK in seen["entries"]
    for directory in expected.directories:
        assert directory.relative_to(workdir).parts[0] in seen["entries"]
    if expected.instructions_file is None:
        assert seen["files"] == {}
    else:
        assert seen["files"] == {expected.instructions_file.name: spec.instructions}

    # The parser saw the artifacts the CLI wrote.
    parsed = _expected_parsed(case["expectedParsed"])
    assert (result.cost_usd, result.tokens_in, result.tokens_out, result.raw) == (
        parsed["cost_usd"], parsed["tokens_in"], parsed["tokens_out"], parsed["raw"],
    )

    # Owned projection and lease are gone; CLI-written artifacts survive; empty planned dirs are pruned.
    assert not (workdir / LOCK).exists()
    if expected.instructions_file is not None:
        assert not expected.instructions_file.exists()
    for directory in expected.directories:
        written = any(Path(a["path"]).is_relative_to(directory) for a in artifacts)
        assert directory.exists() == written
    for artifact in artifacts:
        assert Path(artifact["path"]).is_file()
