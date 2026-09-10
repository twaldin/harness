# Examples

Real consumers of `harness`. Each subdirectory documents how a project either uses harness today or plans to integrate.

| project   | relationship                              | status       |
| --------- | ----------------------------------------- | ------------ |
| hone      | mutator backend via `HarnessMutator`      | shipped      |
| agentelo  | will replace ~800 LOC of TS spawn logic   | planned      |
| flt       | one-shot consultations only (different exec model) | informal sister |

See each subdir's README for code snippets.

Standalone samples:

- [`hello-world.py`](hello-world.py) / [`../ts/examples/hello-world.ts`](../ts/examples/hello-world.ts) — smallest possible `run()` call against a real CLI.
- [`api-guide.py`](api-guide.py) / [`../ts/examples/api-guide.ts`](../ts/examples/api-guide.ts) — the dual-language API guide described below.

## API guide (both languages, same five modes)

`api-guide.py` and `api-guide.ts` are the same program in Python and TypeScript.
They import only from the package root (`from harness import ...`,
`from '@twaldin/harness-ts'`), take the mode as the first argument, and take
every environment-specific value (`--executable`, `--workdir`, `--model`,
`--config-home`) from the caller, so every mode can run against a synthetic CLI
with no provider, credentials or network access.

| mode | what it exercises | needs |
| ---- | ----------------- | ----- |
| `one-shot` | `run(RunSpec)` / `await run(spec)`: build, execute, parse; full result reporting (`termination`, `signal`, timeout kind, truncation flags, `launch_error` / `callback_error` / `parse_error`) | any executable |
| `config` | `build_command` / `buildCommand` with explicit executable, model, `CODEX_HOME`, native read-only sandbox and upstream permissions, plus capability inspection | no installed agent; the builder writes nothing (the example creates a temporary workdir if omitted) |
| `cancel` | `threading.Event` / `AbortSignal` requests cancellation while a run is pending | a slow executable; the offline peer below demonstrates in-flight cancellation |
| `stream` | `on_output` / `onOutput` chunk callbacks with the stdout/stderr distinction preserved, plus the optional inactivity watchdog | an executable that writes to both streams |
| `session` | `open_session` / `openSession` for `pi` on backend `rpc`: capabilities, native identity, one turn plus an optional follow-up, event consumption, turn status/error/stderr, guaranteed close | a Pi RPC peer (real or synthetic) |

Shared flags (environment fallbacks are shown where supported):
`--harness` (`HARNESS_EXAMPLE_HARNESS`, default `codex`; `session` always uses
`pi`), `--model` (`HARNESS_EXAMPLE_MODEL`), `--executable`
(`HARNESS_EXAMPLE_EXECUTABLE`), `--workdir` (`HARNESS_EXAMPLE_WORKDIR`, default
a fresh temporary directory that is removed on exit), `--config-home`
(`HARNESS_EXAMPLE_CONFIG_HOME`), `--prompt`, `--follow-up`, `--timeout`
(default 120s), `--request-timeout` (default 30s), `--inactivity`,
`--cancel-after` (default 1s). Timeouts are finite by default in every mode.

### Run them as an installed consumer

These examples target the landed source, not necessarily the published release.
First [build artifacts from a selected commit](../CONTRIBUTING.md#distribution-qualification).
Use Python 3.10+, Node 22 and Bun 1.3.14 on macOS/Linux. Then copy the examples
from that same source export into a disposable consumer:

```bash
SOURCE=/absolute/path/to/export
CONSUMER="$(mktemp -d)"
printf '{"private":true,"type":"module"}\n' > "$CONSUMER/package.json"
cp "$SOURCE/examples/api-guide.py" "$SOURCE/ts/examples/api-guide.ts" "$CONSUMER/"
python3 -m venv "$CONSUMER/.venv"
"$CONSUMER/.venv/bin/python" -m pip install "$SOURCE/dist/"*.whl

# Never install into an empty directory without its own package.json.
test "$(npm --prefix "$CONSUMER" prefix)" = "$CONSUMER"
npm --prefix "$CONSUMER" install "$SOURCE/ts/"*.tgz
cd "$CONSUMER"
.venv/bin/python -c 'import harness, pathlib, sys; p = pathlib.Path(harness.__file__).resolve(); assert p.is_relative_to(pathlib.Path(sys.prefix)); print(p)'
node --input-type=module -e "import {pathToFileURL} from 'node:url'; const p = import.meta.resolve('@twaldin/harness-ts'); if (!p.startsWith(pathToFileURL(process.cwd() + '/node_modules/').href)) throw Error(p); console.log(p)"
```

Run corresponding modes from that consumer, replacing executable paths with
your chosen real CLI or the finite synthetic peers below:

```bash
.venv/bin/python api-guide.py config --model synthetic-model
.venv/bin/python api-guide.py one-shot --executable /abs/path/to/chatty-cli --timeout 30
.venv/bin/python api-guide.py cancel --executable /abs/path/to/slow-cli --cancel-after 1 --timeout 30
.venv/bin/python api-guide.py stream --executable /abs/path/to/chatty-cli --timeout 30
.venv/bin/python api-guide.py session --executable /abs/path/to/pi-rpc-peer --follow-up "and again" --timeout 30

bun api-guide.ts config --model synthetic-model
bun api-guide.ts one-shot --executable /abs/path/to/chatty-cli --timeout 30
bun api-guide.ts cancel --executable /abs/path/to/slow-cli --cancel-after 1 --timeout 30
bun api-guide.ts stream --executable /abs/path/to/chatty-cli --timeout 30
bun api-guide.ts session --executable /abs/path/to/pi-rpc-peer --follow-up "and again" --timeout 30
```

Node 22.23.2 can also run the TypeScript file directly with
`node --experimental-strip-types api-guide.ts <mode> ...`. No TS loader is
installed by the example. For an already published release, replace the local
artifact arguments with `harness-cli` and `@twaldin/harness-ts` only after
checking that release's API; retain the isolated environment and absolute prefix.

The examples print returned process/session outcomes, including failures;
they do not convert every failed result into a nonzero example exit status.
`HarnessError` is caught and reported with its stable code. Applications should
set their own success policy after inspecting the result and native output.

### Synthetic executables for offline runs

The run modes only need a program that behaves like a CLI; harness passes the
adapter's argv, and a synthetic peer may ignore all of it. These two scripts
(no downloads, no installs) cover `one-shot`, `cancel` and `stream`:

```bash
PEERS="$(mktemp -d)"
cat > "$PEERS/slow-cli" <<'EOF'
#!/bin/sh
i=0
while [ $i -lt 40 ]; do echo "stdout chunk $i"; echo "stderr note $i" >&2; sleep 0.25; i=$((i+1)); done
EOF
cat > "$PEERS/chatty-cli" <<'EOF'
#!/bin/sh
i=0
while [ $i -lt 4 ]; do echo "working on step $i"; echo "diagnostic $i" >&2; sleep 0.15; i=$((i+1)); done
echo '{"type":"turn.completed","usage":{"input_tokens":11,"output_tokens":7}}'
EOF
chmod +x "$PEERS/slow-cli" "$PEERS/chatty-cli"
# Use the printed directory to replace /abs/path above.
printf '%s\n' "$PEERS"
```

`chatty-cli`'s last line is a `codex` JSONL `turn.completed` event, so the
`codex` parser reports `tokens=11/7` instead of unknown metrics. Do not reuse
that output as a fixture for an unrelated adapter; parsers have different
contracts and may also read native artifacts.

`session` needs a peer that speaks the Pi RPC protocol on stdio: read one JSON
object per line from stdin, answer a `get_state` request with
`{"id": <request id>, "type": "response", "command": "get_state", "success": true, "data": {"sessionId": <id>, "sessionFile": <absolute path>, "isStreaming": false, "isCompacting": false}}`,
and for each `prompt` request emit the same response envelope followed by the
native turn frames ending in `{"type": "agent_settled"}`. The session file must
exist with a matching `{"type": "session", "id": ..., "cwd": ...}` header line.
This repository's own synthetic peer,
[`../tests/helpers/rpc_agent.py`](../tests/helpers/rpc_agent.py), implements
exactly that; its `HARNESS_RPC_CASE` env variable selects failure scenarios.
Use its absolute path as `/abs/path/to/pi-rpc-peer`. This exercises the Harness
protocol client, not a real Pi installation or provider. Remove the disposable
consumer and peer directories after the calls have returned and cleanup has
completed; keep a supplied workdir/session file if you intend to resume.

### Safety notes

- Neither example installs dependencies. A **real selected upstream agent can
  read/write its home, config, history and authentication state**; a temporary
  workdir and no-edit prompt do not isolate that state or sandbox its tools.
- `--config-home` applies to `config` mode only: it plans `CODEX_HOME` without
  creating, reading or copying it. The builder executes no CLI. Omitted workdir
  still causes the example program to create and later remove a temporary one.
- Permissions stay `upstream`, not implicitly safe or deny-all. The read-only
  Codex sandbox is shown in the **build-only `config` mode**, not imposed on
  other modes. Combining that sandbox with bypass is rejected.
- Default workdir is a fresh temporary directory, removed on exit. Session mode
  closes the owned process group (SIGTERM, then SIGKILL) through
  `async with` / `try`-`finally` even when a turn fails.
- Streaming chunks are decoded text, not bytes, lines or JSONL records. UTF-8
  boundaries are handled by Harness; consumers still buffer complete records.
  Order is preserved per stream; stdout/stderr interleaving is unspecified.
  Capture limits do not cap callbacks, but cancellation/timeout can interrupt
  delivery; inspect `callback_error` / `callbackError`.

### Live sessions other than Pi RPC

`open_session` / `openSession` is one surface, but each backend needs the
caller to supply its own SDK, CLI or already-running server. Rather than
guessing at those installs, read the landed section for the pair you need:

| harness / backend | caller must supply | docs |
| ----------------- | ------------------ | ---- |
| `pi` / `rpc` | the qualified Pi coding-agent executable (owned `pi --mode rpc` child) | [README](../README.md#controlled-pi-rpc-sessions) · [SPEC](../SPEC.md#controlled-rpc-sessions) |
| `omp` / `sdk` | Bun plus the caller-installed OMP SDK package root and agent directory | [README](../README.md#optional-oh-my-pi-sdk-sessions) · [SPEC](../SPEC.md#optional-omp-sdk-sessions) |
| `claude-code` / `sdk` | the pinned Claude Agent SDK package root and a pinned Claude Code executable | [README](../README.md#optional-claude-agent-sdk-sessions) · [SPEC](../SPEC.md#optional-claude-agent-sdk-sessions) |
| `amp` / `sdk` | Node plus the Amp SDK package root and the native `amp` CLI | [README](../README.md#optional-amp-sdk-sessions) · [SPEC](../SPEC.md#optional-amp-sdk-sessions) |
| `cline` / `sdk` | Node plus the Cline SDK package root and a Cline root directory | [README](../README.md#optional-cline-sdk-sessions) · [SPEC](../SPEC.md#optional-cline-sdk-sessions) |
| `factory-droid` / `sdk` | the Droid SDK, the `droid` CLI and a `FACTORY_API_KEY` | [README](../README.md#optional-factory-droid-sdk-sessions) · [SPEC](../SPEC.md#optional-factory-droid-sdk-sessions) |
| `opencode` / `rpc` | an `opencode serve` instance the caller runs and owns | [README](../README.md#caller-owned-opencode-http-sessions) · [SPEC](../SPEC.md#caller-owned-opencode-http-sessions) |
| `openhands` / `rpc` | an OpenHands Agent Server the caller runs and owns, plus its session key | [README](../README.md#caller-owned-openhands-agent-server-sessions) · [SPEC](../SPEC.md#caller-owned-openhands-agent-server-sessions) |

Exact qualified versions, platforms and rejection rules live in those sections
and in [ADAPTER-MATRIX.md](../ADAPTER-MATRIX.md); this directory does not
restate them.
