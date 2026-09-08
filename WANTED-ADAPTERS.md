# Wanted adapters

An evidence-backed catalog of upstream coding-agent CLIs and the work needed to
support them. **Checked 2026-09-07** against official documentation, source and
package metadata. Commands below establish an executable integration path, not
an installed-version or real-provider smoke result. No candidate was installed,
authenticated or run against a provider for this catalog refresh.

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

After adapter initialization, both registries contain twenty-three adapters, with shared fixture files:
`aider`, `amp`, `auggie`, `claude-code`, `cline`, `codex`, `continue-cli`, `copilot`, `crush`, `cursor`, `factory-droid`,
`gemini`, `goose`, `hermes`, `kilo`, `kiro`, `mistral-vibe`, `omp`, `openclaude`, `opencode`, `pi`, `qwen`, `swe-agent`.
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
  a native SWE-agent CLI. The distinct native mini-SWE CLI is tracked below.
- `auggie` shipped through [TWA-81](https://linear.app/twaldin/issue/TWA-81).
  See [setup, JSON billing and account qualification](ADAPTER-MATRIX.md#auggie).
- `hermes` now ships local quiet chat in both languages ([TWA-73](https://linear.app/twaldin/issue/TWA-73)).
  See its [qualification and smoke limits](ADAPTER-MATRIX.md#hermes); the gateway,
  controlled sessions and machine-readable usage are not part of this adapter.
- `goose` now ships local `run` with JSONL output in both languages ([TWA-74](https://linear.app/twaldin/issue/TWA-74)).
  See its [setup, permissions and detached-extension limits](ADAPTER-MATRIX.md#goose).
- Refresh the shipped set in [TWA-68](https://linear.app/twaldin/issue/TWA-68).
  Pi's current upstream advertises `@earendil-works/pi-coding-agent`
  ([upstream](https://github.com/earendil-works/pi)); the checked-in adapter
  reference still names `@mariozechner/pi-coding-agent`. Requalification and RPC
  belong to [TWA-71](https://linear.app/twaldin/issue/TWA-71), not another Pi ticket.
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

### Native mini-SWE-agent — [TWA-82](https://linear.app/twaldin/issue/TWA-82)

- **Identity / maintenance:** [SWE-agent/mini-SWE-agent](https://github.com/SWE-agent/mini-swe-agent),
  v2.4.6 released July 23; source active September 7.
  [Installation](https://mini-swe-agent.com/latest/quickstart/):
  `uv tool install mini-swe-agent` supplies `mini` and `mini-extra`.
- **Path:** [`mini -t "TASK" -m PROVIDER/MODEL -y --exit-immediately -o trajectory.json`](https://github.com/SWE-agent/mini-swe-agent/blob/main/src/minisweagent/run/mini.py).
- **Gate / validation:** `-y` deliberately bypasses confirmation; expose that limitation.
  First-run configuration must be prepared without an interactive setup wizard.
  Verify termination, trajectory fields, explicit model/cwd and cleanup. Do not
  silently replace the shipped `swe-agent` wrapper or conflate it with SWE-agent.

### OpenHands CLI — [TWA-83](https://linear.app/twaldin/issue/TWA-83)

- **Identity / maintenance:** [current CLI docs](https://docs.openhands.dev/openhands/usage/cli/installation),
  exact release not pinned here. `uv tool install openhands --python 3.12`
  supplies `openhands`; select the CLI distribution, not Agent Canvas.
- **Path:** [`openhands --headless --json -t "TASK"`](https://docs.openhands.dev/openhands/usage/cli/headless)
  emits JSONL events.
- **Gate / validation:** preconfigured provider/key or OpenHands account;
  headless mode always approves actions. Expose that limitation. Verify actual
  event/usage schema, settings/conversation isolation, exit and cancellation;
  no usage totals are established here. Agent Canvas is a control center for
  agents, while SDK qualification is tracked in TWA-86.

## New source-qualified discoveries

Workspace and repository backlog searches found no existing Qoder or Kimi Code
adapter tickets. Both follow-ups remain in Backlog, are children of
[TWA-87](https://linear.app/twaldin/issue/TWA-87), and depend on shared conformance
[TWA-67](https://linear.app/twaldin/issue/TWA-67), which carries the contract and
lifecycle prerequisites. No new runtime adapter is shipped by this catalog PR.

### Qoder CLI — [TWA-92](https://linear.app/twaldin/issue/TWA-92)

- **Identity / maintenance:** npm [`@qoder-ai/qodercli`](https://www.npmjs.com/package/@qoder-ai/qodercli)
  1.1.46, registry modified September 7; bins `qoder` and `qodercli`.
  Install with `npm install -g @qoder-ai/qodercli`.
- **Path:** [`qoder -p "PROMPT" --output-format json --permission-mode accept_edits --max-turns 20`](https://docs.qoder.com/cli/run-in-scripts).
- **Gate / validation:** caller-selected Qoder
  [account/PAT](https://docs.qoder.com/cli/authentication), model and `QODER_CONFIG_DIR`;
  BYOK is not established here. `accept_edits` still denies shell commands;
  text-mode confirmation defaults to deny, while host-driven stream-json approvals
  are a separate protocol path. Verify edit versus shell denial, JSON metadata,
  partial streams and cleanup. Unknown token/USD fields stay null.

### Kimi Code CLI — [TWA-93](https://linear.app/twaldin/issue/TWA-93)

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

SDKs and protocols are **backend options**, not duplicate adapter identities.
Pi SDK ([TWA-84](https://linear.app/twaldin/issue/TWA-84)), OMP SDK (TWA-85), and
[other SDK/protocol qualification](https://linear.app/twaldin/issue/TWA-86)
are separate from the CLI additions. This catalog does not change the current
public API or implement the proposed backend contract
([TWA-63](https://linear.app/twaldin/issue/TWA-63)). Cloud worker fleets, Amp orbs,
Augment Cosmos and OpenHands Agent Canvas are orchestration surfaces, not local
one-shot adapters; Harness does not take ownership of those control planes.

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
