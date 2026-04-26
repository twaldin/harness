from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class ModelPricing:
    input_per_mtok: float
    output_per_mtok: float


PRICING: dict[str, ModelPricing] = {
    "claude-opus-4-7": ModelPricing(15.00, 75.00),
    "claude-opus-4-7-1m": ModelPricing(30.00, 150.00),
    "opus": ModelPricing(15.00, 75.00),
    "opus[1m]": ModelPricing(30.00, 150.00),
    "claude-sonnet-4-6": ModelPricing(3.00, 15.00),
    "sonnet": ModelPricing(3.00, 15.00),
    "sonnet[1m]": ModelPricing(6.00, 22.50),
    "claude-haiku-4-5": ModelPricing(1.00, 5.00),
    "haiku": ModelPricing(1.00, 5.00),
    "gpt-5.4": ModelPricing(3.00, 12.00),
    "gpt-5.4-mini": ModelPricing(0.40, 1.60),
    "gpt-5.4-high": ModelPricing(3.00, 12.00),
    "gpt-5.3-codex": ModelPricing(3.00, 12.00),
    "gpt-5.3-codex-spark": ModelPricing(0.40, 1.60),
    "gpt-5.5": ModelPricing(5.00, 20.00),
    "gpt-4.1": ModelPricing(2.00, 8.00),
    "o3": ModelPricing(2.00, 8.00),
    "gemini-2.5-pro": ModelPricing(1.25, 10.00),
    "gemini-2.5-flash": ModelPricing(0.30, 2.50),
    "qwen3-coder-plus": ModelPricing(1.00, 4.00),
    "qwen3-coder-flash": ModelPricing(0.20, 0.80),
}

FAMILY_PREFIXES: list[tuple[str, ModelPricing]] = [
    ("gpt-5.4", ModelPricing(3.00, 12.00)),
    ("gpt-5.5", ModelPricing(5.00, 20.00)),
    ("gpt-4", ModelPricing(2.00, 8.00)),
    ("gpt-5", ModelPricing(3.00, 12.00)),
    ("gemini", ModelPricing(1.25, 10.00)),
    ("qwen", ModelPricing(1.00, 4.00)),
    ("opus", ModelPricing(15.00, 75.00)),
    ("sonnet", ModelPricing(3.00, 15.00)),
    ("haiku", ModelPricing(1.00, 5.00)),
    ("claude", ModelPricing(3.00, 15.00)),
]


def lookup_pricing(model: str | None) -> ModelPricing | None:
    if not model:
        return None
    idx = model.find("/")
    ident = model[idx + 1 :] if idx >= 0 else model
    lower = ident.lower().strip()

    if ident in PRICING:
        return PRICING[ident]
    if lower in PRICING:
        return PRICING[lower]

    for prefix, pricing in FAMILY_PREFIXES:
        if lower.startswith(prefix):
            return pricing
    return None


def derive_cost(model: str | None, tokens_in: int | None, tokens_out: int | None) -> float | None:
    pricing = lookup_pricing(model)
    if pricing is None:
        return None
    if tokens_in is None and tokens_out is None:
        return None
    in_cost = (tokens_in or 0) / 1_000_000 * pricing.input_per_mtok
    out_cost = (tokens_out or 0) / 1_000_000 * pricing.output_per_mtok
    return round(in_cost + out_cost, 6)
