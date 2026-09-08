# Adapter matrix

Per-CLI reference for current command construction, instruction files and token/cost parsing. [SPEC.md](SPEC.md) defines the shared contract; [fixture coverage notes](SPEC.md#json-fixture-driven-verification) describe what the two suites actually assert.

**Qualification refreshed 2026-09-08 for TWA-68's thirteen named adapters.**
The ledger below separates primary-source checks, installed help/version probes,
synthetic conformance and provider smoke. None has a successful provider smoke
recorded by this audit. Hermes and OMP landed separately; their entries retain
their own qualification evidence. Hermes headless flags were checked against
installed Hermes Agent v0.20.0 (2026.8.3) and the upstream parser.

## Shipped versus planned

The sixteen adapters below are registered in **both** implementations and have
shared fixture files: `aider`, `claude-code`, `cline`, `codex`, `continue-cli`, `crush`,
`factory-droid`, `gemini`, `hermes`, `kilo`, `omp`, `openclaude`, `opencode`, `pi`,
`qwen`, `swe-agent`. Registration and fixtures are not proof of current upstream
compatibility or real-provider smoke coverage.
Both package roots initialize the built-in registry on import, so listing
adapters no longer depends on a prior Python build/parse/run call.

[WANTED-ADAPTERS.md](WANTED-ADAPTERS.md) is the dated upstream candidate catalog:
installation identities, headless feasibility, exclusions and deduplicated
implementation tickets. A catalog entry or ticket is **not** a shipped adapter.
In particular, the shipped `swe-agent` is a consumer-supplied mini-SWE wrapper
(see [its command](#swe-agent)), not the planned native mini-SWE-agent CLI adapter.

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
| aider | [`aider-chat`; CLI options](https://aider.chat/docs/config/options.html) (0.86.2; Python >=3.10,<3.13) | not on PATH | Source-checked; cached and multiple-message usage reports repaired against upstream emission. Rounded token scraper only; no session helper/provider qualification. |
| claude-code | [`@anthropic-ai/claude-code`; CLI reference](https://code.claude.com/docs/en/cli-reference) (registry 2.1.263) | 2.1.220 | Help-checked; JSON usage/cost source documented. Current pane/cutoff/config-root qualification remains TWA-96. |
| codex | [`@openai/codex`; upstream](https://github.com/openai/codex) | 0.153.4 | Help-checked; provider smoke **failed**: configured ChatGPT account rejected default `gpt-5.3-codex` and explicit `gpt-5.4` with HTTP 400. Both language runs cleaned up; no silent model fallback. |
| continue-cli | [`@continuedev/cli`; headless mode](https://docs.continue.dev/cli/headless-mode) (1.5.47) | not on PATH | Source-checked after command/rule/model repair. Headless JSON is model output, not usage telemetry. Default ask-tier tools are excluded; explicit bypass adds `--auto`. |
| crush | [`charmbracelet/tap/crush`; source](https://github.com/charmbracelet/crush) (v0.92.0) | v0.62.0 | Help-checked; upstream-shaped schema reproduction repairs nonexistent `sessions.model`. No provider/actual-run DB qualification. `--yolo` is not a `run` flag. |
| factory-droid | [`droid`; official headless guide](https://docs.factory.ai/droid-exec/overview) (0.213.0) | 0.132.1, off PATH | Help-checked with explicit executable. Replaces nonexistent `@factory-ai/droid`. Managed/custom model IDs now remain caller-selected. Default is read-only; documented JSON has no usage/cost. |
| gemini | [`@google/gemini-cli`; headless reference](https://geminicli.com/docs/cli/headless/) (0.58.0) | 0.37.0 | Help-checked; stats schema source-checked. Current docs deprecate `-y` in favor of `--approval-mode yolo`; installed `-y` still exists. Legacy session layout unqualified. |
| kilo | [`@kilocode/cli`; CLI reference](https://kilo.ai/docs/code-with-ai/platforms/cli-reference) (7.5.15) | not on PATH | Source-checked; assistant DB model key repaired to `modelID`. Without `--auto`, headless permission requests are rejected; this is upstream policy, not implicit bypass. |
| openclaude | [`@gitlawb/openclaude`; upstream](https://github.com/Gitlawb/openclaude) (0.30.0) | 0.6.0, off PATH | Legacy help-checked; current source checked separately. npm `openclaude` is an unrelated reservation without a binary. Current upstream moved to `~/.openclaude`; shipped legacy session helper is not qualified for that cutover. |
| opencode | [`opencode-ai`; CLI reference](https://opencode.ai/docs/cli/) (1.18.29) | 1.14.46, off PATH | Help-checked; source-shaped DB regression replaces `session.model` with assistant `modelID`. New docs use `--auto`; installed help uses `--dangerously-skip-permissions`. No version-independent bypass mapping added. |
| pi | [`@earendil-works/pi-coding-agent`; upstream](https://github.com/earendil-works/pi) (0.85.1) | not on PATH | Source-checked CLI JSON contract; old `@mariozechner/pi-coding-agent` 0.73.1 is explicitly deprecated. Install metadata corrected; runtime/RPC acceptance remains TWA-71. |
| qwen | [`@qwen-code/qwen-code`; headless source](https://github.com/QwenLM/qwen-code/blob/main/docs/users/features/headless.md) (0.23.0) | not on PATH | Source-checked flags/result array. Existing default `qwen3-coder` is not provider-qualified; current upstream also uses `coder-model`. Hash/project session layouts remain TWA-96. |
| swe-agent | [`mini-swe-agent`; native CLI docs](https://mini-swe-agent.com/latest/usage/mini/) (registry 2.4.6) plus a **consumer-supplied wrapper** | dependency 2.2.8; wrapper help checked | Wrapper-only, not native SWE-agent/mini support. `mini --version` fails; metadata now queries the dependency via the wrapper's `python3`. Installing the dependency does not install the wrapper. Native mini is TWA-82. |
| cline | [`cline`; standalone CLI](https://docs.cline.bot/cli/cli-reference), pinned [cli-v3.0.61](https://github.com/cline/cline/tree/cli-v3.0.61/apps/cli) | 3.0.61, isolated npm prefix | Help/version and real-CLI loopback protocol checked; JSON differs from docs. SIGINT stops ordinary shell tools; SIGTERM does not. Real Cline provider smoke failed without authentication; no successful real-provider coverage. |

Off-PATH probes used absolute executables; Harness does not add them to PATH.
No tools were upgraded, credentials switched, global configuration rewritten or
packages published. Provider/model availability must be verified for the caller's
selected account; fixture success cannot qualify it.

## Session telemetry coverage

Both languages expose session-path and parsing hooks for the same 12 adapters
(every adapter except `aider`, `cline`, `hermes` and `omp`). "Wired" means the hooks exist,
not that the current upstream layout is recognized or discovery identifies a
unique live session. Several legacy layouts below are contradicted by current
upstreams and tracked in TWA-96. These are caller-driven artifact helpers, not
controlled sessions.

| adapter | TypeScript hooks | Python hooks | notes |
|---|---|---|---|
| claude-code | wired | wired | JSONL under `~/.claude/projects/<encoded>/` |
| codex | wired | wired | JSONL path + parser |
| gemini | wired | wired | `logs.json` path; interactive logs without usage return null metrics; stats blobs can supply usage |
| opencode | wired | wired | SQLite selector path |
| swe-agent | wired | wired | trajectory JSON |
| pi | wired | wired | JSONL event stream |
| continue-cli | wired | wired | probes `~/.continue/...` + `CONTINUE_SESSION_DIR` override |
| crush | wired | wired | SQLite selector path |
| factory-droid | wired | wired | probes `FACTORY_HOME` / `~/.factory/...` |
| openclaude | wired | wired | claude-code-compatible JSONL path |
| qwen | wired | wired | `~/.qwen/tmp/<basename>/logs.json` (fallback `.gemini`); stats blobs can supply usage, other logs return null metrics |
| kilo | wired | wired | SQLite selector path |
| aider | unwired | unwired | no session-log hooks |
| hermes | unwired | unwired | no session-log hooks; the headless `raw.session_id` comes from stderr, not a log file |
| omp | unwired | unwired | ephemeral headless JSONL; no latest-session discovery |
| cline | unwired | unwired | foreground NDJSON only; no session resume or latest-session discovery |

## Backend and permission capabilities

All sixteen currently implement `backend="cli"` only. `rpc` and `sdk` are
explicitly unsupported, with no fallback. `get_capabilities` / `getCapabilities`
reports implemented support without probing binaries or credentials. Streaming
(raw subprocess chunks) and cancellation are true for every shipped CLI adapter
under the shared execution engine; controlled sessions are false. Streaming is
chunk delivery of whatever the CLI writes, not structured events.
Pure pane/install helpers exist for the same twelve adapters that have session
hooks; `aider` and `hermes` ship none.
OMP and Cline add install metadata without pane or session-log heuristics.

The default permission policy is `upstream`: commands below omit approval/bypass
flags unless the caller explicitly supplies a native approval override. This
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
| hermes | `--yolo` |
| omp | `--auto-approve` |
| continue-cli | `--auto` |
| cline | `--auto-approve true` |
| crush, opencode, pi, swe-agent | unsupported; request fails before writes/spawn |

Claude Code, Codex and Cline have typed native options:
`ClaudeCodeOptions.effort` / `{kind: 'claude-code', effort}` adds `--effort`;
`CodexOptions.sandbox` / `{kind: 'codex', sandbox}` adds `--sandbox`;
`ClineOptions.provider` and `auto_approve` / `{kind: 'cline', provider, autoApprove}`
add `--provider` and `--auto-approve true|false`. Codex sandbox or Cline
autoApprove combined with bypass is a conflict, not a precedence rule.
See [SPEC permission migration](SPEC.md#permission-policy-and-migration).

Configuration selection is also explicit: `executable` selects the binary;
`configHome` maps to `CLAUDE_CONFIG_DIR` for Claude Code, `CODEX_HOME` for
Codex, `HERMES_HOME` for Hermes, `CLINE_DIR` for Cline, and `PI_CODING_AGENT_DIR`
plus `--profile default` for OMP. `configFile` maps to Claude Code `--settings`, or `--config` for Aider,
Continue and OMP. Other adapters reject these typed overrides. Existing
caller-selected env remains inherited; no configuration or credential is copied.
See [SPEC](SPEC.md#supported-configuration-overrides) for precedence, current
official sources, and limits.

---

## Cost + token reporting at a glance

This table describes headless `parseOutput` / `parse_output`, not session-log
helpers. "Populated" requires the expected output or database to be available.

| adapter      | `cost_usd`        | `tokens_in` / `tokens_out`    | source                            |
| ------------ | ----------------- | ----------------------------- | --------------------------------- |
| claude-code  | populated         | populated                     | `--output-format json` envelope   |
| openclaude   | populated         | populated                     | `--output-format json` envelope   |
| factory-droid| optional fields only | optional fields only     | documented JSON omits usage/cost; extended-field parsing is fixture-only |
| opencode     | populated         | populated                     | sqlite session DB post-exit       |
| codex        | **null**          | populated (summed from JSONL) | JSONL turn events on stdout       |
| gemini       | estimated         | populated (summed)            | `stats.models` tokens + built-in pricing |
| aider        | **null**          | populated (regex parse)       | "Tokens: N sent, M received" log  |
| swe-agent    | populated         | populated                     | trajectory JSON post-exit         |
| qwen         | **null**          | populated                     | JSON array, last `type:'result'` item `usage` |
| continue-cli | **null**          | **null**                    | `--format json` contains model-generated output, not trusted usage |
| pi           | populated         | populated                     | `--mode json` event stream, summed from `agent_end.messages[].usage` |
| omp          | populated when reported | populated when reported | JSONL completed-cycle usage, with partial-message fallback |
| crush        | populated         | populated                     | sqlite `sessions` totals post-exit |
| kilo         | populated         | populated                     | sqlite `message/session` totals post-exit |
| hermes       | **null**          | **null**                      | not parsed; stdout is preserved verbatim, only `session_id:` stderr lines are read |
| cline        | when reported     | when reported                 | last top-level `run_result.usage`; partial streams retain raw events with null totals |

Headless cost is null for codex, aider and qwen; hermes reports null cost and tokens because its `--quiet` output has no machine-readable usage contract. Gemini estimates cost from token totals and the first model in `stats.models` when pricing is known. Selected session-log parsers also derive estimates, so their cost behavior can differ from headless parsing.

---

## Cross-cutting: model normalization

- Canonical model names (for example `gpt-5.4`) are accepted across adapters.
- Harness normalizes model IDs at `buildCommand` time:
  - **Provider-required CLIs** (`opencode`, `swe-agent`, `aider`, `kilo`) get `provider/model` forms.
  - **Bare-model CLIs** (`codex`, `claude-code`, `openclaude`, `qwen`, `gemini`) get known provider prefixes stripped.
  - **continue-cli** preserves explicit `owner/package` Hub slugs; omitted model delegates to upstream config.
  - **pi** prefixes bare `gpt-5*` models with `openai-codex/` and preserves recognized explicit providers.
  - **factory-droid** preserves managed model IDs and explicitly supplied `custom:` IDs; it never invents BYOK configuration.
  - **crush** preserves explicit provider prefixes and passes bare names through.
  - **hermes** has no library default and no rewriting: an explicit model is trimmed and passed to `--model` as given; an omitted model leaves the upstream `config.yaml` selection in charge and reports `model` as null.
  - **cline** has no library default; model IDs pass through trimmed, without provider-prefix inference. `ClineOptions.provider` selects the provider independently. Omitted choices use upstream configuration.
  - **omp** preserves bare names and all explicit provider prefixes; OMP resolves its own fuzzy aliases.
  - `modelNoResolve` / `model_no_resolve` bypasses these rules; surrounding whitespace is still trimmed.
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
- **Backend boundary:** chunk streaming and cancellation work through the common CLI API. Controlled sessions, resume, RPC, ACP and SDK are not exposed by this headless adapter; unsupported backend requests reject. [TWA-69](https://linear.app/twaldin/issue/TWA-69) owns the shared session contract and [TWA-85](https://linear.app/twaldin/issue/TWA-85) owns optional SDK work.

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
- **Default model**: `gpt-5.4` (normalized to `openai/gpt-5.4` for CLI invocation)
- **Command**: `opencode run --dir <workdir> --model <model> <prompt>`
- **Token source**: sqlite read from `~/.local/share/opencode/opencode.db` (override via `OPENCODE_DB` env var) — find session where `directory LIKE %<workdir-basename>%`, sum assistant `message.data.tokens.{input,output}`.
- **Cost source**: same sqlite — sum `message.data.cost`
- **Env**: none required

### Post-exit DB query

```sql
SELECT
  COALESCE(SUM(json_extract(data, '$.tokens.input')), 0)  AS tokens_in,
  COALESCE(SUM(json_extract(data, '$.tokens.output')), 0) AS tokens_out,
  COALESCE(SUM(json_extract(data, '$.cost')), 0)          AS cost,
  -- Model comes from assistant message.data.modelID, not session.model.
  COUNT(*)                                             AS row_count
FROM message m
JOIN session s ON s.id = m.session_id
WHERE m.session_id IN (
  SELECT id FROM session WHERE directory LIKE ? ORDER BY time_updated DESC LIMIT 1
)
```

The parameter is `%<resolved-workdir-basename>%`. This is a discovery heuristic,
not native run correlation. No matching assistant rows returns null metrics;
a matching session can legitimately total zero. Model extraction uses assistant
`modelID` only when all contributing rows identify one model; session estimates
use that model, never an invented `gpt-5.4`. TypeScript selects `bun:sqlite` under
Bun and `better-sqlite3` under Node; driver-load failure returns null metrics.
Relative DB overrides, release-channel storage and cost provenance remain TWA-95.

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
- **Command**: `crush run --data-dir <data-dir> --model <model> --small-model <model> <prompt>`
- **Token source**: sqlite `<data-dir>/crush.db` (`sessions.prompt_tokens`, `sessions.completion_tokens`)
- **Cost source**: sqlite `<data-dir>/crush.db` (`sessions.cost`)
- **Fairness**: harness always passes both `--model` and `--small-model` with the same normalized model
- **Container note**: `<data-dir>` defaults to `<workdir>/.harness/crush-data`; `CRUSH_DATA_DIR` in `RunSpec.env`, then process environment, overrides it. The same path is used for command construction and headless DB lookup.

### Post-exit DB query

```sql
SELECT id, prompt_tokens, completion_tokens, cost
FROM sessions
WHERE parent_session_id IS NULL
ORDER BY updated_at DESC
LIMIT 1
```

The session table has no `model` column. The reader obtains a consistent model
from assistant rows in `messages` for the selected session. Fixtures use this
upstream shape rather than inventing `sessions.model`.

---

## kilo

- **CLI**: `kilo`
- **Instructions file**: `AGENTS.md`
- **Default model**: `gpt-5.4`
- **Command**: `kilo run --format json --dir <workdir> --model <provider/model> <prompt>`
- **Env defaults set by adapter**:
  - `KILO_DB=<workdir>/.harness/kilo/kilo.db`
  - `KILO_CONFIG_CONTENT={"model":"<provider/model>","small_model":"<provider/model>","default_agent":"build"}`
- **Token source**: sqlite `message.data.tokens.{input,output}` summed over assistant rows for latest matching session
- **Cost source**: sqlite `message.data.cost` summed over assistant rows for latest matching session. Session model comes from `message.data.modelID`, not the user-message `model` object; unknown/mixed models do not select an arbitrary fallback price.
- **Model default**: generated `KILO_CONFIG_CONTENT` pins `model == small_model` and `default_agent=build` only when that variable is absent from both inherited and explicit env; selected configuration is not rewritten

### Post-exit DB query

```sql
SELECT
  COALESCE(SUM(json_extract(data, '$.tokens.input')), 0)  AS tokens_in,
  COALESCE(SUM(json_extract(data, '$.tokens.output')), 0) AS tokens_out,
  COALESCE(SUM(json_extract(data, '$.cost')), 0)          AS cost
FROM message
WHERE session_id IN (
  SELECT id FROM session
  WHERE directory LIKE ?
  ORDER BY time_updated DESC
  LIMIT 1
)
AND json_extract(data, '$.role') = 'assistant'
```

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

swe-agent folds instructions into its prompt; it still acquires the workdir lease.

---

## Cross-cutting: subprocess runner

Shared across adapters:
- Merges `extra_env` onto `process.env` (os.environ for py)
- Closes stdin (`DEVNULL`) by default
- Captures stdout + stderr separately
- Enforces wall/inactivity deadlines, finite stdin, bounded capture and owned process-tree teardown on supported POSIX runtimes. Python sync/async and TypeScript Bun/Node behavior is covered by the shared lifecycle scenarios.
- Returns structured exit/termination/timeout/launch/parse information; nonzero child exits remain results, not exceptions. See [SPEC](SPEC.md#ownership-and-execution) for the current contract and limits.
