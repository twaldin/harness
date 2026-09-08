# Wanted adapters

An evidence-backed catalog of upstream coding agents and their CLI, SDK and
protocol integration paths. CLI discovery was checked **2026-09-07**; the
[SDK/protocol qualification](#sdk-and-protocol-backends) was refreshed
**2026-09-08**. Source qualification is not installed-runtime or authenticated
provider success; each section states its evidence boundary.

## Qualification policy

- Prefer maintained agents with a documented noninteractive executable. Record
  the upstream project, distribution, binary, headless path, auth/permissions,
  output limitations and validation scope. A name or SDK alone is not enough.
- Subscription-only and proprietary CLIs are eligible. Billing/auth requirements
  are capabilities and prerequisites, not a blanket BYOK-only exclusion. Do not
  silently substitute providers, models, permission modes or CLI/SDK backends.
- **Source-qualified** means a plausible implementation can be scoped.
  **Deferred** means an identified maintenance or integration gap remains.
  Neither means shipped or provider-tested. Null usage is not zero cost;
  credits, estimated USD and billed USD are different measurements.
- Recheck official sources and the installed version when implementation starts.
  Dates/versions below are observations, not permanent compatibility promises.
  Vendor documentation without a pinned release is weaker maintenance evidence
  than a dated release; it is marked accordingly.

## Shipped, not wanted work

After adapter initialization, both registries contain twenty-six adapters, with shared fixture files:
`aider`, `amp`, `auggie`, `claude-code`, `cline`, `codex`, `continue-cli`, `copilot`, `crush`, `cursor`, `factory-droid`,
`gemini`, `goose`, `hermes`, `kilo`, `kimi-code`, `kiro`, `mini-swe-agent`, `mistral-vibe`, `omp`, `openclaude`, `opencode`, `pi`, `qoder`, `qwen`, `swe-agent`.
See [ADAPTER-MATRIX.md](ADAPTER-MATRIX.md#shipped-versus-planned) for their actual
commands, metrics and known language skew. Fixtures do not establish current
upstream compatibility.

- `qwen`, `continue-cli`, `pi`, `factory-droid`, `kilo`, `crush` and `openclaude`
  have shipped alongside the original six; do not create duplicate additions.
- `crush` already constructs `crush run` and reads SQLite metrics. The old
  question about whether Harness has a headless Crush adapter is resolved;
  upstream requalification is still separate.
- `openclaude` is shipped. Earlier concerns about OpenClaude / Claw Code / forks
  of leaked Claude Code source were legal ambiguity, fragmentation and unstable
  releases. Shipping does not establish that those concerns are resolved or
  approve other forks.
- `swe-agent` currently invokes a consumer-supplied mini-SWE Python wrapper, not
  a native SWE-agent CLI. The distinct `mini-swe-agent` adapter now invokes native `mini`.
- Native mini-SWE-agent shipped through [TWA-82](https://linear.app/twaldin/issue/TWA-82).
  See [setup, capabilities and qualification](ADAPTER-MATRIX.md#mini-swe-agent).
- `auggie` shipped through [TWA-81](https://linear.app/twaldin/issue/TWA-81).
  See [setup, JSON billing and account qualification](ADAPTER-MATRIX.md#auggie).
- `hermes` now ships local quiet chat in both languages ([TWA-73](https://linear.app/twaldin/issue/TWA-73)).
  See its [qualification and smoke limits](ADAPTER-MATRIX.md#hermes); the gateway,
  controlled sessions and machine-readable usage are not part of this adapter.
- `goose` now ships local `run` with JSONL output in both languages ([TWA-74](https://linear.app/twaldin/issue/TWA-74)).
  See its [setup, permissions and detached-extension limits](ADAPTER-MATRIX.md#goose).
- Refresh the shipped set in [TWA-68](https://linear.app/twaldin/issue/TWA-68).
  Pi CLI and controlled RPC now use `@earendil-works/pi-coding-agent`; see
  [current qualification](SPEC.md#controlled-rpc-sessions). Historical Pi
  compatibility remains with [TWA-71](https://linear.app/twaldin/issue/TWA-71);
  Pi SDK [TWA-84](https://linear.app/twaldin/issue/TWA-84) stays deferred behind
  that unanswered decision. Do not create another Pi owner.
- Oh My Pi (`omp`) now ships in both languages through [TWA-70](https://linear.app/twaldin/issue/TWA-70).
  See [its adapter reference](ADAPTER-MATRIX.md#omp-oh-my-pi) for current
  installation, headless behavior and qualification limits. RPC and optional
  SDK support remain separate work.
- Cline CLI now ships in both languages through [TWA-75](https://linear.app/twaldin/issue/TWA-75).
  See [setup, local ownership and qualification limits](ADAPTER-MATRIX.md#cline).
  It uses standalone foreground JSON and SIGINT teardown; controlled sessions,
  detached hub execution and optional SDK qualification (TWA-86) remain separate.
- GitHub Copilot CLI now ships in both languages through [TWA-76](https://linear.app/twaldin/issue/TWA-76).
  See [setup, native permissions and dated coverage](ADAPTER-MATRIX.md#copilot);
  this is the current `@github/copilot` agent, not the old `gh copilot` helper.
- Amp local execute mode now ships in both languages through [TWA-78](https://linear.app/twaldin/issue/TWA-78).
  See [setup, model limitations and dated coverage](ADAPTER-MATRIX.md#amp);
  remote orbs and runners are not exposed.
- Cursor CLI now ships in both languages through [TWA-77](https://linear.app/twaldin/issue/TWA-77).
  See [setup, permissions and dated qualification](ADAPTER-MATRIX.md#cursor).
  Cloud workers, persist/resume, ACP and SDK execution remain unsupported.

### Kiro CLI — [TWA-80](https://linear.app/twaldin/issue/TWA-80)

`kiro` now ships in both registries using the official `kiro-cli` V2 headless
path, with explicit tool trust and opaque JSONL events. It is the successor to
Amazon Q CLI, not another alias for an existing Harness adapter. Preview V3,
ACP sessions and aggregate usage/USD remain unqualified.
See [setup, permissions and coverage](ADAPTER-MATRIX.md#kiro).

### Qoder CLI — [TWA-92](https://linear.app/twaldin/issue/TWA-92)

`qoder` now ships in both registries with explicit edit permissions, caller-selected
model/config/auth, JSON results and null usage. Version 1.1.47 was installed and
native missing-auth output checked; credentialed provider edit/test smoke remains
unqualified. See [setup, prompt compatibility and limits](ADAPTER-MATRIX.md#qoder).

## Source-qualified: existing implementation backlog

These are unshipped. Reuse the linked ticket; each owns one adapter. Commands
show the headless entry point, not a universal safe permission configuration.
Caller-selected auth and configuration must already be available. Each entry's
specific checks supplement the [common validation scope](#validation-and-maintenance).

### Prime Agent — [TWA-72](https://linear.app/twaldin/issue/TWA-72)

- **Identity / maintenance:** [PrimeIntellect-ai/prime-agent](https://github.com/PrimeIntellect-ai/prime-agent),
  MIT; [v0.9.3](https://github.com/PrimeIntellect-ai/prime-agent/releases/tag/v0.9.3)
  released September 6. The README's `https://app.primeintellect.ai/prime-agent/install.sh`
  installs `prime-agent`. Its workspace manifest still uses the Pi npm name/bin;
  do not mistake that manifest for a supported Prime npm installation.
- **Path:** [`prime-agent -p --mode json "PROMPT"`](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/usage.md),
  with explicit provider/model and optional `--no-session`.
- **Gate / validation:** subscription or API-key provider; model-generated Python
  runs with user permissions. Verify worker/kernel lifetime and usage aggregation.
  Do not implement cleanup with global `shutdown` or manage unrelated background
  agents. Its own subagents do not make the single-run CLI an orchestration API.





### Mistral Vibe — shipped — [TWA-79](https://linear.app/twaldin/issue/TWA-79)

`mistral-vibe` now ships in both registries, qualified against official Vibe 2.25.0
with a bounded local synthetic provider. Programmatic mode uses the configured
agent and denies approval callbacks; bypass and workspace trust are separate
explicit choices. Credentialed provider success remains unqualified.
See [setup, capabilities and evidence](ADAPTER-MATRIX.md#mistral-vibe).


### OpenHands CLI — excluded after qualification — [TWA-83](https://linear.app/twaldin/issue/TWA-83)

The [legacy CLI README](https://github.com/OpenHands/OpenHands-CLI/blob/954f2ba646e8d749261a8f2b2b7e3031fa39be9f/README.md)
explicitly ends maintenance. The old `openhands --headless --json` candidate
is withdrawn, not shipped. Agent Canvas replaces the UI/launcher, but its
`--backend-only` starts persistent services; it is not task-and-exit.

TWA-83 exercised legacy CLI 1.16.0 version/help and missing-configuration
rejection, plus Canvas 1.16.0 launcher version/help only. It did not qualify
SDK/API behavior, full Canvas startup or provider success. The maintained
[SDK and Agent Server](https://docs.openhands.dev/sdk/getting-started) are
evaluated below; connecting to a caller-owned server never grants ownership
of that server or its containers.

## New source-qualified discoveries

The September 7 catalog discovered Qoder and Kimi Code under
[TWA-87](https://linear.app/twaldin/issue/TWA-87), dependent on shared conformance
[TWA-67](https://linear.app/twaldin/issue/TWA-67). Both have since shipped:
Qoder is listed above; Kimi Code's intake evidence and current reference follow.

### Kimi Code CLI — [TWA-93](https://linear.app/twaldin/issue/TWA-93)

**Shipped September 8:** one `kimi-code` adapter in both languages. See the
[maintained adapter reference](ADAPTER-MATRIX.md#kimi-code) for current
permissions, configuration, parsing and qualification gaps. The original
source-qualified intake evidence follows.

- **Identity / maintenance:** [MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code),
  MIT; npm [`@moonshot-ai/kimi-code`](https://www.npmjs.com/package/@moonshot-ai/kimi-code)
  0.41.0, registry modified September 4, supplies `kimi`. Official binary installer
  is also supported. The winding-down Python `kimi-cli` is a different distribution.
- **Path:** [`kimi -p "PROMPT" --output-format stream-json`](https://moonshotai.github.io/kimi-code/en/reference/kimi-command.html).
- **Gate / validation:** Kimi OAuth/API key or a configured compatible provider;
  preserve explicit model alias and `KIMI_CODE_HOME`. Print mode implies `auto`
  permissions and rejects `--yolo`, `--auto`, `--plan`; static denies still apply.
  Verify stderr versus JSONL, tool messages, exit/partial output and cancellation.
  Do not inherit predecessor exit codes or assume usage fields. Avoid automatic
  migration of the user's legacy config/sessions; ACP/web are separate surfaces.

## Deferred or unsupported candidates

These are not permanent name-based bans. Reopen qualification when the stated
blocker changes; do not create an implementation ticket solely to collect a name.

### Neovate Code — deferred: maintenance signal is stale

[neovateai/neovate-code](https://github.com/neovateai/neovate-code) is not archived,
but its last observed push was March 24, 2026; npm `@neovate/code` 0.28.5 was
published February 26 (registry metadata was modified July 1).
It has a concrete executable path: `npm install -g @neovate/code` supplies
`neovate`, and [CLI source](https://github.com/neovateai/neovate-code/blob/master/src/index.ts)
defines `neovate -q --output-format stream-json "PROMPT"`, `--approval-mode`
and `--cwd`. The plugin system is **not** a headless blocker. Provider keys are
supported; usage payload remains unverified. Recheck maintenance first, then
scope permission/output/isolation validation before promoting one adapter ticket.

### Plandex — deferred: dormant upstream and cloud wind-down

[plandex-ai/plandex](https://github.com/plandex-ai/plandex) is MIT, not Apache-2.0.
Its [latest commits](https://github.com/plandex-ai/plandex/commits/main/) are from
October 3, 2025; the README says Plandex Cloud is winding down from that date and
accepts no new users. It is not a maintained high-priority first contribution.

The official `https://plandex.ai/install.sh` installs `plandex`/`pdx`;
self-hosted/local Docker mode with provider keys remains documented. The
[`tell` command](https://github.com/plandex-ai/plandex/blob/main/app/cli/cmd/tell.go)
has automation flags, but requires server/project/plan setup: “CLI-first” alone
was insufficient qualification. [`usage --log`](https://github.com/plandex-ai/plandex/blob/main/app/cli/cmd/usage.go)
queries a credits ledger, not a verified per-run BYOK usage schema. Its exact
local-mode behavior was not run; no claim is made that the command necessarily
fails there. Reconsider only with a maintained release/fork, a provisioned
noninteractive edit path and independently verified per-run output/usage.

### Roo Code CLI — unsupported archived target

[RooCodeInc/Roo-Code](https://github.com/RooCodeInc/Roo-Code) is archived; its
README announces the extension shutdown on May 15, 2026. The old catalog's
`@roo-code/cli` npm install claim is not supported: npm returned 404 and the
[CLI manifest](https://github.com/RooCodeInc/Roo-Code/blob/main/apps/cli/package.json)
is `private: true` (source binary name `roo`). This does not prove source builds
are impossible, but there is no maintained published CLI path qualified here.
Community forks need their own maintenance/install/headless evidence.

### Other former exclusions: distinguish product boundaries

| Project | Classification and current decision |
| --- | --- |
| [GPT Pilot](https://github.com/Pythagora-io/gpt-pilot) | Multi-agent application-development workflow with human review, not a qualified single coding-agent headless run here. A bounded executable contract would need separate evidence. |
| [Mentat original CLI](https://github.com/AbanteAI/archive-old-cli-mentat) | Upstream explicitly archived and unsupported. The hosted successor is not evidence that this CLI is maintained. |
| [CodeMachine-CLI](https://github.com/moazbuilds/CodeMachine-CLI) | Orchestrates other coding agents into workflows: a Harness consumer/control plane, not another agent adapter. |
| [smol-ai/developer](https://github.com/smol-ai/developer) | Older Python developer-agent project; last observed push April 7, 2024. No maintained headless coding integration qualified here. |
| [Hugging Face smolagents](https://github.com/huggingface/smolagents) | Maintained agent-building library, **not** `smol-ai/smolagents`. Its [manifest](https://github.com/huggingface/smolagents/blob/main/pyproject.toml) does expose `smolagent`/`webagent` drivers; their existence is not a qualified coding-agent contract. SDK/library integration is a separate decision, not an absence-of-CLI claim. |
| [Kimi CLI predecessor](https://github.com/MoonshotAI/kimi-cli) | Upstream announces gradual wind-down in favor of Kimi Code CLI. Qualify the successor above; do not create both by accident. |

## SDK and protocol backends

**Decision — TWA-86, checked 2026-09-08:** keep agent identity separate from
execution transport. The maintained paths below are useful, but none is a
small contract-compatible addition: each needs session/permission mapping,
bounded disposal and cross-language qualification, not merely a flag or import.
This finding changes no public API, runtime dependency, fixture or package
version. New integrations remain Backlog; CLI behavior stays unchanged.

The [implementation gates](SPEC.md#backend-and-session-implementation-gates)
remain authoritative. An SDK may wrap a subprocess, embed an agent, or only
connect to a server; these are not interchangeable. A protocol library is not
evidence that every agent implements its current schema. Unknown events and
unsupported options must remain visible rather than being silently discarded.

### Maintained paths and dependency cost

Versions below are registry/source observations, not a supported Harness
version range. Dependency weight describes the runtime closure, not a measured
installation size. Local execution means tools run locally; model requests can
still leave the machine. Remote execution means the workspace/tools live on the
selected server, not in the caller's local `workdir`.

| Agent identity / official path | Language and runtime | Execution and dependency cost |
| --- | --- | --- |
| `claude-code`: [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview), [TS reference](https://code.claude.com/docs/en/agent-sdk/typescript), [Python SDK](https://github.com/anthropics/claude-agent-sdk-python) | TS `@anthropic-ai/claude-agent-sdk` **0.3.263**, Node >=18; Python `claude-agent-sdk` **0.2.152**, Python >=3.10 | Both are first-party language SDKs supervising a local Claude Code child, not native in-process agents. Native platform binaries plus model/MCP dependencies are substantial; TS bundles CLI **2.1.263**, Python **2.1.259**. Explicit executable overrides need separate version checks. |
| `codex`: [official SDKs](https://developers.openai.com/codex/sdk), [TS source](https://github.com/openai/codex/tree/main/sdk/typescript), [Python reference](https://github.com/openai/codex/blob/main/sdk/python/docs/api-reference.md) | TS `@openai/codex-sdk` **0.153.4**, Node >=18; Python `openai-codex` **0.147.0**, Python >=3.10 | **Different execution models:** TS wraps a new `codex exec` process per turn; Python drives app-server. Each includes/pins a native CLI dependency; Python pins **0.147.0**, not TS's **0.153.4**. Native Python support exists, but is not TS parity. |
| `codex`: [app-server protocol](https://developers.openai.com/codex/app-server/) | Language-neutral JSON-RPC/JSONL plus caller-selected Codex executable | Owned stdio child is the narrow candidate. No language SDK required. App-server is labelled experimental; remote WebSocket/Unix and Code Mode host selection are not a production-support promise. Do not create/manage its daemon. |
| `cline`: [SDK overview](https://docs.cline.bot/sdk/overview.md), [published package](https://registry.npmjs.org/@cline/sdk/latest) | Official TS `@cline/sdk` **0.0.82** aliases `@cline/core`; Node >=22. No official Python SDK qualified. | Full embedded agent runtime, provider/tool stack and SQLite, not a thin client. Python needs a named Node bridge or a different shared protocol. Explicit `backendMode: "local"` avoids shared infrastructure; default `auto` is not an ownership-safe choice. |
| `copilot`: [official SDK](https://github.com/github/copilot-sdk), [TS package](https://registry.npmjs.org/@github/copilot-sdk/1.0.13), [Python package](https://pypi.org/project/github-copilot-sdk/1.0.13/) | Both **1.0.13**, upstream GA/semver; TS Node `^20.19.0` or `>=22.12.0`, Python >=3.11 | JSON-RPC clients of CLI runtime **1.0.83**, with explicit external-server mode. TS ships optional platform runtimes plus JSON-RPC/Zod/FFI dependencies; Python uses Pydantic/HTTP support and packaged runtime provisioning. Select an installed runtime explicitly; no first-use download/cache setup during a Harness run. Experimental in-process FFI is excluded. |
| New identity `openhands`: [SDK/server](https://github.com/OpenHands/software-agent-sdk), [TS client](https://github.com/OpenHands/software-agent-sdk/blob/main/clients/typescript/README.md) | Python `openhands-sdk` / `openhands-agent-server` **1.45.0**, Python >=3.12; `@openhands/typescript-client` **1.45.0**, browser/Node client, **alpha** | Python is the native agent; TS is a remote HTTP/WebSocket client, not the same in-process agent. SDK closure includes LiteLLM, MCP, Pydantic, tree-sitter and Laminar; server adds FastAPI/database/container dependencies. Direct caller-owned-server protocol avoids loading that closure locally. |
| `opencode`: [JS/TS SDK](https://opencode.ai/docs/sdk/), [HTTP/OpenAPI server](https://opencode.ai/docs/server/) | `@opencode-ai/sdk` source manifest **1.18.29**; JS/TS client with `fetch`; no native Python SDK qualified | Small generated client plus cross-spawn, but a full agent server is still required. `createOpencode()` starts a server; `createOpencodeClient({baseUrl})` only attaches. Direct HTTP/SSE can provide Python parity without a JS bridge. Client runtime floor must be qualified at implementation. |
| `factory-droid`: [Python SDK](https://docs.factory.ai/sdk/python.md), [TS SDK](https://docs.factory.ai/sdk/typescript.md) | `droid-sdk` Python source **0.4.0**, Python >=3.10; published `@factory/droid-sdk` **0.9.1**, Node >=18 | Local CLI process in both; TS also has daemon/browser clients. Python core uses Pydantic; TS adds MCP, WebSocket, Zod and OpenTelemetry dependencies. Optional in-process MCP servers add resources. The TS examples repository still pins **0.7.0**: not the current published version. |
| `amp`: [SDK docs](https://ampcode.com/docs/sdk), [npm metadata](https://registry.npmjs.org/@ampcode/sdk/latest) | Docs offer Python and TS; TS npm **0.1.0-20260823161614-g3631dc6**, Node >=18. Current Python release/runtime floor not qualified. | SDK drives the CLI; TS depends on Zod and `@ampcode/cli: latest`. Docs describe Neo, but observed npm metadata declares `releaseTag: legacy`: resolve channel compatibility before implementation. Remote orb/runner execution is excluded. |

Package/version anchors for Claude:
[TS 0.3.263](https://github.com/anthropics/claude-agent-sdk-typescript/releases/tag/v0.3.263),
[Python 0.2.152](https://github.com/anthropics/claude-agent-sdk-python/releases/tag/v0.2.152).
Other anchors:
[Codex Python manifest](https://github.com/openai/codex/blob/main/sdk/python/pyproject.toml),
[OpenHands PyPI](https://pypi.org/project/openhands-sdk/1.45.0/),
[OpenHands npm](https://registry.npmjs.org/@openhands/typescript-client/1.45.0),
[OpenCode manifest](https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/package.json),
[Droid Python manifest](https://github.com/Factory-AI/droid-sdk-python/blob/main/pyproject.toml),
[Droid TS registry](https://registry.npmjs.org/@factory/droid-sdk/0.9.1).
Moving docs/source can describe behavior newer than these published packages;
implementation must pin and verify the actual SDK/runtime pair.

### Session, permission and telemetry differences

**Claude Agent SDK.** Use streaming input for an interruptible live query;
`interrupt()` is not available for simple string-input queries. Interrupt
receipts depend on CLI capabilities and do not cancel queued future messages;
drain the interrupted result before follow-up. `session_id` and explicit
`resume` preserve identity; `continue` means latest and is not acceptable resume.
`canUseTool` / `can_use_tool` is a real approval channel, separate from permission
modes. Preserve explicit model/executable/settings selection: current TS
`settingSources` defaults to all CLI filesystem sources, not the older opt-in
behavior. TypeScript V2 `createSession` examples are obsolete; current query
and Python client surfaces still need a capability-by-capability mapping.
Per-turn main-loop `usage` differs from cumulative `modelUsage` and
`total_cost_usd`, which is an **estimate**, not a bill; never sum cumulative
results. SDK disposal needs owned-child bounds, and unknown-message retention
needs verification. Upstream telemetry/settings and Anthropic's third-party
authentication terms remain caller prerequisites, not new Harness behavior.
Sources: [TS reference](https://code.claude.com/docs/en/agent-sdk/typescript),
[permissions](https://code.claude.com/docs/en/agent-sdk/permissions),
[sessions](https://code.claude.com/docs/en/agent-sdk/sessions).

**Codex SDK versus app-server.** The TS SDK has explicit thread-ID resume and
per-turn JSONL usage, but `AbortSignal` kills the exec child rather than
interrupting a persistent live session. It exposes policy flags, not an
approval callback. Python offers `TurnHandle.interrupt()` and native turn
streams; its approval-response coverage is not established here. Direct
app-server exposes `thread/start|resume`, `turn/start|interrupt`, server-to-client
approval requests and `turn/completed` status/error. A start or interrupt
response is an acknowledgement, not settlement. Preserve thread/turn/item
IDs, raw unknown frames, model/sandbox/approval choices and tokens with no
inferred USD. Keep usage totals distinct from last-turn snapshots.
Installed help says analytics are off by default for app-server; do not enable
them or invoke account/config-write APIs. Generated schemas are
version-specific, so a new backend needs a declared compatibility range and
explicit treatment of upstream's experimental status.
Sources: [exec implementation](https://github.com/openai/codex/blob/main/sdk/typescript/src/exec.ts),
[Python API](https://github.com/openai/codex/blob/main/sdk/python/docs/api-reference.md),
[app-server](https://developers.openai.com/codex/app-server/).

**Cline.** This is a genuine published SDK, not just internal CLI code.
The [hub architecture](https://docs.cline.bot/sdk/architecture/hub-spoke.md)
describes automatic singleton-daemon startup and daemon-owned spokes that
survive client exit; its mode table also describes `auto` falling back locally.
Neither description authorizes Harness to discover/start/stop the shared hub.
Only explicit local execution is a candidate. Native `sessionId`, `send`,
checkpoint restore, `abort`, `dispose` and destructive `delete` are distinct;
the latter is never cleanup. `done.reason` distinguishes completion, abort,
iteration/mistake limits and error. `requestToolApproval` is separate from
tool policies; unlisted tools default to enabled and auto-approved.
Usage carries per-event counts and `total*` fields with optional cost; do not
sum both. Telemetry/logger configuration is upstream-owned. A local Node
bridge still needs bounded child/tool disposal and Python parity; native
`cline --acp` is an alternative to qualify, not a reason to wrap the hub.
Sources: [ClineCore](https://docs.cline.bot/sdk/reference/cline-core.md),
[events](https://docs.cline.bot/sdk/reference/events.md),
[permissions](https://docs.cline.bot/sdk/guides/permission-handling.md),
[CLI reference](https://docs.cline.bot/cli/cli-reference).

**Copilot.** `abort()` interrupts work; session `disconnect()` releases
attachment resources while preserving persisted history; deletion is separate.
Explicit native session-ID resume and cwd context exist. Permission decisions
must preserve managed settings and caller policy, not copy an `approveAll`
example. Native `assistant.turn_end` has turn correlation, but
`assistant.idle` can occur while background work remains; `session.idle` is
the broader quiescence signal. Experimental completion receipts are not a
stable universal terminal contract. Preserve abort/error/disconnect/deadline
outcomes separately. Unlike the CLI result parser's null token totals, SDK
`assistant.usage` exposes optional **per-call token usage**; session checkpoints
and shutdown metrics are aggregates. `cost` is a multiplier and
`totalNanoAiu` uses AI units, not USD. Do not mix context occupancy with usage.
OpenTelemetry export/content capture is explicit caller configuration.
External-server mode must not launch a runtime; its close path still needs
source/runtime proof that it leaves the server and unrelated sessions alive.
Sources: [client/session API](https://github.com/github/copilot-sdk/blob/main/nodejs/README.md),
[generated native events](https://github.com/github/copilot-sdk/blob/main/nodejs/src/generated/session-events.ts),
[connection setup](https://github.com/github/copilot-sdk/blob/main/docs/getting-started.md).

**OpenHands.** Prefer the caller-owned Agent Server protocol over a local
Python bridge or alpha-client composition. Remote workdir is server-side;
session API auth is distinct from provider credentials. Agent creation can
serialize LLM credentials to the server, so never discover/copy them from a
local account. Use an explicit caller-selected profile/configuration.
The server's default `NeverConfirm` is not a sandbox or approval guarantee;
confirmation policies and approval responses are separate choices.
Conversation UUID and follow-up exist, but the Python remote wrapper can
create after an attach 404 and swallow an already-running 409: Harness must
reject both explicitly. `/pause` waits for the active LLM call, whereas
`/interrupt` cancels it; both reach resumable `paused`, not a terminal finished
result. Transport close does not stop remote work. No kill escalation against
the caller's server/container is permitted; failure to confirm interruption
must stay visible. Python's typed event validation can drop unknown kinds,
and its event list timestamp-sorts: preserve raw wire order instead.
Stats are cumulative, keyed by usage identity; LiteLLM-derived cost is
estimated and missing stats are not zero. Laminar/PostHog export behavior and
ambient automation callbacks need explicit qualification. Never use
`delete_on_close`, provisioning workspaces or Canvas as a substitute backend.
Sources: [Agent Server](https://docs.openhands.dev/sdk/arch/agent-server),
[remote conversation](https://github.com/OpenHands/software-agent-sdk/blob/main/openhands-sdk/openhands/sdk/conversation/impl/remote_conversation.py),
[server routes](https://github.com/OpenHands/software-agent-sdk/blob/main/openhands-agent-server/openhands/agent_server/conversation_router.py),
[workspace side effects](https://github.com/OpenHands/software-agent-sdk/blob/main/openhands-sdk/openhands/sdk/workspace/remote/base.py).

**Other maintained paths.** OpenCode's HTTP API has native session/message
IDs, SSE, prompt, abort and permission-response routes. Client request abort
is not proof the agent stopped; `instance/dispose` and session DELETE are not
handle cleanup. Server config/provider writes and TUI automation are excluded.
Factory's SDKs provide same-ID follow-up/resume, separate interrupt/close and
permission handlers; resume restores cwd/settings, while handlers must be
reattached. Python early stream exit needs its context manager/`aclose`;
TypeScript iterator break requests interruption. Per-turn tokens/Factory
credits differ from cumulative usage updates and are not USD. Both SDKs
have observability sinks; preserve caller selection. Amp supports explicit
thread-ID continuation, async input/output and AbortSignal cancellation;
qualify reusable-session versus abort behavior and Python parity. Mode/effort,
plugin permission policy, thread visibility and settings must not silently
become model/bypass defaults; its native result usage is not qualified here.
Sources: [OpenCode server](https://opencode.ai/docs/server/),
[Droid Python](https://docs.factory.ai/sdk/python.md),
[Droid TypeScript](https://docs.factory.ai/sdk/typescript.md),
[Amp SDK](https://ampcode.com/docs/sdk).

### ACP is a protocol choice, not another agent

[ACP](https://agentclientprotocol.com/get-started/introduction.md) has official
[Python](https://agentclientprotocol.com/libraries/python.md) and
[TypeScript](https://agentclientprotocol.com/libraries/typescript.md) libraries.
Observed manifests: Python **0.12.1**, Python >=3.10,<3.15 with Pydantic;
TS **1.4.0** with Zod peer dependency, no declared Node floor. Agent runtime
dependencies remain additional. V1 is stable; V2 and remote transport support
must not be assumed from the presence of draft/experimental APIs.
Native sessions, prompt stop reasons, permission requests and cancellation
are useful, but client filesystem/terminal services create additional
capabilities and owned resources. General request cancellation is optional;
neither it nor a closed stream proves tools stopped. Negotiate each agent's
actual version/capabilities, retain extension payloads, and distinguish
optional cumulative usage/cost from per-turn accounting.

The [agent directory](https://agentclientprotocol.com/get-started/agents.md)
includes Cline, Gemini, Copilot, OpenCode, Kiro and others, but also
third-party bridges: Claude via Zed's adapter, Codex via ACP's adapter, and
Pi via a community adapter. It even links older upstream identities.
Directory membership is discovery evidence, not maintained-native support for
every listed agent. Prefer each agent's direct supported surface; begin ACP
qualification with Cline's existing follow-up, not a universal transport
manager or another Pi/OMP owner.
Sources: [Python manifest](https://github.com/agentclientprotocol/python-sdk/blob/main/pyproject.toml),
[TS manifest](https://github.com/agentclientprotocol/typescript-sdk/blob/main/package.json),
[cancellation](https://agentclientprotocol.com/protocol/v1/cancellation.md).

### Disposition and evidence boundary

These deduplicated follow-ups are **Backlog, not dispatched**. Each requires
matching Python/TypeScript behavior in one PR and retains the common
identity/permissions/cleanup gates:

| Follow-up | Bounded decision / integration |
| --- | --- |
| [TWA-100](https://linear.app/twaldin/issue/TWA-100) | Claude Agent SDK: streaming-input sessions, runtime-pair capability mapping and bounded disposal. |
| [TWA-103](https://linear.app/twaldin/issue/TWA-103) | Codex: pinned local app-server protocol; resolve experimental compatibility before enabling it. Do not combine unequal SDKs. |
| [TWA-104](https://linear.app/twaldin/issue/TWA-104) | Copilot SDK: explicit local runtime, permission decisions and correlated terminal/cleanup behavior; no FFI or automatic downloads. |
| [TWA-101](https://linear.app/twaldin/issue/TWA-101) | Cline: choose explicit local SDK + named Python bridge versus native ACP; no hub/spoke management. |
| [TWA-102](https://linear.app/twaldin/issue/TWA-102) | OpenHands: caller-owned Agent Server only; exact resume, raw events, interrupt settlement and no server/container takeover. |
| [TWA-98](https://linear.app/twaldin/issue/TWA-98) | OpenCode: explicit caller-owned HTTP/SSE endpoint, auth/workdir identity and abort semantics. |
| [TWA-99](https://linear.app/twaldin/issue/TWA-99) | Factory Droid: local SDK runtime pair, permission/result and iterator-cleanup parity; no Computers/Missions. |
| [TWA-97](https://linear.app/twaldin/issue/TWA-97) | Amp: resolve release-channel/runtime parity first; local executor only. |

Pi SDK [TWA-84](https://linear.app/twaldin/issue/TWA-84) remains deferred behind
TWA-71's compatibility decision. OMP SDK [TWA-85](https://linear.app/twaldin/issue/TWA-85)
retains its existing owner. Their native SDKs are TypeScript agent runtimes
([Pi SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md),
[OMP SDK](https://github.com/can1357/oh-my-pi/blob/main/docs/sdk.md)); Python is
a separately qualified bridge/protocol path, not a native SDK. Neither is
duplicated here. Cloud fleets, Amp orbs, Augment Cosmos, OpenHands Canvas,
raw model SDKs, scraping and consumer migrations remain excluded.

Local evidence for this refresh: macOS arm64, Claude Code **2.1.220** version
only; Codex **0.153.4** version/app-server help and successful isolated
`generate-json-schema`. Generated interruption parameters require native
`threadId` and `turnId`; schema generation is not a session handshake or
generation test. Node **26.6.0**, Python **3.14.3**, Bun **1.3.14** were observed.
Cline, Copilot, OpenHands and OpenCode were not on this owner's selected PATH;
that is not a claim they are absent from all isolated installations.
No new optional SDK was installed or imported, no persistent agent server was
started, and no authentication/global configuration was changed.

**Evidence levels stay separate:** official-source qualification above;
installed version/help/schema checks just described; existing deterministic
Harness fixtures/conformance; native runtime against a local synthetic
provider; and actual authenticated provider success. This SDK inventory
claims neither of the last two. TWA-83's legacy OpenHands checks remain
limited to its handoff above; previous CLI smoke evidence is not SDK evidence.

## Validation and maintenance

1. **Deduplicate before intake.** Search the linked Linear project and GitHub
   issues/PRs by upstream, old/new package names and executable. Reuse an existing
   ticket; new discoveries get one adapter ticket with official sources and
   actual dependencies. Backlog is not authorization to start implementation.
2. **Refresh evidence.** Record checked date, upstream release/source revision,
   exact installed binary/package, platform and auth prerequisites. Recheck
   renamed, archived and subscription-only entries rather than copying this
   snapshot's flags or treating an active website as a successful smoke test.
3. **Prove both languages.** Follow the
   [adapter contribution guide](CONTRIBUTING.md#adding-a-new-adapter): Python and
   TypeScript command/parser behavior, shared redacted fixtures, fixture-loader
   coverage, matrix row and any public API changes in one PR. Keep the common
   interface small and unsupported capabilities explicit.
4. **Separate deterministic from provider evidence.** Use the shared conformance
   work in TWA-67 for stdin EOF, spawn/auth failures, permissions, nonzero exits,
   malformed/partial output, cancellation and owned-child cleanup. Verify model,
   config and instruction isolation. Do not read unrelated sessions to fill in
   missing telemetry or turn unknown usage into zero.
5. **Smoke only with authorized prerequisites.** In a disposable working directory,
   demonstrate a bounded edit/test task and relevant failure/cleanup behavior;
   record exact versions and missing auth/platform coverage. Do not install tools,
   create accounts, switch credentials or rewrite global configuration merely to
   qualify a candidate. Never publish private conversation logs or credentials.
6. **Promote only what lands.** Move an entry to shipped after registration in both
   languages and relevant validation, linking its matrix section. Keep upstream
   qualification separate from the fuller capability guide (TWA-88) and
   installed-package/provider acceptance (TWA-89).
