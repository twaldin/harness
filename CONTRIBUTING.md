# Contributing to harness

Harness is a small library for uniform coding-agent integration. CLI execution ships today; optional agent SDK/protocol backends must satisfy the shared [SPEC](SPEC.md#backend-and-session-implementation-gates) without adding a fleet manager or application.

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
from harness._subproc import SubprocOutcome

class MyCLIAdapter(Adapter):
    name = "mycli"
    instructions_filename = "AGENTS.md"
    DEFAULT_MODEL = "mycli/default"

    def build_command(self, spec: RunSpec) -> BuildCommand:
        resolved = self.resolve_run_spec(spec)
        args = ["run", "--model", resolved.model, spec.prompt]
        return self.finalize_command(spec, cmd="mycli", args=args)

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
import { finalizeCommand, validateRunSpec } from '../base.js'
import type { Adapter, BuildCommand, ParsedOutput, RunSpec, SubprocOutcome } from '../base.js'

const myCLIAdapter: Adapter = {
  name: 'mycli',
  instructionsFilename: 'AGENTS.md',
  defaultModel: 'mycli/default',

  buildCommand(spec: RunSpec): BuildCommand {
    const resolved = validateRunSpec(this, spec)
    return finalizeCommand(this, spec, resolved, {
      cmd: 'mycli', args: ['run', '--model', resolved.model, spec.prompt],
    })
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

An omitted or empty model selects the default in both languages; whitespace is
trimmed after that choice. Every adapter validates backend, permission, native
options and config overrides through the shared validator, then returns through
the common command finalizer. Builders plan only: no instruction/config writes
or directory creation. Use the validated absolute workdir for cwd flags and
artifact paths; preparation owns filesystem effects and cleanup.
Add a bypass or config mapping only when supported upstream; an omitted
permission policy preserves upstream behavior. Reject unsupported options
rather than discarding them.

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
- Automatic CLI/SDK fallback, implicit permission bypass, or unsupported capabilities disguised as no-ops.
- Fleet/worktree/host-driver ownership or raw model API wrappers presented as agent backends.

Streaming, controlled sessions and optional agent SDK integrations are eligible
when they implement the [SPEC gates](SPEC.md#backend-and-session-implementation-gates)
in both languages. This supersedes the historical blanket SDK exclusion; it
does not claim those backends currently ship. Keep optional SDK loading isolated
from ordinary CLI imports and preserve existing caller-selected configuration.
