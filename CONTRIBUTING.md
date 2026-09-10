# Contributing to harness

Harness is a small dual-language library for uniform coding-agent integration.
Shipped today: CLI command construction and one-shot execution with streaming
and bounded capture, controlled Pi RPC sessions, optional OMP/Amp/Cline SDK
bridges, native Claude/Factory Droid SDK sessions, caller-owned
OpenCode/OpenHands sessions, and instruction-projection, pricing, pane/dialog,
install-metadata and session-log helpers. Additional backends must satisfy the
shared [SPEC gates](SPEC.md#backend-and-session-implementation-gates) without
adding a fleet manager or an application.

## Before you open a PR

- **Open an issue first** for anything bigger than a typo or a one-line fix.
- Keep the scope tight. One conceptual change per PR.
- Match existing style. Read a few neighboring files before writing.
- Read the upstream sources, declare exact capabilities, add shared fixtures.

## Current scope

What the library owns:

- Per-agent command construction, one-shot execution, output parsing, pricing.
- Pure per-agent knowledge for externally hosted panes: ready/status/dialog
  interpretation, submit keys, paste flattening, scroll ownership, install
  metadata, session-log location and parsing.
- Controlled sessions for the qualified `(harness, backend)` pairs, each owning
  only the transport it created.

What stays with the consumer:

- Host drivers (tmux, PTY, container, ssh, browser) and the capture/poll loop.
- Fleets, worktrees, multi-agent orchestration, gates, message routing.
- Credentials, account selection and billing interpretation.

### Historical live-mode proposals

The local May 13 `harness-live-design.md`, `harness-live-dogfood.md` and
`harness-live-use-cases-audit.md` documents are proposals. They remain useful
history, they are not the current API, and their originals are not edited.
SPEC records what was retained and what was refused in
[the reconciliation section](SPEC.md#reconciliation-of-the-live-session-proposals).
Two consequences when you cite them:

- Their non-goal lines — "tmux lifecycle, pane scraping, idle detection, and
  permission-dialog auto-approval are flt's job; streaming callbacks are future
  work" — no longer describe this repository. Pane/dialog/session-log/install
  helpers ship in both languages as pure functions over already-captured
  content, CLI chunk streaming and the opt-in inactivity watchdog ship under the
  execution contract, and controlled sessions ship through `open_session` /
  `openSession`. Do not re-list any of those as a non-goal. What is still not
  shipped is the host driver, the polling loop and the orchestration around them.
- Their unadopted parts stay unadopted: a second `buildSpawnArgs` / `LiveSpec`
  argv surface, mandatory bypass flags, a mandatory `Session` facade,
  billing-tier inference from headless-versus-live mode, hard-coded cache
  prices, an automatic OAuth-proxy `env()` factory, consumer/fleet migrations,
  staged single-language API PRs, and member-count or source-text parity checks.

Some backends are qualified as unsupported or deferred rather than shipped —
Pi SDK, Codex app-server and Copilot SDK today — and other agents are only
source-qualified candidates. Their evidence, dated versions and follow-up
tickets live in [WANTED-ADAPTERS.md](WANTED-ADAPTERS.md) and
[ADAPTER-MATRIX.md](ADAPTER-MATRIX.md). Reuse the existing ticket instead of
opening a duplicate owner, and never promote a deferred candidate to "supported"
in documentation alone.

## Two implementations in lockstep

`harness` ships both a Python and a TypeScript implementation. They share the
contract in [SPEC.md](SPEC.md) and the fixtures and case files in `tests/`.
Changes to the public API MUST land in both languages in the same PR.

- The exported surface must agree: `src/harness/__init__.py` and
  `src/harness/base.py` against `ts/src/index.ts` and `ts/src/base.ts`. Field
  names differ by convention only (`cost_usd` ↔ `costUsd`); the Python CLI's
  `harness run --json` emits snake_case and omits `raw`, and is not the
  TypeScript `RunResult` shape.
- Capability answers must agree. `get_capabilities` / `getCapabilities` report
  the CLI backend from adapter declarations; `get_session_capabilities` /
  `getSessionCapabilities` report a session pair. Where one language cannot do
  something, both raise the same explicit error rather than one language
  silently accepting it.
- The fixture set is the tiebreak: if a shared fixture passes in one language
  and fails in the other, the fixture is right and the lagging implementation
  catches up.
- Contract or fixture changes bump both manifests (`pyproject.toml` and
  `ts/package.json`) in the same PR per [SPEC versioning](SPEC.md#versioning).
  Documentation-only PRs bump nothing and publish nothing.

## Running the tests

```bash
# Python
PYTHONPATH=src uv run pytest tests/

# TypeScript
cd ts && bun test
```

Install Python development dependencies with `uv sync --extra dev`, and
TypeScript development dependencies (`bun install` from `ts/`) before the Python
suite as well: both languages' Cline cases use its optional pinned `@cline/sdk`
package with a finite synthetic loopback provider.

All tests must pass in both. If you add a fixture, both impls must parse it.

### Offline conformance versus live smoke

Ordinary `pytest` and `bun test` runs use synthetic fixtures, local child
executables and bounded owned loopback HTTP peers, not installed coding-agent
CLIs, provider accounts or external network calls.
Dependency installation may use the network; CI runs Python tests with
`uv run --offline` after installing dependencies. Fixture logs contain only
synthetic prompts, usage and identifiers; keep real credentials and conversations
out of public fixtures.

The `subprocess lifecycle` workflow gates macOS and Linux (GitHub
`macos-latest` / `ubuntu-latest`) with Python 3.10, Bun 1.3.14 and Node 22.
After `bun run build`, run `node tests/node-lifecycle.mjs` and
`node tests/node-sessions.mjs`, `node tests/node-omp-sdk.mjs`,
`node tests/node-claude-sdk.mjs`, `node tests/node-amp-sdk.mjs`,
`node tests/node-cline-sdk.mjs`, `node tests/node-opencode.mjs`,
`node tests/node-openhands.mjs` and `node tests/node-droid-sdk.mjs` from `ts/`
to check packaged subprocess, RPC, SDK and HTTP/SSE/WebSocket behavior under
Node as well as source under Bun. OMP uses the real Bun worker with a synthetic
SDK; Amp uses the real Node worker with a synthetic SDK and finite CLI fixture.
Claude and Factory use pinned real SDK development dependencies with finite
synthetic CLIs, never bundled CLIs or providers. Install Python development
dependencies with `uv sync --extra dev` before these cases.
No Windows lifecycle support is claimed.
Cline uses the pinned real SDK in a Node >=22.14 worker for Python, Bun and
packaged Node. `tests/cline_sdk_cases.json` shares expected outcomes; its
provider peer is finite and synthetic. Test-only event/failure injection is
separate from private unmodified native-runtime and authenticated-provider
qualification.
The remote cases share `tests/opencode_cases.json` and `tests/openhands_cases.json`
with isolated synthetic peers, finite lifetimes and handle-owned cleanup.
They are not native OpenCode/OpenHands or authenticated-provider qualification;
keep those evidence categories separate.

Type-check source and tests from `ts/` with
`bun x tsc --noEmit --rootDir . --allowJs`; the build checks source declarations.

Real-provider checks are separate, explicit operator actions:

- Python: `PYTHONPATH=src uv run python scripts/smoke_gpt54.py --harness <name>`.
- TypeScript: from `ts/`, `bun tests/e2e-claude.ts --live`.

These require an installed provider CLI and caller-selected local authentication,
may incur cost, and retain upstream permission defaults. Never run them in
ordinary CI. Record provider/runtime versions and the exercised behavior
separately; passing synthetic conformance does not qualify upstream flags,
authentication or model availability.

### Evidence categories

Keep these four apart in PR bodies, fixtures, README and matrix text. Merging
them is the most common reason a contribution gets sent back.

| category | what it proves | what it never proves |
|---|---|---|
| Source | upstream flags, protocol and defaults at a named version/commit | that the installed build behaves that way |
| Fixture / synthetic | argv, parsing, capability rejection, lifecycle and protocol handling against synthetic children, loopback peers and injected events — including cases that drive a pinned real SDK against a synthetic peer | end-to-end behavior of an unmodified native runtime against a real provider |
| Native runtime | that an unmodified SDK/CLI/server at exact pins on a named platform accepted the traffic, and which permissions, options and lifecycle were exercised there | that a provider account, model or credential is available or that other versions/platforms behave the same |
| Provider | a dated authenticated call, with model, auth prerequisites and cost | anything about other versions, platforms or accounts |

Record dates, exact versions and platforms; state unavailable cases instead of
implying coverage. Local spot checks that help but are not evidence on their own:
`bun ts/scripts/session-telemetry.ts <adapter> sessionLogPath|parseSessionLog <arg>`
for cross-language session-log agreement, and `scripts/check_binaries.sh` to
record which agent binaries and versions an operator machine actually has
(its list is an operator convenience, not the adapter registry).

## Style

- Python: type hints on public functions, no `Any` in adapter surfaces, `from __future__ import annotations` at the top.
- TypeScript: strict mode, no `as any` / `as unknown as` casts.
- Match surrounding code. If in doubt, look at the adapter you're editing.

## PR etiquette

- Title: imperative, lowercase.
- Body: what changed, why, how you tested, and which evidence category each
  claim belongs to.
- Reference the issue if there is one.

## Adding a new adapter

An adapter is a CLI one-shot backend: it plans a command and parses that
command's output. It lands in both languages, with one shared fixture.

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

### 3. Declare capabilities, permissions and configuration

Capability records are derived from adapter declarations, so a wrong
declaration is a wrong public answer. Declare each of these only when upstream
really supports it, with the same value in both languages:

| Python | TypeScript | meaning |
|---|---|---|
| `permission_bypass_args` | `permissionBypassArgs` | argv appended only for `permission_policy="bypass"`; `None`/absent makes explicit bypass an `unsupported-capability` rejection |
| `native_options_kind` | `nativeOptionsKind` | which typed `NativeOptions` kind this adapter accepts |
| `config_home_env` | `configHomeEnv` | env variable `config_home` maps to; absent rejects the override |
| `config_file_flag` | `configFileFlag` | flag `config_file` maps to; absent rejects the override |
| `graceful_signal` | `gracefulSignal` | `SIGINT` only when the CLI shuts down cleanly on it but not on SIGTERM; omitted stays SIGTERM |
| `install_meta` | `installMeta` | install/update/version argv and supported platforms |
| `submit_keys`, `flatten_on_paste`, `scroll_ownership` | `submitKeys`, `flattenOnPaste`, `scrollOwnership` | pane-hosting knowledge for consumers that drive a TUI |

An omitted permission policy preserves upstream behavior; never inject a bypass
flag by default. Reject unsupported options rather than discarding them, and
never model an unsupported capability as a no-op. Config overrides select
existing caller-owned upstream state — they are not sandboxes and not credential
isolation; say so in the matrix row when the upstream home also holds
authentication. Configuration files are passed by path, never read or copied.
The declared `graceful_signal` travels on the resulting `BuildCommand` for
external drivers through the shared lifecycle engine; do not add a per-adapter
process supervisor.

### 4. Add a fixture

Create `tests/fixtures/<name>.json` following the [shared fixture contract](SPEC.md#json-fixture-driven-verification).
Both loaders discover fixtures and require names to match the registry. Supply
exact command, capability and parser expectations; declare synthetic artifacts
and missing-artifact expectations for database/trajectory parsers. Named `cases`
carry edge inputs and expected results or rejection codes. The loaders run the
same assertions in both languages, including real substitute-executable runs.
Extend `tests/subprocess_cases.json` for a new engine scenario instead of
maintaining independent expected outcomes in each language.

### 5. Document it

Add a row to [ADAPTER-MATRIX.md](ADAPTER-MATRIX.md) covering: CLI binary name,
instructions file, default model, command flags, permission/config support,
token/cost source, output shape, and the dated source or runtime evidence behind
those claims. If the adapter changes what README lists as shipped, update
[README.md](README.md) and [ts/README.md](ts/README.md) in the same PR.

### Quick checklist

- [ ] `src/harness/adapters/<name>.py` + registered in `__init__.py`
- [ ] `ts/src/adapters/<name>.ts` + imported in `adapters/index.ts`
- [ ] Capability, permission and config declarations identical in both languages
- [ ] `tests/fixtures/<name>.json`
- [ ] Row in `ADAPTER-MATRIX.md`, with evidence category and dates
- [ ] `PYTHONPATH=src uv run pytest tests/` passes
- [ ] `cd ts && bun test` passes

## Adding a session backend

A session backend is a controlled `(harness, backend)` pair behind
`open_session` / `openSession`. It reuses the shared spec validation, event
queue, turn core and teardown; it does not introduce a parallel session API.
Read the [SPEC gates](SPEC.md#backend-and-session-implementation-gates) first —
they are acceptance criteria, not advice.

1. **Register the pair.** Add it to `_SESSION_BACKENDS` in
   `src/harness/sessions.py` and `SESSION_BACKENDS` in `ts/src/sessions.ts`;
   the two maps must agree. Backend selection is explicit and stable for the
   session: a missing SDK, runtime or server is a prerequisite error, never a
   fallback to CLI or to another backend. A session-only harness with no CLI
   adapter (like `openhands`) stays out of the adapter registry, and
   `get_adapter` / `getAdapter` keeps raising `unknown-harness` for it.
2. **Declare capabilities honestly.** `get_session_capabilities` /
   `getSessionCapabilities` are pure: no install, credential or server probing.
   `approval` means the generic `respond_approval` / `respondApproval` channel
   exists; a backend whose native approvals arrive as callbacks declares them in
   its own options type instead. Concurrent turns are either supported with
   correlation or rejected — never mixed. Anything unimplemented rejects with
   `unsupported-backend` / `unsupported-capability` in both languages.
3. **Make the caller's selection explicit.** Add one frozen options dataclass in
   Python and its mirror interface in TypeScript (see `OpenCodeOptions`,
   `ClaudeSdkOptions`, `OpenHandsOptions`): absolute paths, explicit endpoint,
   explicit auth, explicit native policy. No endpoint, account, package or
   profile is discovered from the environment, and a caller-owned server is
   never started, reconfigured or disposed. A backend may spawn the children it
   owns — a bridge worker, an SDK's own CLI process — because those are its own
   resources, not the caller's server. Validation is side-effect-free: no
   network call, no spawned process, no writes, no directory creation. It may
   read caller-named existing files where identity demands it (resume verifies
   the native session header/transcript before anything is launched). Recognized
   options this backend cannot honor reject by name with the reason, so no
   native choice is silently discarded or downgraded.
4. **Record the qualified versions, and enforce what you can.** Keep the exact
   distribution, CLI and server versions as module constants (`SUPPORTED_*` in
   `src/harness/sessions.py`, the worker's own `SDK_VERSION` / `CLI_VERSION`)
   and document them in the matrix and READMEs. Enforcement differs per backend
   and must be described as it is, not generalized: the Claude and Amp workers
   probe the selected CLI's `--version` and the loaded SDK version before a
   session opens, the OpenCode and OpenHands clients check the server's
   version endpoint, while `pi`'s distribution pin and Factory's
   `QUALIFIED_DROID_CLI_VERSION` are qualification records with no per-open CLI
   probe (Factory validates the handshake envelope and the SDK's result schema
   instead). Whatever you do enforce fails closed as a prerequisite error before
   a session exists — never a fallback to another backend. Where the two
   languages are qualified against different upstream pairs, state both rather
   than averaging them.
5. **Isolate the optional dependency.** Import the transport lazily inside the
   open path (`from harness._opencode import open_opencode_session`,
   `await import('./opencode.js')`). Python SDKs go behind extras in
   `pyproject.toml`. On the TypeScript side pick the honest shape: an optional
   peer when this process imports the package (`@factory/droid-sdk`, `ws`), or
   no dependency at all when the caller installs it themselves and selects it by
   absolute `packageRoot` for an owned worker to load (OMP, Amp, Cline and
   Claude work this way; the workers are `_omp_sdk.mjs`, `_amp_sdk.mjs`,
   `_cline_sdk.mjs`, `claude-sdk-worker.mjs`). Prefer the worker shape for a
   foreign runtime instead of importing it into the host process. Ordinary CLI
   imports and capability queries must not load an SDK. A Python bridge is named
   and qualified as a bridge, not presented as a native Python SDK.
6. **Reuse the shared lifecycle.** Owned children go through `_OwnedChild`
   (Python) / `OwnedChild` (`ts/src/owned-process.ts`): own process group,
   graceful signal → grace → SIGKILL → bounded drain and reap, with the workdir
   lease and any projected instructions held until the tree is gone. Events go
   through the bounded single-consumer queue (`_SessionEvents` / `EventQueue`)
   preserving upstream order and turn correlation, with unknown payloads still
   reachable through `raw`. Exactly one terminal `SessionTurnResult` per accepted
   turn, with protocol failure, disconnect, cancellation, timeout, signal exit
   and agent error distinguishable. A handle owns only what it created:
   attaching to a caller-owned server never authorizes killing it, and closing
   never deletes persisted upstream history. Resume requires an explicit native
   ID verified against the recorded workdir/endpoint; "latest" is not resume.
7. **Prove it in both languages from one case file.** Add
   `tests/<name>_cases.json` (see `tests/session_cases.json`,
   `tests/opencode_cases.json`, `tests/cline_sdk_cases.json`) holding the shared
   prompts, event types and expected statuses; drive it from
   `tests/test_<name>*.py` and `ts/tests/<name>-sessions.test.ts` (or
   `<name>-sdk.test.ts`), and add `ts/tests/node-<name>.mjs` — sharing a
   `<name>-conformance.mjs` module with the Bun test where the peer is
   synthetic — so the built package is exercised under Node as well as source
   under Bun. Wire the packaged runner into `.github/workflows/lifecycle.yml`.
   Cover native identity, follow-up and resume, interrupt, dispose, protocol
   errors, partial output and unsupported operations. Peers and fixtures stay
   finite, synthetic and handle-cleaned; no private prompts or credentials.
8. **Document it.** Add the backend's setup, options, pinned versions and limits
   to [README.md](README.md) and [ts/README.md](ts/README.md), and its dated
   qualification record to [ADAPTER-MATRIX.md](ADAPTER-MATRIX.md). An unsupported
   outcome is documented as unsupported, with the deferred ticket preserved.

### Quick checklist

- [ ] Pair registered in both session maps; capabilities agree
- [ ] Explicit options type in both languages; side-effect-free validation; unsupported options rejected by name
- [ ] Qualification pins recorded, and whatever this backend actually enforces fails closed before a session exists
- [ ] Optional dependency lazy: Python extra, optional TS peer, or caller-installed `packageRoot` loaded by an owned worker
- [ ] Shared owned-child teardown, bounded event queue, single terminal result
- [ ] Shared `tests/<name>_cases.json` driven from Python, Bun and packaged Node
- [ ] New packaged runner added to `.github/workflows/lifecycle.yml`
- [ ] README, ts/README and matrix updated with dated evidence

## Distribution qualification

Source-tree tests do not prove the artifact a consumer installs. Packaging can
drop a worker script, a type declaration or an optional peer without failing a
single test. For any change to the public API, a session backend, a worker file
or a manifest, exercise the change from an isolated consumer.

From the checkout, build local artifacts:

```bash
uv build
cd ts
bun install --frozen-lockfile
npm --prefix "$PWD" pack --pack-destination "$PWD"
```

Then install the resulting wheel and `.tgz` by absolute path into a throwaway
consumer directory: a fresh `python3 -m venv`, and a `package.json` containing
`{"private":true,"type":"module"}` created before installing. Confirm the prefix
before installing and confirm the installed imports resolve inside the consumer,
not back into the checkout:

```bash
npm --prefix /absolute/path/to/consumer prefix          # must print the consumer dir
npm --prefix /absolute/path/to/consumer install /absolute/path/to/ts/twaldin-harness-ts-<version>.tgz
/absolute/path/to/consumer/.venv/bin/python -m pip install /absolute/path/to/dist/harness_cli-<version>-py3-none-any.whl
/absolute/path/to/consumer/.venv/bin/python -c "import harness; print(harness.__file__)"
cd /absolute/path/to/consumer && node --input-type=module \
  -e "console.log(await import.meta.resolve('@twaldin/harness-ts'))"
```

Run the changed path there, importing only from the package root (`import
harness`, `@twaldin/harness-ts`); the printed paths must sit under the consumer
directory. See [example commands](examples/README.md). A managed worktree with
private instruction symlinks must first be exported with `git archive <commit>`
to a disposable source directory; build there without removing those links. No
package publication is required, and a qualification PR does not publish or tag
one.

Check specifically that:

- a new worker script is both copied by the `ts` `build` script and included in
  `package.json::files`, and resolvable beside the bundle at runtime;
- a new optional dependency is a Python extra, an optional TypeScript peer, or a
  caller-installed package selected by absolute `packageRoot` — never a hard
  requirement, so a default install still imports and answers capability queries
  without it;
- the built TypeScript declarations expose the new types
  (`cd ts && bun run build` runs `tsc -p tsconfig.build.json`);
- packaged Node runs pass: `cd ts && bun run build && node tests/node-<name>.mjs`.

## What I'm likely to merge

- New adapters for AI coding CLIs (mirror an existing adapter's shape in both languages; add a fixture).
- Paired session backends that satisfy the [SPEC gates](SPEC.md#backend-and-session-implementation-gates) with shared case files in both languages.
- Bug fixes with a fixture that demonstrates the bug.
- SPEC clarifications where the contract is ambiguous.
- Qualification records that honestly document an unsupported or deferred outcome.

## What I'll probably close

- Changes to one impl without the other.
- New adapters that don't ship a fixture, or session backends without packaged-Node coverage.
- Automatic CLI/SDK fallback, implicit permission bypass, or unsupported capabilities disguised as no-ops.
- Backends that kill or reconfigure caller-owned servers, delete upstream history, or resume by "latest".
- Optional SDK loading reachable from ordinary CLI imports or capability queries.
- Fleet/worktree/host-driver ownership or raw model API wrappers presented as agent backends.
- Evidence claims that mix fixture success with native-runtime or provider qualification.

Streaming, controlled sessions and optional agent SDK integrations are eligible
when they implement the SPEC gates in both languages. This supersedes the
historical blanket SDK exclusion. Pi RPC, OMP/Amp/Cline SDK bridges, native
Claude/Factory Droid SDK sessions and caller-owned OpenCode/OpenHands sessions
are implemented; other protocols and SDKs need qualification first.
