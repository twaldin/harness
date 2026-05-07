# `harness` (Python)

Python implementation of the harness contract. Cross-language contract:
[`../../SPEC.md`](../../SPEC.md). Parity model: [`../../CLAUDE.md`](../../CLAUDE.md).

## Build and run

`pyproject.toml` builds a wheel via `hatchling` from `src/harness`. The PyPI name
is `harness-cli` (the unprefixed `harness` was squatted) but the import is always
`from harness import ...`. The Typer CLI entrypoint is `harness.cli:app`, exposed
as `harness` on PATH after install.

```bash
pip install -e ".[dev]"                  # editable + pytest deps
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
    instructions_filename = "AGENTS.md"   # or "" to fold into prompt
    DEFAULT_MODEL = "mycli/default"

    def build_command(self, spec: RunSpec) -> BuildCommand: ...
    def parse_output(self, spec: RunSpec, outcome: SubprocOutcome) -> dict: ...
```

Wire it in by adding an `import` and a `register("name", AdapterCls)` call to
`src/harness/adapters/__init__.py`. `build_command` MAY write instructions/config
files but MUST NOT spawn a subprocess. `parse_output` MAY read post-exit
artifacts but MUST NOT block on long I/O (sqlite reads use `timeout=5.0`).

## Output parsing strategies

The thirteen CLIs expose totals in five different shapes; each adapter picks one:

- **JSON envelope on stdout** — `claude-code`, `continue-cli`. Parse the final
  line as a JSON object; read `usage.input_tokens`, `usage.output_tokens`,
  `total_cost_usd`.
- **JSONL event stream** — `pi`, `qwen`, `codex`. Sum `usage` across
  `assistant` / `turn_end` events.
- **Stats blob** — `gemini`. Look up `stats.models.<model>.tokens.{input, candidates}`.
- **Log scrape** — `aider`. Regex `r"Tokens:\s+([\d,.]+k?)\s+sent,\s+([\d,.]+k?)\s+received"`.
- **Trajectory file** — `swe-agent`. Parse `info.model_stats.instance_cost`
  from the wrapper's JSON trajectory.
- **sqlite session DB** — `opencode`, `kilo`, `crush` (see below).

When tokens are available but cost is not, fall through to
`harness.pricing.derive_cost(model, tokens_in, tokens_out)` so consumers get a
best-effort number rather than `null`.

## Database adapters (kilo / crush / opencode)

Three adapters read sqlite session DBs after the CLI exits — substantially
different from the stdout-parsers:

- **`opencode`** — DB at `~/.local/share/opencode/opencode.db` (or `OPENCODE_DB`).
  Query by `session.directory == workdir` to find the session this run created.
- **`kilo` / `crush`** — Force a deterministic per-workdir DB path under
  `<workdir>/.harness/...` via env vars (`KILO_DB`) or `--data-dir`. Keeps
  benchmark containers isolated from shared user state.

All three open the DB read-only (`mode=ro` URI, 5s timeout) and tolerate
`sqlite3.Error` by returning `None`. TS counterparts use `better-sqlite3` with
the same logic; parity tests live in `tests/test_*_db.py` and
`ts/tests/adapters/*-sessionlog.test.ts`.

`kilo` and `crush` also enforce `model == small_model` (pin both flags to the
same value) to prevent helper-model drift skewing benchmark numbers.

## Session telemetry and fixture parity

Several adapters return a `SessionTelemetry` payload (`base.py`) alongside the
standard parsed dict; parity is checked in `tests/adapters/test_session_parity.py`.
`tests/test_fixtures.py` walks `../../tests/fixtures/*.json` and runs every
adapter's `build_command` and `parse_output` against JSON-encoded expectations.
A change to argv, env, or instructions filename in either language MUST be
reflected in the fixture, otherwise the other language silently passes.

## What to keep in lockstep with TypeScript

Mirror these in `ts/src/` (same PR, or a tracked-skew follow-up):

- A new adapter, or a removed one.
- A new field on `RunSpec` / `RunResult` / `BuildCommand` / `SessionTelemetry`.
- A `build_command` argv change that affects the fixture.
- Changes to `model_normalization.py` or `pricing.py` logic.

Local-only (no TS counterpart needed): Typer-CLI ergonomics (`cli.py`), pytest
fixtures, hatchling config, internal `_subproc.py` helpers that don't change
the public type shape.
