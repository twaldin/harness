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

## What I'm likely to merge

- New adapters for AI coding CLIs (mirror an existing adapter's shape in both languages; add a fixture).
- Bug fixes with a fixture that demonstrates the bug.
- SPEC clarifications where the contract is ambiguous.

## What I'll probably close

- Changes to one impl without the other.
- New adapters that don't ship a fixture.
- "Streaming API" — not planned for v1.
- Wrapping non-CLI tools (API SDKs, MCP servers).
