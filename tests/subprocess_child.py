#!/usr/bin/env python3
"""Deterministic I/O child for the shared subprocess cases (tests/subprocess_cases.json).

Where tests/process_tree.py exercises process ownership, this fixture exercises
the byte-level contract: chunk boundaries, capture caps, floods and stdin.
Every mode is fully determined by its arguments, so both language suites run
the same argv and compare against the same expected outcome.

Usage: python3 tests/subprocess_child.py <mode> [args...]

Modes:
  write-pieces <hex>...        write the hex-encoded pieces to stdout.
  gated-pieces <dir> <hex>...  wait for a callback acknowledgement before each next
                               piece, proving separate reads without startup sleeps.
  flood <bytes>                write <bytes> of 'a' to stdout and <bytes> of 'e' to
                               stderr, then exit 0.
  echo-stdin-noisy <bytes>     copy stdin to stdout while a thread writes <bytes>
                               of 'e' to stderr; exit 0 once stdin hits EOF.
  stderr-ticks <n> <seconds>   print '.' to stderr <n> times, <seconds> apart, then
                               'done' to stdout.
"""
from __future__ import annotations

import shutil
from pathlib import Path
import sys
import threading
import time

MODES = ("write-pieces", "gated-pieces", "flood", "echo-stdin-noisy", "stderr-ticks")


def write_pieces(pieces: list[str], gate: Path | None = None) -> None:
    out = sys.stdout.buffer
    for index, piece in enumerate(pieces):
        out.write(bytes.fromhex(piece))
        out.flush()
        if gate is not None and index < len(pieces) - 1:
            deadline = time.monotonic() + 8
            while not (gate / f"chunk-{index}").exists():
                if time.monotonic() > deadline:
                    raise TimeoutError("output callback did not acknowledge the piece")
                time.sleep(0.01)


def flood(count: int) -> None:
    sys.stdout.buffer.write(b"a" * count)
    sys.stdout.buffer.flush()
    sys.stderr.buffer.write(b"e" * count)
    sys.stderr.buffer.flush()


def echo_stdin_noisy(count: int) -> None:
    def noise() -> None:
        sys.stderr.buffer.write(b"e" * count)
        sys.stderr.buffer.flush()

    thread = threading.Thread(target=noise)
    thread.start()
    shutil.copyfileobj(sys.stdin.buffer, sys.stdout.buffer)
    sys.stdout.buffer.flush()
    thread.join()


def stderr_ticks(count: int, interval: float) -> None:
    for _ in range(count):
        sys.stderr.write(".")
        sys.stderr.flush()
        time.sleep(interval)
    sys.stdout.write("done\n")
    sys.stdout.flush()


def main(argv: list[str]) -> None:
    mode = argv[1] if len(argv) > 1 else ""
    args = argv[2:]
    if mode == "write-pieces" and args:
        write_pieces(args)
    elif mode == "gated-pieces" and len(args) >= 2:
        write_pieces(args[1:], Path(args[0]))
    elif mode == "flood" and len(args) == 1:
        flood(int(args[0]))
    elif mode == "echo-stdin-noisy" and len(args) == 1:
        echo_stdin_noisy(int(args[0]))
    elif mode == "stderr-ticks" and len(args) == 2:
        stderr_ticks(int(args[0]), float(args[1]))
    else:
        raise SystemExit(f"usage: {argv[0]} <{'|'.join(MODES)}> [args...]")


if __name__ == "__main__":
    main(sys.argv)
