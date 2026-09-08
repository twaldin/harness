"""Run configuration: executable/config overrides, pure builders, env layering
and the prepare/cleanup lifecycle observed by a real fake executable."""
from __future__ import annotations

import asyncio
import json
import os
import stat
import sys
from threading import Event
from pathlib import Path

import pytest

from harness import (
    Adapter,
    BuildCommand,
    HarnessError,
    RunSpec,
    build_command,
    list_adapters,
    register,
    run,
    run_async,
)

LOCK = ".harness-run.lock"

FAKE_CLI = """#!/bin/sh
# Records what a CLI observes: cwd, argv, selected env and the instructions file.
python3 - "$@" <<'PY'
import json, os, sys
files = {n: open(n, encoding="utf-8").read() for n in sorted(os.listdir(".")) if os.path.isfile(n)}
print(json.dumps({
    "cwd": os.getcwd(),
    "argv": sys.argv[1:],
    "env": {k: v for k, v in os.environ.items() if k.startswith(("HARNESS_T_", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "KILO_"))},
    "entries": sorted(os.listdir(".")),
    "files": files,
}))
PY
"""


@pytest.fixture
def workdir(tmp_path: Path) -> Path:
    d = tmp_path / "repo"
    d.mkdir()
    return d


@pytest.fixture
def fake_cli(tmp_path: Path) -> Path:
    exe = tmp_path / "bin" / "fake-cli"
    exe.parent.mkdir()
    exe.write_text(FAKE_CLI)
    exe.chmod(exe.stat().st_mode | stat.S_IXUSR)
    return exe


def _spec(harness: str, workdir: Path, **kw) -> RunSpec:
    return RunSpec(harness=harness, prompt="do it", workdir=workdir, **kw)


def _wrapper(tmp_path: Path) -> Path:
    p = tmp_path / "wrapper.py"
    p.write_text("")
    return p


# ── validation ──────────────────────────────────────────────────────────────


@pytest.mark.parametrize("executable", ["", "bin/claude", "./claude", "cla\0ude"])
def test_bad_executables_are_invalid_options(workdir: Path, executable: str):
    with pytest.raises(HarnessError) as exc:
        build_command(_spec("claude-code", workdir, executable=executable))
    assert exc.value.code == "invalid-options"


@pytest.mark.parametrize("executable", ["claude-nightly", "/opt/bin/claude"])
def test_executable_overrides_cmd(workdir: Path, executable: str):
    assert build_command(_spec("claude-code", workdir, executable=executable)).cmd == executable


@pytest.mark.parametrize("name", [n for n in list_adapters() if n not in ("claude-code", "codex", "copilot", "hermes", "omp", "cline", "goose")])
def test_config_home_unsupported_where_unmapped(name: str, workdir: Path, tmp_path: Path):
    env = {"SWE_WRAPPER": str(_wrapper(tmp_path))} if name == "swe-agent" else {}
    with pytest.raises(HarnessError) as exc:
        build_command(_spec(name, workdir, env=env, config_home=tmp_path / "home"))
    assert exc.value.code == "unsupported-capability"


@pytest.mark.parametrize("name", [n for n in list_adapters() if n not in ("claude-code", "aider", "continue-cli", "omp", "amp")])
def test_config_file_unsupported_where_unmapped(name: str, workdir: Path, tmp_path: Path):
    env = {"SWE_WRAPPER": str(_wrapper(tmp_path))} if name == "swe-agent" else {}
    with pytest.raises(HarnessError) as exc:
        build_command(_spec(name, workdir, env=env, config_file=tmp_path / "cfg"))
    assert exc.value.code == "unsupported-capability"


@pytest.mark.parametrize("field", ["config_home", "config_file"])
def test_relative_config_paths_are_invalid_options(workdir: Path, field: str):
    with pytest.raises(HarnessError) as exc:
        build_command(_spec("claude-code", workdir, **{field: Path("relative/path")}))
    assert exc.value.code == "invalid-options"


@pytest.mark.parametrize("workdir", ["", "bad\0path"])
def test_invalid_workdir_rejected_before_planning(workdir: str):
    with pytest.raises(HarnessError) as exc:
        build_command(RunSpec(harness="codex", prompt="x", workdir=workdir))
    assert exc.value.code == "invalid-options"


def test_config_home_conflicting_env_is_invalid_options(workdir: Path, tmp_path: Path):
    home = tmp_path / "home"
    with pytest.raises(HarnessError) as exc:
        build_command(_spec("claude-code", workdir, config_home=home, env={"CLAUDE_CONFIG_DIR": "/elsewhere"}))
    assert exc.value.code == "invalid-options"
    # Same value is not a conflict; inherited process values are simply overridden.
    bc = build_command(_spec("claude-code", workdir, config_home=home, env={"CLAUDE_CONFIG_DIR": str(home)}))
    assert bc.env["CLAUDE_CONFIG_DIR"] == str(home)


def test_config_file_is_passed_verbatim_without_touching_it(workdir: Path, tmp_path: Path):
    cfg = tmp_path / "does-not-exist" / "settings.json"
    bc = build_command(_spec("claude-code", workdir, config_file=cfg))
    assert bc.args[-2:] == ["--settings", str(cfg)]
    assert not cfg.parent.exists()
    aider = build_command(_spec("aider", workdir, config_file=cfg))
    assert aider.args[:2] == ["--config", str(cfg)]


# ── builders are pure and layer env deterministically ───────────────────────


@pytest.mark.parametrize("name", list_adapters())
def test_builders_write_nothing_and_plan_absolute_paths(name: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.chdir(tmp_path)
    env = {"SWE_WRAPPER": str(_wrapper(tmp_path))} if name == "swe-agent" else {}
    before = sorted(tmp_path.iterdir())
    bc = build_command(RunSpec(harness=name, prompt="p", workdir=Path("missing-repo"), instructions="i", env=env))
    assert sorted(tmp_path.iterdir()) == before
    assert bc.cwd == tmp_path / "missing-repo"
    assert Path.cwd() == tmp_path
    assert all(d.is_absolute() and d.is_relative_to(bc.cwd) for d in bc.directories)
    if bc.instructions_file is not None:
        assert bc.instructions_file == bc.cwd / bc.instructions_file.name
        assert bc.instruction_content == "i"
    else:
        assert bc.instruction_content is None
    assert all(not a.startswith("missing-repo") for a in bc.args)


def test_env_layers_adapter_then_caller_then_config_home(workdir: Path, tmp_path: Path):
    spec = _spec("kilo", workdir, env={"KILO_DB": "/caller/kilo.db", "KILO_CONFIG_CONTENT": '{"mine":1}'})
    caller_env = dict(spec.env)
    bc = build_command(spec)
    assert bc.env["KILO_DB"] == "/caller/kilo.db"  # caller wins over adapter addition
    assert bc.env["KILO_CONFIG_CONTENT"] == '{"mine":1}'  # passed through, not rewritten
    assert bc.directories == ()  # overridden DB path is caller-owned
    assert spec.env == caller_env

    home = tmp_path / "codex-home"
    bc = build_command(_spec("codex", workdir, config_home=home, env={"HARNESS_T_X": "1"}))
    assert bc.env == {"HARNESS_T_X": "1", "CODEX_HOME": str(home)}


def test_kilo_generates_single_model_config_only_when_absent(workdir: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("KILO_CONFIG_CONTENT", raising=False)
    generated = json.loads(build_command(_spec("kilo", workdir, model="gpt-5.4")).env["KILO_CONFIG_CONTENT"])
    assert generated == {"model": "openai/gpt-5.4", "small_model": "openai/gpt-5.4", "default_agent": "build"}
    monkeypatch.setenv("KILO_CONFIG_CONTENT", '{"inherited":true}')
    assert "KILO_CONFIG_CONTENT" not in build_command(_spec("kilo", workdir)).env


def test_crush_override_dir_is_not_planned(workdir: Path, tmp_path: Path):
    bc = build_command(_spec("crush", workdir, env={"CRUSH_DATA_DIR": str(tmp_path / "shared")}))
    assert bc.args[bc.args.index("--data-dir") + 1] == str(tmp_path / "shared")
    assert bc.directories == ()


def test_registry_finalizes_minimal_third_party_adapters(workdir: Path, monkeypatch: pytest.MonkeyPatch):
    import harness.registry as registry

    monkeypatch.setattr(registry, "_REGISTRY", dict(registry._REGISTRY))

    class Minimal(Adapter):
        name = "minimal-test-adapter"
        DEFAULT_MODEL = "m"

        def build_command(self, spec: RunSpec) -> BuildCommand:
            self.validate_run_spec(spec)
            return BuildCommand(cmd="true", args=[], cwd=spec.workdir, env={"FROM_ADAPTER": "1"}, instructions_file=None)

        def parse_output(self, spec, outcome):
            return {"cost_usd": None, "tokens_in": None, "tokens_out": None, "raw": None}

    register(Minimal.name, Minimal)
    bc = build_command(RunSpec(harness=Minimal.name, prompt="p", workdir=Path("rel"), env={"MINE": "2"}, executable="/bin/true"))
    assert bc.cmd == "/bin/true"
    assert bc.cwd == Path("rel").absolute()
    assert bc.env == {"FROM_ADAPTER": "1", "MINE": "2"}
    assert bc.model == "m"


# ── runs observed by a fake executable ──────────────────────────────────────


def test_run_hands_the_cli_cwd_env_config_and_projected_instructions(workdir: Path, fake_cli: Path, tmp_path: Path):
    home = tmp_path / "claude-home"
    settings = tmp_path / "settings.json"
    (workdir / "CLAUDE.md").write_text("user file\n")
    result = run(
        _spec(
            "claude-code",
            workdir,
            model="opus",
            instructions="projected rules",
            executable=str(fake_cli),
            config_home=home,
            config_file=settings,
            env={"HARNESS_T_CALLER": "yes"},
        )
    )
    assert result.ok, result.stderr
    seen = json.loads(result.stdout)
    assert Path(seen["cwd"]).resolve() == workdir.resolve()
    assert seen["argv"][:4] == ["-p", "do it", "--model", "opus"]
    assert seen["argv"][seen["argv"].index("--settings") + 1] == str(settings)
    assert seen["env"] == {"HARNESS_T_CALLER": "yes", "CLAUDE_CONFIG_DIR": str(home)}
    assert seen["files"]["CLAUDE.md"] == "projected rules"
    assert LOCK in seen["entries"]
    assert result.model == "opus"
    # restored afterwards
    assert (workdir / "CLAUDE.md").read_text() == "user file\n"
    assert sorted(p.name for p in workdir.iterdir()) == ["CLAUDE.md"]


def test_run_with_relative_workdir_resolves_once_against_process_cwd(tmp_path: Path, fake_cli: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.chdir(tmp_path)
    (tmp_path / "rel-repo").mkdir()
    result = run(_spec("codex", Path("rel-repo"), instructions="hello", executable=str(fake_cli)))
    assert result.ok, result.stderr
    seen = json.loads(result.stdout)
    assert Path(seen["cwd"]).resolve() == (tmp_path / "rel-repo").resolve()
    assert seen["argv"][seen["argv"].index("-C") + 1] == str(tmp_path / "rel-repo")
    assert seen["files"] == {"AGENTS.md": "hello"}
    assert Path.cwd() == tmp_path
    assert list((tmp_path / "rel-repo").iterdir()) == []


def test_run_without_instructions_still_holds_the_lease_and_creates_planned_dirs(workdir: Path, fake_cli: Path):
    result = run(_spec("crush", workdir, executable=str(fake_cli)))
    assert result.ok, result.stderr
    seen = json.loads(result.stdout)
    assert seen["entries"] == [".harness", LOCK]
    assert seen["files"] == {}
    assert (workdir / ".harness" / "crush-data").is_dir() is False  # pruned: nothing written by the CLI
    assert sorted(p.name for p in workdir.iterdir()) == []


async def test_run_async_snapshots_env_and_cleans_up(workdir: Path, fake_cli: Path):
    spec = _spec("gemini", workdir, instructions="async rules", executable=str(fake_cli), env={"HARNESS_T_A": "1"})
    result = await run_async(spec)
    assert result.ok, result.stderr
    seen = json.loads(result.stdout)
    assert seen["env"] == {"HARNESS_T_A": "1"}
    assert seen["files"] == {"GEMINI.md": "async rules"}
    assert list(workdir.iterdir()) == []




def test_parse_exception_becomes_parse_error_and_restores_workdir(workdir: Path, monkeypatch: pytest.MonkeyPatch):
    from harness._subproc import SubprocOutcome

    (workdir / "AGENTS.md").write_text("mine")
    monkeypatch.setattr(
        "harness._subproc.run_subprocess",
        lambda *a, **kw: SubprocOutcome(0, 0.0, "kept out", "kept err", False, termination="exited"),
    )

    def boom(self, spec, outcome):
        raise RuntimeError("parse failed")

    monkeypatch.setattr("harness.adapters.pi.PiAdapter.parse_output", boom)
    result = run(_spec("pi", workdir, instructions="tmp"))
    assert result.parse_error == "RuntimeError: parse failed"
    assert (result.exit_code, result.termination, result.stdout, result.stderr) == (0, "exited", "kept out", "kept err")
    assert (result.cost_usd, result.tokens_in, result.tokens_out, result.raw) == (None, None, None, None)
    assert not result.ok
    assert (workdir / "AGENTS.md").read_text() == "mine"
    assert not (workdir / LOCK).exists()


def test_direct_parse_output_stays_strict(workdir: Path, monkeypatch: pytest.MonkeyPatch):
    from harness import parse_output
    from harness._subproc import SubprocOutcome

    def boom(self, spec, outcome):
        raise RuntimeError("parse failed")

    monkeypatch.setattr("harness.adapters.pi.PiAdapter.parse_output", boom)
    with pytest.raises(RuntimeError, match="parse failed"):
        parse_output(_spec("pi", workdir), SubprocOutcome(0, 0.0, "", "", False))


@pytest.mark.parametrize("entrypoint", ["sync", "async"])
async def test_launch_failure_still_restores_workdir(workdir: Path, entrypoint: str):
    target = workdir / "AGENTS.md"
    target.write_text("original")
    identity = target.stat().st_ino
    spec = _spec("pi", workdir, instructions="tmp", executable="/nonexistent/harness-fake-binary")
    result = run(spec) if entrypoint == "sync" else await run_async(spec)
    assert result.termination == "launch-failed"
    assert target.read_text() == "original"
    assert target.stat().st_ino == identity
    assert not (workdir / LOCK).exists()


def test_run_fails_before_spawning_when_workdir_is_leased(workdir: Path, fake_cli: Path):
    os.mkdir(workdir / LOCK, 0o700)
    with pytest.raises(HarnessError) as exc:
        run(_spec("pi", workdir, instructions="tmp", executable=str(fake_cli)))
    assert exc.value.code == "instruction-conflict"
    assert sorted(p.name for p in workdir.iterdir()) == [LOCK]


@pytest.mark.skipif(os.name != "posix", reason="owned process-group cancellation is POSIX-only")
@pytest.mark.parametrize("entrypoint", ["sync-event", "async-event", "task"])
async def test_cancellation_keeps_instructions_until_child_teardown(workdir: Path, tmp_path: Path, entrypoint: str):
    executable = tmp_path / "cancellable-agent"
    executable.write_text(f"#!{sys.executable}\n" + """
import signal, sys, time
from pathlib import Path
def stop(signum, frame):
    time.sleep(0.08)
    Path("teardown-observed").write_text(Path("AGENTS.md").read_text())
    sys.exit(0)
signal.signal(signal.SIGTERM, stop)
Path("ready").touch()
while True:
    time.sleep(1)
""")
    executable.chmod(0o700)
    target = workdir / "AGENTS.md"
    target.write_text("original")
    identity = target.stat().st_ino
    cancellation = Event()
    spec = _spec("codex", workdir, instructions="projected", executable=str(executable),
                 cancel=cancellation, timeout_seconds=5)
    invocation = asyncio.to_thread(run, spec) if entrypoint == "sync-event" else run_async(spec)
    task = asyncio.create_task(invocation)
    deadline = asyncio.get_running_loop().time() + 5
    while not (workdir / "ready").exists() and not task.done() and asyncio.get_running_loop().time() < deadline:
        await asyncio.sleep(0.01)
    try:
        assert (workdir / "ready").exists(), "child did not become ready"
        if entrypoint == "task":
            task.cancel()
            await asyncio.sleep(0.02)
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
        else:
            cancellation.set()
            result = await task
            assert result.termination == "cancelled"
        assert (workdir / "teardown-observed").read_text() == "projected"
        assert target.read_text() == "original"
        assert target.stat().st_ino == identity
        assert not (workdir / LOCK).exists()
    finally:
        cancellation.set()
        if not task.done():
            await task


@pytest.mark.parametrize("entrypoint", ["sync", "async", "cancelled-task"])
async def test_failed_process_teardown_retains_instruction_ownership(workdir: Path, monkeypatch, entrypoint: str):
    target = workdir / "AGENTS.md"
    target.write_text("original")

    def failed_teardown(*args, **kwargs):
        raise PermissionError("synthetic process-group denial")

    async def failed_async_teardown(*args, **kwargs):
        if entrypoint == "cancelled-task":
            raise asyncio.CancelledError() from PermissionError("synthetic process-group denial")
        failed_teardown()

    monkeypatch.setattr("harness._subproc.run_subprocess", failed_teardown)
    monkeypatch.setattr("harness._subproc.run_subprocess_async", failed_async_teardown)
    spec = _spec("codex", workdir, instructions="projected")
    with pytest.raises((PermissionError, asyncio.CancelledError)):
        if entrypoint == "sync":
            run(spec)
        else:
            await run_async(spec)
    assert target.read_text() == "projected"
    assert (workdir / LOCK / "original-AGENTS.md").read_text() == "original"
    assert (workdir / LOCK).exists()


INVALID_IO = [
    {"timeout_seconds": -1},
    {"timeout_seconds": float("inf")},
    {"inactivity_timeout_seconds": 0},
    {"inactivity_timeout_seconds": float("nan")},
    {"max_output_bytes": -1},
    {"max_output_bytes": 1.5},
    {"max_output_bytes": True},
    {"max_output_bytes": 2 ** 53},
    {"stdin": b"bytes"},
    {"on_output": "not callable"},
]


@pytest.mark.parametrize("entrypoint", ["sync", "async"])
@pytest.mark.parametrize("options", INVALID_IO, ids=lambda o: next(iter(o)))
async def test_invalid_io_options_rejected_before_preparation(workdir: Path, entrypoint: str, options: dict):
    target = workdir / "AGENTS.md"
    target.write_text("original")
    identity = target.stat().st_ino
    spec = _spec("codex", workdir, instructions="projected", **options)
    with pytest.raises(HarnessError) as exc:
        if entrypoint == "sync":
            run(spec)
        else:
            await run_async(spec)
    assert exc.value.code == "invalid-options"
    assert target.read_text() == "original"
    assert target.stat().st_ino == identity
    assert not (workdir / LOCK).exists()
    with pytest.raises(HarnessError) as exc:
        build_command(spec)
    assert exc.value.code == "invalid-options"


async def test_sync_run_rejects_async_callback_before_preparation(workdir: Path):
    async def cb(chunk: str, stream: str) -> None:
        pass

    (workdir / "AGENTS.md").write_text("original")
    spec = _spec("codex", workdir, instructions="projected", on_output=cb)
    with pytest.raises(HarnessError) as exc:
        run(spec)
    assert exc.value.code == "invalid-options"
    assert (workdir / "AGENTS.md").read_text() == "original"
    assert not (workdir / LOCK).exists()
    # build_command cannot know the entry point; only the blocking runner refuses.
    assert build_command(spec).cmd == "codex"


def test_run_validates_io_even_when_a_custom_builder_skips_validation(workdir: Path, monkeypatch: pytest.MonkeyPatch):
    import harness.registry as registry

    monkeypatch.setattr(registry, "_REGISTRY", dict(registry._REGISTRY))

    class Unchecked(Adapter):
        name = "unchecked-test-adapter"
        instructions_filename = "AGENTS.md"

        def build_command(self, spec: RunSpec) -> BuildCommand:
            return BuildCommand(cmd="true", args=[], cwd=spec.workdir, env={}, instructions_file=None)

        def parse_output(self, spec, outcome):
            return {"cost_usd": None, "tokens_in": None, "tokens_out": None, "raw": None}

    register(Unchecked.name, Unchecked)
    spec = RunSpec(harness=Unchecked.name, prompt="p", workdir=workdir, instructions="projected", max_output_bytes=-5)
    with pytest.raises(HarnessError) as exc:
        Unchecked().run(spec)
    assert exc.value.code == "invalid-options"
    assert not (workdir / LOCK).exists()
    assert list(workdir.iterdir()) == []
