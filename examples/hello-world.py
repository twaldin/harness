#!/usr/bin/env python3
"""Minimal harness usage: invoke claude-code, print cost + result.

Run from repo root without installing:
    python examples/hello-world.py
"""
import os
import sys
import tempfile

# Make `harness` importable from a clean checkout (no pip install -e . required).
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from harness import RunSpec, run

with tempfile.TemporaryDirectory() as wd:
    r = run(RunSpec(
        harness="claude-code",
        model="sonnet",
        prompt="Print the string 'hello from harness' and nothing else.",
        workdir=wd,
        timeout_seconds=120,
    ))

cost = f"${r.cost_usd:.4f}" if r.cost_usd is not None else "n/a"
print(f"exit={r.exit_code}  cost={cost}  tokens={r.tokens_in}/{r.tokens_out}  wall={r.duration_seconds:.1f}s")
print(r.stdout[:400])
