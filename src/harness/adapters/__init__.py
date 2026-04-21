"""Importing this package registers every shipped adapter."""
from harness.adapters.aider import AiderAdapter
from harness.adapters.claude_code import ClaudeCodeAdapter
from harness.adapters.codex import CodexAdapter
from harness.adapters.continue_cli import ContinueCliAdapter
from harness.adapters.gemini import GeminiAdapter
from harness.adapters.opencode import OpenCodeAdapter
from harness.adapters.qwen import QwenAdapter
from harness.adapters.swe_agent import SweAgentAdapter
from harness.registry import register

register("claude-code", ClaudeCodeAdapter)
register("opencode", OpenCodeAdapter)
register("codex", CodexAdapter)
register("gemini", GeminiAdapter)
register("aider", AiderAdapter)
register("swe-agent", SweAgentAdapter)
register("qwen", QwenAdapter)
register("continue-cli", ContinueCliAdapter)

__all__ = [
    "AiderAdapter",
    "ClaudeCodeAdapter",
    "CodexAdapter",
    "ContinueCliAdapter",
    "GeminiAdapter",
    "OpenCodeAdapter",
    "QwenAdapter",
    "SweAgentAdapter",
]
