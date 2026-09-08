# Adapter matrix

Per-CLI reference for current command construction, instruction files and token/cost parsing. [SPEC.md](SPEC.md) defines the shared contract; [fixture coverage notes](SPEC.md#json-fixture-driven-verification) describe what the two suites actually assert.

The command/policy contract below is source-derived; the explicit native option flags were also checked against installed Claude Code 2.1.220 and Codex 0.153.4 help, and the Hermes headless flags against installed Hermes Agent v0.20.0 (2026.8.3) plus the current upstream parser. This is not a full current-upstream qualification or provider smoke.

## Shipped versus planned

The fourteen adapters below are registered in **both** implementations and have
shared fixture files: `aider`, `claude-code`, `codex`, `continue-cli`, `crush`,
`factory-droid`, `gemini`, `hermes`, `kilo`, `openclaude`, `opencode`, `pi`,
`qwen`, `swe-agent`. Registration and fixtures are not proof of current upstream
compatibility or real-provider smoke coverage.
Both package roots initialize the built-in registry on import, so listing
adapters no longer depends on a prior Python build/parse/run call.

[WANTED-ADAPTERS.md](WANTED-ADAPTERS.md) is the dated upstream candidate catalog:
installation identities, headless feasibility, exclusions and deduplicated
implementation tickets. A catalog entry or ticket is **not** a shipped adapter.
In particular, the shipped `swe-agent` is a consumer-supplied mini-SWE wrapper
(see [its command](#swe-agent)), not the planned native mini-SWE-agent CLI adapter.

Current qualification work is tracked in
[TWA-68](https://linear.app/twaldin/issue/TWA-68) (all shipped adapters) and
[TWA-71](https://linear.app/twaldin/issue/TWA-71) (Pi CLI/RPC).
The broader capability/API guide belongs to
[TWA-88](https://linear.app/twaldin/issue/TWA-88); installed-package and
real-provider validation belongs to
[TWA-89](https://linear.app/twaldin/issue/TWA-89).
Until those changes land, the source-derived commands below describe the
implementation, not promised upstream behavior.

## Session telemetry coverage

Both languages expose session-path and parsing hooks for the same 12 adapters
(every adapter except `aider` and `hermes`). "Wired" means the hooks exist, not
that every log contains usage or that discovery identifies a unique live
session. No controlled-session backend is shipped; these are caller-driven
artifact helpers.

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

## Backend and permission capabilities

All fourteen currently implement `backend="cli"` only. `rpc` and `sdk` are
explicitly unsupported, with no fallback. `get_capabilities` / `getCapabilities`
reports implemented support without probing binaries or credentials. Streaming
(raw subprocess chunks) and cancellation are true for every shipped CLI adapter
under the shared execution engine; controlled sessions are false. Streaming is
chunk delivery of whatever the CLI writes, not structured events.
Pure pane/install helpers exist for the same twelve adapters that have session
hooks; `aider` and `hermes` ship none.

The default permission policy is `upstream`: commands below omit approval/bypass
flags. This preserves the selected upstream's policy, not a guarantee of
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
| continue-cli, crush, opencode, pi, swe-agent | unsupported; request fails before writes/spawn |

Only Claude Code and Codex currently have typed native options:
`ClaudeCodeOptions.effort` / `{kind: 'claude-code', effort}` adds `--effort`;
`CodexOptions.sandbox` / `{kind: 'codex', sandbox}` adds `--sandbox`.
Sandbox plus bypass is a conflict, not a precedence rule. See
[SPEC permission migration](SPEC.md#permission-policy-and-migration).

Configuration selection is also explicit: `executable` selects the binary;
`configHome` maps to `CLAUDE_CONFIG_DIR` for Claude Code, `CODEX_HOME` for
Codex and `HERMES_HOME` for Hermes. `configFile` maps to Claude Code
`--settings`, Aider `--config`, or Continue `--config`. Other adapters reject
these typed overrides. Existing caller-selected env remains inherited; no
configuration or credential is copied.
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
| factory-droid| populated         | populated                     | `--output-format json` envelope   |
| opencode     | populated         | populated                     | sqlite session DB post-exit       |
| codex        | **null**          | populated (summed from JSONL) | JSONL turn events on stdout       |
| gemini       | estimated         | populated (summed)            | `stats.models` tokens + built-in pricing |
| aider        | **null**          | populated (regex parse)       | "Tokens: N sent, M received" log  |
| swe-agent    | populated         | populated                     | trajectory JSON post-exit         |
| qwen         | **null**          | populated                     | JSON array, last `type:'result'` item `usage` |
| continue-cli | populated         | populated                     | `--json` envelope `usage`         |
| pi           | populated         | populated                     | `--mode json` event stream, summed from `agent_end.messages[].usage` |
| crush        | populated         | populated                     | sqlite `sessions` totals post-exit |
| kilo         | populated         | populated                     | sqlite `message/session` totals post-exit |
| hermes       | **null**          | **null**                      | not parsed; stdout is preserved verbatim, only `session_id:` stderr lines are read |

Headless cost is null for codex, aider and qwen; hermes reports null cost and tokens because its `--quiet` output has no machine-readable usage contract. Gemini estimates cost from token totals and the first model in `stats.models` when pricing is known. Selected session-log parsers also derive estimates, so their cost behavior can differ from headless parsing.

---

## Cross-cutting: model normalization

- Canonical model names (for example `gpt-5.4`) are accepted across adapters.
- Harness normalizes model IDs at `buildCommand` time:
  - **Provider-required CLIs** (`opencode`, `swe-agent`, `aider`, `kilo`) get `provider/model` forms.
  - **Bare-model CLIs** (`codex`, `claude-code`, `openclaude`, `continue-cli`, `qwen`, `gemini`) get known provider prefixes stripped.
  - **pi** prefixes bare `gpt-5*` models with `openai-codex/` and preserves recognized explicit providers.
  - **factory-droid** strips known provider prefixes and adds `custom:` for a configured BYOK model.
  - **crush** preserves explicit provider prefixes and passes bare names through.
  - **hermes** has no library default and no rewriting: an explicit model is trimmed and passed to `--model` as given; an omitted model leaves the upstream `config.yaml` selection in charge and reports `model` as null.
  - `modelNoResolve` / `model_no_resolve` bypasses these rules; surrounding whitespace is still trimmed.
- Fairness default for frontier adapters is strict single-model:
  - `crush`: `--model == --small-model`
  - `kilo`: default `model == small_model` via `KILO_CONFIG_CONTENT`; an existing caller-selected config is preserved
  - `openclaude`: no `--fallback-model`
  - `factory-droid`: `--model == --spec-model`

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
- **Command**: `droid exec --output-format json --model <model> --spec-model <model> <prompt>`; normalization turns the default into `custom:gpt-5.4`.
- **Token source**: JSON envelope on stdout → `usage.{input_tokens,output_tokens}` (fallbacks: `usage.{input,output}`)
- **Cost source**: JSON envelope → `total_cost_usd` (fallbacks to `usage.cost[.total]`)
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
- **Token source**: sqlite read from `~/.local/share/opencode/opencode.db` (override via `OPENCODE_DB` env var) — find session where `directory LIKE %<workdir-basename>%`, sum `message.data.tokens.{input,output}`
- **Cost source**: same sqlite — sum `message.data.cost`
- **Env**: none required

### Post-exit DB query

```sql
SELECT
  COALESCE(SUM(json_extract(data, '$.tokens.input')), 0)  AS tokens_in,
  COALESCE(SUM(json_extract(data, '$.tokens.output')), 0) AS tokens_out,
  COALESCE(SUM(json_extract(data, '$.cost')), 0)          AS cost,
  MAX(s.model)                                         AS model,
  COUNT(*)                                             AS row_count
FROM message m
JOIN session s ON s.id = m.session_id
WHERE m.session_id IN (
  SELECT id FROM session WHERE directory LIKE ? ORDER BY time_updated DESC LIMIT 1
)
```

The parameter is `%<resolved-workdir-basename>%`. No matching message rows returns null metrics; a matching session can legitimately total zero. TypeScript selects `bun:sqlite` under Bun and `better-sqlite3` under Node; driver-load failure returns null metrics rather than throwing.

---

## aider

- **CLI**: `aider`
- **Instructions file**: `.harness-aider-instructions.md`, supplied as text through `--read`
- **Default model**: `openrouter/anthropic/claude-sonnet-4.6`
- **Command**: `aider --no-restore-chat-history --chat-history-file <null-device> --input-history-file <null-device> --model <model> --message <prompt> --no-auto-commits --no-analytics --no-show-model-warnings`; adds `--read <instructions-file>` when instructions are supplied
- **Config**: uses upstream configuration by default; explicit `configFile` adds `--config <path>`. No empty `.agentelo-aider.yml` is generated.
- **Token source**: regex on combined stdout+stderr: `/Tokens:\s+([\d,.]+k?)\s+sent,\s+([\d,.]+k?)\s+received/i` — numeric `k` suffix → ×1000
- **Cost source**: not reported by aider — always `null`
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
- **Instructions file**: `CONTINUE.md`
- **Default model**: `claude-sonnet-4-6`
- **Command**: `cn -p <prompt> --model <model> --json`
- **Explicit config**: `configFile` uses `cn -p --config <path> --format json <prompt>`. Omit `model` for this path: the file selects it; an explicit model rejects rather than being silently discarded. Current Continue `--model` is a Hub slug, so the legacy default branch remains subject to upstream qualification.
- **Credential safety**: no generated YAML. The former explicit OpenAI-compatible env branch now requires a caller-selected `configFile`.
- **Token source**: JSON envelope on stdout → `usage.input_tokens`, `usage.output_tokens`
- **Cost source**: JSON envelope → `total_cost_usd`
- **Env**: `CONTINUE_API_KEY` (consumer sets; harness does not require or inject it)

### Output shape
```json
{ "type": "result", "result": "...", "usage": { "input_tokens": N, "output_tokens": M }, "total_cost_usd": 0.019 }
```

---

## pi

- **CLI**: `pi` (from `@mariozechner/pi-coding-agent`, see [pi.dev](https://pi.dev))
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

Full event reference: [pi-mono/packages/coding-agent/docs/json.md](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/json.md).

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
SELECT prompt_tokens, completion_tokens, cost, model
FROM sessions
WHERE parent_session_id IS NULL
ORDER BY updated_at DESC
LIMIT 1
```

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
- **Cost source**: sqlite `message.data.cost` summed over assistant rows for latest matching session
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
- Enforces `timeout_seconds`; on timeout, returns `{exit_code: -1, timed_out: true, stdout, stderr}` with captured output. Python's runners and TypeScript's synchronous runner terminate the direct child; TypeScript's async runner creates and kills a process group.
- Returns `{exit_code, duration_seconds, stdout, stderr, timed_out}` — never throws on non-zero exit
