import { mkdirSync, writeFileSync, existsSync, copyFileSync, unlinkSync, readdirSync, rmdirSync, readFileSync } from 'fs'
import { dirname, join } from 'path'
import type { SubprocOutcome } from './base.js'
import { cancelledBeforeLaunch, prepareLaunch, runLifecycle, runLifecycleSync } from './lifecycle.js'
import type { RunSubprocessOptions } from './lifecycle.js'

export type { RunSubprocessOptions } from './lifecycle.js'

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
    if (backup) {
      // Always back up before any mutation so restoreProjectedInstructions
      // can undo. Previously the markers branch skipped this and `restore`
      // became a silent no-op, leaving flt's projection in the coder diff.
      mkdirSync(dirname(backupPath), { recursive: true })
      copyFileSync(filePath, backupPath)
      wroteBackup = true
    }
    if (markers && existing.includes(markers.start) && existing.includes(markers.end)) {
      const re = new RegExp(`${escapeRegex(markers.start)}[\\s\\S]*?${escapeRegex(markers.end)}`)
      writeFileSync(filePath, existing.replace(re, content), 'utf-8')
      return { workdir, filename, filePath, existedBefore, backupPath, wroteBackup }
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

/**
 * Blocking execution with the full lifecycle contract (fresh process group,
 * bounded TERM→KILL teardown of leftovers, bounded pipe drain). Runs the
 * async engine in a per-invocation supervisor process so the calling thread
 * can block. `cancel` is only honored when already aborted at call time.
 */
export function runSubprocess(cmd: string[], opts: RunSubprocessOptions): Required<SubprocOutcome> {
  const request = prepareLaunch(cmd, opts)
  if (opts.cancel?.aborted) return cancelledBeforeLaunch()
  return runLifecycleSync(request)
}

/** Same lifecycle contract, in-process; `cancel` may abort at any time. */
export function runSubprocessAsync(cmd: string[], opts: RunSubprocessOptions): Promise<Required<SubprocOutcome>> {
  return runLifecycle(prepareLaunch(cmd, opts), opts.cancel)
}
