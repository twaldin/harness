import { describe, test, expect } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { projectInstructions, restoreProjectedInstructions } from '../src/subproc.js'

function tmpDir(name: string): string {
  const dir = join('/tmp', `harness-ts-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

describe('instruction lifecycle helpers', () => {
  test('restores existing file from backup', () => {
    const workdir = tmpDir('restore')
    const file = join(workdir, 'AGENTS.md')
    writeFileSync(file, 'original\n', 'utf-8')

    const projected = projectInstructions(workdir, 'AGENTS.md', 'injected', { mode: 'prepend' })
    expect(readFileSync(file, 'utf-8')).toContain('injected')

    restoreProjectedInstructions(projected)
    expect(readFileSync(file, 'utf-8')).toBe('original\n')
  })

  test('removes newly-created file on restore', () => {
    const workdir = tmpDir('remove')
    const projected = projectInstructions(workdir, '.opencode/agents/flt.md', 'injected')

    expect(existsSync(join(workdir, '.opencode/agents/flt.md'))).toBe(true)
    restoreProjectedInstructions(projected)
    expect(existsSync(join(workdir, '.opencode/agents/flt.md'))).toBe(false)
    expect(existsSync(join(workdir, '.opencode/agents'))).toBe(false)
    expect(existsSync(join(workdir, '.opencode'))).toBe(false)
  })
})
