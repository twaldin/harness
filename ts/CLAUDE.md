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
`src/adapters/index.ts`, a fixture at `../tests/fixtures/<name>.json` and the
name to `ADAPTER_NAMES` in `tests/fixtures.test.ts`.

## Model normalization

`src/model-normalization.ts` resolves canonical model names per harness.
Most adapters use the sets at the top of the file:

- `BARE_MODEL_HARNESSES` — pass the model through stripped of any provider
  prefix (`claude-code`, `codex`, `gemini`, `qwen`, `continue-cli`, `openclaude`).
- `PROVIDER_MODEL_HARNESSES` — require a `provider/model` form
  (`aider`, `kilo`, `opencode`, `swe-agent`).
- `PRESERVE_EXPLICIT_PROVIDER_HARNESSES` — pass through unchanged when the
  user supplied a provider prefix (`crush`).

`pi` and `factory-droid` have explicit branches: pi handles provider prefixes,
while factory-droid produces a `custom:` model ID for a configured BYOK model.

For a new normalization rule, update this file and its Python counterpart
`src/harness/model_normalization.py`, with coverage in both languages'
model-normalization tests. Honor `RunSpec.modelNoResolve`: it bypasses
harness-specific rewriting, but surrounding whitespace is still trimmed.

## Fixture parity

`tests/fixtures.test.ts` loads the adapter names in its explicit
`ADAPTER_NAMES` list from `../tests/fixtures/`. It compares command arguments
and instruction paths exactly. Fixtures with `expectedParsed.note` assert
null metrics instead of the recorded values. Python uses adapter-specific
assertions rather than the same generic loop. See the
[shared coverage notes](../CLAUDE.md#how-parity-is-enforced).

`tests/adapters/*-sessionlog.test.ts` covers selected session-log parsers:
crush and kilo create temporary sqlite databases; continue-cli, factory-droid,
openclaude and qwen use JSON/JSONL files. `opencode-parse.test.ts` covers
per-run database selection. Python's `tests/test_*_db.py` covers all three schemas.

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
