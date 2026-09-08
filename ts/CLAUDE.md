# `@twaldin/harness-ts`

TypeScript implementation of the harness contract. This is half of a two-language
monorepo — the cross-language contract lives in [`../SPEC.md`](../SPEC.md) and the
parity model in [`../CLAUDE.md`](../CLAUDE.md). This document covers the
TypeScript-specific build, test, and adapter conventions.

## Build and test

Bun is the build and test runner. For Node runtime requirements, consult
[`README.md`](README.md#install): `better-sqlite3` 12 does not support Node 18.

```bash
cd ts
bun install                # uses bun.lock
bun test                   # runs ts/tests + ts/tests/adapters
bun run build              # bundles ESM + generates declarations with tsc
```

`prepare` and `prepublishOnly` both run the build, so `npm publish` from a clean
checkout produces the `dist/` that `package.json::files` ships. `dist/` is not
committed; build before publish.

`tsconfig.json` is `strict` with `noUncheckedIndexedAccess`. No `any`, no
`as unknown as` casts — narrow with type guards. The Bun bundler writes ESM
only; the package has `"type": "module"`.

## Adapter pattern

Each adapter lives under `src/adapters/<name>.ts` and self-registers via
`register('<name>', adapter)`. Some modules also export helpers. The adapter
object satisfies the `Adapter` interface from `src/base.ts`:

```typescript
const myAdapter: Adapter = {
  name: 'mycli',
  instructionsFilename: 'AGENTS.md',     // inline instructions need adapter-specific handling
  defaultModel: 'mycli/default',
  buildCommand(spec: RunSpec): BuildCommand { /* plans argv/env/cwd and instructions */ },
  parseOutput(spec, outcome): ParsedOutput { /* extracts cost + tokens */ },
}
register('mycli', myAdapter)
```

`buildCommand` plans without filesystem writes or subprocesses. Execution uses
`prepareCommand` / `cleanupCommand`; external drivers retain the handle until
their process tree has stopped. `parseOutput` MAY read files written by the CLI
(sqlite, trajectory JSON) but MUST NOT block on long I/O. Both are pure with
respect to network state.

New adapters are wired in by adding an `import './<name>.js'` line to
`src/adapters/index.ts` and a fixture at `../tests/fixtures/<name>.json`.
Both fixture loaders discover names and require them to match the registry.

## Model normalization

`src/model-normalization.ts` resolves canonical model names per harness.
Most adapters use the sets at the top of the file:

- `BARE_MODEL_HARNESSES` — pass the model through stripped of any provider
  prefix (`claude-code`, `codex`, `gemini`, `qwen`, `openclaude`).
- `PROVIDER_MODEL_HARNESSES` — require a `provider/model` form
  (`aider`, `kilo`, `opencode`, `swe-agent`).
- `PRESERVE_EXPLICIT_PROVIDER_HARNESSES` — pass through unchanged when the
  user supplied a provider prefix (`crush`).

`pi` handles provider prefixes explicitly. Factory preserves the caller's exact
managed or `custom:` model ID. Continue preserves Hub `owner/package` slugs and
uses upstream configuration when no model is selected.

For a new normalization rule, update this file and its Python counterpart
`src/harness/model_normalization.py`, with coverage in both languages'
model-normalization tests. Honor `RunSpec.modelNoResolve`: it bypasses
harness-specific rewriting, but surrounding whitespace is still trimmed.

## Fixture parity

`tests/fixtures.test.ts` and Python's `tests/test_fixtures.py` assert the same
discovered command, parser and capability cases, including real substitute-CLI
execution and synthetic database/trajectory artifacts. The subprocess manifest
at `../tests/subprocess_cases.json` runs against source under Bun and the built
package under Node. See [the fixture contract](../SPEC.md#json-fixture-driven-verification)
and [offline versus live coverage](../CONTRIBUTING.md#offline-conformance-versus-live-smoke).

`tests/adapters/*-sessionlog.test.ts` and `opencode-parse.test.ts` retain
additional session-log and database-selection edge coverage.

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
