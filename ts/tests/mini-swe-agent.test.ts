import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const LIMIT = 16 * 1024 * 1024
const TRAJECTORY = { trajectory_format: 'mini-swe-agent-1.1', messages: [] }
const source = new URL('../src/index.ts', import.meta.url).href

for (const kind of ['fifo', 'symlink', 'oversized', 'at-limit']) {
  test(`mini trajectory read boundary: ${kind}`, () => {
    const workdir = mkdtempSync(join(tmpdir(), 'mini-trajectory-'))
    const path = join(workdir, '.harness', 'mini-swe-agent.traj.json')
    try {
      mkdirSync(join(workdir, '.harness'))
      if (kind === 'fifo') {
        expect(spawnSync('mkfifo', [path]).status).toBe(0)
      } else if (kind === 'symlink') {
        const target = join(workdir, 'other.json')
        writeFileSync(target, JSON.stringify(TRAJECTORY))
        symlinkSync(target, path)
      } else {
        const content = JSON.stringify(TRAJECTORY)
        writeFileSync(path, content + ' '.repeat(LIMIT + Number(kind === 'oversized') - Buffer.byteLength(content)))
      }
      // Isolate the call so an accidental blocking open fails, not hangs the suite.
      const code = `import { parseOutput } from ${JSON.stringify(source)};
        console.log(JSON.stringify(parseOutput(
          ${JSON.stringify({ harness: 'mini-swe-agent', prompt: 'synthetic', workdir })},
          ${JSON.stringify({ exitCode: 0, durationSeconds: 0, timedOut: false,
            stdout: `Saved trajectory to '${path}'\n`, stderr: '' })}
        )));`
      const child = spawnSync(process.execPath, ['--eval', code], { encoding: 'utf8', timeout: 5000 })
      expect(child.error).toBeUndefined()
      expect(child.status).toBe(0)
      expect(JSON.parse(child.stdout)).toEqual({
        costUsd: null, tokensIn: null, tokensOut: null,
        raw: kind === 'at-limit' ? TRAJECTORY : null,
      })
    } finally {
      rmSync(workdir, { recursive: true, force: true })
    }
  }, 10000)
}
