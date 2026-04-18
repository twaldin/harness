"""Importing this package registers every shipped adapter."""
from harness.adapters.claude_code import ClaudeCodeAdapter
from harness.adapters.opencode import OpenCodeAdapter
from harness.registry import register

register("claude-code", ClaudeCodeAdapter)
register("opencode", OpenCodeAdapter)

__all__ = ["ClaudeCodeAdapter", "OpenCodeAdapter"]
