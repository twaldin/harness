"""harness CLI — `harness run`, `harness list`."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import typer
from rich.console import Console

from harness import HarnessError, RunSpec, list_adapters, run
from harness.base import BACKENDS, PERMISSION_POLICIES

app = typer.Typer(add_completion=False, no_args_is_help=True, help="Invoke AI coding-agent CLIs uniformly.")
console = Console(stderr=True)


def _one_of(allowed: tuple[str, ...]):
    def check(value: str) -> str:
        if value not in allowed:
            raise typer.BadParameter(f"expected one of: {', '.join(allowed)}")
        return value

    return check


@app.command("list")
def list_cmd() -> None:
    """List registered harness adapters."""
    for name in list_adapters():
        typer.echo(name)


@app.command("run")
def run_cmd(
    prompt: str = typer.Argument(..., help="The task to give the agent."),
    harness: str = typer.Option(..., "--harness", "-h", help="Adapter name (e.g. claude-code, opencode)."),
    workdir: Path = typer.Option(Path.cwd(), "--workdir", "-d", help="Working directory for the agent."),
    model: str = typer.Option(None, "--model", "-m", help="Model identifier (adapter-specific)."),
    instructions_file: Path = typer.Option(
        None,
        "--instructions",
        "-i",
        help="Path to a file whose content is injected as the per-harness instructions file.",
    ),
    timeout: int = typer.Option(1800, "--timeout", "-t", help="Wall-clock timeout in seconds."),
    model_no_resolve: bool = typer.Option(False, "--model-no-resolve", help="Pass --model through exactly as given; skip harness-specific normalization."),
    backend: str = typer.Option(
        "cli",
        "--backend",
        callback=_one_of(BACKENDS),
        help="Execution backend. Only 'cli' is implemented; 'rpc'/'sdk' are rejected before anything runs.",
    ),
    permission_policy: str = typer.Option(
        "upstream",
        "--permission-policy",
        callback=_one_of(PERMISSION_POLICIES),
        help="'upstream' keeps the CLI's own permission prompts; 'bypass' injects the adapter's skip-permissions flag.",
    ),
    json_out: bool = typer.Option(False, "--json", help="Emit RunResult as JSON to stdout instead of human text."),
) -> None:
    """Invoke a harness on PROMPT and report the result."""
    instructions = None
    if instructions_file is not None:
        if not instructions_file.exists():
            console.print(f"[red]instructions file not found:[/red] {instructions_file}")
            raise typer.Exit(2)
        instructions = instructions_file.read_text(encoding="utf-8")

    spec = RunSpec(
        harness=harness,
        prompt=prompt,
        workdir=workdir.resolve(),
        model=model,
        instructions=instructions,
        timeout_seconds=timeout,
        model_no_resolve=model_no_resolve,
        backend=backend,  # type: ignore[arg-type]  # validated by callback
        permission_policy=permission_policy,  # type: ignore[arg-type]
    )

    resolve_mode = "raw" if model_no_resolve else "resolved"
    console.print(f"[dim]running {harness} (model={model or 'default'}, {resolve_mode}, {backend}, permissions={permission_policy}) in {workdir} ...[/dim]")
    try:
        result = run(spec)
    except HarnessError as exc:
        console.print(f"[red]{exc.code}:[/red] {exc}")
        raise typer.Exit(2) from exc

    if json_out:
        payload = {
            "harness": result.harness,
            "model": result.model,
            "exit_code": result.exit_code,
            "duration_seconds": result.duration_seconds,
            "timed_out": result.timed_out,
            "cost_usd": result.cost_usd,
            "tokens_in": result.tokens_in,
            "tokens_out": result.tokens_out,
            "stdout": result.stdout,
            "stderr": result.stderr,
        }
        typer.echo(json.dumps(payload, indent=2))
        sys.exit(0 if result.ok else 1)

    status = "[green]ok[/green]" if result.ok else "[red]failed[/red]"
    console.print(f"  status        {status} (exit={result.exit_code}, timed_out={result.timed_out})")
    console.print(f"  duration      {result.duration_seconds:.1f}s")
    if result.tokens_in is not None or result.tokens_out is not None:
        console.print(f"  tokens        in={result.tokens_in} out={result.tokens_out}")
    if result.cost_usd is not None:
        console.print(f"  cost          ${result.cost_usd:.4f}")
    if result.stdout.strip():
        console.print("[dim]--- stdout ---[/dim]")
        typer.echo(result.stdout)
    if result.stderr.strip():
        console.print("[dim]--- stderr ---[/dim]")
        typer.echo(result.stderr, err=True)

    sys.exit(0 if result.ok else 1)


if __name__ == "__main__":  # pragma: no cover
    app()
