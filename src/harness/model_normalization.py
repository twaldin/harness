"""Shared model normalization helpers.

Goal: let callers pass canonical names like ``gpt-5.4`` across harnesses while
still emitting each CLI's preferred model format.
"""
from __future__ import annotations

KNOWN_PROVIDERS = {
    "anthropic",
    "azure",
    "bedrock",
    "deepseek",
    "gemini",
    "google",
    "groq",
    "mistral",
    "ollama",
    "openai",
    "openrouter",
    "qwen",
    "vertex",
    "xai",
}

BARE_MODEL_HARNESSES = {
    "claude-code",
    "codex",
    "continue-cli",
    "factory-droid",
    "gemini",
    "openclaude",
    "pi",
    "qwen",
    "crush",
}

PROVIDER_MODEL_HARNESSES = {
    "aider",
    "kilo",
    "opencode",
    "swe-agent",
}


def strip_known_provider_prefixes(model: str) -> str:
    """Remove one or more known provider prefixes from ``model``.

    Examples:
      - ``openai/gpt-5.4`` -> ``gpt-5.4``
      - ``openrouter/anthropic/claude-sonnet-4-6`` -> ``claude-sonnet-4-6``
    """
    normalized = model.strip()
    while True:
        head, sep, tail = normalized.partition("/")
        if not sep:
            return normalized
        if head.lower() not in KNOWN_PROVIDERS:
            return normalized
        normalized = tail.strip()


def infer_provider_for_model(model: str, default_provider: str = "openai") -> str:
    """Best-effort provider inference for canonical (bare) model names."""
    m = model.strip().lower()

    if not m:
        return default_provider
    if m in {"sonnet", "opus", "haiku"}:
        return "anthropic"
    if m.startswith(("claude", "sonnet", "opus", "haiku")):
        return "anthropic"
    if m.startswith("gemini"):
        return "google"
    if m.startswith("qwen"):
        return "qwen"
    if m.startswith("deepseek"):
        return "deepseek"
    if m.startswith("grok"):
        return "xai"
    if m.startswith("mistral"):
        return "mistral"
    return default_provider


def ensure_provider_prefix(model: str, default_provider: str = "openai") -> str:
    """Ensure ``provider/model`` format for CLIs that require it."""
    normalized = model.strip()
    if not normalized:
        return normalized

    head, sep, _tail = normalized.partition("/")
    if sep and head.lower() in KNOWN_PROVIDERS:
        return normalized

    provider = infer_provider_for_model(normalized, default_provider=default_provider)
    return f"{provider}/{normalized}"


def normalize_model_for_harness(harness: str, model: str | None) -> str | None:
    """Normalize model identifier for the target harness CLI."""
    if model is None:
        return None

    normalized = model.strip()
    if not normalized:
        return normalized

    if harness in PROVIDER_MODEL_HARNESSES:
        return ensure_provider_prefix(normalized, default_provider="openai")
    if harness in BARE_MODEL_HARNESSES:
        return strip_known_provider_prefixes(normalized)
    return normalized
