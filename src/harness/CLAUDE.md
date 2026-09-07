# `harness` (Python)

Python implementation of the harness contract. Cross-language contract:
[`../../SPEC.md`](../../SPEC.md). Parity model: [`../../CLAUDE.md`](../../CLAUDE.md).

## Build and run

`pyproject.toml` builds a wheel via `hatchling` from `src/harness`. The PyPI name
is `harness-cli` (the unprefixed `harness` was squatted) but the import is always
`from harness import ...`. The Typer CLI entrypoint is `harness.cli:app`, exposed
as `harness` on PATH after install.

```bash
pip install -e ".[dev]"                 # run from the repository root
PYTHONPATH=src uv run pytest tests/      # full suite
harness list                             # smoke check the registry
```

`asyncio_mode = "auto"` is set in `pyproject.toml`, so `async def` test
functions are picked up without decorators (used by `tests/test_run_async.py`).

## Adapter pattern

Each adapter is a class in `src/harness/adapters/<name>.py` extending
`harness.base.Adapter`:

```python
class MyCLIAdapter(Adapter):
    name = "mycli"
    instructions_filename = "AGENTS.md"   # inline instructions require adapter-specific handling
    DEFAULT_MODEL = "mycli/default"

    def build_command(self, spec: RunSpec) -> BuildCommand: ...
    def parse_output(self, spec: RunSpec, outcome: SubprocOutcome) -> dict: ...
```

Wire it in by adding an `import` and a `register("name", AdapterCls)` call to
`src/harness/adapters/__init__.py`. `build_command` MAY write instructions/config
files but MUST NOT spawn a subprocess. `parse_output` MAY read post-exit
artifacts but MUST NOT block on long I/O (sqlite reads use `timeout=5.0`).

## Output parsing strategies

Adapters use several output shapes; check the adapter and [matrix](../../ADAPTER-MATRIX.md) for exact fields:

- **JSON envelope on stdout** — `claude-code`, `openclaude`, `continue-cli`,
  `factory-droid`; their usage and cost field names differ.
- **JSONL event stream** — `pi`, `codex`; their event names and accumulation
  rules differ, so mirror the existing parser rather than summing every
  usage-bearing event.
- **JSON array** — `qwen`; read the last `type: "result"` item's usage, with a
  legacy stats-envelope fallback.
- **Stats blob** — `gemini`. Look up `stats.models.<model>.tokens.{input, candidates}`.
- **Log scrape** — `aider`. Regex `r"Tokens:\s+([\d,.]+k?)\s+sent,\s+([\d,.]+k?)\s+received"`.
- **Trajectory file** — `swe-agent`. Parse `info.model_stats.instance_cost`
  from the wrapper's JSON trajectory.
- **sqlite session DB** — `opencode`, `kilo`, `crush` (see below).

`gemini` derives headless cost from token totals and known model pricing.
Selected session-log parsers also use `harness.pricing.derive_cost`.
This is not a universal fallback: headless codex, aider and qwen parsing
still returns `None` for cost.

## Database adapters (kilo / crush / opencode)

Three adapters read sqlite session DBs after the CLI exits — substantially
different from the stdout-parsers:

- **`opencode`** — DB at `~/.local/share/opencode/opencode.db` (or `OPENCODE_DB`).
  Match the latest session whose directory contains the resolved workdir basename.
- **`kilo` / `crush`** — Force a deterministic per-workdir DB path under
  `<workdir>/.harness/...` via env vars (`KILO_DB`) or `--data-dir`. Keeps
  benchmark containers isolated from shared user state.

All three open the DB read-only (`mode=ro` URI, 5s timeout) and tolerate
`sqlite3.Error` by returning `None`. Python schema tests live in
`tests/test_*_db.py`. TypeScript selects `bun:sqlite` under Bun and
`better-sqlite3` under Node. Its session-log tests create temporary databases
for crush and kilo, but do not cover opencode in that directory.

`crush` pins `--model` and `--small-model` to the same value; `kilo` sets
`model` and `small_model` in `KILO_CONFIG_CONTENT`. Both avoid helper-model drift.

## Session telemetry and fixture parity

Several adapters expose `session_log_path` and `parse_session_log` methods
returning a `SessionTelemetry` payload (`base.py`), separate from headless
`parse_output`. Selected cross-runtime cases are checked in
`tests/adapters/test_session_parity.py`.

`tests/test_fixtures.py` explicitly loads named fixtures and uses
adapter-specific assertions; it does not discover new JSON files. Add tests
for each new adapter in both languages. See
[the shared fixture coverage notes](../../CLAUDE.md#how-parity-is-enforced).

## What to keep in lockstep with TypeScript

Mirror these in `ts/src/` in the same PR:

- A new adapter, or a removed one.
- A new field on `RunSpec` / `RunResult` / `BuildCommand` / `SessionTelemetry`.
- A `build_command` argv change that affects the fixture.
- Changes to `model_normalization.py` or `pricing.py` logic.

Local-only (no TS counterpart needed): Typer-CLI ergonomics (`cli.py`), pytest
fixtures, hatchling config, internal `_subproc.py` helpers that don't change
the public type shape.
