#!/usr/bin/env python3
"""Harness Python API guide: five selectable modes over the public package API.

    # Install into an isolated consumer first; see examples/README.md.
    python api-guide.py one-shot  --harness codex --executable /abs/path/to/cli
    python api-guide.py config
    python api-guide.py cancel    --harness codex --executable /abs/path/to/slow-cli
    python api-guide.py stream    --harness codex --executable /abs/path/to/chatty-cli
    python api-guide.py session   --executable /abs/path/to/pi

Every symbol comes from the package root (`from harness import ...`).
The selected CLI still owns its native configuration/authentication effects.
`--executable`, `--workdir`, `--model` and `--config-home` are always the
caller's choice, so each mode can be pointed at a synthetic CLI instead of a
real provider. See examples/README.md for exact commands and the behavior each
synthetic executable needs.

Only `pi` on backend `rpc` is exercised here. The other live-session backends
(OMP, Claude Agent, Amp, Cline and Factory Droid SDKs; caller-owned OpenCode
and OpenHands servers) share this same `open_session` surface but each needs a
caller-installed SDK, CLI or running server — read their sections in
../README.md and ../SPEC.md instead of guessing from an example.
"""
from __future__ import annotations

import argparse
import asyncio
import contextlib
import math
import os
import tempfile
import threading
from pathlib import Path

from harness import (
    CodexOptions,
    HarnessError,
    LiveSession,
    RunResult,
    RunSpec,
    SessionSpec,
    build_command,
    get_capabilities,
    get_session_capabilities,
    open_session,
    run,
)

MODES = ("one-shot", "config", "cancel", "stream", "session")


def report(result: RunResult) -> None:
    """Report process status; native errors may also remain in raw/output."""
    cost = f"${result.cost_usd:.4f}" if result.cost_usd is not None else "n/a"
    print(f"  harness={result.harness} model={result.model} ok={result.ok}")
    print(f"  exit={result.exit_code} termination={result.termination} signal={result.signal}"
          f" timed_out={result.timed_out} timeout_kind={result.timeout_kind}")
    print(f"  wall={result.duration_seconds:.2f}s cost={cost} tokens={result.tokens_in}/{result.tokens_out}")
    print(f"  stdout={result.stdout_bytes}B truncated={result.stdout_truncated}"
          f"  stderr={result.stderr_bytes}B truncated={result.stderr_truncated}")
    for label, detail in (
        ("launch_error", result.launch_error),
        ("callback_error", result.callback_error),
        ("parse_error", result.parse_error),
    ):
        if detail:
            print(f"  {label}: {detail}")


def one_shot(args: argparse.Namespace, workdir: Path) -> None:
    """One CLI invocation: build, execute, parse. `run` blocks this thread."""
    result = run(RunSpec(
        harness=args.harness,
        prompt=args.prompt,
        workdir=workdir,
        model=args.model,            # None selects the adapter default
        executable=args.executable,  # None selects the adapter's default binary
        timeout_seconds=args.timeout,
    ))
    report(result)
    if result.stdout:
        print(f"  stdout head: {result.stdout[:200]!r}")


def plan_command(args: argparse.Namespace, workdir: Path) -> None:
    """Explicit configuration, planned only: `build_command` runs no CLI and
    writes no files, so this mode is safe with no `codex` installed at all."""
    plan = build_command(RunSpec(
        harness="codex",
        prompt=args.prompt,
        workdir=workdir,
        model=args.model or "gpt-5.3-codex",
        executable=args.executable or "codex",
        # Absolute directory exported as CODEX_HOME; harness never creates,
        # copies or reads it. Planned here, not created.
        config_home=Path(args.config_home) if args.config_home else workdir / "codex-home",
        native_options=CodexOptions(sandbox="read-only"),
        permission_policy="upstream",  # default: no approval or bypass flag is injected
        timeout_seconds=args.timeout,
    ))
    caps = get_capabilities("codex")
    print(f"  cmd={plan.cmd}")
    print(f"  args={plan.args}")
    print(f"  cwd={plan.cwd}")
    print(f"  env={plan.env}")  # adapter + caller additions only; the process env is layered at exec
    print(f"  model={plan.model} instructions_file={plan.instructions_file} directories={plan.directories}")
    print(f"  capabilities: native_options={caps.native_options} config_home_env={caps.config_home_env}"
          f" config_file_flag={caps.config_file_flag} streaming={caps.streaming}"
          f" cancellation={caps.cancellation} sessions={caps.sessions}")
    print("  note: codex maps no config-file flag, so RunSpec(config_file=...) is rejected"
          " with unsupported-capability; permission_policy='bypass' with a sandbox is rejected too.")


def cancel_in_flight(args: argparse.Namespace, workdir: Path) -> None:
    """Request cancellation while a run is pending. Use a slow synthetic peer
    to observe in-flight cancellation; a pre-set event launches nothing."""
    cancel = threading.Event()
    timer = threading.Timer(args.cancel_after, cancel.set)
    timer.start()
    try:
        result = run(RunSpec(
            harness=args.harness,
            prompt=args.prompt,
            workdir=workdir,
            model=args.model,
            executable=args.executable,
            timeout_seconds=args.timeout,
            cancel=cancel,
        ))
    finally:
        timer.cancel()
    report(result)
    if result.termination == "cancelled":
        print(f"  cancelled in flight after ~{args.cancel_after:.1f}s (a pre-set event launches nothing)")
    else:
        print(f"  the child finished on its own (termination={result.termination});"
              f" point --executable at something that outlives --cancel-after")


def stream_output(args: argparse.Namespace, workdir: Path) -> None:
    """Live output. Chunk boundaries are arbitrary — not lines, not JSONL
    records — so a consumer must buffer before parsing. Order is preserved per
    stream; interleaving between stdout and stderr is not specified.
    `run` accepts synchronous callbacks; `run_async` also awaits async ones."""
    chars = {"stdout": 0, "stderr": 0}

    def on_output(chunk: str, stream: str) -> None:
        chars[stream] += len(chunk)
        print(f"  {stream:<6} +{len(chunk)}c {chunk[:72]!r}")

    result = run(RunSpec(
        harness=args.harness,
        prompt=args.prompt,
        workdir=workdir,
        model=args.model,
        executable=args.executable,
        timeout_seconds=args.timeout,
        inactivity_timeout_seconds=args.inactivity,  # None disables the watchdog
        on_output=on_output,
    ))
    print(f"  streamed stdout={chars['stdout']}c stderr={chars['stderr']}c"
          " (the capture cap does not cap callback delivery)")
    report(result)


async def take_turn(live: LiveSession, prompt: str) -> None:
    """One turn: consume its events, then read the single settled result."""
    turn = live.start_turn(prompt)
    counts: dict[str, int] = {}
    async for event in turn.events:  # single consumer; ends when the turn settles
        counts[event.type] = counts.get(event.type, 0) + 1
    result = await turn.result  # terminal outcome; task cancellation still propagates
    print(f"  turn {result.turn_id}: status={result.status} events={counts}"
          f" events_truncated={result.events_truncated} exit={result.exit_code} signal={result.signal}")
    if result.error:
        print(f"    error: {result.error}")
    if result.stderr.strip():
        print(f"    child stderr[{result.stderr_bytes}B]: {result.stderr.strip()[:160]!r}")


async def live_session(args: argparse.Namespace, workdir: Path) -> None:
    """A controlled Pi RPC session: one owned `pi --mode rpc` child, serial
    turns, native events, guaranteed cleanup."""
    caps = get_session_capabilities("pi", "rpc")
    print(f"  capabilities: events={caps.events} interrupt={caps.interrupt} follow_up={caps.follow_up}"
          f" resume={caps.resume} concurrent_turns={caps.concurrent_turns} approval={caps.approval}")
    spec = SessionSpec(
        harness="pi",
        backend="rpc",
        workdir=workdir,
        model=args.model,                                # None keeps the native selection
        executable=args.executable or "pi",
        timeout_seconds=args.timeout,                    # per-turn wall clock; expiry tears the session down
        request_timeout_seconds=args.request_timeout,    # per native round trip
    )
    # `async with` closes the session (SIGTERM -> SIGKILL on the owned process
    # group, bounded drain) even when a turn raises.
    async with await open_session(spec) as live:
        print(f"  session_id={live.reference.session_id}")
        print(f"  session_file={live.reference.session_file}")
        await take_turn(live, args.prompt)
        if args.follow_up:
            # Follow-ups reuse the same native session; one turn at a time.
            await take_turn(live, args.follow_up)
        print(f"  closed={live.closed} active={live.active}")
    print("  resume: save the complete live.reference before close, then reopen the same"
          " SessionSpec with resume=reference and the same workdir."
          " Keep that workdir/session file; this example removes a default temporary workdir.")
    print("  interrupt: `await live.interrupt()` aborts the active turn and waits for it to settle"
          " (status 'interrupted' only when the backend confirms the abort).")


def positive_seconds(value: str) -> float:
    seconds = float(value)
    if not math.isfinite(seconds) or seconds <= 0:
        raise argparse.ArgumentTypeError("expected positive finite seconds")
    return seconds


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Harness public API guide (Python).")
    parser.add_argument("mode", choices=MODES)
    parser.add_argument("--harness", default=os.environ.get("HARNESS_EXAMPLE_HARNESS", "codex"),
                        help="adapter name for the run modes (session mode always uses pi)")
    parser.add_argument("--model", default=os.environ.get("HARNESS_EXAMPLE_MODEL"))
    parser.add_argument("--executable", default=os.environ.get("HARNESS_EXAMPLE_EXECUTABLE"),
                        help="bare name on PATH or absolute path; use a synthetic CLI for offline runs")
    parser.add_argument("--workdir", default=os.environ.get("HARNESS_EXAMPLE_WORKDIR"),
                        help="defaults to a fresh temporary directory removed on exit")
    parser.add_argument("--config-home", default=os.environ.get("HARNESS_EXAMPLE_CONFIG_HOME"),
                        help="absolute CODEX_HOME for the config mode (planned, never created)")
    parser.add_argument("--prompt", default="Print the string 'hello from harness' and nothing else.")
    parser.add_argument("--follow-up", default=None, help="optional second session turn")
    parser.add_argument("--timeout", type=positive_seconds, default=120.0, help="wall-clock seconds (finite by default)")
    parser.add_argument("--request-timeout", type=positive_seconds, default=30.0)
    parser.add_argument("--inactivity", type=positive_seconds, default=None, help="stream mode: silence watchdog seconds")
    parser.add_argument("--cancel-after", type=positive_seconds, default=1.0, help="cancel mode: seconds before cancelling")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    with contextlib.ExitStack() as stack:
        workdir = (Path(args.workdir).absolute() if args.workdir
                   else Path(stack.enter_context(tempfile.TemporaryDirectory(prefix="harness-guide-"))))
        print(f"{args.mode}: workdir={workdir}")
        try:
            if args.mode == "one-shot":
                one_shot(args, workdir)
            elif args.mode == "config":
                plan_command(args, workdir)
            elif args.mode == "cancel":
                cancel_in_flight(args, workdir)
            elif args.mode == "stream":
                stream_output(args, workdir)
            else:
                asyncio.run(live_session(args, workdir))
        except HarnessError as err:
            print(f"  HarnessError [{err.code}]: {err}")
            return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
