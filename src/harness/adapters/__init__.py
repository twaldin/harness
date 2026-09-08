"""Importing this package registers every shipped adapter."""
from harness.adapters.amp import AmpAdapter
from harness.adapters.aider import AiderAdapter
from harness.adapters.auggie import AuggieAdapter
from harness.adapters.claude_code import ClaudeCodeAdapter
from harness.adapters.cline import ClineAdapter
from harness.adapters.codex import CodexAdapter
from harness.adapters.copilot import CopilotAdapter
from harness.adapters.continue_cli import ContinueCliAdapter
from harness.adapters.crush import CrushAdapter
from harness.adapters.cursor import CursorAdapter
from harness.adapters.factory_droid import FactoryDroidAdapter
from harness.adapters.gemini import GeminiAdapter
from harness.adapters.goose import GooseAdapter
from harness.adapters.hermes import HermesAdapter
from harness.adapters.kilo import KiloAdapter
from harness.adapters.mistral_vibe import MistralVibeAdapter
from harness.adapters.omp import OmpAdapter
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
register("hermes", HermesAdapter)
register("copilot", CopilotAdapter)
register("omp", OmpAdapter)
register("cline", ClineAdapter)
register("goose", GooseAdapter)
register("amp", AmpAdapter)
register("mistral-vibe", MistralVibeAdapter)
register("cursor", CursorAdapter)
register("auggie", AuggieAdapter)

__all__ = [
    "AmpAdapter",
    "AiderAdapter",
    "AuggieAdapter",
    "ClaudeCodeAdapter",
    "ClineAdapter",
    "CodexAdapter",
    "ContinueCliAdapter",
    "CopilotAdapter",
    "CrushAdapter",
    "CursorAdapter",
    "FactoryDroidAdapter",
    "GeminiAdapter",
    "GooseAdapter",
    "HermesAdapter",
    "KiloAdapter",
    "MistralVibeAdapter",
    "OmpAdapter",
    "OpenClaudeAdapter",
    "OpenCodeAdapter",
    "PiAdapter",
    "QwenAdapter",
    "SweAgentAdapter",
]
