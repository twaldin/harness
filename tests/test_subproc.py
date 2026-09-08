"""_subproc runner tests — pure-shell tests that don't depend on any adapter CLI."""
from harness._subproc import run_subprocess


def test_run_subprocess_captures_stdout(tmp_path):
    out = run_subprocess(["sh", "-c", "echo hello && echo bye >&2"], cwd=tmp_path, timeout_seconds=10)
    assert out.exit_code == 0
    assert "hello" in out.stdout
    assert "bye" in out.stderr
    assert not out.timed_out
    assert out.duration_seconds >= 0


def test_run_subprocess_nonzero_exit(tmp_path):
    out = run_subprocess(["sh", "-c", "exit 7"], cwd=tmp_path, timeout_seconds=10)
    assert out.exit_code == 7
    assert not out.timed_out


def test_run_subprocess_timeout(tmp_path):
    out = run_subprocess(["sh", "-c", "sleep 5"], cwd=tmp_path, timeout_seconds=1)
    assert out.timed_out
    assert out.duration_seconds >= 1


def test_run_subprocess_extra_env(tmp_path):
    out = run_subprocess(
        ["sh", "-c", "echo $HARNESS_TEST_VAR"],
        cwd=tmp_path,
        timeout_seconds=10,
        extra_env={"HARNESS_TEST_VAR": "ok"},
    )
    assert out.stdout.strip() == "ok"
