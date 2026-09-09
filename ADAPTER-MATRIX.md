# Adapter matrix

Per-CLI reference for current command construction, instruction files and token/cost parsing. [SPEC.md](SPEC.md) defines the shared contract; [fixture coverage notes](SPEC.md#json-fixture-driven-verification) describe what the two suites actually assert.

**Qualification refreshed 2026-09-08 for TWA-68's thirteen named adapters.**
The ledger below separates primary-source checks, installed help/version probes,
synthetic conformance and provider smoke. None has a successful provider smoke
recorded by this audit. Hermes and OMP landed separately; their entries retain
their own qualification evidence. Hermes headless flags were checked against
installed Hermes Agent v0.20.0 (2026.8.3) and the upstream parser.

## Shipped versus planned

The twenty-six adapters below are registered in **both** implementations and have
shared fixture files: `aider`, `amp`, `auggie`, `claude-code`, `cline`, `codex`, `continue-cli`, `copilot`, `crush`, `cursor`,
`factory-droid`, `gemini`, `goose`, `hermes`, `kilo`, `kimi-code`, `kiro`, `mini-swe-agent`, `mistral-vibe`, `omp`, `openclaude`, `opencode`, `pi`,
`qoder`, `qwen`, `swe-agent`. Registration and fixtures are not proof of current upstream
compatibility or real-provider smoke coverage.
Both package roots initialize the built-in registry on import, so listing
adapters no longer depends on a prior Python build/parse/run call.

[WANTED-ADAPTERS.md](WANTED-ADAPTERS.md) is the dated upstream candidate catalog:
installation identities, headless feasibility, exclusions and deduplicated
implementation tickets. A catalog entry or ticket is **not** a shipped adapter.
In particular, the shipped `swe-agent` is a consumer-supplied mini-SWE wrapper
(see [its command](#swe-agent)), separate from the native [mini-SWE-agent adapter](#mini-swe-agent).

The bounded repairs and qualification ledger belong to
[TWA-68](https://linear.app/twaldin/issue/TWA-68). Larger discovered repairs are
linked separately: [TWA-95](https://linear.app/twaldin/issue/TWA-95) for native
database run correlation/path/cost semantics; [TWA-96](https://linear.app/twaldin/issue/TWA-96)
for legacy session discovery, parsing and pane evidence. Pi CLI/RPC remains
[TWA-71](https://linear.app/twaldin/issue/TWA-71). The API guide is
[TWA-88](https://linear.app/twaldin/issue/TWA-88); installed-package/provider
acceptance is [TWA-89](https://linear.app/twaldin/issue/TWA-89).

## Dated qualification ledger

**Help-checked** means the named installed executable accepted its version/help
probe and exposed the emitted flags, not that its provider authenticated or
completed a task. **Source-checked** means official docs/source corroborate the
listed command/output contract; an unavailable executable is not provider-tested.
All shared executable/SQLite/JSON fixtures remain synthetic. Latest package
versions below are dated observations, not a supported version range.

| Adapter | Primary installation / source | Installed observation | Qualification and material limit |
|---|---|---|---|
| amp | [official native installer](https://ampcode.com/docs/cli); [execute mode](https://ampcode.com/docs/cli/execute-mode) | isolated Darwin arm64 `0.0.1788868861-g921679` (2026-09-08), checksum verified | Help/version and bounded local native run checked. Configured account returned Out of Credits in JSONL with process exit zero; no successful provider coverage. See [limits](#amp). |
| auggie | [`@augmentcode/auggie`; CLI reference](https://docs.augmentcode.com/cli/reference) | isolated npm 0.36.0 (commit 7c61e5bb), macOS arm64, 2026-09-08 | Version/help and packaged JSON/entitlement paths checked. Native account probe returned not logged in; no authenticated provider coverage. See [limits](#auggie). |
| aider | [`aider-chat`; CLI options](https://aider.chat/docs/config/options.html) (0.86.2; Python >=3.10,<3.13) | not on PATH | Source-checked; cached and multiple-message usage reports repaired against upstream emission. Rounded token scraper only; no session helper/provider qualification. |
| claude-code | [`@anthropic-ai/claude-code`; CLI reference](https://code.claude.com/docs/en/cli-reference) (registry 2.1.263) | 2.1.220 | Embedded installed-binary storage code checked; actual isolated synthetic-provider session captured. Config-root/encoding/cutoff repairs below; other releases and update/approval panes unqualified. |
| codex | [`@openai/codex`; upstream](https://github.com/openai/codex) | 0.153.4 | Help-checked; provider smoke **failed**: configured ChatGPT account rejected default `gpt-5.3-codex` and explicit `gpt-5.4` with HTTP 400. Both language runs cleaned up; no silent model fallback. |
| continue-cli | [`@continuedev/cli`; headless mode](https://docs.continue.dev/cli/headless-mode) (1.5.47) | not on PATH | Source-checked after command/rule/model repair. Headless JSON is model output, not usage telemetry. Default ask-tier tools are excluded; explicit bypass adds `--auto`. |
| copilot | [`@github/copilot`; programmatic reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-programmatic-reference) | 1.0.83, isolated npm install | Help-checked; bounded no-tool provider success and cancellation on macOS arm64. JSONL records retained; token/USD totals unavailable. See [coverage limits](#copilot). |
| mistral-vibe | [`mistral-vibe`; official source](https://github.com/mistralai/mistral-vibe/tree/v2.25.0) | 2.25.0, isolated Python 3.12 install | Version/help and programmatic source checked; see [native smoke and provider limits](#mistral-vibe). |
| crush | [`charmbracelet/tap/crush`; source](https://github.com/charmbracelet/crush) (v0.92.0) | v0.62.0 | Help-checked; upstream-shaped schema reproduction repairs nonexistent `sessions.model`. No provider/actual-run DB qualification. `--yolo` is not a `run` flag. |
| factory-droid | [`droid`; official headless guide](https://docs.factory.ai/droid-exec/overview) (0.213.0) | 0.132.1, off PATH | Help-checked with explicit executable. Replaces nonexistent `@factory-ai/droid`. Managed/custom model IDs now remain caller-selected. Default is read-only; documented JSON has no usage/cost. |
| gemini | [`@google/gemini-cli`; headless reference](https://geminicli.com/docs/cli/headless/) (0.58.0) | 0.37.0 | Help-checked; current session registry/JSONL replay source-checked with synthetic fixtures below. Current docs deprecate `-y` in favor of `--approval-mode yolo`; installed `-y` still exists. |
| kilo | [`@kilocode/cli`; CLI reference](https://kilo.ai/docs/code-with-ai/platforms/cli-reference) (7.5.15) | not on PATH | Source-checked; assistant DB model key repaired to `modelID`. Without `--auto`, headless permission requests are rejected; this is upstream policy, not implicit bypass. |
| openclaude | [`@gitlawb/openclaude`; upstream](https://github.com/Gitlawb/openclaude) (0.30.0) | 0.6.0, prior off-PATH probe | Current config cutover and provider model namespaces source-checked; discovery now uses only OpenClaude state. No current binary/provider/pane capture. npm `openclaude` is an unrelated reservation. |
| opencode | [`opencode-ai`; CLI reference](https://opencode.ai/docs/cli/) (1.18.29) | 1.14.46, off PATH | Help-checked; source-shaped DB regression replaces `session.model` with assistant `modelID`. New docs use `--auto`; installed help uses `--dangerously-skip-permissions`. No version-independent bypass mapping added. |
| pi | [`@earendil-works/pi-coding-agent`; upstream](https://github.com/earendil-works/pi) (0.85.1) | not on PATH | Source-checked CLI JSON contract; old `@mariozechner/pi-coding-agent` 0.73.1 is explicitly deprecated. Install metadata corrected; runtime/RPC acceptance remains TWA-71. |
| qwen | [`@qwen-code/qwen-code`; headless source](https://github.com/QwenLM/qwen-code/blob/main/docs/users/features/headless.md) (0.23.0) | not on PATH | Source-checked flags/result array and current project/session JSONL layout below. Existing default `qwen3-coder` is not provider-qualified; current upstream also uses `coder-model`. |
| swe-agent | [`mini-swe-agent`; native CLI docs](https://mini-swe-agent.com/latest/usage/mini/) (registry 2.4.6) plus a **consumer-supplied wrapper** | dependency 2.2.8; wrapper help checked | Wrapper-only, not native SWE-agent/mini support. `mini --version` fails; metadata now queries the dependency via the wrapper's `python3`. Installing the dependency does not install the wrapper. Native mini is TWA-82. |
| cline | [`cline`; standalone CLI](https://docs.cline.bot/cli/cli-reference), pinned [cli-v3.0.61](https://github.com/cline/cline/tree/cli-v3.0.61/apps/cli) | 3.0.61, isolated npm prefix | Help/version and real-CLI loopback protocol checked; JSON differs from docs. SIGINT stops ordinary shell tools; SIGTERM does not. Real Cline provider smoke failed without authentication; no successful real-provider coverage. |
| goose | [`aaif-goose/goose` release binary](https://github.com/aaif-goose/goose/releases/tag/v1.49.0); [CLI reference](https://goose-docs.ai/docs/guides/goose-cli-commands) | isolated Darwin arm64 v1.49.0; not installed on PATH | Help/source-checked; bounded real CLI probes with synthetic localhost provider. No authenticated provider coverage. macOS stdio MCP children can escape group teardown; see below. |
| cursor | [official binary installer](https://cursor.com/install); [headless reference](https://cursor.com/docs/cli/headless) | 2026.09.02-c22c1a3, isolated Darwin arm64 archive | Help/source-checked; bounded native auth-failure smoke in both languages. No credentialed provider/edit/tool-cleanup coverage. See [limits](#cursor). |
| mini-swe-agent | [`mini-swe-agent` 2.4.6](https://pypi.org/project/mini-swe-agent/2.4.6/); [official CLI](https://mini-swe-agent.com/latest/usage/mini/) | isolated Python 3.11.15 install, `mini --help` and metadata version checked | Native deterministic-model completion checked on macOS arm64; no external-provider qualification. Local shell actions detach from the CLI group. See [limits](#mini-swe-agent). |
| kiro | [official installer](https://cli.kiro.dev/install); [headless reference](https://kiro.dev/docs/cli/headless.md) | checksum-verified stable 2.21.1 macOS universal DMG, run on arm64 | Version/help and bounded native missing-auth path checked; no provider success. Stable help names `--agent-engine`, while docs use `--engine`. See [limits](#kiro). |
| kimi-code | [`@moonshot-ai/kimi-code` 0.41.0](https://www.npmjs.com/package/@moonshot-ai/kimi-code); [official command reference](https://moonshotai.github.io/kimi-code/en/reference/kimi-command.html) | `kimi` not on PATH (2026-09-08); no install attempted | Release source/package identity checked; synthetic conformance only. Print mode implies native auto permissions. No installed version/help, native auth-failure or provider edit/test smoke. See [limits](#kimi-code). |
| qoder | [`@qoder-ai/qodercli` 1.1.47](https://www.npmjs.com/package/@qoder-ai/qodercli/v/1.1.47); [headless reference](https://docs.qoder.com/cli/run-in-scripts) | isolated npm install on macOS arm64; `qoder --version`, help, bundled parser and JSON/stream-json auth failure checked | No credentialed provider success or edit/test smoke. USD is a native placeholder; metrics remain null. See [limits](#qoder). |

Off-PATH probes used absolute executables; Harness does not add them to PATH.
No tools were upgraded, credentials switched, global configuration rewritten or
packages published. Provider/model availability must be verified for the caller's
selected account; fixture success cannot qualify it.

## Session telemetry coverage

Both languages expose session-path and parsing hooks for the same 12 adapters
(every adapter except `aider`, `amp`, `auggie`, `cline`, `copilot`, `cursor`, `goose`, `hermes`, `kimi-code`, `kiro`, `mini-swe-agent`, `mistral-vibe`, `omp` and `qoder`). "Wired" means the hooks exist,
not that the current upstream layout is recognized or discovery identifies a
unique live session. The seven file-based helpers qualified below use current
source-shaped fixtures; they remain caller-driven artifact helpers, separate
from [controlled Pi RPC sessions](SPEC.md#controlled-rpc-sessions).

| adapter | TypeScript hooks | Python hooks | notes |
|---|---|---|---|
| claude-code | wired | wired | `<CLAUDE_CONFIG_DIR or ~/.claude>/projects/<encoded>/`; bounded cwd metadata check |
| codex | wired | wired | JSONL path + parser |
| gemini | wired | wired | `<GEMINI_CLI_HOME or ~>/.gemini/tmp/<registry slug or hash>/chats/session-*.jsonl` (also legacy session JSON); validates projectHash |
| opencode | wired | wired | explicit native-ID SQLite selector only; workdir discovery returns null |
| swe-agent | wired | wired | workdir-local wrapper trajectory JSON; no global last-run fallback |
| pi | wired | wired | JSONL event stream |
| continue-cli | wired | wired | `<CONTINUE_GLOBAL_DIR or ~/.continue>/sessions/<uuid>.json`; matches workspaceDirectory, reads cumulative usage |
| crush | wired | wired | explicit native-ID SQLite selector only; workdir discovery returns null |
| factory-droid | wired | wired | `<FACTORY_HOME_OVERRIDE or ~>/.factory/sessions/<encoded-cwd>/<uuid>.jsonl` plus `.settings.json`; validates session_start.cwd |
| openclaude | wired | wired | `<OPENCLAUDE_CONFIG_DIR or ~/.openclaude>/projects/<encoded>/`; never falls back to `.claude` |
| qwen | wired | wired | `<QWEN_RUNTIME_DIR or QWEN_HOME or ~/.qwen>/projects/<encoded-cwd>/chats/<uuid>.jsonl`; validates cwd, excludes sidecars |
| kilo | wired | wired | explicit native-ID SQLite selector only; workdir discovery returns null |
| aider | unwired | unwired | no session-log hooks |
| hermes | unwired | unwired | no session-log hooks; the headless `raw.session_id` comes from stderr, not a log file |
| omp | unwired | unwired | ephemeral headless JSONL; no latest-session discovery |
| cline | unwired | unwired | foreground NDJSON only; no session resume or latest-session discovery |
| goose | unwired | unwired | `complete` usage comes from stdout; no latest-session discovery or session ID in stream events |
| copilot | unwired | unwired | native JSONL events only; no latest-session discovery |
| amp | unwired | unwired | `session_id` retained in JSONL; no latest-thread discovery or continuation |
| mistral-vibe | unwired | unwired | completed history entries on stdout; no latest-session discovery |
| cursor | unwired | unwired | native JSONL events only; no persist/resume or latest-session discovery |
| mini-swe-agent | unwired | unwired | confirmed one-shot trajectory only; no latest-run discovery |
| kiro | unwired | unwired | native ACP JSONL objects only; no discovery or continuation |
| kimi-code | unwired | unwired | print-mode assistant/tool JSONL only; no discovery or continuation |
| qoder | unwired | unwired | one-shot JSON envelope / diagnostic JSONL objects only |

### Artifact qualification — 2026-09-08

All seven helpers above honor an inclusive **file mtime** cutoff: Python
`session_started_after` uses seconds, TypeScript `sessionStartedAfter` uses
milliseconds. A cutoff is not a session creation timestamp: resuming an older
conversation updates its mtime, and concurrent sessions in one workdir remain
ambiguous. Helpers consult the calling process's environment; they do not
remember `RunSpec.env` or `configHome` from a separate child. Align the selected
root explicitly or parse an already-known artifact path. No config/auth files
are migrated or modified by these readers.

- **Claude Code / OpenClaude:** NFC realpath, all non-ASCII-alphanumeric UTF-16
  units replaced with `-`, 200-character prefix plus upstream hash for long
  names. Runtime-dependent long-path hash siblings are considered only when
  the first 64 KiB includes matching cwd metadata; missing/foreign metadata
  returns no match, including short-name collisions. Claude's explicit empty
  `CLAUDE_CONFIG_DIR` means the caller's cwd; OpenClaude's empty override is
  unset. The [OpenClaude cutover](https://github.com/Gitlawb/openclaude/blob/eb3c5902eb742322b437d33307590bdc852d4668/README.md#openclaude-config-cutover)
  and [storage source](https://github.com/Gitlawb/openclaude/blob/eb3c5902eb742322b437d33307590bdc852d4668/src/utils/sessionStoragePortable.ts)
  corroborate that fork's layout. Claude's closed-source **installed 2.1.220**
  bundle and an actual isolated localhost-provider capture establish its
  observed encoding and 11-input/3-output transcript—not support for every
  newer release. Shared synthetic transcripts cover repeated assistant message
  IDs without double counting. Estimates exclude cache pricing and are not
  billed spend. No actual Claude/OpenClaude update or approval pane was captured;
  precedence is unchanged.
- **Factory:** [droid 0.213.0](https://www.npmjs.com/package/droid/v/0.213.0)
  and [official SDK 0.9.1](https://www.npmjs.com/package/@factory/droid-sdk/v/0.9.1)
  `session-discovery` source define the encoded-cwd directory and flat legacy
  JSONL fallback. The SDK cwd-filters only flat legacy files; Harness deliberately
  requires matching canonical absolute `session_start.cwd` in both layouts to
  reject encoded-name collisions. Symlinks and trailing slashes are normalized;
  missing or relative cwd is rejected. Unlike the SDK's live listing, this
  artifact helper does not filter archived files: cwd and mtime do not establish
  live-session identity. Underscores remain intact.
  Cumulative `tokenUsage.inputTokens/outputTokens` and selected model
  come from the sibling `<uuid>.settings.json`; absent settings yield unknown
  usage, with assistant `message.modelId` available as a model-only fallback.
  Credits are not USD: session cost stays null. `FACTORY_HOME_OVERRIDE` replaces
  the home parent, not `.factory`; the old invented `FACTORY_HOME` probes are
  removed. Current schema fixtures are synthetic, not a current-runtime capture;
  no update/approval pane change is claimed.
- **Gemini:** [storage/registry](https://github.com/google-gemini/gemini-cli/blob/85aca163f6c73ac6ce380b5447359146b8adcae4/packages/core/src/config/storage.ts)
  selects `projects.json` slugs, `.project_root` markers or the pre-registry
  SHA-256 path. [Chat recording](https://github.com/google-gemini/gemini-cli/blob/85aca163f6c73ac6ce380b5447359146b8adcae4/packages/core/src/services/chatRecordingService.ts)
  replays last message snapshots, `$set` checkpoints and `$rewindTo` before
  summing `tokens.input/output`. Prompt-history `logs.json` is not a session.
- **Qwen:** [storage](https://github.com/QwenLM/qwen-code/blob/7023bba7600f0f8528809bed85a3ec1bdc2866ae/packages/core/src/config/storage.ts)
  and [recording](https://github.com/QwenLM/qwen-code/blob/7023bba7600f0f8528809bed85a3ec1bdc2866ae/packages/core/src/services/chatRecordingService.ts)
  define project JSONL, assistant `usageMetadata.promptTokenCount/candidatesTokenCount`
  and cumulative UI snapshots (ignored, not added again). Runtime model prefixes
  are removed for telemetry, not inferred as providers. `runtimeOutputDir` from
  upstream settings/in-process context is not discovered; select the matching
  `QWEN_RUNTIME_DIR` or pass a known file. There is no `.gemini` fallback.
  Gemini/Qwen fixtures are source-shaped, not captured provider runs. Mixed or
  unknown contributing models leave aggregate model/cost unavailable.
- **Continue:** [CLI session source](https://github.com/continuedev/continue/blob/5522c6f44ca0ac3528b37244818fbfa39b5af470/extensions/cli/src/session.ts)
  persists cumulative `usage.promptTokens/completionTokens/totalCost`; the
  reported cost may itself be an upstream estimate. It persists no model ID.
  `sessions.json` is an index, not a session. Discovery requires the exact
  absolute/real workdir spelling rather than upstream's case-folded history
  listing, to avoid mixing distinct POSIX workspaces. Old `CONTINUE_SESSION_DIR`
  and basename/dev-data guesses are removed. Headless JSON remains model output,
  never telemetry. No current binary/provider capture is claimed.

These repairs implement [TWA-96](https://linear.app/twaldin/issue/TWA-96), not
native identity or controlled resume from [TWA-69](https://linear.app/twaldin/issue/TWA-69).
Database correlation remains TWA-95; Pi qualification remains TWA-71.

## Backend and permission capabilities

All twenty-six support one-shot `backend="cli"`; `RunSpec` rejects RPC/SDK without
fallback. `get_capabilities` / `getCapabilities` reports one-shot support:
streaming (raw subprocess chunks, not structured events) and cancellation true,
controlled sessions false. The separate `get_session_capabilities("pi")` /
`getSessionCapabilities("pi")` reports the Pi 0.85.1 RPC session contract.
Its current official package is `@earendil-works/pi-coding-agent`; older Pi and
OMP protocols are not assumed compatible. See
[session qualification and limits](SPEC.md#controlled-rpc-sessions).
OMP SDK sessions use `getSessionCapabilities("omp", "sdk")` /
`get_session_capabilities("omp", "sdk")`, qualified for the optional 18.1.14
package on Bun >=1.3.14. Python and Node use the same owned bridge worker;
ordinary CLI imports have no SDK dependency.
Amp SDK sessions use `getSessionCapabilities("amp", "sdk")` /
`get_session_capabilities("amp", "sdk")` with an explicit local executor, mode,
SDK package and pinned Neo CLI. Both languages use one isolated Node >=22
worker per operation. Exact thread resume and interruption preserve the native
thread; approval replies and bypass are unsupported. Local execution still
requires the native Amp thread service. See the
[Amp SDK contract and separate qualification evidence](SPEC.md#optional-amp-sdk-sessions).
OpenCode HTTP sessions use `getSessionCapabilities("opencode", "rpc")` /
`get_session_capabilities("opencode", "rpc")` against an explicitly selected
caller-owned 1.18.29 endpoint. Both languages implement native HTTP/SSE,
exact resume, interruption and one-shot permission replies; close never
disposes the server. Source pin and shared mock conformance are separate from
native-runtime/provider evidence, which has not run. See the
[OpenCode HTTP session contract](SPEC.md#caller-owned-opencode-http-sessions).
Pure pane/install helpers exist for the same twelve adapters that have session
hooks; `aider`, `goose` and `hermes` ship none.
Amp, Auggie, OMP, Cline, Copilot, Cursor, Kimi Code and mini-SWE-agent add install metadata but no pane or session-log heuristics.
These helpers remain separate from native control.

The default permission policy is `upstream`: commands below omit approval/bypass
flags or mode environment overrides unless the caller explicitly supplies a native approval override. This
preserves the selected upstream's policy, not a guarantee of
sandboxing or an interactive approval channel. To intentionally regain the old
auto-approval behavior, use `permission_policy="bypass"` /
`permissionPolicy: "bypass"`. The mapping is:

| adapters | explicit bypass addition |
|---|---|
| claude-code, openclaude | `--dangerously-skip-permissions` |
| codex | `--dangerously-bypass-approvals-and-sandbox` |
| factory-droid | `--skip-permissions-unsafe` |
| gemini, qwen | `-y` |
| aider | `--yes-always` |
| kilo | `--auto` |
| hermes, mini-swe-agent | `--yolo` |
| omp | `--auto-approve` |
| continue-cli | `--auto` |
| cline | `--auto-approve true` |
| goose | child environment `GOOSE_MODE=auto`; conflicting explicit `env.GOOSE_MODE` rejects |
| copilot | `--allow-all` |
| mistral-vibe | `--auto-approve` |
| cursor | `--force`; native explicit denies and team policy still apply |
| kiro | `--trust-all-tools`; conflicts with explicit native `trustTools` |
| amp, auggie, crush, kimi-code, opencode, pi, qoder, swe-agent | unsupported; request fails before writes/spawn |

**Kimi Code print mode inherently uses `auto`**, including under `upstream`.
It cannot request interactive approval or Plan mode. Its conflicting native
`--yolo`/`--auto`/`--plan` flags are not added or silently discarded.

Amp, Claude Code, Codex, Cline and Copilot have typed native options:
`ClaudeCodeOptions.effort` / `{kind: 'claude-code', effort}` adds `--effort`;
`CodexOptions.sandbox` / `{kind: 'codex', sandbox}` adds `--sandbox`;
`ClineOptions.provider` and `auto_approve` / `{kind: 'cline', provider, autoApprove}`
add `--provider` and `--auto-approve true|false`. Codex sandbox or Cline
autoApprove combined with bypass is a conflict, not a precedence rule.
See [SPEC permission migration](SPEC.md#permission-policy-and-migration).
`CopilotOptions.allow_tools` / `deny_tools` (TS `allowTools` / `denyTools`)
emit explicit repeated `--allow-tool=<rule>` / `--deny-tool=<rule>` flags.
Native denial takes precedence over grants and bypass.
`AmpOptions.mode` / `{kind: 'amp', mode}` emits `--mode <value>` for a built-in
or plugin mode; explicit model IDs are unsupported.

Configuration selection is also explicit: `executable` selects the binary;
`configHome` maps to `CLAUDE_CONFIG_DIR` for Claude Code, `CODEX_HOME` for
Codex, `HERMES_HOME` for Hermes, `GOOSE_PATH_ROOT` for Goose, `CLINE_DIR` for Cline, `COPILOT_HOME` for Copilot, and
`PI_CODING_AGENT_DIR` plus `--profile default` for OMP. `configFile` maps to
Claude Code `--settings`, Amp `--settings-file`, or `--config` for Aider, Continue, OMP and mini-SWE-agent.
mini-SWE-agent maps `configHome` to `MSWEA_GLOBAL_CONFIG_DIR`; its config file replaces the built-in config.
Qoder maps `configHome` to `QODER_CONFIG_DIR`; `QoderOptions.permission_mode`
(`permissionMode` in TS) explicitly selects `default`, `accept_edits` or `dont_ask`.
Other adapters reject unsupported typed overrides. Existing
caller-selected env remains inherited; no configuration or credential is copied.
See [SPEC](SPEC.md#supported-configuration-overrides) for precedence, current
official sources, and limits.

---

## amp

- **Distribution:** the official [native installer](https://ampcode.com/install.sh)
  installs `amp` under `~/.amp/bin` and links it onto PATH. The documented setup
  is `curl -fsSL https://ampcode.com/install.sh | bash`; inspect it before running.
  Install metadata deliberately has no argv for this shell pipeline.
  `amp version` probes the version; `amp update` updates it. Harness never installs
  or updates it during a run. Caller env `AMP_SKIP_UPDATE_CHECK=1` disables Amp's
  automatic update checks; Harness leaves caller configuration authoritative.
  Authenticate with the caller's existing `amp login` session or set
  `AMP_API_KEY` to an Amp access token from Settings → Security. The current
  [execute guide](https://ampcode.com/docs/cli/execute-mode) requires an
  `sgamp_` access token in that environment variable, not a short-lived login
  session token. Harness neither discovers nor copies credentials.
- **Command:** `amp --executor local --stream-json [--mode <mode>]
  --execute=<prompt> [--settings-file <path>]`, cwd = workdir, instructions =
  `AGENTS.md`. Prompt must be nonempty; finite stdin is additional input.
  Equals-form prompt protects leading dashes. No `--orb-execute`, `--no-tui`
  runner, continuation, remote orb or runner is selected.
- **Model/config:** no direct model flag. Omit `model` (reported as null);
  explicit nonempty models reject, even with `modelNoResolve`.
  `AmpOptions(mode="low")` / `{kind: 'amp', mode: 'low'}` selects a mode.
  Current help accepts `low`, `medium`, `high`, `ultra` and plugin mode keys or
  labels; Amp owns model/reasoning/tool routing. The observed default was
  `medium`; older execute docs still call it Standard. `configFile` replaces
  user settings, not workspace/managed settings or credentials. `configHome`
  is unsupported; `AMP_HOME` is an installer location, not an isolation mapping.
- **Permissions:** [current upstream docs](https://ampcode.com/docs/tools#permissions)
  say tools run without approval by default. `upstream` does not mean read-only,
  sandboxed, or confirmation-required. Installed help also lists legacy
  permission settings; selected settings/plugins remain authoritative. No
  current bypass CLI flag is qualified, so explicit `bypass` rejects. Use caller
  settings/policy plugins or an isolated environment for tool restrictions.
  IDE context, plugins and MCP remain upstream configuration, not silently
  disabled by Harness.
- **Output:** [JSONL schema](https://ampcode.com/docs/cli/streaming-json).
  Ordered complete object events remain in `raw`, including native `session_id`,
  mode, messages, tool activity and failures. Thread identity is not a controlled
  session handle. The native CLI creates and normally archives a new thread;
  Harness does not delete it or scrape unrelated thread history.
  Input/output totals prefer final top-level result usage, otherwise sum observed
  top-level assistant usage per field. Cache counts stay raw; missing usage
  and USD remain null. Partial output preserves completed records/counts.
  See [exact accounting](SPEC.md#amp).
- **Failure:** `result.is_error` is a native semantic failure even if process
  exit is zero. Inspect raw in addition to Harness termination/exit status.
  Stream capture/callbacks, timeout and cancellation use the shared owned-process
  lifecycle. Remote operations, stream-JSON input, thinking blocks, feature flags,
  plugin readiness controls and session APIs are not exposed by this adapter.
- **Dated evidence (2026-09-08):** checksum-verified isolated native release
  `0.0.1788868861-g921679` on macOS arm64 accepted local execute/JSONL/settings
  flags and completed a bounded no-tool probe in about five seconds. Public
  Python async and built-package Node runs also retained/streamed the native
  error (21.3s and 7.2s within 30s limits). Python sync timeout and Node abort
  stopped native startup in 0.10s and 0.12s; these do not qualify tool-child teardown.
  Native init reported an empty tool/MCP set and the configured account returned
  `Out of Credits`, `is_error: true`, process exit 0. No account switch, credit
  purchase, global install/config change or package publication was performed.
  Successful provider completion, real tool-child teardown, plugins/MCP,
  remote execution and Linux native behavior remain unqualified. Deterministic
  shared fixtures are separate evidence, not provider success.


## Cost + token reporting at a glance

This table describes headless `parseOutput` / `parse_output`, not session-log
helpers. "Populated" requires the expected output or database to be available.

| adapter      | `cost_usd`        | `tokens_in` / `tokens_out`    | source                            |
| ------------ | ----------------- | ----------------------------- | --------------------------------- |
| claude-code  | populated         | populated                     | `--output-format json` envelope   |
| openclaude   | populated         | populated                     | `--output-format json` envelope   |
| factory-droid| optional fields only | optional fields only     | documented JSON omits usage/cost; extended-field parsing is fixture-only |
| opencode     | reported when available | assistant sums when available | exact native session ID from JSONL; read-only SQLite |
| codex        | **null**          | populated (summed from JSONL) | JSONL turn events on stdout       |
| gemini       | estimated         | populated (summed)            | `stats.models` tokens + built-in pricing |
| aider        | **null**          | populated (regex parse)       | "Tokens: N sent, M received" log  |
| swe-agent    | populated         | populated                     | trajectory JSON post-exit         |
| qwen         | **null**          | populated                     | JSON array, last `type:'result'` item `usage` |
| continue-cli | **null**          | **null**                    | `--format json` contains model-generated output, not trusted usage |
| pi           | populated         | populated                     | `--mode json` event stream, summed from `agent_end.messages[].usage` |
| omp          | populated when reported | populated when reported | JSONL completed-cycle usage, with partial-message fallback |
| crush        | reported when available | last-step/context counters, **not run totals** | exact native session UUID from verbose stderr; read-only SQLite |
| kilo         | reported when available | assistant sums when available | exact native session ID from JSONL; read-only SQLite |
| hermes       | **null**          | **null**                      | not parsed; stdout is preserved verbatim, only `session_id:` stderr lines are read |
| cline        | when reported     | when reported                 | last top-level `run_result.usage`; partial streams retain raw events with null totals |
| goose        | optional upstream cost (may be estimated) | optional cumulative totals | last JSONL `complete` event; partial stream without completion has null metrics |
| copilot      | **null**          | **null**                      | JSONL native events retained; premium requests/AI credits are not USD or token totals |
| amp          | **null**          | optional result totals / observed assistant sums | top-level JSONL usage; cache fields remain raw |
| mistral-vibe | **null** | **null** | JSONL completed history entries retained; no terminal usage totals |
| cursor       | **null**          | optional uncached input / output | last JSONL `result.usage`; absent/invalid counts remain null |
| kiro         | **null**          | **null** | native ACP JSONL objects retained; accounting schema unqualified |
| kimi-code    | **null**          | **null** | complete print JSONL objects retained; no evidenced aggregate accounting |
| qoder        | **null**          | **null** | JSON result or diagnostic JSONL objects; unqualified accounting |

Headless cost is null for codex, aider and qwen; hermes reports null cost and tokens because its `--quiet` output has no machine-readable usage contract. Gemini estimates cost from token totals and the first model in `stats.models` when pricing is known. Selected session-log parsers also derive estimates, so their cost behavior can differ from headless parsing.

---

## Cross-cutting: model normalization

- Canonical model names (for example `gpt-5.4`) are accepted where the CLI exposes model selection.
- Harness normalizes model IDs at `buildCommand` time:
  - **Provider-required CLIs** (`opencode`, `swe-agent`, `aider`, `kilo`) get `provider/model` forms.
  - **Bare-model CLIs** (`codex`, `claude-code`, `qwen`, `gemini`) get known provider prefixes stripped.
  - **continue-cli** preserves explicit `owner/package` Hub slugs; omitted model delegates to upstream config.
  - **pi** prefixes bare `gpt-5*` models with `openai-codex/` and preserves recognized explicit providers.
  - **factory-droid** preserves managed model IDs and explicitly supplied `custom:` IDs; it never invents BYOK configuration.
  - **crush** preserves explicit provider prefixes and passes bare names through.
  - **openclaude** preserves provider-namespaced model IDs, including gateway routing keys.
  - **hermes** has no library default and no rewriting: an explicit model is trimmed and passed to `--model` as given; an omitted model leaves the upstream `config.yaml` selection in charge and reports `model` as null.
  - **cline** has no library default; model IDs pass through trimmed, without provider-prefix inference. `ClineOptions.provider` selects the provider independently. Omitted choices use upstream configuration.
  - **copilot** preserves explicit model IDs after trimming; omitted model delegates to upstream selection and reports null.
  - **cursor** preserves native model IDs after trimming, including parameterized bracket overrides; omission uses native selection and reports null.
  - **omp** preserves bare names and all explicit provider prefixes; OMP resolves its own fuzzy aliases.
  - **goose** preserves explicit model IDs without provider inference; omitted/empty model delegates to upstream config and reports null.
  - **amp** rejects explicit nonempty model IDs. `AmpOptions.mode` selects an upstream mode, not a model.
  - **mistral-vibe** preserves explicit model aliases after trimming via child `VIBE_ACTIVE_MODEL`; omitted model uses upstream configuration and reports null.
  - `modelNoResolve` / `model_no_resolve` bypasses normalization, not capability checks; surrounding whitespace is still trimmed.
- Fairness default for frontier adapters is strict single-model:
  - `crush`: `--model == --small-model`
  - `kilo`: default `model == small_model` via `KILO_CONFIG_CONTENT`; an existing caller-selected config is preserved
  - `openclaude`: no `--fallback-model`
  - `factory-droid`: `--model == --spec-model`

---

## omp (Oh My Pi)

- **Distribution / executable:** [`@oh-my-pi/pi-coding-agent`](https://www.npmjs.com/package/@oh-my-pi/pi-coding-agent) supplies `omp`. This is [Oh My Pi](https://github.com/can1357/oh-my-pi), not Pi or Prime Agent.
- **Setup:** upstream recommends `bun install -g @oh-my-pi/pi-coding-agent` (Bun ≥ 1.3.14); `brew install can1357/tap/omp` is also supported and used by install metadata. Authenticate with upstream in the caller-selected home; Harness never copies credentials.
- **Checked September 8, 2026:** npm metadata reports 18.1.14, `omp: dist/cli.js`, Bun ≥ 1.3.14. Installed help/version qualification used a locally patched managed `omp/18.1.10`, not a claim that every 18.x release works.
- **Instructions / model:** owned `AGENTS.md` projection; default `sonnet`. Explicit bare names and `provider/model` strings pass through unchanged apart from shared whitespace trimming. Use a provider-qualified model when provider choice matters; no Pi-style provider inference or helper-model pinning is applied.
- **Command:** `omp --print --mode json --no-session --model MODEL [--profile default] [--auto-approve] [--config FILE] -- PROMPT`. The separator keeps flag-shaped and `@file`-shaped prompts literal.
- **Configuration:** `configHome` selects `PI_CODING_AGENT_DIR` and emits `--profile default`, since named profiles otherwise ignore that variable. It does not isolate global/project discovery or all caches. `configFile` is an additional upstream config overlay. Existing env/profile choices remain upstream-controlled when no typed home override is supplied.
- **Permission:** omitted policy leaves upstream behavior intact. Explicit bypass emits `--auto-approve`; no sandbox or interactive approval transport is provided. No typed native options are claimed.
- **Lifecycle:** the shared runner owns only its child process group, deadline/cancellation, bounded stdout/stderr capture and instruction lease. `--no-session` makes the primary conversation ephemeral; it is not a promise of zero upstream cache/state writes. Cleanup never invokes global `omp ps`, GC or daemon shutdown.
- **Backend boundary:** chunk streaming and cancellation work through the common CLI API. One-shot SDK/RPC selection still rejects. The separate session API exposes an explicit OMP SDK backend through an owned Bun bridge in both languages; OMP RPC/ACP remain unsupported. See [SDK dependencies, configuration and capability limits](SPEC.md#optional-omp-sdk-sessions).

### Structured output and failures

JSONL `message_end`, `turn_end` and `agent_end.messages` repeat assistant usage.
The parser uses each completed cycle's `agent_end.messages` as authoritative,
sums multiple cycles, and falls back to complete `message_end` records for an
unfinished cycle (`turn_end` when that turn has no message-end record).
Stream deltas never count as usage. An incomplete final line is ignored;
complete object records, including unknown events and native errors, remain in
`raw`. Missing or malformed metrics remain independently null; explicit zero
remains zero. `input`/`output` exclude separate cache counts; `cost.total` is
upstream-reported USD, not proof of subscription billing.

**Process exit is not semantic success:** OMP JSON mode can emit assistant
`stopReason: "error"` or `"aborted"` with exit code zero. Harness preserves the
actual process status and raw native error; callers must inspect terminal
assistant records as well as lifecycle fields. It does not rewrite exit codes
or pretend an upstream error is a parser failure.

Sources: [pinned print-mode implementation](https://github.com/can1357/oh-my-pi/blob/v18.1.10/packages/coding-agent/src/modes/print-mode.ts),
[argument parsing](https://github.com/can1357/oh-my-pi/blob/v18.1.10/packages/coding-agent/src/cli/args.ts),
[environment precedence](https://github.com/can1357/oh-my-pi/blob/main/docs/environment-variables.md),
[native RPC reference](https://github.com/can1357/oh-my-pi/blob/main/docs/rpc.md).
Shared synthetic fixtures cover success, nonzero startup failure, native
error with zero exit, multiple cycles, malformed usage, partial output, explicit
configuration and owned cleanup. The bounded installed-CLI smoke used isolated
HOME/agent directories, an explicit config overlay and `openai-codex/gpt-5.4`,
with tools/extensions/skills/rules disabled by an explicit smoke wrapper.
Python `run`/`run_async` and TypeScript `run`/`runAsync` each returned the native
missing-credential failure in under two seconds, retained the session header,
honored the selected agent home over an inherited named profile, streamed stdout,
restored existing instructions and released the lease. Each had a 30-second
deadline and 64-KiB capture bound. No credentials were copied. Real-provider
success, other providers, and an unmodified 18.1.14 runtime remain unqualified;
synthetic success fixtures do not fill that gap.

---

## claude-code

- **CLI**: `claude`
- **Instructions file**: `CLAUDE.md`
- **Default model**: `sonnet`
- **Command**: `claude -p <prompt> --model <model> --output-format json`; appends `--append-system-prompt <instructions>` when instructions are non-empty.
- **Token source**: JSON envelope on stdout → `usage.input_tokens`, `usage.output_tokens`
- **Cost source**: JSON envelope → `total_cost_usd`
- **Env**: none required

### Output shape
```json
{ "type": "result", "result": "...", "usage": { "input_tokens": N, "output_tokens": M }, "total_cost_usd": 0.034 }
```

---

## openclaude

- **CLI**: `openclaude`
- **Instructions file**: `CLAUDE.md`
- **Default model**: `gpt-5.4`
- **Command**: `openclaude -p <prompt> --output-format json`; appends `--append-system-prompt <instructions>` when non-empty, then `--model <model>` unless OpenAI-compatible mode is selected.
- **OpenAI-compatible mode**: when `RunSpec.env` contains a non-empty `OPENAI_API_KEY` or `OPENAI_BASE_URL`, harness sets `CLAUDE_CODE_USE_OPENAI=1`, omits `--model`, and sets `OPENAI_MODEL=<model>` unless already in `RunSpec.env`. It does not add a `--provider` flag. Process environment alone does not select this branch.
- **Token source**: JSON envelope on stdout → `usage.input_tokens`, `usage.output_tokens`
- **Cost source**: JSON envelope → `total_cost_usd`
- **Fairness**: harness does not pass `--fallback-model` (single-model default)

### Output shape
```json
{ "type": "result", "subtype": "success", "usage": { "input_tokens": N, "output_tokens": M }, "total_cost_usd": 0.012 }
```

---

## factory-droid

- **CLI**: `droid`
- **Instructions file**: `AGENTS.md`
- **Default model**: `gpt-5.4`
- **Command**: `droid exec --output-format json --model <model> --spec-model <model> <prompt>`. A managed model stays unchanged; BYOK requires the caller's exact configured `custom:` ID.
- **Token/cost source**: the documented JSON envelope omits usage and cost, so ordinary output returns null metrics. Extended `usage` / `total_cost_usd` fields are parsed if present, but only synthetic fixtures cover those fields here.
- **Fairness**: harness pins `--model` and `--spec-model` to the same normalized model

---

## codex

- **CLI**: `codex`
- **Instructions file**: `AGENTS.md`
- **Default model**: `gpt-5.3-codex`
- **Command**: `codex exec -m <model> --json -C <workdir> <prompt>`
- **Token source**: JSONL on stdout; sum `usage.{input_tokens, output_tokens}` across every `turn.completed` event
- **Cost source**: not reported — always `null`
- **Env**: none required

### Output shape
```
{"type":"turn.started", ...}
{"type":"turn.completed", "usage":{"input_tokens":123,"output_tokens":45}}
{"type":"turn.completed", "usage":{"input_tokens":200,"output_tokens":88}}
...
```

---

## gemini

- **CLI**: `gemini`
- **Instructions file**: `GEMINI.md`
- **Default model**: `gemini-2.5-pro`
- **Command**: `gemini -p <prompt> -m <model> --output-format json`
- **Token source**: JSON envelope → iterate `stats.models[*].tokens.{input, candidates}` and sum
- **Cost source**: estimated from token totals and the first model in `stats.models` using built-in pricing; null if pricing is unavailable.
- **Env**: `GOOGLE_GENAI_USE_VERTEXAI`, `GOOGLE_CLOUD_PROJECT` (consumer sets for free $300 credits; harness doesn't require them)

### Output shape
```json
{
  "response": "...",
  "stats": {
    "models": {
      "gemini-2.5-pro": { "tokens": { "input": N, "candidates": M } }
    }
  }
}
```

Parsing is fallback-tolerant: try whole-stdout as JSON first, then scan each `{`-prefixed line. A recognized stats block can report zero tokens; zero is distinct from an unparseable response.

---

## opencode

- **CLI**: `opencode`
- **Instructions file**: `AGENTS.md`
- **Default model**: `gpt-5.4` (normalized to `openai/gpt-5.4`)
- **Command**: `opencode run --format json --dir <workdir> --model <model> <prompt>`
- **Identity**: the top-level `sessionID` in native JSONL `step_start`, `step_finish`, `text`, `reasoning`, `tool_use` or `error` events. Missing or conflicting IDs return null metrics; message text is not an identity source.
- **Database**: `OPENCODE_DB` from effective child env is authoritative. Absolute paths are literal; relative values (including `~/…`) are joined to the upstream data directory, not the workdir. `:memory:` is unavailable after exit. Explicit choices never fall back.

The upstream data directory is `<XDG_DATA_HOME>/opencode`, or
`<HOME>/.local/share/opencode` when XDG is unset/empty. Upstream
[`xdg-basedir` 5.1.0](https://github.com/sindresorhus/xdg-basedir/blob/v5.1.0/index.js)
also accepts relative XDG values; these resolve against the child workdir.
The build-time release channel selects `opencode.db` for latest/beta/prod,
otherwise `opencode-<sanitized-channel>.db`. The channel is not in run JSON or
`--version`. Without a DB override, Harness checks direct `.db` files in that
data directory for the **exact observed ID** and requires one unique match.
`OPENCODE_DISABLE_CHANNEL_DB=1|true` limits lookup to `opencode.db`.
No basename, substring, timestamp or latest-session ranking is used.
Harness does not invoke `opencode db path`: its upstream imports create global
directories and initialize database machinery.

### Post-exit assistant selection

After verifying the exact session row, the readers select assistant fields
(simplified SQL below; JSON type checks also reject booleans and nonnumeric usage):

```sql
SELECT json_extract(data, '$.tokens.input') AS tokens_in,
       json_extract(data, '$.tokens.output') AS tokens_out,
       json_extract(data, '$.cost') AS cost,
       json_extract(data, '$.modelID') AS model,
       json_extract(data, '$.providerID') AS provider
FROM message
WHERE session_id = ?
  AND json_extract(data, '$.role') = 'assistant';
```

The parameter is the observed native ID, never a directory hint. Each metric
is summed only when every assistant row reports a valid nonnegative value;
absent/null/invalid fields make that metric unavailable, not zero or a partial
sum. No assistant rows means null metrics. Model telemetry requires unanimous
nonempty model and provider IDs. Mixed models may still have reported cost;
Harness never prices their combined tokens with a single model.

`raw` contains `{"sessionID":"ses_…","costSource":"reported"}` when cost is
available, otherwise `"costSource":"unavailable"`. An observed ID survives a
missing database. Missing/conflicting identity returns `raw: null`.
These adapters produce **no Harness cost estimates**: reported zero remains
zero, including the current upstream runner's literal `cost: 0`. “Reported”
identifies the upstream field, not measured billing or a free run.

Current upstream maps `tokens.input` to non-cached input and `tokens.output`
to visible output. Cache reads/writes and reasoning are separate fields.
Harness preserves input/output as reported and does not add cache tokens,
reasoning or historical pricing multipliers. Older provider paths may differ.

### Explicit session telemetry

For OpenCode, Kilo and Crush, `sessionLogPath(workdir, since)` returns null:
neither a workdir nor a timestamp establishes native ownership.
`parseSessionLog("<database-path>#session=<percent-encoded-native-ID>")`
reads only that explicit session, with the same zero/unavailable behavior and
raw provenance. Bare database paths and the former `#session(basename)` hint
return unavailable metrics. No legacy latest-session fallback remains.
Python uses the equivalent snake_case methods. Bun uses `bun:sqlite`, Node
uses `better-sqlite3`; unavailable drivers/artifacts return null metrics.
Database connections are read-only and bounded.

### Qualification

Primary sources refreshed September 8, 2026:
[run JSON emitter](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/cli/cmd/run.ts),
[database resolver](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/database/database.ts),
[global paths](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/global.ts),
[token mapping](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/session/runner/publish-llm-event.ts),
[runner cost](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/session/runner/llm.ts).
Shared synthetic fixtures exercise identity conflicts, concurrent same-basename
workdirs, channel ambiguity, relative overrides, missing artifacts, mixed
models, cache accounting and zero versus missing cost in both languages.
These are deterministic conformance, not provider qualification.
On this execution host OpenCode and Kilo are not on PATH; Crush v0.62.0 version
and `run --help` were checked separately. An isolated Crush invocation accepted
the flags and exited 1 with no provider configured. This is not provider success
or a billing qualification; no credentials or global configuration were read
or changed.

---

## aider

- **CLI**: `aider`
- **Instructions file**: `.harness-aider-instructions.md`, supplied as text through `--read`
- **Default model**: `openrouter/anthropic/claude-sonnet-4.6`
- **Command**: `aider --no-restore-chat-history --chat-history-file <null-device> --input-history-file <null-device> --model <model> --message <prompt> --no-auto-commits --no-analytics --no-show-model-warnings`; adds `--read <instructions-file>` when instructions are supplied
- **Config**: uses upstream configuration by default; explicit `configFile` adds `--config <path>`. No empty `.agentelo-aider.yml` is generated.
- **Token source**: sum rounded `sent`/`received` counts across combined stdout+stderr reports; optional `cache write`/`cache hit` fields do not suppress the report. The numeric `k` suffix scales by 1000. [Upstream emission](https://github.com/Aider-AI/aider/blob/v0.86.2/aider/coders/base_coder.py#L2023-L2030).
- **Cost source**: Aider emits a textual message/session cost report, but Harness does not parse it; always `null`.
- **Env**: caller-selected provider authentication is inherited; Harness does not select a proxy or inject a credential

### Example log line
```
Tokens: 12.3k sent, 2,145 received
```

---

## swe-agent

- **CLI**: `python3 <wrapper>` (NOT a native CLI — wraps mini-swe-agent Python API)
- **Instructions file**: none; folded into prompt via `<instructions>\n\n---\n\n<prompt>`
- **Default model**: `gpt-5.4` (normalized to `openai/gpt-5.4` for wrapper invocation)
- **Wrapper resolution**: `env.SWE_WRAPPER` → `~/agentelo/bin/run-mini-swe.py` → error
- **Command**: `python3 <wrapper> --model <model> --task <combined-prompt> --cwd <workdir> --cost-limit 10.0 --output <workdir>/.harness/swe-traj.json`
- **Preparation**: creates `<workdir>/.harness/` after acquiring the workdir lease; building only plans the directory
- **Token source**: post-exit read of `swe-traj.json` → sum `messages[*].extra.response.usage.{prompt_tokens|input_tokens, completion_tokens|output_tokens}`
- **Cost source**: `swe-traj.json` → `info.model_stats.instance_cost`
- **Env**: may set `SWE_WRAPPER` to override default wrapper path

### Trajectory JSON shape (relevant subset)
```json
{
  "info": { "model_stats": { "instance_cost": 0.23 } },
  "messages": [
    { "extra": { "response": { "usage": { "prompt_tokens": 1234, "completion_tokens": 567 } } } }
  ]
}
```

Legacy artifact discovery considers only `<workdir>/.harness/swe-traj.json`,
then `<workdir>/mini-traj.json`, filtering each by the inclusive mtime cutoff
(Python seconds; TypeScript milliseconds). It no longer reads a global
`last_mini_run.traj.json` to fill missing metrics: interactive mini normally
serializes an empty environment cwd, so that file cannot identify this workdir.
The native wrapper trajectory model comes from `extra.response.model`, then
`info.config.model.model_name`, not the `api_calls` key in `model_stats`.
These shapes are checked against mini-swe-agent 2.2.8 and
[`DefaultAgent.serialize`](https://github.com/SWE-agent/mini-swe-agent/blob/04d809ceab9df28f9adaed044884180159172930/src/minisweagent/agents/default.py)
and [model serialization](https://github.com/SWE-agent/mini-swe-agent/blob/04d809ceab9df28f9adaed044884180159172930/src/minisweagent/models/litellm_model.py).

An isolated 2.2.8 PTY capture reached `What do you want to do?` and the
`Submit message: Esc, then Enter` footer without submitting a task. No actual
spinner/approval pane was captured; pane precedence is unchanged. Native
mini-SWE support remains [TWA-82](https://linear.app/twaldin/issue/TWA-82).

---

## qwen

- **CLI**: `qwen`
- **Instructions file**: `QWEN.md`
- **Default model**: `qwen3-coder`
- **Command**: `qwen -p <prompt> -m <model> --output-format json`
- **Token source**: JSON array on stdout → find last item with `type:'result'`, read `usage.{input_tokens, output_tokens}`
- **Cost source**: not reported — always `null` (Alibaba Cloud pricing tracked externally via API key account)
- **Env**: `QWEN_API_KEY` (consumer sets; harness does not require or inject it)

### Output shape
```json
[
  { "type": "assistant", "content": "..." },
  { "type": "result", "usage": { "input_tokens": N, "output_tokens": M } }
]
```

Parsing is fallback-tolerant: try whole-stdout as JSON first, then scan each `[`-prefixed line. First match containing a `type:'result'` item wins.

---

## continue-cli

- **CLI**: `cn`
- **Instructions file**: `CONTINUE.md`, explicitly passed through `--rule <absolute-path>`; Continue does not discover this root filename itself.
- **Default model**: none; existing upstream configuration selects it. Adapter metadata uses an empty string for no default; reported command/result model is null.
- **Command**: `cn -p <prompt> [--model <owner/package>] [--rule <instructions-file>] --format json`.
- **Explicit config**: `configFile` uses `cn -p --config <path> [--rule <instructions-file>] --format json <prompt>`. Leave `model` unset: the file selects it. Without a config file, an explicit model must be a Continue Hub `owner/package` slug, not a bare provider model ID.
- **Permissions**: default preserves upstream exclusion of ask-tier tools in headless mode. Explicit bypass adds `--auto`; no permission flag is inserted otherwise.
- **Credential safety**: no generated YAML. Explicit OpenAI-compatible env selection requires a caller-selected `configFile`.
- **Token/cost source**: none in headless stdout. `--format json` emits model-authored JSON verbatim or wraps text in `{response,status,note}`. Even usage-shaped model output is not billing telemetry; metrics remain null.
- **Env**: caller-selected provider/Continue authentication is inherited; Harness does not require or inject it.

### Output shape
```json
{ "response": "added docstrings", "status": "success", "note": "Response was not valid JSON, so it was wrapped in a JSON object" }
```

---

## pi

- **CLI**: `pi` from `@earendil-works/pi-coding-agent` (Node >=22.19.0 for 0.85.1). Official npm installation recommends `--ignore-scripts`.
- **Instructions file**: `AGENTS.md` (pi also auto-reads `CLAUDE.md` via context-file discovery)
- **Default model**: `sonnet`
- **Command**: `pi --mode json --no-session --model <model> <prompt>`
- **Token source**: JSON event stream on stdout → find the last `agent_end` event, sum `messages[*].usage.input` / `.output` across assistant messages. Falls back to summing `turn_end.message.usage` events if the stream is truncated.
- **Cost source**: same path, summed from `usage.cost.total`
- **Env**: provider-specific API keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.) set by the consumer; harness does not inject them

### Output shape
pi emits one JSON object per stdout line:
```json
{"type":"session","version":3,"id":"...","cwd":"..."}
{"type":"agent_start"}
{"type":"turn_start"}
{"type":"message_end","message":{"role":"assistant","usage":{"input":1200,"output":340,"cost":{"total":0.0087}}}}
{"type":"turn_end","message":{"role":"assistant","usage":{...}},"toolResults":[]}
{"type":"agent_end","messages":[{"role":"user","content":"..."},{"role":"assistant","usage":{...}}]}
```

The adapter prefers `agent_end.messages` (authoritative final state) over per-turn events.

Full event reference: [Pi JSON event contract](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/json.md). `--mode json` is noninteractive; no built-in permission popup/sandbox is implied. Project trust is a separate upstream setting, not Harness bypass.

---

## crush

- **CLI**: `crush`
- **Instructions file**: `AGENTS.md`
- **Default model**: `gpt-5.4`
- **Command**: `crush run --verbose --data-dir <data-dir> --model <model> --small-model <model> <prompt>`
- **Identity**: anchored stderr `INFO  Created session for non-interactive run session_id=<UUID>`, emitted by `--verbose`. Stdout remains assistant text and is never scraped for identity. Missing/conflicting records return unavailable metrics. This is a qualified native log, not a stable JSON protocol; format changes fail closed.
- **Data directory**: default `<workdir>/.harness/crush-data`. The existing Harness `CRUSH_DATA_DIR` convention maps caller/inherited env to `--data-dir`; **it is not a native Crush environment variable**. Relative values resolve against the child workdir. Caller-selected directories remain caller-owned.
- **Fairness**: both model flags use the same normalized model; caller configuration remains otherwise intact.

### Post-exit DB query

```sql
SELECT id, prompt_tokens, completion_tokens, cost
FROM sessions
WHERE id = ?;
```

The UUID parameter comes from the creation log, not the newest root session.
The model is in assistant `messages.model` / `messages.provider`, not
`sessions.model`; it is reported only when all assistant rows agree.

**Counters are not run totals.** Current Crush overwrites prompt/completion
counters with last-step usage; prompt normally includes cache reads, while
summarization uses a different update path. Per-message/cache counters are not
persisted. Harness exposes those native counters without inventing totals.
Cost accumulates across the newly created session and already includes
child-session costs; Harness does not sum children again. Upstream may compute
cost from configured pricing or use provider metadata. Flat-rate models and
estimated-usage paths can write literal zero. Reported zero is preserved, not
proof of free usage; no Harness repricing occurs. See the shared
[identity/provenance and explicit-selector contract](#opencode).

Sources checked against current main and identity emission against v0.62.0:
[run command](https://github.com/charmbracelet/crush/blob/main/internal/cmd/run.go),
[v0.62.0 local runner](https://github.com/charmbracelet/crush/blob/v0.62.0/internal/app/app.go),
[initial schema](https://github.com/charmbracelet/crush/blob/main/internal/db/migrations/20250424200609_initial.sql),
[usage accounting](https://github.com/charmbracelet/crush/blob/main/internal/agent/agent.go),
[child cost rollup](https://github.com/charmbracelet/crush/blob/main/internal/agent/coordinator.go),
[data directory resolution](https://github.com/charmbracelet/crush/blob/main/internal/config/load.go).
Installed v0.62.0 help confirms `--verbose` and `--data-dir`. A separate
credential-free invocation with an empty environment and temporary HOME/XDG
directories exited 1 in 0.54 seconds with “No providers configured”; no native
creation log was emitted. This verifies flag acceptance and the missing-provider
path, not successful provider execution or actual-run database metrics.

---

## kilo

- **CLI**: `kilo`
- **Instructions file**: `AGENTS.md`
- **Default model**: `gpt-5.4`
- **Command**: `kilo run --format json --dir <workdir> --model <provider/model> <prompt>`
- **Identity/accounting**: the same native JSONL `sessionID`, exact assistant-row selection, null/zero/provenance and explicit log-selector rules as [OpenCode](#opencode). No basename/latest-session lookup or cost estimation.
- **Env defaults**: `KILO_DB=<workdir>/.harness/kilo/kilo.db` and `KILO_CONFIG_CONTENT={"model":"<provider/model>","small_model":"<provider/model>","default_agent":"build"}`. Generated model configuration is used only when neither caller nor inherited env selected it.

Caller `KILO_DB` values remain verbatim in the command environment. Absolute
paths are literal; relative paths resolve under `<XDG_DATA_HOME>/kilo` (or
`<HOME>/.local/share/kilo`), rather than directly under the workdir. Relative
XDG values resolve against the child cwd, as in OpenCode. Upstream strips
CR/LF from its XDG-derived paths. `:memory:` yields unavailable metrics.
Explicit choices never fall back; caller-owned DB parents are not prepared.
The default injected absolute DB path deliberately overrides upstream channel
storage. When upstream selects storage itself, stable channels use `kilo.db`;
other channels use `kilo-<channel>.db`, with legacy `opencode-<channel>.db`
fallback. An explicit empty `KILO_DB` clears the Harness default and inherited
choice: exact-ID discovery then requires one matching native channel database,
or uses only `kilo.db` when `KILO_DISABLE_CHANNEL_DB=1|true`.

Current Kilo has the same separate non-cached input, visible output, cache
and reasoning fields as OpenCode, and its runner also writes literal zero
cost. “Reported” is upstream provenance, not a billing guarantee.
Sources refreshed September 8, 2026:
[native emitter](https://github.com/Kilo-Org/kilocode/blob/main/packages/opencode/src/cli/cmd/run.ts),
[database path and channel fallback](https://github.com/Kilo-Org/kilocode/blob/main/packages/core/src/database/database.ts),
[global paths](https://github.com/Kilo-Org/kilocode/blob/main/packages/core/src/global.ts),
[usage mapping](https://github.com/Kilo-Org/kilocode/blob/main/packages/core/src/session/runner/publish-llm-event.ts),
[runner cost](https://github.com/Kilo-Org/kilocode/blob/main/packages/core/src/session/runner/llm.ts).
Kilo is not installed on PATH here; shared conformance is synthetic, not
provider smoke.

---

## cursor

- **Distribution / executable**: the [official installer](https://cursor.com/install) installs the standalone `agent` executable and legacy `cursor-agent` alias. The editor's `cursor` launcher is different. On macOS/Linux, install with `curl https://cursor.com/install -fsS | bash`; update explicitly with `agent update`; check `agent --version`. Harness never installs/updates automatically. `executable` can select an absolute isolated installation.
- **Command**: `agent --print --output-format stream-json --stream-partial-output [--model MODEL] [--force] -- PROMPT`. The prompt is one literal argument, including leading dashes/newlines. Empty prompts reject before preparation. The shared lifecycle projects/restores root `AGENTS.md`; Cursor also reads native `CLAUDE.md` and `.cursor/rules`.
- **Model / config / auth**: no Harness model default or provider rewrite. `configHome` maps to documented `CURSOR_CONFIG_DIR`; `configFile` is unsupported. This relocates configuration, not all data or credentials: native source separately uses `CURSOR_DATA_DIR` for project data. Preserve caller-selected native environment and login (`agent login`) or `CURSOR_API_KEY`; Harness does not harvest/copy credentials, switch accounts or alter global configuration. Available models and entitlement depend on that account.
- **Permissions**: upstream mode injects no grants. Do **not** treat `--print` alone as a read-only security boundary. The [headless guide](https://cursor.com/docs/cli/headless) says edits require `--force`, but the current [permissions reference](https://cursor.com/docs/cli/reference/permissions) and installed help explicitly give print mode write/shell tools governed by native permissions. Existing allow/deny and sandbox/team policies matter. Explicit bypass adds only `--force` (force-allow unless explicitly denied); Harness adds no separate `--trust`, `--approve-mcps` or `--sandbox` override. Native `--mode ask` / `plan` advertise read-only behavior but have no Harness mapping; callers needing that mode must use Cursor directly. Actual editing/permission enforcement was not provider-tested.
- **Output / metrics**: `raw` retains all complete object events in order, including assistant deltas and duplicate buffered/final flushes. Use the terminal `result.result` for final text rather than concatenating all assistant events. Malformed/truncated/non-object lines are skipped by parsing but remain in stdout. The last `type: "result"` owns optional `usage.inputTokens` / `outputTokens`; counts must be nonnegative safe integers (at most 2^53 - 1), independently validated. Installed source subtracts cache reads/writes before emitting `inputTokens`; do not add them back. No cost derivation. The online result example omits usage; older/missing fields stay null. Native error events never replace process exit/termination.
- **Capabilities / ownership**: one-shot CLI, raw-chunk streaming, cancellation, explicit bypass and config-home override. SIGINT is the graceful signal because native headless mode wires it to its abort controller/background-work registry; the shared engine owns escalation and instruction cleanup. No native options, alternate text/JSON format selection, ask/plan, sandbox/trust/MCP grants, attachments, persist/resume, worktrees, cloud workers, ACP/RPC/SDK, pane or session-log mapping. Unsupported backend/config/native-option requests reject rather than silently disappearing.

### Cursor qualification and limits

Checked September 8, 2026: current official installer selected **2026.09.02-c22c1a3**; its Darwin arm64 archive was extracted into a disposable directory, not installed globally. The bundled launcher execs its bundled Node runtime; `--version`, `--help`, native auth status and shipped JS headless/config/permission/signal code were checked. Shared success, failure, partial-stream and optional-usage fixtures are synthetic, not provider observations.

Bounded Python, Bun and packaged Node runs (20-second deadlines, upstream and bypass policies, disposable work/config/data directories) each exited 1 in one to three seconds with native `Authentication required` stderr, empty stdout/raw, working output callbacks and restored instruction files. The selected native status was unauthenticated. No login/account/config change was attempted.

**Not covered:** successful provider response, live token accounting, read/write/shell permission enforcement, workspace/MCP approval, or cancellation while actual tools/subagents are running. Native source can spawn shell tools in detached process groups; SIGINT requests native abort, but arbitrary detached/escaped descendants are not guaranteed stopped by Harness group teardown. No global worker/session cleanup is attempted. Qualify the caller's selected version/configuration before relying on tool cleanup; conformance proves the shared owned-process machinery, not all Cursor extensions.

## copilot

- **Distribution / executable**: official [`@github/copilot`](https://github.com/github/copilot-cli), binary `copilot`; this is not the old `gh copilot` shell helper. [Setup](https://docs.github.com/en/copilot/get-started/cli-quickstart) documents `npm install -g @github/copilot` with Node.js 22+, or `brew install --cask copilot-cli`. Harness never installs or updates it automatically; install metadata is caller-driven.
- **Command**: `copilot --no-auto-update --no-remote-export --no-ask-user --output-format json [--model MODEL] [permission flags] --prompt=PROMPT`. Disables update downloads, remote session export/control and interactive questions for this local subprocess invocation. It does not disable the caller's configured tools, MCP servers or custom instructions.
- **Prompt / instructions**: nonempty prompt passed verbatim with equals syntax, including leading dashes and newlines; empty rejects before preparation. The shared lifecycle temporarily projects `AGENTS.md` and restores it after owned teardown.
- **Model / configuration**: no Harness default model and no provider rewriting. A trimmed explicit ID is sent as `--model`; omission delegates to upstream selection and reports null. `configHome` maps to `COPILOT_HOME` (configuration and session state); it does not copy credentials or isolate all upstream discovery. `configFile` is unsupported. Existing provider/config environment remains caller-selected.
- **Permissions**: `upstream` injects no grant; noninteractive tools may be denied rather than prompting. `CopilotOptions(allow_tools=(...), deny_tools=(...))` / `{kind: 'copilot', allowTools: [...], denyTools: [...]}` maps each rule to `--allow-tool=<rule>` / `--deny-tool=<rule>`. Empty arrays add nothing; invalid member types, empty/whitespace-only rules and NULs reject. Native rules are preserved verbatim. Denial takes precedence over grants. `bypass` explicitly adds `--allow-all`, which allows tools, paths and URLs; it is never inferred from headless mode.
- **Authentication / billing**: GitHub-hosted models require the selected account's Copilot entitlement, available quota and applicable organization policy. Keep native host-local login; [documented token precedence](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-programmatic-reference) is `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`, then stored credentials. No account, subscription or billing changes occur in Harness. [BYOK](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/use-byok-models) uses caller-selected provider environment, including optional offline mode; it is not an automatic fallback.
- **Output**: `--output-format json` emits JSONL. All complete JSON objects are retained in order in `raw`, including assistant deltas/messages, `session.error`, `abort` and terminal `result`. Nonobjects, noise and malformed/partial lines are ignored by parsing but retained in stdout. The result event's `sessionId` is available to the caller without any latest-session search. Native errors never overwrite the actual process exit/termination.
- **Metrics**: token and USD totals are null. Qualified JSONL `result.usage` reports premium requests, durations and code changes; cache checkpoints/AI credits are not aggregate token or USD totals. Those native values remain in `raw`. The separate upstream `--usage-output-file` and OpenTelemetry paths are not consumed.
- **Capabilities**: CLI, raw chunk streaming and cancellation; explicit bypass and Copilot native permission rules; npm install metadata. No RPC/SDK, controlled/resumable sessions, pane or session-log helpers. Other upstream CLI choices (agents, effort, tool availability, attachments, URL/path grants, resume, ACP) have no typed Harness mapping; unknown native option fields reject rather than disappearing.

### Qualification

Checked September 8, 2026: official [programmatic reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-programmatic-reference), [command reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference), npm registry `@github/copilot` 1.0.83 and isolated installed `copilot --version`, `--help`, `help environment`. Host: macOS arm64, Node 26.6.0. No global installation, account switching or configuration edits.

A bounded no-tool GitHub-hosted request completed with exit 0 and the requested synthetic response; default upstream routing selected the model. A separate cooperative cancellation probe returned `cancelled` and retained native abort/partial output. Process sampling saw the npm Node launcher and native binary in the same owned process group, with neither remaining after normal completion or cancellation. The probe disabled built-in MCP servers and remote export; this establishes that local path, not arbitrary configured extensions.

Public-adapter smoke also passed in Python 3.11.15 and the built TypeScript
package under Node 26.6.0: deliberately omitted model, explicit deny rules,
synthetic no-tool response, streaming callbacks and restored instruction/lease
files. Node `runAsync` cancellation restored the same files. Separate explicit
`gpt-5.4` runs in both languages exited 1 because the selected account reported
that model unavailable; Harness did not substitute another model.

Shared fixtures are synthetic and exercise both public run paths, exact argv, permissions, validation, native success/failure and interrupted output. Full coding tasks, MCP/subagent/extension descendants, BYOK/offline providers, remote sessions, Linux/Windows provider execution and every subscription/model combination remain untested. Deliberately detached or remote work is outside the shared POSIX process-group cleanup guarantee.

---

## hermes

- **CLI**: `hermes` (from [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent); the [official installer](https://hermes-agent.nousresearch.com/docs/getting-started/installation/) places it under `~/.hermes/hermes-agent/` with a `hermes` launcher on `PATH`)
- **Instructions file**: `AGENTS.md` (Hermes auto-injects the workdir `AGENTS.md`; Harness projects and restores it like the other `AGENTS.md` adapters)
- **Default model**: none in the library — the upstream `config.yaml` / provider selection applies. `BuildCommand.model` and `RunResult.model` are null when `model` is omitted or empty.
- **Command**: `hermes chat --cli --quiet --query=<prompt>`; inserts `--model <model>` after `--quiet` when a trimmed explicit model is supplied, then `--yolo` for `permission_policy="bypass"`, and `--query=<prompt>` last. The `--query=` form keeps a prompt that starts with `-` from being parsed as a flag.
- **Prompt**: passed verbatim (no trimming). An empty prompt rejects with `invalid-options` before any write or spawn; whitespace-only prompts are passed through.
- **Permissions**: `upstream` adds nothing, so Hermes' own approval behavior applies and it may reject a dangerous command with stdin closed. `bypass` maps to `chat --yolo`. The top-level `hermes -z/--oneshot` path was intentionally not used: it auto-bypasses approvals, which would make the `upstream` policy impossible to honor, and its `--usage-file` only exists on that path.
- **Config**: `configHome` maps to `HERMES_HOME`, selecting an existing Hermes home (config.yaml, `.env`, sessions, skills); it is not a sandbox and nothing is copied there. `configFile` and native options are unsupported and reject. Omitted `configHome` keeps the caller's existing `~/.hermes` state.
- **Token source**: none — `tokens_in` / `tokens_out` are always `null`. Quiet output has no machine-readable usage contract, and Harness never parses Hermes stdout as JSON.
- **Cost source**: none — always `null`
- **`raw`**: `{"session_id": "<id>"}` when stderr contains a complete line matching `^session_id: ([A-Za-z0-9_-]+)\r?\n`; the last complete match wins, a truncated trailing line without its newline is ignored, and no match yields `raw: null`. Resuming that session is an upstream feature (`hermes chat --resume`), not a Harness session API.
- **stdout**: preserved verbatim in `RunResult.stdout`; the final response is whatever Hermes printed. Exit code, stderr, timeouts, cancellation and streaming chunks come from the shared subprocess engine.
- **Env**: provider credentials come from the selected Hermes home / caller env; Harness injects none. Optional terminal backends (Docker, SSH, Modal, etc.) are configured upstream by the caller; the library provisions no runtime and reads no credential.
- **Capabilities**: `cli` only; `bypass` supported; streaming and cancellation true; controlled sessions false; no session-log, pane or install helpers.

### Qualification

Installed locally: Hermes Agent v0.20.0 (2026.8.3), Python 3.11.15, OpenAI SDK 2.24.0, source `9d6c5a920c773f86fad9ea16528212faeaa21815`. Current upstream `main` (`pyproject` version 0.21.1, Python `>=3.11,<3.14`) and its [`hermes_cli/_parser.py`](https://github.com/NousResearch/hermes-agent/blob/main/hermes_cli/_parser.py) still accept `chat --cli --quiet --query --model --yolo`; the installed build lacks the newer `--query-file`, which Harness does not use. This is flag-level verification against installed help and the current parser, not provider execution.

Real CLI smoke (2026-09-08, macOS arm64): Python `run` and TypeScript `run`
each invoked installed v0.20.0 with `chat --cli --quiet --query=...` in separate
temporary HOME/HERMES_HOME/workdirs, with a 45-second Harness deadline.
Both exited 1 in about 6.7 seconds with “No inference provider configured”;
stdout was preserved, no session footer was emitted, and raw/metrics were null.
No credentials were copied or existing configuration changed. This verifies the
installed CLI's bounded missing-provider path, **not a successful provider turn**.
Provider success, model availability, tool execution, remote/container runtimes
and current-main runtime compatibility remain untested.

### Output shape

stdout is the plain final response; stderr carries the session line in quiet mode:
```
session_id: 20260908_094809_a1b2c3
```

---

## cline

- **Distribution:** standalone npm [`cline`](https://www.npmjs.com/package/cline), executable `cline`; not the VS Code extension, Continue's `cn`, or a hub client. The npm launcher runs Node and selects a platform binary with Bun embedded. [Official setup](https://docs.cline.bot/getting-started/installing-cline#cli) calls for Node 20+ (22 recommended).
- **Setup:** install with `npm install -g cline`, then authenticate explicitly with `cline auth`. To use a separate existing config root, configure it with `cline --config /absolute/cline-home auth` and select the same path using Harness `configHome`. Harness never authenticates, copies credentials, or runs the advertised install/update commands.
- **Command:** `cline --json --cwd <absolute-workdir> [--model <model>] [--provider <provider>] [--auto-approve true|false] -- <prompt>`. Empty/whitespace-only prompts reject before preparation. `--` protects leading-dash prompts. Finite stdin is also passed through; upstream appends it to the prompt.
- **Model/provider:** no Harness default and no provider inference. Omitted options leave upstream configuration in charge. `BuildCommand.model` / `RunResult.model` report the requested model or null; native resolved provider/model remain in `raw` when upstream emits them.
- **Instructions:** Harness temporarily projects `CLINE.md` in the workdir and prefixes the prompt with `Follow the instructions in @./CLINE.md` followed by a blank line. Cline's [native file-mention resolver](https://github.com/cline/cline/blob/595f1dbf2ea819e987afeadb4ed4dd9a0ae9a55e/apps/cli/src/runtime/prompt.ts#L104-L204) includes that file. The mention has no trailing punctuation, which upstream would treat as part of the filename. This is explicit attachment, not a claim that upstream auto-loads `CLINE.md`; upstream's existing project/global rules remain in effect.
- **Permissions:** upstream normally auto-approves. Omitted policy adds no flag. `bypass` maps to `--auto-approve true`; `ClineOptions(auto_approve=False)` / `{kind: 'cline', autoApprove: false}` requests approval, which non-TTY tool execution denies. Combining any explicit native autoApprove with bypass rejects. Approval denial can still precede an exit-zero completed response; inspect native tool events when that distinction matters. Upstream `ask_question` may choose its first offered option with no TTY; Harness supplies no interactive response channel.
- **Config:** `configHome` maps to native `CLINE_DIR`, the config root used by `--config`. This is not a sandbox or an isolation guarantee: upstream reads project/global rules and writes provider/model/session state. Existing `CLINE_DATA_DIR` and other caller-selected state overrides still apply. `configFile` is unsupported; `--config` takes a directory, not a config file.
- **Owned mode:** every invocation sets `CLINE_SESSION_BACKEND_MODE=local`, `CLINE_NO_AUTO_UPDATE=1`, and `CLINE_RUN_AS_HUB_DAEMON=0`. These prevent shared-hub routing, the detached automatic npm updater, and accidental daemon entry. Conflicting explicit `env` values reject rather than silently changing execution mode. Effective `CLINE_TOOL_APPROVAL_MODE=desktop` rejects because it delegates approval to an external desktop service. No hub/daemon is started or stopped by Harness.
- **Cancellation:** `BuildCommand.gracefulSignal="SIGINT"` selects one SIGINT through the common lifecycle engine, followed by the existing bounded SIGKILL fallback. Cline 3.0.61's one-shot SIGTERM handler cannot abort its active session; SIGINT disposes it, including ordinary shell tools that Cline places in separate process groups. External command drivers must honor the planned signal. Forced kill/crash, deliberately backgrounded tools and remote/container processes remain outside guaranteed cleanup; this is not a descendant-adoption supervisor.
- **Capabilities:** CLI, raw chunk streaming, cancellation, native Cline provider/approval options, configHome and explicit bypass. No RPC/SDK fallback, controlled sessions, resume, daemon, pane or session-log helpers.

### JSON and result parsing

Cline 3.0.61 emits NDJSON objects such as `hook_event`, `agent_event`,
`team_event`, `run_result` and `run_aborted`; timestamps are ISO strings.
The documentation's `ask`/`say` table does not match this release.
Harness retains every parsed stdout object, including unknown event kinds, in
`raw`; malformed/non-object lines are skipped there but remain in `stdout`.
Stderr remains verbatim, including JSON errors and non-JSON runtime warnings.

Metrics come only from the **last top-level `run_result.usage`**:
`inputTokens`, `outputTokens`, `totalCost`. Token counts must be nonnegative safe
integer numbers; cost must be finite and nonnegative. Invalid or absent metrics
are individually null. Repeated `agent_event.usage`, `done`, and the echoed
`aggregateUsage` are not added again. Without a terminal result, raw partial
events remain available and all metrics are null.

`exitCode` is the actual process status, not synthesized agent success.
A successful task requires a terminal `run_result.finishReason="completed"`
as well as a successful process result. In particular, upstream can exit zero
after SIGINT or an abort. Harness-triggered cancellation/timeouts retain their
own terminal classification even when the CLI exits zero.

### Qualification — 2026-09-08

Isolated npm `cline@3.0.61` on macOS arm64, Node 26.6.0; `--version` and
`--help` checked. Source pinned to
[`595f1dbf`](https://github.com/cline/cline/tree/595f1dbf2ea819e987afeadb4ed4dd9a0ae9a55e/apps/cli).
The official package was invoked against a synthetic loopback OpenAI-compatible
endpoint: text completion, shell-tool execution, default/true approval,
false approval under EOF, and SIGINT shell cleanup were exercised.
These are **real CLI / synthetic provider** checks, not provider qualification.
An isolated real Cline-provider attempt returned an explicit authentication
error with exit 1. No real provider succeeded; no credentials were copied,
global configuration changed, shared services stopped, or packages published.
The isolated `--data-dir` probe lacked auth and did not qualify that mode.

## goose

- **Distribution / setup:** official native `goose` binary from
  [aaif-goose/goose](https://github.com/aaif-goose/goose) (formerly `block/goose`).
  The [official installation guide](https://goose-docs.ai/docs/getting-started/installation)
  supplies the release installer; configure provider/model/extensions locally
  with `goose configure`, or select existing configuration through `configHome`
  and caller env. Harness neither installs the CLI nor reads/copies credentials.
- **Command:** `goose run --quiet --output-format stream-json`, optional
  `--model <trimmed model>`, optional `--system=<exact instructions>`, then
  `--text=<exact prompt>`. Equals forms preserve empty and leading-dash text.
  Instructions are inline, not projected into `.goosehints` or `AGENTS.md`.
  Upstream context files still apply according to `CONTEXT_FILE_NAMES`.
- **Model / provider:** no library default or provider inference. Omitted/empty
  model emits no flag and reports null; explicit IDs are trimmed only for argv.
  `GOOSE_PROVIDER`, `GOOSE_MODEL`, credentials and helper-model settings remain
  upstream-controlled; an explicit `--model` overrides upstream model selection.
- **Permissions:** default `upstream` adds no mode override. Goose defaults to
  `auto`, but caller `GOOSE_MODE`/config can select `chat`, `approve` or
  `smart_approve`. Headless approval requests fail instead of being approved.
  Explicit Harness `bypass` sets child `GOOSE_MODE=auto`; a different explicit
  `env.GOOSE_MODE` conflicts (`invalid-options`). Inherited mode may be overridden
  by that explicit policy. No global settings are changed.
- **Configuration:** `configHome` maps to documented
  [`GOOSE_PATH_ROOT`](https://goose-docs.ai/docs/guides/environment-variables),
  relocating Goose config/data/state, not isolating credentials. System config,
  `GOOSE_ADDITIONAL_CONFIG_FILES`, project plugins/context and user-selected
  external paths can still apply. `configFile` and typed native options reject.
- **Input / sessions / extensions:** Harness uses text input plus additive system
  instructions. Upstream file/stdin input (`-i <file>` / `-i -`), recipes,
  resume/fork, `--no-session`, and `--with-*` extension flags are not exposed as
  typed options. Common finite stdin is delivered to the process, not substituted
  for `prompt`. Caller-configured extensions remain enabled; Harness does not
  inject `--no-profile`. Goose normally stores sessions in SQLite; even upstream
  `--no-session` creates a hidden row in v1.49.0. No session discovery, resume,
  pane, install helper or RPC/SDK backend is claimed by this adapter.
- **Output:** `raw` is the ordered array of JSON objects with a string `type`,
  including `message`, `notification`, `error`, `complete` and unknown future
  events; null when none parse. Non-JSON banners, scalar/array values, typeless
  objects and malformed/truncated lines are ignored. The last `complete`
  supplies cumulative `input_tokens`, `output_tokens`, `cost_usd` independently;
  absent/invalid values are null, zero is retained, totals are never summed.
  Token values must be finite nonnegative integers; cost must be finite and
  nonnegative. Cache/total fields remain in raw without inventing missing metrics.
  Upstream cumulative usage can include descendant sessions and cost estimates.
- **Failure:** bootstrap or approval errors can exit nonzero without structured
  completion. Provider stream failures can emit `error` then `complete` and
  exit **zero**. Harness retains the actual exit status; inspect raw events for
  agent failure. Interrupted streams retain parsed events but have null metrics
  if no complete was captured. Original stdout/stderr stay on `RunResult`.

### Qualification and ownership boundary — 2026-09-08

Official v1.49.0 (released September 3), source
[`71fc4be1`](https://github.com/aaif-goose/goose/tree/v1.49.0), was checked against
an isolated `goose-aarch64-apple-darwin.tar.bz2` executable; `--version` reports
`1.49.0` and `run --help` accepts the emitted flags. Primary implementation:
[`cli.rs`](https://github.com/aaif-goose/goose/blob/v1.49.0/crates/goose-cli/src/cli.rs),
[`session/mod.rs`](https://github.com/aaif-goose/goose/blob/v1.49.0/crates/goose-cli/src/session/mod.rs),
[`session/builder.rs`](https://github.com/aaif-goose/goose/blob/v1.49.0/crates/goose-cli/src/session/builder.rs).

Bounded macOS real-CLI probes used a synthetic localhost OpenAI-compatible
provider, isolated state and disabled keyring access—not an authenticated
provider. Python `run`/`run_async` and TypeScript `run`/`runAsync` each completed
the actual adapter command, retained streamed output and inline instructions,
reported synthetic usage 11 input / 3 output with null cost and null reported
model (upstream-configured), and released the workdir lease. A built-in developer
shell sleep stopped with the original process
group at a four-second timeout. `GOOSE_MODE=approve` rejected the same tool
request with exit 1 and no shell launch. A stdio MCP tool still running at timeout
survived under PID 1 in its own process group; only that reverified test child was
then stopped. No unrelated processes or shared services were stopped.

This is the existing [SPEC detached-descendant exclusion](SPEC.md#ownership-and-execution),
not complete extension-tree cancellation. Goose
[`subprocess.rs`](https://github.com/aaif-goose/goose/blob/v1.49.0/crates/goose/src/subprocess.rs)
starts stdio MCP children in new groups and has Linux-only parent-death signaling;
the CLI handles SIGINT, not SIGTERM. Cancellation/timeout covers the original
group, **not** escaped extensions, remote tools or container runtimes. Their
lifecycle remains caller/upstream-owned. Harness does not silently disable them
or launch a supervisor. Authenticated providers, Linux upstream process cleanup,
ACP providers and external extensions remain unqualified.

## mistral-vibe

- **Distribution / executable:** official [Mistral Vibe](https://github.com/mistralai/mistral-vibe/tree/v2.25.0), PyPI [`mistral-vibe`](https://pypi.org/project/mistral-vibe/2.25.0/), binary `vibe`. Python 3.12+; upstream targets UNIX. Install with `uv tool install mistral-vibe`, update with `uv tool upgrade mistral-vibe`, probe with `vibe --version`. Install metadata is caller-driven; Harness never installs or updates globally.
- **Command:** `vibe --output streaming [--auto-approve] [--agent=NAME] [--trust] --prompt=PROMPT`. Prompt is nonempty and literal, including leading dashes/newlines. Uses the caller's workdir as cwd; never passes `--worktree`, creates a checkout, or deletes caller-owned worktrees.
- **Model / configuration:** no Harness default or provider rewriting. Explicit trimmed `model` selects the upstream config alias through child `VIBE_ACTIVE_MODEL` (there is no native `--model` flag); a conflicting explicit `env.VIBE_ACTIVE_MODEL` rejects. Omission leaves upstream selection unchanged and reports null. `configHome` maps to `VIBE_HOME`; `configFile` is unsupported. Vibe reads its `config.toml`, `.env`, agents and state there, plus trusted project configuration. This is not a sandbox or a guarantee of isolated discovery.
- **Trust / instructions:** `VibeOptions(trust=True)` / `{kind: 'mistral-vibe', trust: true}` emits `--trust`, trusting the workspace for this invocation without persisting the trust decision. This enables project configuration, hooks, agents and `AGENTS.md`, not just the projected instructions. Nonempty `instructions` requires this explicit opt-in; otherwise Harness rejects before writes/spawn. Shared instruction preparation restores the owned `AGENTS.md` after teardown. No implicit trust is granted for bypass.
- **Permissions / agents:** `VibeOptions(agent="ask")` / `{kind: 'mistral-vibe', agent: 'ask'}` selects an exact built-in or custom profile. Omission uses upstream `default_agent` (stock `accept-edits`). Programmatic mode denies callbacks requiring user approval and disables native interactive question tools; auto-approved tools can still execute. `bypass` adds `--auto-approve`; without an explicit agent upstream selects its auto-approve profile, otherwise it applies auto-approval to the chosen profile. Trust and auto-approval are independent, explicit choices.
- **Output / metrics:** streaming emits completed history entries, not token deltas. `raw` retains every complete JSON object in order: messages, reasoning, tool effects, answered callbacks, notices and unknown future objects. Malformed/nonobject lines and incomplete tails remain in stdout but are excluded from `raw`; no objects means null. History entries do not contain aggregate token/USD telemetry, so all metrics remain null. Denied tools or native notices can coexist with exit 0; inspect `raw` when that distinction matters. Native records never replace the actual process exit or Harness termination cause.
- **Capabilities / exclusions:** shared one-shot CLI execution, raw stdout/stderr chunk callbacks, finite stdin, bounded capture, deadlines and cancellation. No RPC/SDK/ACP, controlled/resumable sessions, pane or session-log discovery. The CLI's `--max-turns`, `--max-price`, `--max-tokens`, tool filters, additional roots, resume, teleport and worktree options have no typed Harness mapping; unknown native fields reject. Use caller-selected native configuration where upstream supports it. Harness's timeout is a wall-clock limit, not a token/price budget.
- **Authentication:** use caller-selected local `MISTRAL_API_KEY` / upstream setup, or configure a native compatible provider. Harness neither reads credentials itself nor changes accounts/configuration. Missing required credentials in programmatic mode fail without onboarding.

### Qualification — 2026-09-08

Official 2.25.0 distribution, installed `vibe --version` / `--help`, and
[programmatic output](https://github.com/mistralai/mistral-vibe/blob/v2.25.0/vibe/cli/programmatic.py)
were checked on macOS arm64 with Python 3.12.13. A disposable install, home,
Vibe config and workdir exercised the real CLI against a loopback synthetic
OpenAI-compatible provider: completed response, projected instructions reaching
the request, an `ask` profile denying a shell write, explicit bypass allowing that
write, and missing-auth exit 1. Denial returned exit 0 with the answered callback.
These are native CLI checks with a synthetic provider, **not credentialed Mistral
provider success**.

Python `run` / `run_async` and the built package under Node `run` / `runAsync`
also completed against that native CLI. Callback-triggered cancellation retained
the completed user entry, returned `cancelled`, restored the original instruction
file and left no matching Vibe process. These no-tool cancellation checks do not
qualify arbitrary tool descendants.

The qualified CLI's [LocalHarness](https://github.com/mistralai/mistral-vibe/blob/v2.25.0/vibe/app_server/local.py)
uses an in-process app server and memory transport, not a detached shared daemon.
Harness controls only its owned process tree; arbitrary configured MCP servers,
hooks, remote/container tools and deliberately detached commands remain outside
the teardown guarantee. Native provider authentication, billing/model availability,
Linux upstream behavior, managed-shell rollout and arbitrary extensions are not
qualified by the synthetic fixture suite.

## mini-swe-agent

- **Identity / setup:** native [mini-SWE-agent](https://mini-swe-agent.com/latest/quickstart/), PyPI `mini-swe-agent`, executable `mini`. Distinct from the existing consumer-supplied `swe-agent` wrapper; neither adapter invokes the full SWE-agent CLI. Qualified distribution: **2.4.6**, Python >=3.10. Install in a caller-selected environment with `uv tool install mini-swe-agent`; update with `uv tool upgrade mini-swe-agent`. `mini --version` is not supported: use `python3 -c "from importlib.metadata import version; print(version('mini-swe-agent'))"` with the Python belonging to that installation. `mini --help` also prints the version banner. Harness does not install or configure globally.
- **Command:** `mini --task=TEXT --exit-immediately --output <absolute-workdir>/.harness/mini-swe-agent.traj.json`, adding `--yolo` only for explicit bypass, `--config PATH` for a selected config, and `--model PROVIDER/MODEL` only when requested. A leading-dash task is safe in equals form; empty tasks reject. Instructions are prepended to the task with a separator, not written to an instruction file. No default model or provider rewriting: omitted models use native config/environment.
- **Configuration / authentication:** child `MSWEA_CONFIGURED=true` disables the initial model/key wizard, not permissions. An explicit empty value rejects instead of reopening onboarding. `configHome` selects `MSWEA_GLOBAL_CONFIG_DIR`; native `.env` is loaded there without replacing already-set child variables. `configFile` **replaces** the default `mini.yaml`, so provide a complete upstream configuration, including required templates. Without it, native `MSWEA_MINI_CONFIG_PATH` remains effective. Existing provider keys/model settings remain caller-selected; no credentials are read, copied or harvested by Harness.
- **Permissions / termination:** `--exit-immediately` prevents the final new-task confirmation loop. Stock `upstream` mode still asks before shell actions; closed stdin fails with EOF instead of approving. Unattended coding therefore requires explicit `permissionPolicy: "bypass"` / `permission_policy="bypass"` or caller-configured approvals. No implicit `--yolo`, budget increase or response to confirmation prompts. Native step/cost limits remain configurable upstream; Harness deadlines are separate.
- **Environment / ownership:** the native default is local execution in the CLI cwd, unless config selects an environment cwd. A complete config may explicitly select a container/custom environment; those runtimes are not qualified or managed by this adapter. In 2.4.6, [`LocalEnvironment._run`](https://github.com/SWE-agent/mini-SWE-agent/blob/v2.4.6/src/minisweagent/environments/local.py) launches **each shell action with `start_new_session=True`**. These groups can survive cancellation of `mini`, and its normal action timeout cannot fire after the parent is killed. Harness bounds teardown of its owned CLI group only; it does not adopt detached shells, stop shared containers or shut down unrelated processes. Use an isolated environment with caller-owned cleanup when executing untrusted or long-running commands.
- **Result extraction:** the CLI overwrites the reserved workdir trajectory. The parser reads it only after a zero, non-timeout exit whose stdout ends with the exact native `Saved trajectory to 'PATH'` marker, tolerating ANSI and Rich line wrapping. Earlier echoed markers and failed-run output cannot authenticate a saved result. Missing marker/file, malformed JSON or an unknown trajectory format yields null metrics/raw, even if a prior file exists. Interrupted/provider-exception partial files are deliberately not trusted; partial stdout/stderr remains in the result. stdout truncation that removes the marker also makes metrics unknown. `/dev/stdout` and `/dev/fd/1` output were rejected by native Typer path validation on macOS; no fragile stdout redirect wrapper is used.
- **Artifact safety:** trajectory extraction accepts only a non-symlink regular file of at most 16 MiB. Nonblocking open and a size-bounded read prevent FIFO hangs and unbounded allocation; a changed length or rejected artifact yields null metrics/raw.
- **Metrics / native status:** `mini-swe-agent-1.1` JSON supplies full `raw`, finite nonnegative `info.model_stats.instance_cost`, and independent safe-integer usage totals from assistant `extra.response.usage` only. Primary prompt/completion fields fall back to input/output fields only when absent/null. Zero is real; malformed/missing dimensions and unsafe totals remain null; no repricing. Native `LimitsExceeded` can exit zero: inspect `raw.info.exit_status` for `Submitted` before declaring the task completed.
- **Capabilities / exclusions:** common CLI lifecycle, raw console chunk streaming, finite stdin, bounded capture, deadlines and CLI-group cancellation. No structured live events, typed native options, SDK/RPC, controlled/resumable sessions, pane or session-log discovery. Native config is the explicit route for model backend, environment and budget choices; Harness does not silently select an SDK or container.

### Qualification — 2026-09-08

Official distribution/docs, isolated `mini --help`, metadata version and installed
source were checked with 2.4.6 on macOS arm64 / Python 3.11.15. A bounded native
CLI run used the package's own deterministic model to write a synthetic file and
submit, with a complete private config and explicit bypass. Python `run` /
`run_async` and the built package under Node `run` / `runAsync` all returned
`Submitted`, a saved trajectory and synthetic cost 0.03; instructions reached
the native task. Stock confirmation failed with native `EOFError` and no file
edit in both languages. Python also exercised a native step limit (exit zero,
`LimitsExceeded`), wall timeout without stale telemetry, and an action that
survived CLI-group teardown; the smoke stopped only that recorded action group.
Node callback cancellation returned `cancelled`. Every run released its lease.

These prove native CLI behavior, **not external-provider success or billing**.
No OpenAI/Anthropic API key was available in the selected process environment;
no credential stores were searched. Shared fixtures separately cover
command/capability parity, stale/missing artifacts, native limits, partial/failure
output and telemetry boundaries. External providers, Linux native execution,
custom/container environments and arbitrary detached descendants remain unqualified.

## kimi-code

- **Identity / installation:** maintained [MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code),
  npm `@moonshot-ai/kimi-code` supplies `kimi`; the official binary installer
  is an alternative. npm 0.41.0 declares Node >=22.19.0. Install metadata is
  caller-driven; Harness never installs automatically. The winding-down
  [Python predecessor](https://github.com/MoonshotAI/kimi-cli) is not supported,
  and Harness neither invokes `kimi migrate` nor creates an ACP/web identity.
- **Command:** `kimi --output-format stream-json [--model=ALIAS] --prompt=PROMPT`.
  Blank prompts reject; equals form keeps leading hyphens as data. Exact model
  aliases pass through after trimming; omitted model leaves `default_model`
  selection to upstream. No model fallback or legacy alias rewriting.
- **Permissions:** print mode **always uses native auto permissions**, including
  when Harness policy is `upstream`. Static deny rules remain effective.
  Upstream rejects `--yolo`, `--auto` and `--plan` with `--prompt`; explicit
  Harness `bypass` therefore fails `unsupported-capability` before preparation,
  rather than claiming a stronger policy or silently dropping a flag.
- **Configuration / auth:** `configHome` maps to `KIMI_CODE_HOME`. Upstream reads
  `config.toml` under that home; arbitrary `configFile` is unsupported.
  The [native configuration](https://moonshotai.github.io/kimi-code/en/configuration/config-files.html)
  and selected OAuth/provider credentials remain caller-owned. Harness does
  not inspect/copy credentials, edit global config, log in or migrate sessions.
  Passing an unrelated API-key environment variable is not proof upstream will
  use it. Existing `HOME` and environment selection are preserved.
- **Instructions:** shared preparation owns a temporary workdir `AGENTS.md`.
  Native instruction discovery is source-qualified, not provider-tested.
- **Output:** complete stdout JSON objects remain in ordered `raw`, or null
  when absent. Assistant `content`/`tool_calls`, Tool `tool_call_id`/`content`
  and unknown objects survive. Thinking/progress stderr is never parsed as
  JSONL. Malformed/truncated/nonobject lines are skipped; stdout/stderr remain
  independently available. Token and USD totals stay null even for unknown
  usage-like fields. Nonzero exit and cancellation retain complete messages;
  predecessor exit-code semantics are not imported.
- **Lifecycle / unsupported:** shared capture, deadlines, cancellation and owned
  process-group cleanup only. ACP/web/SDK, resume, session-log discovery and
  native permission/plan/custom-agent controls are not exposed.

### Qualification — 2026-09-08

The npm registry still advertises **0.41.0**, bin `kimi: dist/main.mjs`.
Release tag resolves to
[`95478e8c7ba248fd2470d5bb151555ec7fedd19d`](https://github.com/MoonshotAI/kimi-code/tree/95478e8c7ba248fd2470d5bb151555ec7fedd19d).
The release's
[`options.ts`](https://github.com/MoonshotAI/kimi-code/blob/95478e8c7ba248fd2470d5bb151555ec7fedd19d/apps/kimi-code/src/cli/options.ts)
and
[`prompt-render.ts`](https://github.com/MoonshotAI/kimi-code/blob/95478e8c7ba248fd2470d5bb151555ec7fedd19d/apps/kimi-code/src/cli/prompt-render.ts)
qualify flag conflicts and assistant/tool JSONL shape.

`kimi` was not on PATH. No install/account was required for qualification:
**installed version/help, native auth-failure, credentialed provider completion,
bounded native edit/test and native tool-child cleanup remain unverified**.
Shared fixtures exercise synthetic success/auth-failure/nonzero, stderr
separation, tool messages and partial output; common subprocess conformance
exercises cancellation, bounded capture and owned descendants. These are not
native Kimi execution or provider evidence.

## kiro

- **Distribution / identity:** official native `kiro-cli`, installed through
  [`https://cli.kiro.dev/install`](https://cli.kiro.dev/install). This is the
  successor to Amazon Q CLI; the official installer can upgrade an existing
  `q` installation. Harness registers only `kiro`, with no duplicate Q adapter.
  It is not Kiro IDE, Crew, an npm package or a supported Homebrew formula.
  Install/update metadata is caller-driven; Harness never runs it automatically.
- **Platforms:** upstream documents macOS, Linux and Windows 11. The official
  Unix installer supports x86_64/aarch64, selects GNU or musl Linux archives,
  and checks SHA-256. Its current GNU thresholds are glibc 2.34 on x86_64 and
  2.39 on aarch64. Harness lifecycle support remains macOS/Linux only; upstream
  Windows availability does not imply Harness Windows support.
- **Command:** `kiro-cli chat --no-interactive --agent-engine v2
  --output-format stream-json [--model=MODEL] [--trust-all-tools]
  [--trust-tools=TOOLS] [--require-mcp-startup] -- PROMPT`. Empty prompts
  reject; leading hyphens remain positional. The selected stable V2 engine
  avoids inheriting legacy V1 or preview V3. No preview-engine fallback,
  remote/cloud execution or shared daemon management is added.
- **Model / configuration:** no Harness model default or provider rewriting.
  Explicit IDs are trimmed for argv; reported model is the requested label,
  or null when omitted/empty. Native config and model access remain upstream
  concerns. `configHome` and `configFile` have no qualified mapping and reject.
  Caller environment is inherited/overlaid normally, not a sandbox.
- **Instructions:** shared preparation temporarily projects workdir `AGENTS.md`.
  [Kiro steering](https://kiro.dev/docs/steering.md) documents automatic
  workspace discovery. Custom native agent resource configuration can change
  what is loaded; Harness does not rewrite that configuration. Native
  instruction ingestion has not been provider-tested.
- **Permissions:** omission adds no trust flags and preserves upstream policy.
  `KiroOptions(trust_tools="read,grep")` /
  `{kind: 'kiro', trustTools: 'read,grep'}` emits that exact comma-separated
  tool set. **Empty string explicitly trusts no tools** (`--trust-tools=`).
  Nonempty whitespace-only values and NUL bytes reject. `bypass` alone adds
  `--trust-all-tools`; combining it with any explicit trust set, including
  empty, rejects rather than broadening the requested permissions.
  Names/categories and approval outcomes are resolved upstream; the stable
  help uses `fs_read,fs_write` examples while current docs use `read,grep`.
- **MCP startup:** `require_mcp_startup=True` / `requireMcpStartup: true` adds
  `--require-mcp-startup`; false/omitted adds nothing. Upstream documents exit 3
  when an enabled MCP server cannot start; without this flag startup failures
  can be warnings. Harness neither starts nor stops unrelated MCP services.
- **Output / metrics:** stable help describes stream-json as native **ACP
  events**, each a self-describing JSON object line. Harness preserves every
  complete object in `raw`, including unknown events, errors and partial-run
  events. Malformed/nonobject lines and incomplete tails remain in stdout but
  are excluded from `raw`; no complete objects means null. All token/USD
  metrics are null because no aggregate accounting schema is qualified.
  Process exit, native event status and Harness termination remain distinct.
- **Authentication:** follow [official setup](https://kiro.dev/docs/getting-started/authentication.md).
  Headless docs prescribe `KIRO_API_KEY` for eligible paid subscriptions
  (Pro/Pro+/Pro Max/Power), potentially requiring administrator enablement.
  Authentication docs give an existing browser session precedence over the
  environment key; use native `kiro-cli whoami` to check the selected identity.
  Harness does not authenticate, switch accounts or inspect credential stores.
  **Without credentials, 2.21.1 attempts browser onboarding even in headless
  mode. Keep a finite Harness deadline; do not assume a prompt-free auth error.**
- **Capabilities / exclusions:** shared CLI lifecycle, finite stdin, raw chunk
  callbacks, bounded capture, deadlines and cancellation; explicit bypass and
  the two typed Kiro options above. No V1/V3 selection, agent/effort switching,
  resume, controlled ACP/RPC sessions, SDK, cloud sessions, pane helpers or
  session-log discovery. Unsupported native fields/backend/config choices reject.

### Qualification — 2026-09-08

The [stable release manifest](https://prod.download.cli.kiro.dev/stable/latest/manifest.json)
advertised **2.21.1**. Its universal macOS DMG was downloaded, checksum-verified
and mounted read-only outside the repository; no global installer, login,
configuration change or account switch was performed. `kiro-cli --version`,
`chat --help`, `update --help` and isolated `whoami` were checked. Current
[3.0 docs](https://kiro.dev/docs/cli/v3.md) describe an opt-in early release,
not the stable distribution selected here.

Python `run` and the built TypeScript package's Node `run` each used an isolated
workdir and explicit trust-none. With no `KIRO_API_KEY` and isolated `whoami`
reporting not logged in, the CLI attempted browser onboarding rather than
emitting JSONL. Both preserved streamed output and returned `timed-out` at their
30-second deadlines (Python 30.005s, Node 30.022s), released the workdir leases
and left no matching native process. No authentication flow was completed.

Shared fixtures use **synthetic framing events**, not captured provider
conversations or a claim to reproduce a stable ACP event schema. Both fixture
loaders exercise exact argv, tool trust/denial selection, rejected options,
success/failure/partial JSONL parsing and real substitute-executable lifecycle.
No real provider succeeded. Provider event schema/accounting, model access,
actual tool approval/denial, instructions reaching the model, native MCP/tool
descendants, background/remote tools, Linux native runtime and preview V3 remain
untested. Cancellation owns the foreground process group, not arbitrary detached
or remote processes; no global shutdown command is used.

---

## Cross-cutting: instruction ownership

Builders return a side-effect-free plan. `run` / `runAsync` acquire a workdir
lease, prepare the instruction file, and restore it after execution and parsing.
External drivers call `prepareCommand` and retain its handle until their process
tree stops, then call `cleanupCommand` (snake_case in Python).

Same-workdir overlap and unsafe symlinks reject. Cleanup restores only unchanged,
still-owned projections; edits or replacements produce `instruction-conflict`
and retain the current file plus original backup for manual recovery.
The explicit `projectInstructions` helper uses the same protocol.
`writeInstructions` now exclusively creates a caller-owned file and never
overwrites existing content. See [SPEC](SPEC.md#instruction-preparation-and-restoration).

swe-agent and mini-swe-agent fold instructions into their prompts; both still acquire the workdir lease.

---

## Cross-cutting: subprocess runner

Shared across adapters:
- Merges `extra_env` onto `process.env` (os.environ for py)
- Closes stdin (`DEVNULL`) by default
- Captures stdout + stderr separately
- Enforces wall/inactivity deadlines, finite stdin, bounded capture and owned process-tree teardown on supported POSIX runtimes. Python sync/async and TypeScript Bun/Node behavior is covered by the shared lifecycle scenarios.
- Returns structured exit/termination/timeout/launch/parse information; nonzero child exits remain results, not exceptions. See [SPEC](SPEC.md#ownership-and-execution) for the current contract and limits.

## auggie

- **Distribution / setup:** official npm [`@augmentcode/auggie`](https://www.npmjs.com/package/@augmentcode/auggie), executable `auggie`, Node 20+. Install/update with `npm install -g @augmentcode/auggie`; probe with `auggie --version`. Harness only exposes install metadata; it does not install or upgrade the CLI.
- **Command:** `auggie --print --output-format json --show-cost --workspace-root <absolute workdir> [--model <trimmed model>] --instruction=<exact prompt>`. An empty prompt rejects; leading dashes and newlines remain literal. Finite stdin is additional prompt context, not a replacement for the instruction.
- **Workspace / instructions:** the explicit workspace root prevents upstream Git-root autodetection from broadening the selected workdir. Print mode **skips indexing confirmation**: run only in a workspace you authorize Augment to index. Shared preparation projects `AGENTS.md` and restores it after owned teardown; existing Augment/Claude rules still apply. This is not a sandbox.
- **Model / configuration:** no Harness default or provider-prefix rewriting. Omitted model leaves account/config selection unchanged and reports null; explicit model IDs pass to `--model`. Existing local Augment configuration/authentication remains caller-selected. `configHome`, `configFile`, bypass and typed native options are unsupported and reject before writes/spawn; the cache-directory flag is not misrepresented as a complete config-home mapping.
- **Permissions:** default `upstream` adds no permission grants, ask-mode toggle or bypass. Native tool policies still apply. Configure them upstream; no interactive approval channel is provided. Fine-grained `--permission`, `--ask`, tool filters, reasoning effort, persona, max-turns, queued prompts and extra workspace flags have no typed Harness mapping.
- **Output / accounting:** 0.36.0 emits a compact JSON result at agent-loop completion, not incremental assistant/tool events. Shared streaming callbacks deliver raw process chunks only. `raw` retains every complete JSON object line in order, including unknown objects, native status, IDs and retry metadata; null when none decode. Noise, scalars/arrays and truncated records remain in stdout. Only the last `type="result"` object's finite nonnegative `billing.total_cost` with `billing.usage_unit="usd"` supplies `costUsd`. Credits, missing/invalid billing and missing results yield null; tokens are always null. No summation, conversion or estimated pricing.
- **Completion / failures:** require the native final `subtype="success"` and `is_error=false` as well as an ordinary zero process exit when deciding task success. `empty_completion`, `error_during_execution` and `error_max_turns` are distinct outcomes even if the process exits zero. Authentication or entitlement errors can exit 1 without JSON. Harness preserves process status and native fields rather than fabricating completion or rewriting errors.
- **Ownership / exclusions:** one-shot foreground CLI only; no daemon, cloud/Cosmos, ACP/MCP server, RPC/SDK, resume or controlled session support. Native session persistence remains upstream behavior. Shared SIGTERM then bounded SIGKILL teardown owns the original process group, not detached tools or remote services. Child `AUGMENT_DISABLE_AUTO_UPDATE=1` disables CLI self-updates by default; an explicit caller env value wins. No global daemon shutdown, credential copying or configuration edits.

### Qualification — 2026-09-08

Official [overview](https://docs.augmentcode.com/cli/overview),
[reference](https://docs.augmentcode.com/cli/reference),
[automation](https://docs.augmentcode.com/cli/automation/overview),
[rules](https://docs.augmentcode.com/cli/rules) and
[permissions](https://docs.augmentcode.com/cli/permissions) were refreshed against
an isolated npm 0.36.0 executable (commit `7c61e5bb`) on macOS arm64.
The packaged renderer corroborates the JSON completion fields and unit-tagged
billing; `--show-cost` is current and `--show-credits` a deprecated alias in
this release. `account status` returned not logged in (exit 1).

Bounded 15-second native probes through Python `run`/`run_async` and TypeScript
`run`/`runAsync` (Node 26.6.0, Bun 1.3.14) each returned authentication failure
with exit 1 in under two seconds. Stdout was empty, stderr was captured and
delivered to callbacks, metrics/raw were null, and owned instruction projections
and leases were removed. No authenticated generation was attempted after that
failure.

An active caller-configured Augment account/session is required. Enterprise
agreements may separately disable noninteractive mode; login alone does not
qualify that entitlement. Authenticated generation, billed usage, tool execution,
native tool-tree cancellation and Linux upstream behavior remain untested.
Shared fixtures use synthetic results and executables, not a successful provider
session. No global install, account switch or package publication was performed.

## qoder

- **Identity:** official npm [`@qoder-ai/qodercli`](https://www.npmjs.com/package/@qoder-ai/qodercli)
  supplies `qoder` (dispatcher) and `qodercli`. Harness invokes `qoder`, not an
  IDE, hosted worker or SDK. Version 1.1.47 requires Node >=20. Upstream also
  distributes Windows binaries; Harness lifecycle support remains macOS/Linux.
  Install/update metadata is caller-driven, never executed by an adapter run.
- **Command:** `qoder --print --output-format json --input-format text
  --max-turns 20 [--model MODEL] [--permission-mode MODE] --prompt=PROMPT`,
  cwd = the validated workdir, instructions = owned `AGENTS.md` projection.
  The turn cap is a supported hidden 1.1.47 option. Empty prompts reject.
  Native argument processing rejects positional prompts beginning `--` even
  after `--`; the supported but deprecated `--prompt=` form preserves literal
  prompts. Its native deprecation warning is not suppressed.
- **Model/config/auth:** no Harness default model; explicit model IDs retain
  their provider prefix. `configHome` selects `QODER_CONFIG_DIR`; caller env
  and existing auth remain authoritative. Follow [Qoder authentication](https://docs.qoder.com/cli/authentication)
  for account login or `QODER_PERSONAL_ACCESS_TOKEN` (PAT takes precedence).
  No BYOK path is qualified here. Config relocation is not a sandbox or proof
  that all native startup writes stay under that directory. Harness does not
  create accounts, copy credentials, edit settings or replace global config.
- **Permissions:** omission preserves upstream behavior. Opt in with Python
  `QoderOptions(permission_mode="accept_edits")` or TS
  `{kind: 'qoder', permissionMode: 'accept_edits'}`. Also accepts `default` and
  `dont_ask`. [Upstream permission rules](https://docs.qoder.com/cli/permissions)
  say `accept_edits` approves safe workspace edits but not shell commands;
  existing explicit rules, sensitive-path checks and trust still apply.
  Text-input headless confirmation requests are denied. Bypass and `auto`
  are unsupported, and Harness never enables `--yolo`. Host-driven
  stream-json approval callbacks are a separate, unsupported protocol.
- **Output:** [JSON mode](https://docs.qoder.com/cli/run-in-scripts) emits one
  terminal object, retained verbatim as `raw` (including multiline JSON).
  Otherwise complete JSON object lines are retained in order for diagnostics;
  malformed/truncated lines are skipped. A valid array/scalar document yields
  null. Unknown fields and native failures/permission denials remain raw.
  Native `subtype: "success"` can coexist with `is_error: true`; process
  failure and Harness cancellation are separate fields. All token/USD totals
  remain null: aggregate usage is unqualified, credits are not USD, and the
  installed result builder hardcodes `total_cost_usd: 0`.
- **Unsupported:** config-file overrides, protocol selection, host approvals,
  resume/session discovery, remote execution, RPC and SDK sessions.
- **Qualification (2026-09-08):** an isolated local npm install reported 1.1.47;
  version/help, bundled flag/result schema and bounded native JSON/stream-json
  missing-auth runs were checked on macOS arm64. Both formats exited 1 with
  `Not logged in` and retained native error fields. No caller PAT or usable
  Qoder login was available; credentialed edit/test success, real shell-denial
  execution, native tool-child teardown and Linux provider behavior remain
  unqualified. Shared fixtures use synthetic output and substitute executables;
  shared cancellation/process-group conformance is not provider validation.
