# harness

Unified Python interface for invoking AI coding-agent CLIs as subprocesses.

Wraps `claude-code`, `opencode`, and (planned) `codex`, `gemini`, `aider`, `swe-agent` behind one API. Extracted from agentelo (TS) and hone (Python) so consumers stop reimplementing per-CLI subprocess plumbing.

## Install

```bash
cd harness
pip install -e ".[dev]"
```

## Library use

```python
from harness import RunSpec, run

result = run(RunSpec(
    harness="opencode",
    model="openai/gpt-5.4",
    prompt="Fix the failing tests in this repo.",
    workdir="/path/to/repo",
    instructions="You are an autonomous bug-fixing agent. ...",
    timeout_seconds=1800,
))

print(result.ok, result.exit_code, result.cost_usd, result.tokens_in)
```

`instructions` is written to the per-harness file inside `workdir`:

| harness     | instructions filename |
| ----------- | --------------------- |
| claude-code | `CLAUDE.md`           |
| opencode    | `AGENTS.md`           |

## CLI use

```bash
harness list
harness run --harness opencode --model openai/gpt-5.4 \
    --workdir /tmp/repo --instructions /tmp/agents.md \
    --timeout 1800 \
    "Fix the failing tests."
```

Add `--json` to emit a structured RunResult on stdout.

## Adapter contract

Each adapter:

1. Writes `spec.instructions` to its known filename in `spec.workdir` (if provided).
2. Builds the CLI invocation for `spec.prompt` + `spec.model`.
3. Calls `harness._subproc.run_subprocess` (handles env merge, cwd, timeout, capture).
4. Parses any structured output the CLI emits (JSON envelope, session metadata) and fills `RunResult.cost_usd` / `tokens_in` / `tokens_out` / `raw`.

Add a new adapter by subclassing `harness.base.Adapter` and registering it in `harness/adapters/__init__.py`.

## Status

v0.1 — claude-code + opencode only. codex / gemini / aider / swe-agent ports pending.
