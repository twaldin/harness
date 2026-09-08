# harness

`harness` is a dual-language (Python + TypeScript) adapter library that wraps fifteen
AI coding-agent CLIs — `claude-code`, `openclaude`, `opencode`, `codex`, `gemini`,
`aider`, `swe-agent`, `qwen`, `continue-cli`, `pi`, `omp`, `factory-droid`, `kilo`, `crush`, `hermes` —
behind a shared `RunSpec → RunResult` contract. Both implementations sit in
this monorepo. [SPEC.md](SPEC.md) defines the shared contract and distinguishes
shipped CLI behavior from future RPC/SDK implementation requirements.

Authoritative references in this repo:

- [SPEC.md](SPEC.md) — the cross-language contract. Public API, types, error rules.
- [ADAPTER-MATRIX.md](ADAPTER-MATRIX.md) — per-CLI flags, cost reporting, output shapes.
- [CONTRIBUTING.md](CONTRIBUTING.md) — code conventions and the "add an adapter" guide.

## Repository layout

```
harness/
├── SPEC.md                      cross-language contract (THE source of truth)
├── ADAPTER-MATRIX.md            per-adapter quirk reference
├── tests/fixtures/*.json        shared golden fixtures (Py + TS both consume)
├── src/harness/                 Python implementation (see src/harness/CLAUDE.md)
│   ├── base.py                  RunSpec / RunResult / Adapter dataclasses
│   ├── registry.py              run / list_adapters / get_adapter
│   ├── cli.py                   Typer CLI entrypoint (harness.cli:app)
│   ├── model_normalization.py   per-harness canonical model resolution
│   ├── pricing.py               cost derivation from token counts
│   ├── _subproc.py              subprocess runner
│   ├── _instructions.py         owned instruction projection lifecycle
│   └── adapters/                15 adapter modules, one per CLI
├── ts/                          TypeScript implementation (see ts/CLAUDE.md)
│   ├── package.json             @twaldin/harness-ts (Bun build + test)
│   ├── src/base.ts              mirror of Python base.py types
│   ├── src/registry.ts          mirror of Python registry.py
│   ├── src/model-normalization.ts
│   ├── src/pricing.ts
│   ├── src/subproc.ts
│   ├── src/instructions.ts      owned instruction projection lifecycle
│   ├── src/util.ts
│   └── src/adapters/            15 adapter modules, one per CLI
├── tests/                       pytest suite (Python)
└── ts/tests/                    bun test suite (TypeScript)
```

The two language trees are deliberately near-identical: the same module names,
the same adapter names, the same field names (snake_case in Python,
camelCase in TS). When you read one, you can navigate the other by analogy.

## Dual-language parity contract

Both implementations provide the core headless API described in
[SPEC.md](SPEC.md):

- Types: `RunSpec`, `BuildCommand`, `RunResult`, `HarnessError`, `Capabilities`,
  `Backend`, `PermissionPolicy` and typed `NativeOptions`.
- Functions: `listAdapters()`, `getAdapter()`, `getCapabilities()`,
  `buildCommand(spec)`, `parseOutput(spec, outcome)`, `run(spec)`,
  `runAsync(spec)` (Python uses snake_case names).
- Adapters: fifteen registered names, exact strings — `aider`, `claude-code`,
  `codex`, `continue-cli`, `crush`, `factory-droid`, `gemini`, `hermes`, `kilo`,
  `omp`, `openclaude`, `opencode`, `pi`, `qwen`, `swe-agent`. Lookup is case-sensitive.

Both package roots initialize the built-in registry and expose subprocess
outcomes plus optional pane/dialog/install/session-log helpers. Python's
`RunResult.ok` and projection keyword arguments remain idiomatic conveniences.
The exported contract and helper availability must agree across languages;
see `src/harness/__init__.py`, `src/harness/base.py`, `ts/src/index.ts` and
`ts/src/base.ts`.

Permission policy defaults to upstream behavior; bypass is explicit opt-in.
Builders plan commands without file writes. Reject unsupported backend, permission,
native-option and config-override requests before preparation. External drivers
retain `prepareCommand` ownership until process teardown and then clean up.
CLI remains the one-shot backend; controlled Pi RPC uses the separate session API.
See SPEC for exact errors, capabilities, migration and subprocess/session ownership.

Field naming differs (`cost_usd` ↔ `costUsd`, `tokens_in` ↔ `tokensIn`,
`timed_out` ↔ `timedOut`). The Python CLI's `harness run --json` emits
snake_case fields and omits `raw`; it is not the TypeScript `RunResult` shape.

The documented version-alignment requirement is major.minor alignment:

- `harness-cli` (Python distribution; import `harness`) — `pyproject.toml::project.version`
- `@twaldin/harness-ts` — `ts/package.json::version`

Patch versions MAY diverge for implementation-only fixes (e.g. a Node prebuild
bump that doesn't apply to the Python wheel). Anything that touches SPEC.md or
the fixture set bumps both simultaneously.

Current manifests do not meet that alignment: Python is `0.3.6` and
TypeScript is `0.2.10`. This is recorded skew, not a new release policy.

## How parity is enforced

The contract and fixture suites support parity; they do not prove every upstream
version works:

1. **SPEC.md is the shared contract.** Contract changes update both implementations
   in one PR. Its future-backend implementation gates are not shipped APIs.
2. **Shared behavioral fixtures.** Both loaders discover
   `tests/fixtures/<name>.json`, require fixture names to match the registry,
   and assert the same command, parser and capability cases. Each adapter also
   runs through an explicit synthetic executable, with owned cleanup checked.
   `tests/subprocess_cases.json` supplies shared lifecycle/I/O expectations for
   Python, Bun and the built package under Node. See
   [SPEC.md](SPEC.md#json-fixture-driven-verification) for fixture fields and
   [CONTRIBUTING.md](CONTRIBUTING.md#offline-conformance-versus-live-smoke) for
   platform coverage and the separate provider-smoke boundary.

Database adapters (`opencode`, `kilo`, `crush`) read sqlite session DBs after
the CLI exits. Shared fixtures assert populated synthetic databases and explicit
missing-artifact results; `swe-agent` does the same for trajectory JSON.
Python's `tests/test_*_db.py` and TypeScript's adapter/session-log tests retain
additional schema, selection and telemetry edge coverage.

## Public API changes

Public API changes MUST update Python and TypeScript together in the same PR,
as required by [CONTRIBUTING.md](CONTRIBUTING.md#two-implementations-in-lockstep).
Current implementation and version skew is documented as fact; a skew note
does not permit staging a public API change across single-language PRs.

The fixture set is the deciding tiebreak: if a fixture passes in one language
and fails in the other, the fixture is correct and the lagging implementation
must catch up.

## Where to look next

- For Python work — read [`src/harness/CLAUDE.md`](src/harness/CLAUDE.md). Covers
  the Typer CLI, hatchling build, adapter dev, and the database-adapter
  pattern.
- For TypeScript work — read [`ts/CLAUDE.md`](ts/CLAUDE.md). Covers the Bun
  build/test loop, strict-TS adapter pattern, and model-normalization edge
  cases.
- For the cross-language contract — [`SPEC.md`](SPEC.md) is canonical.
- For per-CLI quirks — [`ADAPTER-MATRIX.md`](ADAPTER-MATRIX.md).

## Scope and implementation gates

Keep the library narrow while qualifying optional agent SDK/protocol backends:

- tmux lifecycle, pane capture and polling stay with the consumer. Both languages
  provide optional pure pane-status/dialog helpers; consumers drive capture,
  timing and decide whether to send any returned keystrokes.
- Challenge seeding, grading, ELO scoring — `agentelo`'s job.
- Prompt mutation, GEPA, training loops — `hone`'s job.
- Vertex / OAuth proxy shims — context-specific, lives in the consumer.
- Streaming subprocess output callbacks — Python `run_async()` and TypeScript
  `run()` / `runAsync()` support awaited, backpressured callbacks. Python `run()`
  accepts cooperative synchronous callbacks; TS's blocking low-level helper
  rejects callbacks. Both runtimes provide finite stdin, bounded capture and
  opt-in inactivity deadlines. See SPEC's streaming contract before changing I/O.
- Controlled Pi RPC ships through `open_session` / `openSession`; read SPEC's
  controlled-session contract before modifying its protocol or lifecycle.
  Additional RPC/SDK backends must satisfy the ownership, permission, capability
  and compatibility requirements without becoming a fleet/application layer.

Alongside command construction, output parsing and headless execution, the
package includes instruction projection, pricing and session helpers. These
support interactive consumers without owning their terminal lifecycle.
