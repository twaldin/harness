# harness

`harness` is a dual-language (Python + TypeScript) adapter library that wraps thirteen
AI coding-agent CLIs — `claude-code`, `openclaude`, `opencode`, `codex`, `gemini`,
`aider`, `swe-agent`, `qwen`, `continue-cli`, `pi`, `factory-droid`, `kilo`, `crush` —
behind a single uniform `RunSpec → RunResult` contract. Both implementations sit in
this monorepo and ship in lockstep so any consumer (`hone`, `agentelo`, `flt`, etc.)
gets identical behavior whether it calls `harness` (Python) or `@twaldin/harness-ts`.

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
│   ├── _subproc.py              subprocess runner + instructions writer
│   └── adapters/                13 adapter modules, one per CLI
├── ts/                          TypeScript implementation (see ts/CLAUDE.md)
│   ├── package.json             @twaldin/harness-ts (Bun build + test)
│   ├── src/base.ts              mirror of Python base.py types
│   ├── src/registry.ts          mirror of Python registry.py
│   ├── src/model-normalization.ts
│   ├── src/pricing.ts
│   ├── src/subproc.ts
│   ├── src/util.ts
│   └── src/adapters/            13 adapter modules, one per CLI
├── tests/                       pytest suite (Python)
└── ts/tests/                    bun test suite (TypeScript)
```

The two language trees are deliberately near-identical: the same module names,
the same adapter names, the same field names (snake_case in Python,
camelCase in TS). When you read one, you can navigate the other by analogy.

## Dual-language parity contract

Both implementations export the same public surface as defined in
[SPEC.md](SPEC.md):

- Types: `RunSpec`, `BuildCommand`, `RunResult`, `SubprocOutcome`, `HarnessError`.
- Functions: `listAdapters()`, `buildCommand(spec)`, `parseOutput(spec, outcome)`,
  `run(spec)`, `runAsync(spec)` (Python: `run_async`).
- Adapters: thirteen registered names, exact strings — `aider`, `claude-code`,
  `codex`, `continue-cli`, `crush`, `factory-droid`, `gemini`, `kilo`,
  `openclaude`, `opencode`, `pi`, `qwen`, `swe-agent`. Lookup is case-sensitive.

Field naming flips at the boundary (`cost_usd` ↔ `costUsd`, `tokens_in` ↔
`tokensIn`, `timed_out` ↔ `timedOut`) but the JSON shape emitted by
`harness run --json` matches `RunResult` field names directly so external
consumers see one wire format.

Versions stay aligned at the major.minor level:

- `harness` (Python) — `pyproject.toml::project.version`
- `@twaldin/harness-ts` — `ts/package.json::version`

Patch versions MAY diverge for implementation-only fixes (e.g. a Node prebuild
bump that doesn't apply to the Python wheel). Anything that touches SPEC.md or
the fixture set bumps both simultaneously.

## How parity is enforced

Two mechanisms keep the two implementations from drifting:

1. **SPEC.md is the contract.** Every public type, function name, error case,
   and registry entry is listed there. A change to either implementation that
   isn't reflected in SPEC.md (and the other language) is a bug.
2. **Shared golden fixtures.** Each adapter has a fixture at
   `tests/fixtures/<name>.json` containing a sample `RunSpec`, an
   `expectedCommand`, a sample subprocess outcome, and `expectedParsed`
   (cost + tokens). Both `pytest` and `bun test` load the same fixture files
   and assert byte-equal command construction and identical parse results.
   Adding a flag in one language without updating the fixture means the other
   language silently passes — that is the failure mode the fixtures catch, so
   fixtures are the authoritative source for command shape.

Database adapters (`opencode`, `kilo`, `crush`) read sqlite session DBs after
the CLI exits; their fixtures cover both the build phase and a parsed-payload
expectation. See `tests/test_*_db.py` and `ts/tests/adapters/*-sessionlog.test.ts`
for the schema-level coverage.

## Soft parity rule for staged PRs

Strict simultaneous landing is the goal but not a hard requirement. Single-language
PRs are acceptable when the change is large enough that splitting it is the
clearer review unit (for example, the TypeScript port of a feature that already
exists in Python). When a PR lands in only one language:

- Open a tracking note in `SPEC.md` (or a short `SKEW.md` if the gap is large)
  identifying which language is ahead and what the catch-up patch must do.
- The follow-up PR closes the skew and removes the note.
- A skew note that survives more than one minor release is a parity bug — fix
  the lagging language or revert the leading one.

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

## What harness does not ship

Explicit non-goals (kept here so contributors don't propose them as features):

- tmux lifecycle, pane scraping, idle detection — `flt`'s job.
- Permission-dialog auto-approval — `flt`'s job.
- Challenge seeding, grading, ELO scoring — `agentelo`'s job.
- Prompt mutation, GEPA, training loops — `hone`'s job.
- Vertex / OAuth proxy shims — context-specific, lives in the consumer.
- Streaming output callbacks — not in v1; `run()` is blocking subprocess.

`harness` ships only: command construction (`buildCommand`), output parsing
(`parseOutput`), and convenience `run()` / `runAsync()` for headless callers.
