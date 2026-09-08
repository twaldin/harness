#!/usr/bin/env python3
"""Process-tree fixture for subprocess lifecycle tests (Python and TypeScript).

Usage: python3 tests/process_tree.py <mode> <directory>

Every mode writes `leader.pid` into `<directory>`, prints STDOUT_TEXT to stdout
and STDERR_MARKER to stderr, and finally writes `ready` once every process it
spawned has recorded its pid. Testers poll for `ready` instead of sleeping.

Modes:
  tree          leader + child + grandchild; child and grandchild ignore SIGTERM
                and hold the inherited pipes forever.
  early-exit    like `tree`, but the leader exits 7 once `ready` exists.
  closed-pipes  like `early-exit`, but descendants redirect their output to
                /dev/null; pipe EOF must not bypass process cleanup.
  graceful      all three handle SIGTERM: write `<role>.term`, TERM and reap
                their own child, exit 0.
  interrupt     leader ignores SIGTERM and handles SIGINT only: write
                `leader.int`, INT and reap a child it started in a NEW
                SESSION (outside the runner's group; the child likewise
                ignores SIGTERM and writes `child.int` on SIGINT), exit 0.
                Models a CLI that owns a detached worker and shuts both down
                cleanly on SIGINT but not on SIGTERM.
  escaped       leader spawns a child in a NEW SESSION (outside the runner's
                process group) that keeps the pipes open, then exits 0.
                The tester owns that child through `child.pid`.
  solo          leader only; sleeps forever.
  self-signal   leader sends itself SIGTERM after `ready`.
  partial-utf8  leader writes a truncated multibyte sequence to stdout, then
                sleeps forever.
"""
from __future__ import annotations

import os
import signal
import subprocess
import sys
import time
from pathlib import Path

STDOUT_TEXT = "tree stdout \u2713 \u65e5\u672c\u8a9e \U0001d11e\n"
STDERR_MARKER = "PROCESS_TREE_STDERR_MARKER\n"
PARTIAL_UTF8 = "h\u00e9llo ".encode() + b"\xe2\x9c"  # "✓" cut after two of three bytes

MODES = ("tree", "early-exit", "closed-pipes", "graceful", "interrupt", "escaped", "solo", "self-signal", "partial-utf8")


def _record(directory: Path, name: str, content: str = "") -> None:
    tmp = directory / f".{name}.tmp"
    tmp.write_text(content, encoding="utf-8")
    os.replace(tmp, directory / name)


def _wait_for(path: Path, timeout: float = 10.0) -> None:
    deadline = time.monotonic() + timeout
    while not path.exists():
        if time.monotonic() > deadline:
            raise SystemExit(f"timed out waiting for {path}")
        time.sleep(0.01)


def _sleep_forever() -> None:
    while True:
        time.sleep(3600)


def _spawn(role: str, mode: str, directory: Path, *, new_session: bool = False) -> subprocess.Popen:
    # stdout/stderr are inherited on purpose: descendants keep the pipes open.
    return subprocess.Popen(
        [sys.executable, __file__, role, mode, str(directory)],
        start_new_session=new_session,
    )


def _graceful_handler(directory: Path, role: str, child: subprocess.Popen | None, sig: int = signal.SIGTERM):
    marker = f"{role}.{'int' if sig == signal.SIGINT else 'term'}"

    def handler(signum, frame):  # noqa: ARG001
        signal.signal(sig, signal.SIG_IGN)
        _record(directory, marker)
        if child is not None:
            try:
                child.send_signal(sig)
            except ProcessLookupError:
                pass
            child.wait()
        raise SystemExit(0)

    return handler


def _leader(mode: str, directory: Path) -> None:
    _record(directory, "leader.pid", str(os.getpid()))
    if mode == "partial-utf8":
        sys.stdout.buffer.write(PARTIAL_UTF8)
        sys.stdout.buffer.flush()
    else:
        sys.stdout.write(STDOUT_TEXT)
        sys.stdout.flush()
    sys.stderr.write(STDERR_MARKER)
    sys.stderr.flush()

    if mode in ("solo", "self-signal", "partial-utf8"):
        _record(directory, "ready")
        if mode == "self-signal":
            os.kill(os.getpid(), signal.SIGTERM)
            time.sleep(5)
            raise SystemExit(99)  # SIGTERM was not delivered; make the test fail loudly
        _sleep_forever()

    child = _spawn("_child", mode, directory, new_session=mode in ("escaped", "interrupt"))
    if mode == "graceful":
        signal.signal(signal.SIGTERM, _graceful_handler(directory, "leader", child))
    if mode == "interrupt":
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        signal.signal(signal.SIGINT, _graceful_handler(directory, "leader", child, signal.SIGINT))
        # The child records its pid only once its own handlers are armed, so
        # `ready` implies both processes will honor SIGINT.
        _wait_for(directory / "child.pid")
        _record(directory, "ready")
        # Do not re-enter Popen.wait() from the SIGINT handler while its
        # waitpid lock is already held by this thread.
        _sleep_forever()
    if mode in ("early-exit", "closed-pipes"):
        _wait_for(directory / "ready")
        raise SystemExit(7)
    if mode == "escaped":
        _wait_for(directory / "ready")
        raise SystemExit(0)
    child.wait()
    _sleep_forever()


def _child(mode: str, directory: Path) -> None:
    if mode == "interrupt":
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        signal.signal(signal.SIGINT, _graceful_handler(directory, "child", None, signal.SIGINT))
        _record(directory, "child.pid", str(os.getpid()))
        _sleep_forever()
    _record(directory, "child.pid", str(os.getpid()))
    if mode == "closed-pipes":
        with open(os.devnull, "wb") as sink:
            os.dup2(sink.fileno(), 1)
            os.dup2(sink.fileno(), 2)
    if mode == "escaped":
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        _record(directory, "ready")
        _sleep_forever()
    grandchild = _spawn("_grandchild", mode, directory)
    if mode == "graceful":
        signal.signal(signal.SIGTERM, _graceful_handler(directory, "child", grandchild))
    else:
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
    grandchild.wait()
    _sleep_forever()


def _grandchild(mode: str, directory: Path) -> None:
    _record(directory, "grandchild.pid", str(os.getpid()))
    if mode == "graceful":
        signal.signal(signal.SIGTERM, _graceful_handler(directory, "grandchild", None))
    else:
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
    _record(directory, "ready")
    _sleep_forever()


def main(argv: list[str]) -> None:
    if len(argv) == 3 and argv[1] in MODES:
        _leader(argv[1], Path(argv[2]))
    elif len(argv) == 4 and argv[1] == "_child":
        _child(argv[2], Path(argv[3]))
    elif len(argv) == 4 and argv[1] == "_grandchild":
        _grandchild(argv[2], Path(argv[3]))
    else:
        raise SystemExit(f"usage: {argv[0]} <{'|'.join(MODES)}> <directory>")


if __name__ == "__main__":
    main(sys.argv)
