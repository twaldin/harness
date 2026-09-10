"""Runtime versions follow distribution metadata without requiring an installation."""

from importlib.metadata import version
from pathlib import Path
import subprocess
import sys

import harness


def test_runtime_version_matches_distribution():
    assert harness.__version__ == version("harness-cli")


def test_uninstalled_source_import():
    source = Path(__file__).resolve().parents[1] / "src"
    result = subprocess.run(
        [
            sys.executable, "-I", "-S", "-c",
            "import sys; sys.path.insert(0, sys.argv[1]); "
            "from importlib.metadata import distributions; "
            "assert not list(distributions()); "
            "import harness; "
            "assert harness.__version__ == '0+unknown'; "
            "assert harness.get_adapter('codex').name == 'codex'",
            str(source),
        ],
        capture_output=True,
        text=True,
        timeout=15,
    )
    assert result.returncode == 0, result.stdout + result.stderr
