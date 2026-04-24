"""Importing this package registers every shipped adapter."""
from harness.adapters.aider import AiderAdapter
from harness.adapters.claude_code import ClaudeCodeAdapter
from harness.adapters.codex import CodexAdapter
from harness.adapters.continue_cli import ContinueCliAdapter
from harness.adapters.crush import CrushAdapter
from harness.adapters.factory_droid import FactoryDroidAdapter
from harness.adapters.gemini import GeminiAdapter
from harness.adapters.kilo import KiloAdapter
from harness.adapters.openclaude import OpenClaudeAdapter
from harness.adapters.opencode import OpenCodeAdapter
from harness.adapters.pi import PiAdapter
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
register("pi", PiAdapter)
register("factory-droid", FactoryDroidAdapter)
register("openclaude", OpenClaudeAdapter)
register("crush", CrushAdapter)
register("kilo", KiloAdapter)

__all__ = [
    "AiderAdapter",
    "ClaudeCodeAdapter",
    "CodexAdapter",
    "ContinueCliAdapter",
    "CrushAdapter",
    "FactoryDroidAdapter",
    "GeminiAdapter",
    "KiloAdapter",
    "OpenClaudeAdapter",
    "OpenCodeAdapter",
    "PiAdapter",
    "QwenAdapter",
    "SweAgentAdapter",
]
