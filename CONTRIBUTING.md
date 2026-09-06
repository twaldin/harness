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
from __future__ import annotations

from harness.base import Adapter, BuildCommand, RunSpec
from harness._subproc import SubprocOutcome, write_instructions
from harness.model_normalization import normalize_model_for_harness

class MyCLIAdapter(Adapter):
    name = "mycli"
    instructions_filename = "AGENTS.md"
    DEFAULT_MODEL = "mycli/default"

    def build_command(self, spec: RunSpec) -> BuildCommand:
        instructions_file = write_instructions(spec.workdir, self.instructions_filename, spec.instructions)
        model = normalize_model_for_harness(
            self.name, spec.model or self.DEFAULT_MODEL, resolve=not spec.model_no_resolve,
        )
        args = ["run", "--model", model, spec.prompt]
        return BuildCommand(cmd="mycli", args=args, cwd=spec.workdir,
                            env={}, instructions_file=instructions_file)

    def parse_output(self, spec: RunSpec, outcome: SubprocOutcome) -> dict:
        # Parse this CLI's output; use None only for metrics it cannot report.
        return {"cost_usd": None, "tokens_in": None, "tokens_out": None, "raw": None}
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
import { normalizeModelForHarness } from '../model-normalization.js'
import type { Adapter, BuildCommand, ParsedOutput, RunSpec, SubprocOutcome } from '../base.js'

const myCLIAdapter: Adapter = {
  name: 'mycli',
  instructionsFilename: 'AGENTS.md',
  defaultModel: 'mycli/default',

  buildCommand(spec: RunSpec): BuildCommand {
    const instructionsFile = writeInstructions(spec.workdir, this.instructionsFilename, spec.instructions)
    const model = normalizeModelForHarness(this.name, spec.model ?? this.defaultModel, { resolve: !spec.modelNoResolve }) ?? this.defaultModel
    return { cmd: 'mycli', args: ['run', '--model', model, spec.prompt],
             cwd: spec.workdir, env: {}, instructionsFile }
  },

  parseOutput(_spec: RunSpec, _outcome: SubprocOutcome): ParsedOutput {
    // Parse this CLI's output; use null only for metrics it cannot report.
    return { costUsd: null, tokensIn: null, tokensOut: null, raw: null }
  },
}

register('mycli', myCLIAdapter)
```

Add the import to `ts/src/adapters/index.ts`:

```typescript
import './mycli.js'
```

These examples mirror the existing Gemini adapters, including current
empty-model skew: Python falls back for `None` or `""`, while TypeScript falls
back only for a nullish model. Both trim whitespace after choosing the fallback.
This records existing behavior, not an exception to the same-PR parity rule.

### 3. Add a fixture

Create `tests/fixtures/<name>.json` following the shape in [SPEC.md](SPEC.md#json-fixture-driven-verification). Add Python tests in `tests/test_fixtures.py` and the adapter name to `ADAPTER_NAMES` in `ts/tests/fixtures.test.ts`; neither suite discovers new fixture files automatically. TypeScript compares command arguments exactly; Python uses adapter-specific assertions and temporary-path substitutions. See SPEC.md for the database-fixture limitations.

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
