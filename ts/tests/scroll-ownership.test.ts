import { describe, expect, test } from 'bun:test'
import { getAdapter } from '../src/index.js'

describe('adapter scrollOwnership', () => {
  test('opencode owns app scrolling', () => {
    expect(getAdapter('opencode').scrollOwnership).toBe('app')
  })

  test('claude-code is fullscreen-aware', () => {
    expect(getAdapter('claude-code').scrollOwnership).toBe('fullscreen-aware')
  })

  test('codex leaves scroll ownership unset (defaults to tmux)', () => {
    expect(getAdapter('codex').scrollOwnership).toBeUndefined()
  })
})
