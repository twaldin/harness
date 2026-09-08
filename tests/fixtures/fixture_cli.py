"""Deterministic stand-in for every adapter's CLI (no provider, no network).

Both fixture suites point `RunSpec.executable` at a shell wrapper that execs
this script with `HARNESS_FIXTURE_RUN` naming a JSON manifest:

    {
      "record":    "<file to write what the CLI observed>",
      "envKeys":   ["KILO_DB", ...],   # environment variables worth recording
      "artifacts": [...],              # fixture `artifacts` with placeholders resolved
      "stdout":    "...", "stderr": "...", "exitCode": 0
    }

The script records its cwd, argv, the selected environment, the directory
entries and the text files it can see (the projected instructions file and
the workdir lease are the interesting ones), writes the declared artifacts
(sqlite databases, trajectory JSON) exactly where the real CLI would, then
replays the fixture's sample output and exit code. Runs on Python >= 3.8.
"""
from __future__ import annotations

import json
import os
import sqlite3
import sys


def write_artifacts(artifacts):
    for artifact in artifacts:
        path = artifact["path"]
        os.makedirs(os.path.dirname(path), exist_ok=True)
        kind = artifact["kind"]
        if kind == "sqlite":
            conn = sqlite3.connect(path)
            for statement in artifact["sql"]:
                conn.execute(statement)
            conn.commit()
            conn.close()
            os.chmod(path, 0o444)
        elif kind == "json":
            with open(path, "w", encoding="utf-8") as fh:
                json.dump(artifact["content"], fh)
        else:
            raise SystemExit("unknown artifact kind: %r" % (kind,))


def main():
    with open(os.environ["HARNESS_FIXTURE_RUN"], encoding="utf-8") as fh:
        manifest = json.load(fh)
    entries = sorted(os.listdir("."))
    files = {}
    for name in entries:
        if os.path.isfile(name):
            with open(name, encoding="utf-8", errors="replace") as fh:
                files[name] = fh.read()
    record = {
        "cwd": os.path.realpath(os.getcwd()),
        "argv": sys.argv[1:],
        "env": {key: os.environ[key] for key in manifest["envKeys"] if key in os.environ},
        "entries": entries,
        "files": files,
    }
    with open(manifest["record"], "w", encoding="utf-8") as fh:
        json.dump(record, fh)
    write_artifacts(manifest["artifacts"])
    sys.stdout.write(manifest["stdout"])
    sys.stdout.flush()
    sys.stderr.write(manifest["stderr"])
    sys.stderr.flush()
    sys.exit(manifest["exitCode"])


if __name__ == "__main__":
    main()
