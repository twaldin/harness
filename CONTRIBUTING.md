# Contributing to harness

Thanks for the interest. harness is a small library with one job: wrap AI coding CLIs uniformly. Keep contributions focused on that.

## Before you open a PR

- **Open an issue first** for anything bigger than a typo or a one-line fix.
- Keep the scope tight. One conceptual change per PR.
- Match existing style. Read a few neighboring files before writing.

## Two implementations in lockstep

`harness` ships both a Python and a TypeScript implementation. They share the contract in [SPEC.md](SPEC.md) and the fixtures in `tests/fixtures/`. Changes to the public API MUST land in both languages in the same PR.

## Running the tests

```bash
# Python
PYTHONPATH=src uv run pytest tests/

# TypeScript
cd ts && bun test
```

All tests must pass in both. If you add a fixture, both impls must parse it.

## Style

- Python: type hints on public functions, no `Any` in adapter surfaces, `from __future__ import annotations` at the top.
- TypeScript: strict mode, no `as any` / `as unknown as` casts.
- Match surrounding code. If in doubt, look at the adapter you're editing.

## PR etiquette

- Title: imperative, lowercase.
- Body: what changed, why, how you tested.
- Reference the issue if there is one.

## Adding a new adapter

Adding an adapter takes about 20 minutes if the CLI is straightforward. Here's how.

### 1. Python implementation

Create `src/harness/adapters/<name>.py`. Copy the shape of an existing simple adapter (e.g. `gemini.py`):

```python
from harness.base import Adapter, BuildCommand, ParsedOutput, RunResult, RunSpec, SubprocOutcome
from harness._subproc import run_subprocess, write_instructions

class MyCLIAdapter(Adapter):
    name = "mycli"
    instructions_filename = "AGENTS.md"   # or "" to fold into prompt
    default_model = "mycli/default"

    def build_command(self, spec: RunSpec) -> BuildCommand:
        instructions_file = write_instructions(spec.workdir, self.instructions_filename, spec.instructions)
        args = ["run", "--model", spec.model or self.default_model, spec.prompt]
        return BuildCommand(cmd="mycli", args=args, cwd=str(spec.workdir),
                            env={}, instructions_file=instructions_file)

    def parse_output(self, spec: RunSpec, outcome: SubprocOutcome) -> ParsedOutput:
        # parse stdout/stderr for cost + tokens; return None for unknown fields
        return ParsedOutput(cost_usd=None, tokens_in=None, tokens_out=None, raw=None)
```

Register it in `src/harness/adapters/__init__.py`:

```python
from harness.adapters.mycli import MyCLIAdapter
register("mycli", MyCLIAdapter)
```

### 2. TypeScript implementation

Create `ts/src/adapters/<name>.ts`. Copy the shape of `ts/src/adapters/gemini.ts`:

```typescript
import { register } from '../registry.js'
import { writeInstructions } from '../subproc.js'
import type { Adapter, BuildCommand, ParsedOutput, RunSpec, SubprocOutcome } from '../base.js'

const myCLIAdapter: Adapter = {
  name: 'mycli',
  instructionsFilename: 'AGENTS.md',
  defaultModel: 'mycli/default',

  buildCommand(spec: RunSpec): BuildCommand {
    const instructionsFile = writeInstructions(spec.workdir, this.instructionsFilename, spec.instructions)
    const model = spec.model ?? this.defaultModel
    return { cmd: 'mycli', args: ['run', '--model', model, spec.prompt],
             cwd: spec.workdir, env: {}, instructionsFile }
  },

  parseOutput(_spec: RunSpec, _outcome: SubprocOutcome): ParsedOutput {
    return { costUsd: null, tokensIn: null, tokensOut: null, raw: null }
  },
}

register('mycli', myCLIAdapter)
```

Add the import to `ts/src/adapters/index.ts`:

```typescript
import './mycli.js'
```

### 3. Add a fixture

Create `tests/fixtures/<name>.json` following the shape in [SPEC.md](SPEC.md#json-fixture-driven-verification). Both Python (`pytest`) and TypeScript (`bun test`) load fixtures and verify `buildCommand` output matches `expectedCommand` byte-for-byte.

### 4. Document it

Add a row to [ADAPTER-MATRIX.md](ADAPTER-MATRIX.md) covering: CLI binary name, instructions file, default model, command flags, token/cost source, and output shape.

### Quick checklist

- [ ] `src/harness/adapters/<name>.py` + registered in `__init__.py`
- [ ] `ts/src/adapters/<name>.ts` + imported in `adapters/index.ts`
- [ ] `tests/fixtures/<name>.json`
- [ ] Row in `ADAPTER-MATRIX.md`
- [ ] `PYTHONPATH=src uv run pytest tests/` passes
- [ ] `cd ts && bun test` passes

---

## What I'm likely to merge

- New adapters for AI coding CLIs (mirror an existing adapter's shape in both languages; add a fixture).
- Bug fixes with a fixture that demonstrates the bug.
- SPEC clarifications where the contract is ambiguous.

## What I'll probably close

- Changes to one impl without the other.
- New adapters that don't ship a fixture.
- "Streaming API" — not planned for v1.
- Wrapping non-CLI tools (API SDKs, MCP servers).
