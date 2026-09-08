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

  test('pi uses openai-codex for gpt-5 family', () => {
    expect(normalizeModelForHarness('pi', 'gpt-5.4')).toBe('openai-codex/gpt-5.4')
    expect(normalizeModelForHarness('pi', 'openai-codex/gpt-5.4')).toBe('openai-codex/gpt-5.4')
  })

  test('known provider aliases do not get double-prefixed', () => {
    expect(normalizeModelForHarness('opencode', 'openai-codex/gpt-5.4')).toBe('openai-codex/gpt-5.4')
    expect(normalizeModelForHarness('codex', 'azure-openai-responses/gpt-5.4')).toBe('gpt-5.4')
  })

  test('crush preserves explicit provider prefixes', () => {
    expect(normalizeModelForHarness('crush', 'openrouter/google/gemini-2.5-pro')).toBe('openrouter/google/gemini-2.5-pro')
  })

  test('factory-droid preserves managed and explicit BYOK model identities', () => {
    expect(normalizeModelForHarness('factory-droid', 'claude-sonnet-4-5-20250929')).toBe('claude-sonnet-4-5-20250929')
    expect(normalizeModelForHarness('factory-droid', 'custom:My-Custom-Model-0')).toBe('custom:My-Custom-Model-0')
  })

  test('continue-cli preserves Hub slugs even when owner names match providers', () => {
    expect(normalizeModelForHarness('continue-cli', 'openai/gpt-5')).toBe('openai/gpt-5')
  })

  test('modelNoResolve escape hatch returns raw model', () => {
    expect(normalizeModelForHarness('pi', 'gpt-5.4', { resolve: false })).toBe('gpt-5.4')
    expect(normalizeModelForHarness('codex', 'openai/gpt-5.4', { resolve: false })).toBe('openai/gpt-5.4')
  })
})
