import { spawn, spawnSync } from 'child_process'
import { mkdirSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import type { SubprocOutcome } from './base.js'

export function writeInstructions(
  workdir: string,
  filename: string,
  content: string | undefined | null,
): string | null {
  if (!filename || content == null || content === '') return null
  mkdirSync(workdir, { recursive: true })
  const filePath = `${workdir}/${filename}`
  writeFileSync(filePath, content, 'utf-8')
  return filePath
}

export function runSubprocess(
  cmd: string[],
  opts: {
    cwd: string
    timeoutSeconds?: number
    extraEnv?: Record<string, string>
  },
): SubprocOutcome {
  const timeoutMs = (opts.timeoutSeconds ?? 1800) * 1000
  const env = { ...process.env, ...(opts.extraEnv ?? {}) } as Record<string, string>

  const start = Date.now()
  const result = spawnSync(cmd[0]!, cmd.slice(1), {
    cwd: opts.cwd,
    env,
    timeout: timeoutMs,
    maxBuffer: 100 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf-8',
  })
  const durationSeconds = (Date.now() - start) / 1000

  const timedOut = result.signal === 'SIGTERM' || result.error?.message?.includes('ETIMEDOUT') || false
  const exitCode = timedOut ? -1 : (result.status ?? -1)

  return {
    exitCode,
    durationSeconds,
    stdout: (result.stdout as string) ?? '',
    stderr: (result.stderr as string) ?? '',
    timedOut,
  }
}

export function runSubprocessAsync(
  cmd: string[],
  opts: {
    cwd: string
    timeoutSeconds?: number
    extraEnv?: Record<string, string>
  },
): Promise<SubprocOutcome> {
  return new Promise((resolve) => {
    const timeoutMs = (opts.timeoutSeconds ?? 1800) * 1000
    const env = { ...process.env, ...(opts.extraEnv ?? {}) } as Record<string, string>

    const start = Date.now()
    // detached:true puts child in its own process group, so we can kill the
    // entire group on timeout — otherwise SIGTERM to a shell doesn't propagate
    // to grandchildren (e.g. `sh -c 'sleep 5'` leaves sleep running).
    const child = spawn(cmd[0]!, cmd.slice(1), {
      cwd: opts.cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    })

    let stdoutBuf = ''
    let stderrBuf = ''
    let timedOut = false

    child.stdout!.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString('utf-8')
    })
    child.stderr!.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString('utf-8')
    })

    const timer = setTimeout(() => {
      timedOut = true
      if (child.pid) {
        // Kill process group (negative pid targets the whole group).
        // SIGKILL not SIGTERM — belt-and-suspenders on slow CI where TERM
        // might not get handled in time.
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch {
          child.kill('SIGKILL')
        }
      } else {
        child.kill('SIGKILL')
      }
    }, timeoutMs)

    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({
        exitCode: timedOut ? -1 : (code ?? -1),
        durationSeconds: (Date.now() - start) / 1000,
        stdout: stdoutBuf,
        stderr: stderrBuf,
        timedOut,
      })
    })
  })
}
