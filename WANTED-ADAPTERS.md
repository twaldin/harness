# Wanted Adapters

A list of coding CLIs that would make good contributions to harness. Each entry is pre-scoped: if you open a PR adding the adapter, the scope is already agreed. You still need to follow the [adapter contribution guide](CONTRIBUTING.md#adding-a-new-adapter), but the "should harness support this?" question is already answered yes.

If you're looking for a first PR to harness, pick one of these, open an issue saying you're taking it, and the PR review will focus on the implementation — not whether it belongs.

## Shipped

See [ADAPTER-MATRIX.md](ADAPTER-MATRIX.md) for the current lineup: `claude-code`, `codex`, `gemini`, `opencode`, `aider`, `swe-agent`. `qwen-code` and `continue-cli` land next.

---

## High-priority — moderate effort (~2-4 hours each)

These have clear headless mode and credible cost reporting. Good first PRs.

### Goose

[aaif-goose/goose](https://github.com/aaif-goose/goose) — Apache 2.0, Rust binary, maintained by the Agentic AI Foundation (Linux Foundation, forked from Block Dec 2025).

- **Headless** yes, CLI mode.
- **Cost reporting** JSON session export with full metadata (input/output/cache tokens, model config).
- **Auth** API key per provider (15+ providers: Anthropic, OpenAI, Ollama, Azure, Bedrock, OpenRouter, etc.).
- **Adapter-to-copy-from** `opencode` (session export pattern is closest).

Why it's wanted: 15+ provider support + comprehensive cost tracking is uniquely useful. If someone wants Ollama or Bedrock via harness, Goose is the cleanest path.

### Plandex

[plandex-ai/plandex](https://github.com/plandex-ai/plandex) — Apache 2.0, Go binary, active OSS.

- **Headless** yes, CLI-first.
- **Cost reporting** `plandex usage --log` shows per-call transactions; `plandex show` has token counts.
- **Auth** API key or self-hosted; Plandex Cloud tracks spend.
- **Output** CLI tables (token counts need parsing).
- **Adapter-to-copy-from** `aider` (table-scraping pattern).

Why it's wanted: strongest local-model story (Ollama integration), tree-sitter project maps for context management. Different architecture from the completion-based adapters.

### Cline CLI 2.0

[cline/cline](https://github.com/cline/cline) — MIT, 5M+ VS Code installs; v3.58+ ships a standalone CLI 2.0 with headless mode.

- **Headless** yes, CLI 2.0.
- **Cost reporting** not documented; needs investigation against `cn` output.
- **Auth** model-agnostic; any LLM provider.
- **Tool use** subagent support (v3.58+) plus Edit/Read/Bash equivalents.
- **Adapter-to-copy-from** `claude-code`.

Why it's wanted: biggest community adoption pool of any entry on this list. If Cline users want to point their dev loop at hone / agentelo / your own tool, harness is how.

---

## Medium-priority — moderate effort (~2-4 hours each)

Fine to accept, lower leverage.

### Roo Code CLI

[RooVeterinaryInc/Roo-Code](https://github.com/RooVeterinaryInc/Roo-Code) — MIT, `@roo-code/cli` on npm.

Role-based modes (Architect, Code, Debug, Ask, Custom) map to tool dispatch. Plain text output. Cost reporting not documented. Adapter-to-copy-from: `claude-code`.

### Neovate Code (Ant Group)

[neovateai/neovate-code](https://github.com/neovateai/neovate-code) — MIT, open-sourced 2026.

Plugin system with hooks, custom tools, and output types. Multi-platform (CLI, Web, Desktop). Cost reporting through the plugin interface. Harder to wrap because of plugin model. Adapter-to-copy-from: experimental — no direct analog.

### Crush (Charm)

[charmbracelet/crush](https://github.com/charmbracelet/crush) — MIT, Go binary, Charm-family.

Modern TUI with split-pane diff view. Multi-model via OpenRouter. Headless execution **unconfirmed** — the TUI-first design makes non-interactive output uncertain. If you can confirm a `--non-interactive` or `-p` mode works cleanly, this drops to the high-priority list. If not, skip.

---

## Not wanted — but here's why so you don't ask

### GPT Pilot

Multi-agent orchestration (7 specialized agents, human review gates). Not a CLI-first headless tool. Harness wraps agents, not orchestrators that call agents.

### Mentat (original CLI)

Archived by AbanteAI. Cloud variant sparse docs. If the cloud CLI gets proper docs + a confirmed headless mode, this becomes tier-2.

### CodeMachine-CLI

Meta-orchestrator that spawns Claude Code / Codex / Cursor. Architecturally harness's consumer, not its adapter target.

### smol-ai/developer, smol-ai/smolagents

Python libraries. Wrap your own CLI around them first, then submit that.

### GitHub Copilot CLI

Proprietary. GitHub Copilot subscription only. No BYOK. Harness is BYOK-only by design.

### OpenClaude / Claw Code / forks of the leaked Claude Code source

Legal ambiguity + fragmented ecosystem + unstable release cycle. Wait for legal resolution and/or consolidation before harness picks a winner. Not a principled skip — a wait.

---

## Opening a PR

1. Comment on [this file's GitHub view](https://github.com/twaldin/harness/blob/main/WANTED-ADAPTERS.md) or open an issue saying you're taking a specific entry. This avoids double work.
2. Follow [CONTRIBUTING.md §"Adding a new adapter"](CONTRIBUTING.md#adding-a-new-adapter) — Python + TypeScript + fixture + ADAPTER-MATRIX row in a single PR.
3. Link to this file in the PR description so the scope is obvious.

## Help with harder entries

If you're picking Crush (uncertain headless) or Neovate (plugin system), open an issue before the PR and confirm the approach. The review will be easier if the architectural question is resolved upfront.
