import { describe, expect, test } from 'bun:test'
import { normalizeModelForHarness } from '../src/model-normalization.js'

describe('model normalization', () => {
  test('strips known provider prefixes for bare-model harnesses', () => {
    expect(normalizeModelForHarness('codex', 'openai/gpt-5.4')).toBe('gpt-5.4')
    expect(normalizeModelForHarness('claude-code', 'openrouter/anthropic/claude-sonnet-4-6')).toBe('claude-sonnet-4-6')
  })

  test('adds provider prefix for provider/model harnesses', () => {
    expect(normalizeModelForHarness('opencode', 'gpt-5.4')).toBe('openai/gpt-5.4')
    expect(normalizeModelForHarness('swe-agent', 'claude-sonnet-4-6')).toBe('anthropic/claude-sonnet-4-6')
  })

  test('keeps existing provider-prefixed models unchanged', () => {
    expect(normalizeModelForHarness('kilo', 'openrouter/google/gemini-2.5-pro')).toBe('openrouter/google/gemini-2.5-pro')
  })
})
