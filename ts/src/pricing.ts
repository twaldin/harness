// Per-token pricing for models that don't emit cost in their session output.
// USD per 1M tokens. Prices last verified 2026-04-25 against vendor docs.
// Adapters whose CLIs don't report costUsd (codex, gemini, qwen, aider) use
// these to compute cost from tokensIn/tokensOut, so SessionTelemetry.costUsd
// is non-null whenever tokens are non-null.

export interface ModelPricing {
  /** USD per 1M input tokens. */
  inputPerMTok: number
  /** USD per 1M output tokens. */
  outputPerMTok: number
}

// Index keyed by canonical model id. Match priority: exact id, then prefix, then family.
const PRICING: Record<string, ModelPricing> = {
  // Anthropic
  'claude-opus-4-7':            { inputPerMTok: 15.00, outputPerMTok: 75.00 },
  'claude-opus-4-7-1m':         { inputPerMTok: 30.00, outputPerMTok: 150.00 },
  'opus':                       { inputPerMTok: 15.00, outputPerMTok: 75.00 },
  'opus[1m]':                   { inputPerMTok: 30.00, outputPerMTok: 150.00 },
  'claude-sonnet-4-6':          { inputPerMTok:  3.00, outputPerMTok: 15.00 },
  'sonnet':                     { inputPerMTok:  3.00, outputPerMTok: 15.00 },
  'sonnet[1m]':                 { inputPerMTok:  6.00, outputPerMTok: 22.50 },
  'claude-haiku-4-5':           { inputPerMTok:  1.00, outputPerMTok:  5.00 },
  'haiku':                      { inputPerMTok:  1.00, outputPerMTok:  5.00 },

  // OpenAI / Codex
  'gpt-5.4':                    { inputPerMTok:  3.00, outputPerMTok: 12.00 },
  'gpt-5.4-mini':               { inputPerMTok:  0.40, outputPerMTok:  1.60 },
  'gpt-5.4-high':               { inputPerMTok:  3.00, outputPerMTok: 12.00 },
  'gpt-5.3-codex':              { inputPerMTok:  3.00, outputPerMTok: 12.00 },
  'gpt-5.3-codex-spark':        { inputPerMTok:  0.40, outputPerMTok:  1.60 },
  'gpt-5.5':                    { inputPerMTok:  5.00, outputPerMTok: 20.00 },
  'gpt-4.1':                    { inputPerMTok:  2.00, outputPerMTok:  8.00 },
  'o3':                         { inputPerMTok:  2.00, outputPerMTok:  8.00 },

  // Google
  'gemini-2.5-pro':             { inputPerMTok:  1.25, outputPerMTok: 10.00 },
  'gemini-2.5-flash':           { inputPerMTok:  0.30, outputPerMTok:  2.50 },

  // Qwen (Alibaba)
  'qwen3-coder-plus':           { inputPerMTok:  1.00, outputPerMTok:  4.00 },
  'qwen3-coder-flash':          { inputPerMTok:  0.20, outputPerMTok:  0.80 },
}

const FAMILY_PREFIXES: { prefix: string; pricing: ModelPricing }[] = [
  { prefix: 'gpt-5.4',  pricing: { inputPerMTok: 3.00, outputPerMTok: 12.00 } },
  { prefix: 'gpt-5.5',  pricing: { inputPerMTok: 5.00, outputPerMTok: 20.00 } },
  { prefix: 'gpt-4',    pricing: { inputPerMTok: 2.00, outputPerMTok:  8.00 } },
  { prefix: 'gpt-5',    pricing: { inputPerMTok: 3.00, outputPerMTok: 12.00 } },
  { prefix: 'gemini',   pricing: { inputPerMTok: 1.25, outputPerMTok: 10.00 } },
  { prefix: 'qwen',     pricing: { inputPerMTok: 1.00, outputPerMTok:  4.00 } },
  { prefix: 'opus',     pricing: { inputPerMTok: 15.00, outputPerMTok: 75.00 } },
  { prefix: 'sonnet',   pricing: { inputPerMTok:  3.00, outputPerMTok: 15.00 } },
  { prefix: 'haiku',    pricing: { inputPerMTok:  1.00, outputPerMTok:  5.00 } },
  { prefix: 'claude',   pricing: { inputPerMTok:  3.00, outputPerMTok: 15.00 } },
]

export function lookupPricing(model: string | null | undefined): ModelPricing | null {
  if (!model) return null
  // Strip provider prefix if present (anthropic/sonnet → sonnet)
  const idx = model.indexOf('/')
  const id = idx >= 0 ? model.slice(idx + 1) : model
  const lower = id.toLowerCase().trim()

  if (PRICING[id]) return PRICING[id]
  if (PRICING[lower]) return PRICING[lower]

  for (const { prefix, pricing } of FAMILY_PREFIXES) {
    if (lower.startsWith(prefix)) return pricing
  }
  return null
}

export function deriveCost(model: string | null, tokensIn: number | null, tokensOut: number | null): number | null {
  const pricing = lookupPricing(model)
  if (!pricing) return null
  if (tokensIn === null && tokensOut === null) return null
  const inCost = (tokensIn ?? 0) / 1_000_000 * pricing.inputPerMTok
  const outCost = (tokensOut ?? 0) / 1_000_000 * pricing.outputPerMTok
  return Number((inCost + outCost).toFixed(6))
}
