# `@twaldin/harness-ts`

TypeScript implementation of the harness contract. This is half of a two-language
monorepo — the cross-language contract lives in [`../SPEC.md`](../SPEC.md) and the
parity model in [`../CLAUDE.md`](../CLAUDE.md). This document covers the
TypeScript-specific build, test, and adapter conventions.

## Build and test

Bun is the build and test runner. Node 18+ at runtime, Node 20+ for the frontier
adapters that depend on modern Node prebuilds.

```bash
cd ts
bun install                # uses bun.lock
bun test                   # runs ts/tests + ts/tests/adapters
bun run build              # bundles src/index.ts -> dist/ (target=node, ESM)
```

`prepare` and `prepublishOnly` both run the build, so `npm publish` from a clean
checkout produces the `dist/` that `package.json::files` ships. `dist/` is not
committed; build before publish.

`tsconfig.json` is `strict` with `noUncheckedIndexedAccess`. No `any`, no
`as unknown as` casts — narrow with type guards. The Bun bundler writes ESM
only; the package has `"type": "module"`.

## Adapter pattern

Every adapter is a single file under `src/adapters/<name>.ts` that exports
nothing — it self-registers via `register('<name>', adapter)`. The adapter
object satisfies the `Adapter` interface from `src/base.ts`:

```typescript
const myAdapter: Adapter = {
  name: 'mycli',
  instructionsFilename: 'AGENTS.md',     // empty string = inline into prompt
  defaultModel: 'mycli/default',
  buildCommand(spec: RunSpec): BuildCommand { /* writes instructions, returns argv */ },
  parseOutput(spec, outcome): ParsedOutput { /* extracts cost + tokens */ },
}
register('mycli', myAdapter)
```

`buildCommand` MAY write files (instructions, config) but MUST NOT spawn a
subprocess. `parseOutput` MAY read files written by the CLI (sqlite, trajectory
JSON) but MUST NOT block on long I/O. Both are pure with respect to network
state.

New adapters are wired in by adding an `import './<name>.js'` line to
`src/adapters/index.ts` and dropping a fixture at `../tests/fixtures/<name>.json`.

## Model normalization

`src/model-normalization.ts` resolves canonical model names per harness. Adapters
fall into three buckets, defined as sets at the top of the file:

- `BARE_MODEL_HARNESSES` — pass the model through stripped of any provider
  prefix (`claude-code`, `codex`, `gemini`, `qwen`, `continue-cli`, `openclaude`).
- `PROVIDER_MODEL_HARNESSES` — require a `provider/model` form
  (`aider`, `kilo`, `opencode`, `swe-agent`).
- `PRESERVE_EXPLICIT_PROVIDER_HARNESSES` — pass through unchanged when the
  user supplied a provider prefix (`crush`).

Adding a harness that doesn't fit one bucket means editing this file and
adding both a unit test in `ts/tests/model-normalization.test.ts` AND a Python
counterpart in `src/harness/model_normalization.py`. `RunSpec.modelNoResolve`
is the per-call escape hatch; honor it in every adapter.

## Fixture parity

`ts/tests/fixtures.test.ts` loads every JSON file in `../tests/fixtures/`,
runs `buildCommand(spec)` against `expectedCommand`, and `parseOutput(spec,
sampleOutput)` against `expectedParsed`. The Python suite does the same in
`tests/test_fixtures.py`. The fixtures are the single source of truth for
command shape — if you change argv assembly in a TS adapter, the fixture diff
is what will (or won't) make the Python suite agree.

`ts/tests/adapters/*-sessionlog.test.ts` cover the database-backed adapters
that read sqlite or session logs after the CLI exits (`opencode`, `kilo`,
`crush`, `continue-cli`, `factory-droid`, `qwen`). These tests build temporary
session DBs so the parser exercises real schema rather than mocks.

## Things to keep in lockstep

When you change any of these in TypeScript, make the matching change in
`src/harness/` (or open a same-PR Python patch):

- A new adapter, or a removed one.
- A new field on `RunSpec` / `RunResult` / `BuildCommand`.
- A change to `buildCommand` argv that affects the fixture.
- A change to `model-normalization.ts` (provider sets or normalization rules).
- A change to `pricing.ts` cost derivation logic.

Local-only changes that do NOT need a Python counterpart: `dist/` regen,
better-sqlite3 prebuild bumps, Bun-specific build tweaks, internal helper
refactors that don't touch public types or fixture-visible behavior.
