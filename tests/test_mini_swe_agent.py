"""mini's workspace trajectory must never turn parsing into a blocking pipe read."""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

LIMIT = 16 * 1024 * 1024
TRAJECTORY = {"trajectory_format": "mini-swe-agent-1.1", "messages": []}
PARSE = """
import json, sys
from pathlib import Path
from harness import RunSpec, parse_output
from harness._subproc import SubprocOutcome
workdir = Path(sys.argv[1])
path = workdir / '.harness/mini-swe-agent.traj.json'
spec = RunSpec(harness='mini-swe-agent', prompt='synthetic', workdir=workdir)
outcome = SubprocOutcome(exit_code=0, duration_seconds=0, timed_out=False,
    stdout=f\"Saved trajectory to '{path}'\\n\", stderr='')
print(json.dumps(parse_output(spec, outcome)))
"""


@pytest.mark.parametrize("kind", ["fifo", "symlink", "oversized", "at-limit"])
def test_trajectory_read_boundary(tmp_path: Path, kind: str):
    path = tmp_path / ".harness/mini-swe-agent.traj.json"
    path.parent.mkdir()
    if kind == "fifo":
        os.mkfifo(path)
    elif kind == "symlink":
        target = tmp_path / "other.json"
        target.write_text(json.dumps(TRAJECTORY))
        path.symlink_to(target)
    else:
        with path.open("wb") as stream:
            content = json.dumps(TRAJECTORY).encode()
            stream.write(content)
            stream.write(b" " * (LIMIT + (kind == "oversized") - len(content)))
    # Isolate the call so an accidental blocking open fails, not hangs the suite.
    child = subprocess.run([sys.executable, "-c", PARSE, str(tmp_path)],
                           capture_output=True, text=True, timeout=5, check=True)
    assert json.loads(child.stdout) == {
        "cost_usd": None, "tokens_in": None, "tokens_out": None,
        "raw": TRAJECTORY if kind == "at-limit" else None,
    }
