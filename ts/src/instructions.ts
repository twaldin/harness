import { createHash } from 'node:crypto'
import {
  closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync,
  renameSync, rmdirSync, unlinkSync, writeSync,
} from 'node:fs'
import type { Stats } from 'node:fs'
import { basename, isAbsolute, join, resolve, sep } from 'node:path'
import type { BuildCommand } from './base.js'
import { HarnessError } from './base.js'

/**
 * Per-workdir exclusive lease directory. Created with `mkdir(0o700)` by every
 * `prepareCommand`/`projectInstructions` call in both languages; an existing
 * entry (directory, symlink, anything) means another run owns the workdir.
 */
export const RUN_LOCK_DIRNAME = '.harness-run.lock'

export interface InstructionProjection {
  /** Canonical (realpath) workdir the lease and projection belong to. */
  workdir: string
  filename: string
  filePath: string
  existedBefore: boolean
  /** Owned backup location inside the lease directory; the file exists only when `wroteBackup`. */
  backupPath: string
  wroteBackup: boolean
}

export interface ProjectInstructionsOptions {
  /**
   * How to apply `content` when the target file already exists.
   * - replace: overwrite file with content (followed by a newline)
   * - prepend: place content before existing content (with blank line separator)
   */
  mode?: 'replace' | 'prepend'
  /** Must stay true: originals are always preserved by rename so restore can undo. */
  backup?: boolean
  /** Replace the first well-ordered marker block, including its delimiters; falls back to `mode` when absent. */
  replaceBetweenMarkers?: {
    start: string
    end: string
  }
}

/** A built command whose workdir lease, artifact directories and instructions projection are in place. */
export interface PreparedCommand {
  command: BuildCommand
}

interface FileIdentity {
  ino: number
  dev: number
}

interface Lease extends FileIdentity {
  lockDir: string
}

interface OwnedFile extends FileIdentity {
  mode: number
  size: number
  digest: string
}

interface OwnedDir extends FileIdentity {
  path: string
}

interface OwnedProjection {
  filePath: string
  /** Ancestors of `filePath` below the workdir, shallow to deep. */
  parents: OwnedDir[]
  backupPath: string
  /** Original file now living at `backupPath`, or null when the target did not exist. */
  original: OwnedFile | null
  target: OwnedFile
  /** Parent directories this projection created, shallow to deep. */
  createdDirs: OwnedDir[]
}

interface ProjectionRequest {
  mode: 'replace' | 'prepend'
  markers: { start: string; end: string } | null
  /** Bytes written when the target is new or replaced. */
  replacement: Buffer
  /** Text composed into an existing file under prepend/markers. */
  content: string
}

interface OwnedState {
  lease: Lease
  projection: OwnedProjection | null
  /** Artifact directories created by `prepareCommand`, shallow to deep. */
  createdDirs: OwnedDir[]
  released: boolean
}

/** Ownership metadata stays out of the public handles: never serializable, never forgeable. */
const projections = new WeakMap<InstructionProjection, OwnedState>()
const preparations = new WeakMap<PreparedCommand, OwnedState>()

function conflict(message: string): HarnessError {
  return new HarnessError(message, 'instruction-conflict')
}

function errnoOf(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err && typeof err.code === 'string' ? err.code : undefined
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path)
  } catch (err) {
    const code = errnoOf(err)
    if (code === 'ENOENT' || code === 'ENOTDIR') return null
    throw err
  }
}

function sameIdentity(st: Stats, id: FileIdentity): boolean {
  return st.ino === id.ino && st.dev === id.dev
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Resolve and realpath the workdir so `/tmp` aliases and caller symlinks share one lease. */
function canonicalWorkdir(workdir: string): string {
  if (typeof workdir !== 'string' || workdir === '' || workdir.includes('\0')) {
    throw new HarnessError('workdir must be a non-empty string without NUL bytes', 'invalid-options')
  }
  const absolute = resolve(workdir)
  let real: string
  try {
    real = realpathSync(absolute)
  } catch (err) {
    const code = errnoOf(err)
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new HarnessError(`workdir does not exist: ${absolute}`, 'invalid-options')
    }
    throw err
  }
  if (!lstatSync(real).isDirectory()) {
    throw new HarnessError(`workdir is not a directory: ${absolute}`, 'invalid-options')
  }
  return real
}

function acquireLease(workdir: string): Lease {
  const lockDir = join(workdir, RUN_LOCK_DIRNAME)
  const busy = (): HarnessError =>
    conflict(`workdir ${workdir} is leased by another run (${RUN_LOCK_DIRNAME} exists); wait for it or use a different workdir`)
  if (lstatOrNull(lockDir) !== null) throw busy()
  try {
    mkdirSync(lockDir, { mode: 0o700 })
  } catch (err) {
    if (errnoOf(err) === 'EEXIST') throw busy()
    throw err
  }
  const st = lstatSync(lockDir)
  return { lockDir, ino: st.ino, dev: st.dev }
}

function checkLease(lease: Lease): void {
  const st = lstatOrNull(lease.lockDir)
  if (st === null || !st.isDirectory() || !sameIdentity(st, lease)) {
    throw conflict(`run lock ${lease.lockDir} was removed or replaced while the run was active`)
  }
}

function releaseLease(lease: Lease): void {
  checkLease(lease)
  try {
    rmdirSync(lease.lockDir)
  } catch (err) {
    const code = errnoOf(err)
    if (code === 'ENOTEMPTY' || code === 'EEXIST') {
      throw conflict(`run lock ${lease.lockDir} contains unexpected entries; inspect and remove it manually`)
    }
    throw err
  }
}

/** Validate a workdir-relative path and return every prefix below the workdir, shallow to deep (last = the path itself). */
function chainBelow(workdir: string, relative: string, what: string): string[] {
  if (typeof relative !== 'string' || relative === '' || relative.includes('\0')) {
    throw new HarnessError(`${what} must be a non-empty string without NUL bytes`, 'invalid-options')
  }
  if (isAbsolute(relative)) {
    throw new HarnessError(`${what} must be relative to the workdir, got ${JSON.stringify(relative)}`, 'invalid-options')
  }
  const parts = relative.split(sep === '/' ? '/' : /[\\/]/)
  if (parts.some((p) => p === '' || p === '.' || p === '..')) {
    throw new HarnessError(`${what} must not contain empty, "." or ".." components, got ${JSON.stringify(relative)}`, 'invalid-options')
  }
  if (parts[0] === RUN_LOCK_DIRNAME) {
    throw new HarnessError(`${what} must not point inside ${RUN_LOCK_DIRNAME}`, 'invalid-options')
  }
  const chain: string[] = []
  let current = workdir
  for (const part of parts) {
    current = join(current, part)
    chain.push(current)
  }
  return chain
}

/** Strip the workdir (canonical or the caller's alias) from a planned absolute path. */
function relativeBelow(cwd: string, canonical: string, path: string, what: string): string {
  const absolute = resolve(path)
  for (const root of [cwd, canonical]) {
    if (absolute.startsWith(root + sep)) return absolute.slice(root.length + 1)
  }
  throw new HarnessError(`${what} ${path} is not below workdir ${cwd}`, 'invalid-options')
}

/** Every existing directory in the chain must be a real directory (never a symlink); missing ones are created and owned. */
function ensureDirs(chain: readonly string[], created: OwnedDir[]): void {
  for (const dir of chain) {
    const st = lstatOrNull(dir)
    if (st === null) {
      mkdirSync(dir)
      const made = lstatSync(dir)
      created.push({ path: dir, ino: made.ino, dev: made.dev })
      continue
    }
    if (st.isSymbolicLink()) throw conflict(`${dir} is a symlink; refusing to project instructions through it`)
    if (!st.isDirectory()) throw conflict(`${dir} exists and is not a directory`)
  }
}

/** Re-check every ancestor's identity, including directories that predated preparation. */
function checkDirs(chain: readonly OwnedDir[]): void {
  for (const dir of chain) {
    const st = lstatOrNull(dir.path)
    if (st === null || !st.isDirectory() || !sameIdentity(st, dir)) {
      throw conflict(`${dir.path} was replaced or removed during the run; leaving the projection for manual recovery`)
    }
  }
}

/** Remove owned directories deepest first; anything non-empty or replaced is left alone. */
function pruneDirs(created: readonly OwnedDir[]): void {
  for (let i = created.length - 1; i >= 0; i--) {
    const dir = created[i]!
    const st = lstatOrNull(dir.path)
    if (st === null || !st.isDirectory() || !sameIdentity(st, dir)) return
    if (readdirSync(dir.path).length > 0) return
    rmdirSync(dir.path)
  }
}

function decodeUtf8(bytes: Buffer, path: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw conflict(`${path} is not valid UTF-8; prepend and marker projection need text`)
  }
}

function compose(existing: Buffer, filePath: string, request: ProjectionRequest): Buffer {
  if (request.markers) {
    const text = decodeUtf8(existing, filePath)
    const { start, end } = request.markers
    const startAt = text.indexOf(start)
    const endAt = startAt === -1 ? -1 : text.indexOf(end, startAt + start.length)
    if (startAt !== -1 && endAt !== -1) {
      return Buffer.from(text.slice(0, startAt) + request.content + text.slice(endAt + end.length), 'utf-8')
    }
  }
  if (request.mode === 'prepend') {
    return Buffer.from(`${request.content}\n\n${decodeUtf8(existing, filePath)}`, 'utf-8')
  }
  return request.replacement
}

/** Create the target exclusively (mode 600), write `bytes`, and record the ownership identity. A failed write removes the file again. */
function createOwned(filePath: string, bytes: Buffer): OwnedFile {
  const fd = openSync(filePath, 'wx', 0o600)
  let offset = 0
  let identity: Stats | undefined
  try {
    identity = fstatSync(fd)
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset)
    const st = fstatSync(fd)
    return { ino: st.ino, dev: st.dev, mode: st.mode, size: bytes.length, digest: sha256(bytes) }
  } catch (err) {
    const current = lstatOrNull(filePath)
    if (identity !== undefined && current !== null && current.isFile() && sameIdentity(current, identity)
      && current.nlink === 1 && current.mode === identity.mode && current.size === offset
      && readFileSync(filePath).equals(bytes.subarray(0, offset))) {
      unlinkSync(filePath)
    } else {
      throw conflict(`${filePath} changed during a failed write; leaving it for manual recovery`)
    }
    throw err
  } finally {
    closeSync(fd)
  }
}

/** Verify the file at `path` is still exactly the regular file we own. */
function verifyOwned(path: string, owned: OwnedFile, what: string): void {
  const st = lstatOrNull(path)
  if (st === null) throw conflict(`${what} ${path} was deleted during the run`)
  if (st.isSymbolicLink() || !st.isFile()) throw conflict(`${what} ${path} was replaced by a non-regular file during the run`)
  if (!sameIdentity(st, owned) || st.nlink !== 1) throw conflict(`${what} ${path} was replaced during the run; leaving it for manual recovery`)
  if (st.mode !== owned.mode) throw conflict(`${what} ${path} changed mode during the run; leaving it for manual recovery`)
  if (st.size !== owned.size || sha256(readFileSync(path)) !== owned.digest) {
    throw conflict(`${what} ${path} was edited during the run; leaving it for manual recovery`)
  }
}

/** Project under an already held lease. On failure every owned change is rolled back; the lease stays with the caller. */
function projectUnderLease(lease: Lease, workdir: string, filename: string, request: ProjectionRequest): OwnedProjection {
  const chain = chainBelow(workdir, filename, 'instructions filename')
  const filePath = chain[chain.length - 1]!
  const parents = chain.slice(0, -1)
  const backupPath = join(lease.lockDir, `original-${basename(filePath)}`)
  const createdDirs: OwnedDir[] = []
  let original: OwnedFile | null = null
  try {
    ensureDirs(parents, createdDirs)
    const parentIdentities = parents.map((path) => {
      const st = lstatSync(path)
      return { path, ino: st.ino, dev: st.dev }
    })

    const st = lstatOrNull(filePath)
    let bytes = request.replacement
    if (st !== null) {
      if (st.isSymbolicLink()) throw conflict(`${filePath} is a symlink; refusing to replace it`)
      if (!st.isFile()) throw conflict(`${filePath} exists and is not a regular file`)
      if (st.nlink > 1) throw conflict(`${filePath} has ${st.nlink} hard links; refusing to project over shared content`)
      const existing = readFileSync(filePath)
      bytes = compose(existing, filePath, request)
      original = { ino: st.ino, dev: st.dev, mode: st.mode, size: existing.length, digest: sha256(existing) }
      renameSync(filePath, backupPath)
      verifyOwned(backupPath, original, 'backup')
    }

    const target = createOwned(filePath, bytes)
    return { filePath, parents: parentIdentities, backupPath, original, target, createdDirs }
  } catch (err) {
    if (original !== null) {
      const moved = lstatOrNull(backupPath)
      if (moved !== null && lstatOrNull(filePath) === null) {
        verifyOwned(backupPath, original, 'backup')
        renameSync(backupPath, filePath)
      }
    }
    pruneDirs(createdDirs)
    throw err
  }
}

/** Restore under the lease; any drift throws `instruction-conflict` before touching the target or the backup. */
function restoreUnderLease(lease: Lease, owned: OwnedProjection): void {
  checkLease(lease)
  checkDirs(owned.parents)
  verifyOwned(owned.filePath, owned.target, 'projected instructions file')
  if (owned.original !== null) {
    verifyOwned(owned.backupPath, owned.original, 'backup')
    renameSync(owned.backupPath, owned.filePath)
  } else {
    unlinkSync(owned.filePath)
  }
  pruneDirs(owned.createdDirs)
}

/** Finish a lifecycle: restore the projection, prune owned directories, release the lease. Idempotent after success. */
function releaseOwned(state: OwnedState): void {
  if (state.released) return
  checkLease(state.lease)
  const expectedBackup = state.projection?.original ? basename(state.projection.backupPath) : null
  if (readdirSync(state.lease.lockDir).some((entry) => entry !== expectedBackup)) {
    throw conflict(`${state.lease.lockDir} contains unexpected entries; preserving the projection for manual recovery`)
  }
  if (state.projection !== null) restoreUnderLease(state.lease, state.projection)
  pruneDirs(state.createdDirs)
  releaseLease(state.lease)
  state.released = true
}

/**
 * Create `workdir/filename` exclusively with `content`. Returns the path, or
 * null when `content` is null/undefined (an empty string writes an empty
 * file). Rejects an existing path, a symlink anywhere below the workdir and
 * unsafe filenames; never truncates. The workdir lease is held for the
 * creation only, so the file can never appear underneath a running command;
 * a run in progress rejects with `instruction-conflict`. The file itself is
 * caller-owned and persists: nothing cleans it up. Prefer
 * `projectInstructions` for temporary ownership.
 */
export function writeInstructions(
  workdir: string,
  filename: string,
  content: string | undefined | null,
): string | null {
  if (content == null) return null
  const canonical = canonicalWorkdir(workdir)
  const chain = chainBelow(canonical, filename, 'instructions filename')
  const filePath = chain[chain.length - 1]!
  const lease = acquireLease(canonical)
  const createdDirs: OwnedDir[] = []
  try {
    ensureDirs(chain.slice(0, -1), createdDirs)
    createOwned(filePath, Buffer.from(content, 'utf-8'))
  } catch (err) {
    pruneDirs(createdDirs)
    releaseLease(lease)
    if (errnoOf(err) === 'EEXIST') throw conflict(`${filePath} already exists; writeInstructions never overwrites`)
    throw err
  }
  releaseLease(lease)
  return filePath
}

/**
 * Take the workdir lease and project `content` into `workdir/filename`,
 * preserving any original by rename into the lease directory. The lease is
 * held until `restoreProjectedInstructions` succeeds, so overlapping runs on
 * the same workdir are rejected with `instruction-conflict`.
 */
export function projectInstructions(
  workdir: string,
  filename: string,
  content: string,
  opts: ProjectInstructionsOptions = {},
): InstructionProjection {
  const mode = opts.mode ?? 'replace'
  if (mode !== 'replace' && mode !== 'prepend') {
    throw new HarnessError(`Unknown projection mode ${JSON.stringify(mode)}; expected "replace" or "prepend"`, 'invalid-options')
  }
  if (opts.backup === false) {
    throw new HarnessError('backup=false is not supported: originals are always preserved so restore can undo', 'invalid-options')
  }
  const markers = opts.replaceBetweenMarkers ?? null
  if (markers !== null && (typeof markers.start !== 'string' || typeof markers.end !== 'string' || markers.start === '' || markers.end === '')) {
    throw new HarnessError('replaceBetweenMarkers needs non-empty start and end strings', 'invalid-options')
  }
  if (typeof content !== 'string') {
    throw new HarnessError('instructions content must be a string', 'invalid-options')
  }
  const canonical = canonicalWorkdir(workdir)
  chainBelow(canonical, filename, 'instructions filename')
  const lease = acquireLease(canonical)
  let projection: OwnedProjection
  try {
    projection = projectUnderLease(lease, canonical, filename, {
      mode,
      markers,
      replacement: Buffer.from(`${content}\n`, 'utf-8'),
      content,
    })
  } catch (err) {
    releaseLease(lease)
    throw err
  }
  const handle: InstructionProjection = {
    workdir: canonical,
    filename,
    filePath: projection.filePath,
    existedBefore: projection.original !== null,
    backupPath: projection.backupPath,
    wroteBackup: projection.original !== null,
  }
  projections.set(handle, { lease, projection, createdDirs: [], released: false })
  return handle
}

/**
 * Undo `projectInstructions` and release the lease. Only the exact file we
 * created is removed; a target that was edited, replaced or deleted, or a
 * tampered backup/lock, raises `instruction-conflict` and leaves both the
 * current file and the backup in place with the lease still held.
 * Idempotent after success.
 */
export function restoreProjectedInstructions(projection: InstructionProjection): void {
  const state = projections.get(projection)
  if (state === undefined) {
    throw new HarnessError('restoreProjectedInstructions needs the handle returned by projectInstructions', 'invalid-options')
  }
  releaseOwned(state)
}

/**
 * Acquire the workdir lease, create the planned artifact directories and
 * project `instructionContent` (exact bytes) into `instructionsFile`. Every
 * run takes the lease, even without instructions, so it never observes
 * another run's projection. On failure owned changes are rolled back and the
 * lease released.
 */
export function prepareCommand(command: BuildCommand): PreparedCommand {
  const cwd = resolve(command.cwd)
  const canonical = canonicalWorkdir(cwd)
  const content = command.instructionContent
  let filename: string | null = null
  if (content !== undefined) {
    if (command.instructionsFile === null) {
      throw new HarnessError('instructionContent needs a planned instructionsFile', 'invalid-options')
    }
    filename = relativeBelow(cwd, canonical, command.instructionsFile, 'instructionsFile')
  }
  const dirChains = (command.directories ?? []).map((dir) => chainBelow(canonical, relativeBelow(cwd, canonical, dir, 'planned directory'), 'planned directory'))

  const lease = acquireLease(canonical)
  const createdDirs: OwnedDir[] = []
  let projection: OwnedProjection | null = null
  try {
    for (const chain of dirChains) ensureDirs(chain, createdDirs)
    if (filename !== null && content !== undefined) {
      projection = projectUnderLease(lease, canonical, filename, {
        mode: 'replace',
        markers: null,
        replacement: Buffer.from(content, 'utf-8'),
        content,
      })
    }
  } catch (err) {
    pruneDirs(createdDirs)
    releaseLease(lease)
    throw err
  }
  const handle: PreparedCommand = { command }
  preparations.set(handle, { lease, projection, createdDirs, released: false })
  return handle
}

/**
 * Restore the projected instructions, prune only the directories this
 * preparation created and still empty, and release the lease. CLI-owned
 * outputs inside those directories are never deleted. Idempotent after
 * success; conflicts retain the lease (see `restoreProjectedInstructions`).
 */
export function cleanupCommand(handle: PreparedCommand): void {
  const state = preparations.get(handle)
  if (state === undefined) {
    throw new HarnessError('cleanupCommand needs the handle returned by prepareCommand', 'invalid-options')
  }
  releaseOwned(state)
}
