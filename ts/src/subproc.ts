import { spawn, spawnSync } from 'child_process'
import { mkdirSync, writeFileSync, existsSync, copyFileSync, unlinkSync, readdirSync, rmdirSync, readFileSync } from 'fs'
import { dirname, join } from 'path'
import type { SubprocOutcome } from './base.js'

export interface InstructionProjection {
  workdir: string
  filename: string
  filePath: string
  existedBefore: boolean
  backupPath: string
  wroteBackup: boolean
}

export interface ProjectInstructionsOptions {
  /**
   * How to apply `content` when the target file already exists.
   * - replace: overwrite file with content
   * - prepend: place content before existing content (with blank line separator)
   */
  mode?: 'replace' | 'prepend'
  /** Write a backup before mutating an existing file. Defaults to true. */
  backup?: boolean
  /** Replace existing managed block if markers are present. */
  replaceBetweenMarkers?: {
    start: string
    end: string
  }
}

function backupPathFor(workdir: string, filename: string): string {
  return join(workdir, `.harness-backup-${filename}`)
}

export function writeInstructions(
  workdir: string,
  filename: string,
  content: string | undefined | null,
): string | null {
  if (!filename || content == null || content === '') return null
  mkdirSync(workdir, { recursive: true })
  const filePath = join(workdir, filename)
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, content, 'utf-8')
  return filePath
}

export function projectInstructions(
  workdir: string,
  filename: string,
  content: string,
  opts: ProjectInstructionsOptions = {},
): InstructionProjection {
  const mode = opts.mode ?? 'replace'
  const backup = opts.backup ?? true
  const markers = opts.replaceBetweenMarkers
  const filePath = join(workdir, filename)
  const backupPath = backupPathFor(workdir, filename)
  const existedBefore = existsSync(filePath)
  let wroteBackup = false

  mkdirSync(dirname(filePath), { recursive: true })

  if (existedBefore) {
    const existing = readFileSync(filePath, 'utf-8')
    if (markers && existing.includes(markers.start) && existing.includes(markers.end)) {
      const re = new RegExp(`${escapeRegex(markers.start)}[\\s\\S]*?${escapeRegex(markers.end)}`)
      writeFileSync(filePath, existing.replace(re, content), 'utf-8')
      return { workdir, filename, filePath, existedBefore, backupPath, wroteBackup }
    }
    if (backup) {
      mkdirSync(dirname(backupPath), { recursive: true })
      copyFileSync(filePath, backupPath)
      wroteBackup = true
    }
    if (mode === 'prepend') {
      writeFileSync(filePath, `${content}\n\n${existing}`, 'utf-8')
    } else {
      writeFileSync(filePath, `${content}\n`, 'utf-8')
    }
  } else {
    writeFileSync(filePath, `${content}\n`, 'utf-8')
  }

  return { workdir, filename, filePath, existedBefore, backupPath, wroteBackup }
}

export function restoreProjectedInstructions(
  projection: InstructionProjection,
): void {
  const { workdir, filePath, existedBefore, backupPath, wroteBackup } = projection

  if (wroteBackup && existsSync(backupPath)) {
    copyFileSync(backupPath, filePath)
    try { unlinkSync(backupPath) } catch {}
    return
  }

  if (!existedBefore && existsSync(filePath)) {
    try { unlinkSync(filePath) } catch { return }
    pruneEmptyParents(filePath, workdir)
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function pruneEmptyParents(filePath: string, rootDir: string): void {
  let current = dirname(filePath)
  while (current !== rootDir) {
    try {
      if (readdirSync(current).length > 0) return
      rmdirSync(current)
      current = dirname(current)
    } catch {
      return
    }
  }
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
