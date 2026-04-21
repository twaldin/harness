# Adapter matrix

Per-CLI reference: what flags get built, what instructions filename gets written, how tokens/cost are parsed. **This is the source of truth both `harness` (py) and `@twaldin/harness-ts` implement.** Fixture tests in `tests/fixtures/` enforce byte-level agreement.

Last updated: 2026-04-21. Python source: `src/harness/adapters/*.py`.

---

## Cost + token reporting at a glance

| adapter      | `cost_usd`        | `tokens_in` / `tokens_out`    | source                            |
| ------------ | ----------------- | ----------------------------- | --------------------------------- |
| claude-code  | populated         | populated                     | `--output-format json` envelope   |
| opencode     | populated         | populated                     | sqlite session DB post-exit       |
| codex        | **null**          | populated (summed from JSONL) | JSONL turn events on stdout       |
| gemini       | **null**          | populated (summed)            | JSON envelope `stats.models`      |
| aider        | **null**          | populated (regex parse)       | "Tokens: N sent, M received" log  |
| swe-agent    | populated         | populated                     | trajectory JSON post-exit         |
| qwen         | **null**          | populated (summed)            | JSON envelope `stats.models`      |
| continue-cli | populated         | populated                     | `--json` envelope `usage`         |

Cost is null for codex, gemini, and aider because those CLIs don't emit pricing data. Use your own per-token pricing if you need cost attribution for these adapters.

---

## claude-code

- **CLI**: `claude`
- **Instructions file**: `CLAUDE.md`
- **Default model**: `sonnet`
- **Command**: `claude -p <prompt> --model <model> --output-format json --dangerously-skip-permissions`
- **Token source**: JSON envelope on stdout → `usage.input_tokens`, `usage.output_tokens`
- **Cost source**: JSON envelope → `total_cost_usd`
- **Env**: none required

### Output shape
```json
{ "type": "result", "result": "...", "usage": { "input_tokens": N, "output_tokens": M }, "total_cost_usd": 0.034 }
```

---

## codex

- **CLI**: `codex`
- **Instructions file**: `AGENTS.md`
- **Default model**: `gpt-5.3-codex`
- **Command**: `codex exec -m <model> --dangerously-bypass-approvals-and-sandbox --json -C <workdir> <prompt>`
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
- **Command**: `gemini -p <prompt> -y -m <model> --output-format json`
- **Token source**: JSON envelope → iterate `stats.models[*].tokens.{input, candidates}` and sum
- **Cost source**: not reported — always `null`
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

Parsing is fallback-tolerant: try whole-stdout as JSON first, then scan each `{`-prefixed line. First match with non-zero tokens wins.

---

## opencode

- **CLI**: `opencode`
- **Instructions file**: `AGENTS.md`
- **Default model**: `openai/gpt-5.4`
- **Command**: `opencode run --dir <workdir> --model <model> <prompt>`
- **Token source**: sqlite read from `~/.local/share/opencode/opencode.db` (override via `OPENCODE_DB` env var) — find session where `directory LIKE %<workdir-basename>%`, sum `message.data.tokens.{input,output}`
- **Cost source**: same sqlite — sum `message.data.cost`
- **Env**: none required

### Post-exit DB query

```sql
SELECT
  COALESCE(SUM(json_extract(data, '$.tokens.input')), 0)  AS tokens_in,
  COALESCE(SUM(json_extract(data, '$.tokens.output')), 0) AS tokens_out,
  COALESCE(SUM(json_extract(data, '$.cost')), 0)          AS cost
FROM message
WHERE session_id IN (
  SELECT id FROM session WHERE directory LIKE ? ORDER BY time_updated DESC LIMIT 1
)
```

TS port uses `better-sqlite3` (already a flt dep). Query string is identical.

---

## aider

- **CLI**: `aider`
- **Instructions file**: `.aider.conf.yml` (treated as YAML config, not free-form prompt — consumers who want system instructions should fold into `prompt`)
- **Default model**: `openrouter/anthropic/claude-sonnet-4.6`
- **Command**: `aider --config <workdir>/.agentelo-aider.yml --no-restore-chat-history --chat-history-file <workdir>/.agentelo-aider-chat.history.md --input-history-file <workdir>/.agentelo-aider-input.history --model <model> --message <prompt> --yes-always --no-auto-commits --no-analytics --no-show-model-warnings`
- **Side effect**: writes `<workdir>/.agentelo-aider.yml` with content `{}\n` before exec (empty config → pure CLI flags)
- **Token source**: regex on combined stdout+stderr: `/Tokens:\s+([\d,.]+k?)\s+sent,\s+([\d,.]+k?)\s+received/i` — numeric `k` suffix → ×1000
- **Cost source**: not reported by aider — always `null`
- **Env**: for OpenAI models, consumer sets `--openai-api-base` + `--openai-api-key` (via agentelo's OAuth proxy). Harness doesn't own that shim.

### Example log line
```
Tokens: 12.3k sent, 2,145 received
```

---

## swe-agent

- **CLI**: `python3 <wrapper>` (NOT a native CLI — wraps mini-swe-agent Python API)
- **Instructions file**: none; folded into prompt via `<instructions>\n\n---\n\n<prompt>`
- **Default model**: `openai/gpt-5.4`
- **Wrapper resolution**: `env.SWE_WRAPPER` → `~/agentelo/bin/run-mini-swe.py` → error
- **Command**: `python3 <wrapper> --model <model> --task <combined-prompt> --cwd <workdir> --cost-limit 10.0 --output <workdir>/.harness/swe-traj.json`
- **Side effect**: creates `<workdir>/.harness/` before exec
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
- **Command**: `qwen -p <prompt> -y -m <model> --output-format json`
- **Token source**: JSON envelope on stdout → `stats.models[*].tokens.{input, candidates}` (same shape as gemini)
- **Cost source**: not reported — always `null` (Alibaba Cloud pricing tracked externally via API key account)
- **Env**: `QWEN_API_KEY` (consumer sets; harness does not require or inject it)

### Output shape
```json
{
  "response": "...",
  "stats": {
    "models": {
      "qwen3-coder": { "tokens": { "input": N, "candidates": M } }
    }
  }
}
```

Parsing is fallback-tolerant: try whole-stdout as JSON first, then scan each `{`-prefixed line. First match with non-zero model stats wins.

---

## continue-cli

- **CLI**: `cn`
- **Instructions file**: `CONTINUE.md`
- **Default model**: `claude-sonnet-4-6`
- **Command**: `cn -p <prompt> --model <model> --json`
- **Token source**: JSON envelope on stdout → `usage.input_tokens`, `usage.output_tokens`
- **Cost source**: JSON envelope → `total_cost_usd`
- **Env**: `CONTINUE_API_KEY` (consumer sets; harness does not require or inject it)

### Output shape
```json
{ "type": "result", "result": "...", "usage": { "input_tokens": N, "output_tokens": M }, "total_cost_usd": 0.019 }
```

---

## Cross-cutting: write_instructions helper

All adapters except swe-agent call a shared `writeInstructions(workdir, filename, content)`:
- If `content` is null/undefined → no-op, returns null
- Else: create workdir if missing, write `<workdir>/<filename>` (overwrite), return the path
- Used as a side effect during `buildCommand()` so the file exists before the CLI reads it

swe-agent doesn't write a file; it prepends instructions to prompt.

---

## Cross-cutting: subprocess runner

Shared across adapters:
- Merges `extra_env` onto `process.env` (os.environ for py)
- Closes stdin (`DEVNULL`) by default
- Captures stdout + stderr separately
- Enforces `timeout_seconds`; on timeout, kills process group, returns `{exit_code: -1, timed_out: true, stdout, stderr}` with partial output
- Returns `{exit_code, duration_seconds, stdout, stderr, timed_out}` — never throws on non-zero exit
