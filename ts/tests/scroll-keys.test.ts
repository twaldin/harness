import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getAdapter } from '../src/index.js'

describe('opencode getCurrentScrollKeys', () => {
  test('returns the static C-M-e/y + NPage/PPage map', () => {
    const adapter = getAdapter('opencode')
    expect(adapter.getCurrentScrollKeys?.()).toEqual({
      lineDown: 'C-M-e',
      lineUp: 'C-M-y',
      pageDown: 'NPage',
      pageUp: 'PPage',
    })
  })
})

describe('claude-code getCurrentScrollKeys', () => {
  let homeDir: string
  let originalHome: string | undefined

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'harness-cc-tui-'))
    originalHome = process.env['HOME']
    process.env['HOME'] = homeDir
  })

  afterEach(() => {
    if (originalHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = originalHome
    rmSync(homeDir, { recursive: true, force: true })
  })

  function writeSettings(payload: unknown): void {
    const dir = join(homeDir, '.claude')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'settings.json'), JSON.stringify(payload))
  }

  test('returns the fullscreen scroll-key map when tui = "fullscreen"', () => {
    writeSettings({ tui: 'fullscreen' })
    expect(getAdapter('claude-code').getCurrentScrollKeys?.()).toEqual({
      lineDown: 'C-M-e',
      lineUp: 'C-M-y',
      pageDown: 'NPage',
      pageUp: 'PPage',
    })
  })

  test('returns null when tui = "default"', () => {
    writeSettings({ tui: 'default' })
    expect(getAdapter('claude-code').getCurrentScrollKeys?.()).toBeNull()
  })

  test('returns null when tui is absent', () => {
    writeSettings({ theme: 'dark' })
    expect(getAdapter('claude-code').getCurrentScrollKeys?.()).toBeNull()
  })

  test('returns null when settings.json does not exist', () => {
    expect(getAdapter('claude-code').getCurrentScrollKeys?.()).toBeNull()
  })

  test('returns null when settings.json is malformed', () => {
    const dir = join(homeDir, '.claude')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'settings.json'), '{not valid json')
    expect(getAdapter('claude-code').getCurrentScrollKeys?.()).toBeNull()
  })

  test('reflects mutation between calls (refresh on every call)', () => {
    writeSettings({ tui: 'default' })
    const adapter = getAdapter('claude-code')
    expect(adapter.getCurrentScrollKeys?.()).toBeNull()
    writeSettings({ tui: 'fullscreen' })
    expect(adapter.getCurrentScrollKeys?.()).not.toBeNull()
  })
})

describe('other adapters leave getCurrentScrollKeys undefined', () => {
  test('codex', () => {
    expect(getAdapter('codex').getCurrentScrollKeys).toBeUndefined()
  })

  test('gemini', () => {
    expect(getAdapter('gemini').getCurrentScrollKeys).toBeUndefined()
  })
})
