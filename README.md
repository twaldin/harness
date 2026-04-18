# harness

Unified Python interface for invoking AI coding-agent CLIs as subprocesses. One API for `claude-code`, `opencode`, `codex`, `gemini`, `aider`, `swe-agent`.

## Why

I wrote per-CLI spawn / env / output-parsing logic three separate times across three projects:

- [`flt`](https://github.com/twaldin/flt) — TS adapters in `src/adapters/{claude-code,opencode,codex,gemini,aider,swe-agent}.ts`. Each one knew how to launch its CLI in tmux, strip ANSI, detect a ready prompt, send keys to approve dialogs.
- [`agentelo`](https://github.com/twaldin/agentelo) — `bin/agentelo` (1847 lines of Node) with ~800 lines of `if (harness === 'X')` blocks. Per-CLI argv, env setup (Vertex tokens, GCloud, OpenAI proxy), inactivity watchdogs, six different token/cost parsers (claude's JSON envelope, codex's JSONL turn events, gemini's `stats.models`, opencode's session sqlite, aider's "Tokens: N sent" scrape, swe-agent's trajectory file).
- [`hone`](https://github.com/twaldin/hone) — `src/hone/mutators/claude_code.py`, then almost the same logic again for an `anthropic_api.py` mutator, then a `custom_script.py` shape, with the JSON parsing rewritten each time.

Three implementations, three sets of bugs, knowledge gained in one project never crossed to the others. When `opencode` changed its session DB schema, only agentelo learned. When `claude --output-format json` added a `cache_creation_input_tokens` field that mattered for accurate cost, only hone fixed it.

`harness` is the deduped version. Each CLI's quirks live in exactly one adapter file, all six adapters share the same `RunSpec → RunResult` contract, and the next consumer (TS or Python) shells out to `harness run --json` instead of starting from scratch.

This README has a [Why](#why) section because I want to remember the cost of doing this three times before doing it a fourth.

## Examples by problem

### "I want to run an agent on a repo and capture cost + tokens"

```python
from pathlib import Path
from harness import RunSpec, run

result = run(RunSpec(
    harness="claude-code",
    model="sonnet",
    prompt="Fix the failing tests in this repo and report what you changed.",
    workdir=Path("/tmp/my-bug-fix-checkout"),
    timeout_seconds=1800,
))

print(f"exit={result.exit_code} cost=${result.cost_usd:.4f} "
      f"tokens={result.tokens_in}/{result.tokens_out} "
      f"wall={result.duration_seconds:.1f}s")
```

Token + cost extraction is per-adapter. Adding cost-tracking to `gemini` later didn't require any consumer change.

### "I want to swap models without rewriting the call site"

```python
for spec in [
    RunSpec(harness="claude-code", model="sonnet", prompt=task, workdir=wd),
    RunSpec(harness="opencode",    model="openai/gpt-5.4", prompt=task, workdir=wd),
    RunSpec(harness="gemini",      model="gemini-2.5-pro", prompt=task, workdir=wd),
]:
    r = run(spec)
    print(f"{spec.harness:12} {spec.model:25} ${r.cost_usd or 0:.4f}")
```

Same `prompt`, same `workdir`, three CLIs. Useful for benchmarking, A/B testing prompts across models, or building a router that picks the cheapest harness for a given job.

### "I want to inject a system prompt / agent guide"

```python
result = run(RunSpec(
    harness="opencode",
    model="openai/gpt-5.4",
    prompt="Fix the failing test described in the issue.",
    workdir=Path("/tmp/repo"),
    instructions="""You are an autonomous bug-fixing agent. No human will respond.
Run the failing tests, identify the root cause, fix the source (not the tests),
verify, then stop. Make the smallest possible change.""",
    timeout_seconds=1800,
))
```

`instructions` is written into `workdir` under the per-harness file (`AGENTS.md` for opencode, `CLAUDE.md` for claude-code, `GEMINI.md` for gemini, `.aider.conf.yml` for aider). Filenames are baked into each adapter — consumers don't think about it.

### "I want to use it as a hone mutator"

```bash
hone run prompt.md \
    --grader ./grade.sh \
    --mutator harness:claude-code:sonnet \
    --budget 20
```

The `harness:` prefix in hone's `--mutator` spec dispatches every prompt mutation through `harness.run()`. Swapping to `harness:gemini:gemini-2.5-pro` is a one-token change.

### "I want to call it from a TS project (agentelo, flt)"

```typescript
import { spawnSync } from 'child_process'

function runHarness({ harness, model, workdir, prompt, instructionsFile, timeoutSeconds }) {
  const args = [
    'run',
    '--harness', harness,
    '--model', model,
    '--workdir', workdir,
    '--timeout', String(timeoutSeconds),
    '--json',
  ]
  if (instructionsFile) args.push('--instructions', instructionsFile)
  args.push(prompt)

  const proc = spawnSync('harness', args, { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 })
  return JSON.parse(proc.stdout)
  // -> { harness, model, exit_code, duration_seconds, timed_out, cost_usd,
  //      tokens_in, tokens_out, stdout, stderr }
}
```

Python startup adds ~150ms per invocation — irrelevant against agent runs that take 5-30 minutes. agentelo's planned migration deletes ~800 lines of TS by replacing per-harness blocks with this pattern.

See [`examples/`](examples/) for the full per-consumer integration sketches.

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
