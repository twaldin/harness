"""Shared-contract tests: backend selection, permission policy, typed native
options, capability queries and error codes (mirrors ts/tests contract suite).
"""
from __future__ import annotations

from pathlib import Path

import pytest

from harness import (
    Adapter,
    BuildCommand,
    ClaudeCodeOptions,
    CodexOptions,
    HarnessError,
    RunSpec,
    SubprocOutcome,
    build_command,
    get_adapter,
    get_capabilities,
    list_adapters,
    parse_output,
    register,
    run,
    run_async,
)
from harness.base import Capabilities

BYPASS_FLAGS = {
    "aider": "--yes-always",
    "claude-code": "--dangerously-skip-permissions",
    "openclaude": "--dangerously-skip-permissions",
    "codex": "--dangerously-bypass-approvals-and-sandbox",
    "factory-droid": "--skip-permissions-unsafe",
    "gemini": "-y",
    "hermes": "--yolo",
    "qwen": "-y",
    "kilo": "--auto",
}
ALL_KNOWN_BYPASS_FLAGS = set(BYPASS_FLAGS.values())
NO_BYPASS = ["continue-cli", "crush", "opencode", "pi", "swe-agent"]


def _spec(harness: str, workdir: Path, **kw) -> RunSpec:
    env = {"SWE_WRAPPER": str(_wrapper(workdir))} if harness == "swe-agent" else {}
    return RunSpec(harness=harness, prompt="do it", workdir=workdir, instructions="be careful", env=env, **kw)


def _wrapper(workdir: Path) -> Path:
    p = workdir.parent / "wrapper.py"
    p.write_text("", encoding="utf-8")
    return p


def _outcome(stdout: str = "") -> SubprocOutcome:
    return SubprocOutcome(exit_code=0, duration_seconds=0.1, stdout=stdout, stderr="", timed_out=False)


@pytest.fixture
def workdir(tmp_path: Path) -> Path:
    d = tmp_path / "repo"
    d.mkdir()
    return d


@pytest.fixture
def no_spawn(monkeypatch: pytest.MonkeyPatch):
    def boom(*_a, **_kw):
        raise AssertionError("subprocess must not be spawned")

    async def aboom(*_a, **_kw):
        raise AssertionError("subprocess must not be spawned")

    monkeypatch.setattr("harness._subproc.run_subprocess", boom)
    monkeypatch.setattr("harness._subproc.run_subprocess_async", aboom)


# ── permission policy ───────────────────────────────────────────────────────


@pytest.mark.parametrize("name", list_adapters())
def test_upstream_default_injects_no_bypass_flag(name: str, workdir: Path):
    bc = build_command(_spec(name, workdir))
    assert not ALL_KNOWN_BYPASS_FLAGS.intersection(bc.args), bc.args


@pytest.mark.parametrize("name,flag", sorted(BYPASS_FLAGS.items()))
def test_explicit_bypass_injects_exactly_the_mapped_flag(name: str, flag: str, workdir: Path):
    upstream = build_command(_spec(name, workdir)).args
    bypass = build_command(_spec(name, workdir, permission_policy="bypass")).args
    assert bypass.count(flag) == 1
    assert [a for a in bypass if a != flag] == upstream


@pytest.mark.parametrize("name", NO_BYPASS)
def test_bypass_rejected_before_side_effects_where_unmapped(name: str, workdir: Path):
    with pytest.raises(HarnessError) as exc:
        build_command(_spec(name, workdir, permission_policy="bypass"))
    assert exc.value.code == "unsupported-capability"
    assert list(workdir.iterdir()) == []


def test_unknown_policy_is_invalid_options(workdir: Path):
    with pytest.raises(HarnessError) as exc:
        build_command(_spec("claude-code", workdir, permission_policy="yolo"))
    assert exc.value.code == "invalid-options"
    assert list(workdir.iterdir()) == []


# ── backend selection ───────────────────────────────────────────────────────


@pytest.mark.parametrize("backend", ["rpc", "sdk"])
@pytest.mark.parametrize("name", ["claude-code", "aider", "swe-agent", "crush", "kilo"])
def test_unimplemented_backend_rejected_before_writes(name: str, backend: str, workdir: Path):
    with pytest.raises(HarnessError) as exc:
        get_adapter(name).build_command(_spec(name, workdir, backend=backend))
    assert exc.value.code == "unsupported-backend"
    assert list(workdir.iterdir()) == []


def test_unknown_backend_is_invalid_options(workdir: Path):
    with pytest.raises(HarnessError) as exc:
        build_command(_spec("codex", workdir, backend="grpc"))
    assert exc.value.code == "invalid-options"


@pytest.mark.usefixtures("no_spawn")
def test_run_never_spawns_for_unsupported_backend(workdir: Path):
    with pytest.raises(HarnessError) as exc:
        run(_spec("codex", workdir, backend="sdk"))
    assert exc.value.code == "unsupported-backend"
    assert list(workdir.iterdir()) == []


@pytest.mark.usefixtures("no_spawn")
async def test_run_async_never_spawns_for_unsupported_backend(workdir: Path):
    with pytest.raises(HarnessError) as exc:
        await run_async(_spec("codex", workdir, backend="rpc"))
    assert exc.value.code == "unsupported-backend"


def test_registry_parse_output_validates_selector_and_options(workdir: Path):
    outcome = _outcome('{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}')
    with pytest.raises(HarnessError) as exc:
        parse_output(_spec("codex", workdir, backend="rpc"), outcome)
    assert exc.value.code == "unsupported-backend"
    with pytest.raises(HarnessError) as exc:
        parse_output(_spec("codex", workdir, permission_policy="bypass", native_options=CodexOptions(sandbox="read-only")), outcome)
    assert exc.value.code == "invalid-options"
    assert parse_output(_spec("codex", workdir), outcome)["tokens_in"] == 1


def test_registry_guards_custom_adapters_that_skip_validation(workdir: Path, monkeypatch: pytest.MonkeyPatch):
    import harness.registry as registry
    monkeypatch.setattr(registry, "_REGISTRY", dict(registry._REGISTRY))
    class Naive(Adapter):
        name = "naive-test-adapter"
        DEFAULT_MODEL = "m"

        def build_command(self, spec: RunSpec) -> BuildCommand:
            (spec.workdir / "touched").write_text("x")
            return BuildCommand(cmd="true", args=[], cwd=spec.workdir, env={}, instructions_file=None)

        def parse_output(self, spec, outcome):
            return {"cost_usd": None, "tokens_in": None, "tokens_out": None, "raw": None}

    register(Naive.name, Naive)
    with pytest.raises(HarnessError) as exc:
        build_command(RunSpec(harness=Naive.name, prompt="p", workdir=workdir, backend="sdk"))
    assert exc.value.code == "unsupported-backend"
    with pytest.raises(HarnessError) as exc:
        build_command(RunSpec(harness=Naive.name, prompt="p", workdir=workdir, permission_policy="bypass"))
    assert exc.value.code == "unsupported-capability"
    assert not (workdir / "touched").exists()
    assert build_command(RunSpec(harness=Naive.name, prompt="p", workdir=workdir)).cmd == "true"


# ── native options ──────────────────────────────────────────────────────────


def test_claude_code_effort_emitted_before_output_format(workdir: Path):
    args = build_command(_spec("claude-code", workdir, native_options=ClaudeCodeOptions(effort="xhigh"))).args
    i = args.index("--effort")
    assert args[i + 1] == "xhigh"
    assert args.index("--model") < i < args.index("--output-format")


def test_claude_code_effort_omitted_when_unset(workdir: Path):
    assert "--effort" not in build_command(_spec("claude-code", workdir, native_options=ClaudeCodeOptions())).args


def test_codex_sandbox_emitted_before_prompt(workdir: Path):
    args = build_command(_spec("codex", workdir, native_options=CodexOptions(sandbox="workspace-write"))).args
    i = args.index("--sandbox")
    assert args[i + 1] == "workspace-write"
    assert i < args.index("do it")


def test_codex_sandbox_conflicts_with_bypass(workdir: Path):
    with pytest.raises(HarnessError) as exc:
        build_command(_spec("codex", workdir, permission_policy="bypass", native_options=CodexOptions(sandbox="danger-full-access")))
    assert exc.value.code == "invalid-options"
    assert list(workdir.iterdir()) == []


@pytest.mark.parametrize(
    "name,options",
    [
        ("claude-code", CodexOptions(sandbox="read-only")),
        ("codex", ClaudeCodeOptions(effort="low")),
        ("gemini", ClaudeCodeOptions(effort="low")),
        ("openclaude", ClaudeCodeOptions()),
    ],
)
def test_native_kind_must_match_harness(name: str, options, workdir: Path):
    with pytest.raises(HarnessError) as exc:
        build_command(_spec(name, workdir, native_options=options))
    assert exc.value.code == "invalid-options"
    assert list(workdir.iterdir()) == []


@pytest.mark.parametrize(
    "name,options",
    [
        ("claude-code", ClaudeCodeOptions(effort="ultra")),
        ("codex", CodexOptions(sandbox="none")),
        ("claude-code", {"kind": "claude-code", "effort": "high"}),
    ],
)
def test_bad_native_values_are_invalid_options(name: str, options, workdir: Path):
    with pytest.raises(HarnessError) as exc:
        build_command(_spec(name, workdir, native_options=options))
    assert exc.value.code == "invalid-options"


def test_native_kind_is_fixed():
    assert ClaudeCodeOptions().kind == "claude-code"
    assert CodexOptions().kind == "codex"
    with pytest.raises(TypeError):
        ClaudeCodeOptions(kind="codex")  # type: ignore[call-arg]


# ── capabilities ────────────────────────────────────────────────────────────


CONFIG_MAPPINGS = {
    "claude-code": ("CLAUDE_CONFIG_DIR", "--settings"),
    "codex": ("CODEX_HOME", None),
    "hermes": ("HERMES_HOME", None),
    "aider": (None, "--config"),
    "continue-cli": (None, "--config"),
}


@pytest.mark.parametrize("name", list_adapters())
def test_capabilities_reflect_shipped_support(name: str):
    caps = get_capabilities(name)
    expected_policies = ("upstream", "bypass") if name in BYPASS_FLAGS else ("upstream",)
    expected_native = name if name in ("claude-code", "codex") else None
    home_env, file_flag = CONFIG_MAPPINGS.get(name, (None, None))
    assert caps == Capabilities(
        backend="cli",
        permission_policies=expected_policies,
        native_options=expected_native,
        streaming=True,
        cancellation=True,
        sessions=False,
        config_home_env=home_env,
        config_file_flag=file_flag,
    )


@pytest.mark.parametrize("backend,code", [("rpc", "unsupported-backend"), ("sdk", "unsupported-backend"), ("mcp", "invalid-options")])
def test_capabilities_refuse_unqueryable_backends(backend: str, code: str):
    with pytest.raises(HarnessError) as exc:
        get_capabilities("codex", backend)
    assert exc.value.code == code


def test_capabilities_unknown_harness():
    with pytest.raises(HarnessError) as exc:
        get_capabilities("nope")
    assert exc.value.code == "unknown-harness"


# ── model selection and errors ──────────────────────────────────────────────


@pytest.mark.parametrize("name,flag", [("claude-code", "--model"), ("codex", "-m"), ("gemini", "-m"), ("opencode", "--model")])
def test_empty_model_falls_back_to_default(name: str, flag: str, workdir: Path):
    default = build_command(_spec(name, workdir)).args
    empty = build_command(_spec(name, workdir, model="")).args
    assert empty == default
    assert empty[empty.index(flag) + 1].strip() != ""


def test_run_result_model_reports_request_or_default(workdir: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr("harness._subproc.run_subprocess", lambda *a, **kw: _outcome())
    assert run(_spec("codex", workdir, model="")).model == "gpt-5.3-codex"
    assert run(_spec("codex", workdir, model="openai/o3")).model == "openai/o3"
    assert build_command(_spec("codex", workdir, model="openai/o3")).model == "openai/o3"


def test_harness_error_default_code():
    err = HarnessError("boom")
    assert err.code == "adapter-error"
    assert str(err) == "boom"
    assert isinstance(err, RuntimeError)
