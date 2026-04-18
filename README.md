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

| harness     | instructions filename     | notes                                                    |
| ----------- | ------------------------- | -------------------------------------------------------- |
| claude-code | `CLAUDE.md`               |                                                          |
| opencode    | `AGENTS.md`               |                                                          |
| codex       | `AGENTS.md`               |                                                          |
| gemini      | `GEMINI.md`               |                                                          |
| aider       | `.aider.conf.yml`         | aider treats this as YAML config, not free prompt        |
| swe-agent   | (folded into prompt)      | mini-swe-agent has no instructions file convention       |

## Workdir / worktrees

`harness` does **not** create or manage git worktrees. `workdir` is opaque — the agent runs there and that's all the library cares about. Set it up however your consumer wants:

- a fresh `git clone` into a tmpdir (agentelo-style)
- a `git worktree add` (flt-style)
- the user's existing checkout (interactive use)
- a Docker volume mount (CI)

The opt-in `--worktree` features in some CLIs (e.g. `claude --worktree` creating `.claude/worktrees/`) are intentionally **not** wrapped — they pollute the project tree and limit consumer flexibility. Consumers that want worktrees should call `git worktree add` themselves and pass the resulting path.

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

v0.2 — all six adapters shipped: `claude-code`, `opencode`, `codex`, `gemini`, `aider`, `swe-agent`.

Pending:

- Per-harness inactivity watchdogs (port from `agentelo/bin/agentelo`).
- Vertex AI / GCloud token plumbing (currently consumer-supplied via `env`).
- Wire as a hone mutator type (replaces hone's `ClaudeCodeMutator`).
- Wire as the spawn backend for flt and agentelo (TS → Python subprocess boundary; design TBD).
