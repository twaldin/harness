#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import shutil
import tempfile
import time
from pathlib import Path

from harness import HarnessError, PermissionPolicy, RunSpec, run



PROMPT = "Write exactly hi to hi.txt in the current working directory, then stop."
DEFAULT_HARNESSES = [
    "codex",
    "opencode",
    "pi",
    "swe-agent",
    "continue-cli",
    "factory-droid",
    "openclaude",
    "kilo",
    "crush",
]
REQUIRED_BINARIES = {
    "codex": "codex",
    "opencode": "opencode",
    "pi": "pi",
    "continue-cli": "cn",
    "factory-droid": "droid",
    "openclaude": "openclaude",
    "kilo": "kilo",
    "crush": "crush",
}


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Smoke-test gpt-5.4 across harness adapters")
    p.add_argument("--model", default="gpt-5.4")
    p.add_argument("--timeout", type=int, default=90)
    p.add_argument("--harness", action="append", dest="harnesses", help="Run only the named harness; repeatable")
    p.add_argument("--keep-workdirs", action="store_true")
    p.add_argument("--json", action="store_true")
    p.add_argument("--model-no-resolve", action="store_true")
    p.add_argument("--permission-policy", choices=["upstream", "bypass"], default="upstream",
                   help="Preserve upstream defaults, or explicitly request the adapter's bypass flag")
    p.add_argument("--retries", type=int, default=1, help="Additional retries per harness for flaky provider/proxy errors")
    return p.parse_args()


def _binary_issue(harness: str) -> str | None:
    if harness == "swe-agent":
        import os

        default_wrapper = Path.home() / "agentelo" / "bin" / "run-mini-swe.py"
        swe_wrapper = os.environ.get("SWE_WRAPPER")
        if swe_wrapper and Path(swe_wrapper).exists():
            return None
        if default_wrapper.exists():
            return None
        return "missing SWE_WRAPPER and ~/agentelo/bin/run-mini-swe.py"
    binary = REQUIRED_BINARIES.get(harness)
    if binary and shutil.which(binary) is None:
        return f"missing binary: {binary}"
    return None


def _run_once(harness: str, model: str, timeout: int, keep_workdirs: bool, model_no_resolve: bool, permission_policy: PermissionPolicy = "upstream") -> dict:
    binary_issue = _binary_issue(harness)
    if binary_issue:
        return {
            "harness": harness,
            "ok": False,
            "reason": binary_issue,
            "exit_code": None,
            "model": model,
            "workdir": None,
        }

    tmp = tempfile.TemporaryDirectory(prefix=f"harness-smoke-{harness}-")
    workdir = Path(tmp.name)
    try:
        result = run(
            RunSpec(
                harness=harness,
                model=model,
                prompt=PROMPT,
                workdir=workdir,
                timeout_seconds=timeout,
                model_no_resolve=model_no_resolve,
                permission_policy=permission_policy,
            )
        )
        hi = workdir / "hi.txt"
        hi_text = hi.read_text().strip() if hi.exists() else None
        wrote_hi = hi_text == "hi"
        payload = {
            "harness": harness,
            "ok": wrote_hi,
            "reason": None if wrote_hi else "missing/incorrect hi.txt",
            "exit_code": result.exit_code,
            "timed_out": result.timed_out,
            "model": result.model,
            "cost_usd": result.cost_usd,
            "tokens_in": result.tokens_in,
            "tokens_out": result.tokens_out,
            "workdir": str(workdir),
            "hi_txt": hi_text,
            "stderr_tail": "\n".join((result.stderr or "").splitlines()[-20:]),
        }
    except HarnessError as error:
        payload = {
            "harness": harness,
            "ok": False,
            "reason": f"{error.code}: {error}",
            "exit_code": None,
            "model": model,
            "workdir": str(workdir),
        }
    finally:
        if keep_workdirs:
            tmp.cleanup = lambda: None  # type: ignore[attr-defined]
        else:
            tmp.cleanup()
    return payload


def _run_one(harness: str, model: str, timeout: int, keep_workdirs: bool, model_no_resolve: bool, retries: int, permission_policy: PermissionPolicy = "upstream") -> dict:
    last = None
    for attempt in range(retries + 1):
        last = _run_once(harness, model, timeout, keep_workdirs, model_no_resolve, permission_policy)
        if last["ok"]:
            return last
        if attempt < retries:
            time.sleep(2)
    assert last is not None
    return last


def main() -> None:
    args = _parse_args()
    harnesses = args.harnesses or DEFAULT_HARNESSES
    rows = [_run_one(h, args.model, args.timeout, args.keep_workdirs, args.model_no_resolve, args.retries, args.permission_policy) for h in harnesses]

    if args.json:
        print(json.dumps(rows, indent=2))
        return

    for row in rows:
        status = "PASS" if row["ok"] else "FAIL"
        print(f"{status:4} {row['harness']:14} model={row['model']}")
        if not row["ok"]:
            print(f"      reason: {row['reason']}")
        if row.get("exit_code") is not None:
            print(f"      exit={row['exit_code']} timed_out={row.get('timed_out')} tokens={row.get('tokens_in')}/{row.get('tokens_out')} cost={row.get('cost_usd')}")
        if row.get("stderr_tail"):
            print("      stderr:")
            for line in row["stderr_tail"].splitlines():
                print(f"        {line}")
        if row.get("workdir"):
            print(f"      workdir: {row['workdir']}")


if __name__ == "__main__":
    main()
