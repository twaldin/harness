from harness.model_normalization import normalize_model_for_harness


def test_normalize_model_for_bare_harness_strips_provider_prefixes():
    assert normalize_model_for_harness("codex", "openai/gpt-5.4") == "gpt-5.4"
    assert (
        normalize_model_for_harness("claude-code", "openrouter/anthropic/claude-sonnet-4-6")
        == "claude-sonnet-4-6"
    )


def test_normalize_model_for_provider_harness_adds_provider_prefix():
    assert normalize_model_for_harness("opencode", "gpt-5.4") == "openai/gpt-5.4"
    assert normalize_model_for_harness("swe-agent", "claude-sonnet-4-6") == "anthropic/claude-sonnet-4-6"


def test_normalize_model_for_provider_harness_keeps_existing_provider_prefix():
    assert normalize_model_for_harness("kilo", "openrouter/google/gemini-2.5-pro") == "openrouter/google/gemini-2.5-pro"
