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


def test_pi_uses_openai_codex_for_gpt5_family():
    assert normalize_model_for_harness("pi", "gpt-5.4") == "openai-codex/gpt-5.4"
    assert normalize_model_for_harness("pi", "openai-codex/gpt-5.4") == "openai-codex/gpt-5.4"


def test_known_provider_aliases_do_not_get_double_prefixed():
    assert normalize_model_for_harness("opencode", "openai-codex/gpt-5.4") == "openai-codex/gpt-5.4"
    assert normalize_model_for_harness("codex", "azure-openai-responses/gpt-5.4") == "gpt-5.4"


def test_crush_preserves_explicit_provider_prefixes():
    assert normalize_model_for_harness("crush", "openrouter/google/gemini-2.5-pro") == "openrouter/google/gemini-2.5-pro"


def test_model_no_resolve_escape_hatch_returns_raw_model():
    assert normalize_model_for_harness("pi", "gpt-5.4", resolve=False) == "gpt-5.4"
    assert normalize_model_for_harness("codex", "openai/gpt-5.4", resolve=False) == "openai/gpt-5.4"
