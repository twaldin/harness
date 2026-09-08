import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import '../../src/adapters/swe-agent.js'
import { getAdapter } from '../../src/registry.js'

const cases = JSON.parse(readFileSync(new URL('../../../tests/fixtures/session-logs/swe-agent/discovery.json', import.meta.url), 'utf8')) as Array<{
  name: string; files: Record<string, number>; since: number | null; expected: string | null
}>
const originalHome = process.env.HOME
const roots: string[] = []
afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

for (const item of cases) test(item.name, () => {
  const root = mkdtempSync(join(tmpdir(), 'swe-discovery-'))
  roots.push(root)
  const home = join(root, 'home')
  const workdir = join(root, 'work')
  mkdirSync(workdir, { recursive: true })
  process.env.HOME = home
  const globalDir = process.platform === 'darwin'
    ? join(home, 'Library/Application Support/mini-swe-agent')
    : join(home, '.local/share/mini-swe-agent')
  for (const [relative, modified] of Object.entries(item.files)) {
    const path = relative.startsWith('global/') ? join(globalDir, relative.slice(7)) : join(root, relative)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, '{}')
    utimesSync(path, modified, modified)
  }
  expect(getAdapter('swe-agent').sessionLogPath!(workdir, item.since === null ? undefined : item.since * 1000))
    .toBe(item.expected === null ? null : join(root, item.expected))
})

test('native trajectory reads model configuration, not model_stats keys', () => {
  const path = fileURLToPath(new URL('../../../tests/fixtures/session-logs/swe-agent/trajectory.json', import.meta.url))
  const telemetry = getAdapter('swe-agent').parseSessionLog!(path)
  expect([telemetry.costUsd, telemetry.model, telemetry.tokensIn]).toEqual([0.5, 'openai/gpt-5.4', null])
})
