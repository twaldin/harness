const KNOWN_PROVIDERS = new Set([
  'anthropic',
  'azure',
  'bedrock',
  'deepseek',
  'gemini',
  'google',
  'groq',
  'mistral',
  'ollama',
  'openai',
  'openrouter',
  'qwen',
  'vertex',
  'xai',
])

const BARE_MODEL_HARNESSES = new Set([
  'claude-code',
  'codex',
  'continue-cli',
  'factory-droid',
  'gemini',
  'openclaude',
  'pi',
  'qwen',
  'crush',
])

const PROVIDER_MODEL_HARNESSES = new Set([
  'aider',
  'kilo',
  'opencode',
  'swe-agent',
])

export function stripKnownProviderPrefixes(model: string): string {
  let normalized = model.trim()
  while (true) {
    const slash = normalized.indexOf('/')
    if (slash < 0) return normalized
    const head = normalized.slice(0, slash).toLowerCase()
    if (!KNOWN_PROVIDERS.has(head)) return normalized
    normalized = normalized.slice(slash + 1).trim()
  }
}

export function inferProviderForModel(model: string, defaultProvider = 'openai'): string {
  const m = model.trim().toLowerCase()
  if (!m) return defaultProvider
  if (m === 'sonnet' || m === 'opus' || m === 'haiku') return 'anthropic'
  if (m.startsWith('claude') || m.startsWith('sonnet') || m.startsWith('opus') || m.startsWith('haiku')) return 'anthropic'
  if (m.startsWith('gemini')) return 'google'
  if (m.startsWith('qwen')) return 'qwen'
  if (m.startsWith('deepseek')) return 'deepseek'
  if (m.startsWith('grok')) return 'xai'
  if (m.startsWith('mistral')) return 'mistral'
  return defaultProvider
}

export function ensureProviderPrefix(model: string, defaultProvider = 'openai'): string {
  const normalized = model.trim()
  if (!normalized) return normalized

  const slash = normalized.indexOf('/')
  if (slash > 0) {
    const head = normalized.slice(0, slash).toLowerCase()
    if (KNOWN_PROVIDERS.has(head)) return normalized
  }

  const provider = inferProviderForModel(normalized, defaultProvider)
  return `${provider}/${normalized}`
}

export function normalizeModelForHarness(harness: string, model: string | undefined): string | undefined {
  if (model === undefined) return undefined
  const normalized = model.trim()
  if (!normalized) return normalized

  if (PROVIDER_MODEL_HARNESSES.has(harness)) {
    return ensureProviderPrefix(normalized)
  }
  if (BARE_MODEL_HARNESSES.has(harness)) {
    return stripKnownProviderPrefixes(normalized)
  }
  return normalized
}
