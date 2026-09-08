import { afterAll, describe, expect, test } from 'bun:test'
import {
  chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync,
  renameSync, statSync, symlinkSync, unlinkSync, writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawnSync } from 'node:child_process'
import { HarnessError } from '../src/base.js'
import type { BuildCommand, ErrorCode } from '../src/base.js'
import {
  cleanupCommand, prepareCommand, projectInstructions, restoreProjectedInstructions, writeInstructions,
} from '../src/instructions.js'
import type { InstructionProjection } from '../src/instructions.js'

const LOCK = '.harness-run.lock'
const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'harness-ts-instructions-')))
let counter = 0

function tmpDir(): string {
  const dir = join(ROOT, `wd-${counter++}`)
  mkdirSync(dir)
  return dir
}

afterAll(() => {
  try {
    rmSync(ROOT, { recursive: true, force: true })
  } catch {}
})

function expectCode(fn: () => unknown, code: ErrorCode): HarnessError {
  let caught: unknown
  try {
    fn()
  } catch (err) {
    caught = err
  }
  expect(caught).toBeInstanceOf(HarnessError)
  const err = caught as HarnessError
  expect(err.code).toBe(code)
  return err
}

function command(cwd: string, extra: Partial<BuildCommand> = {}): BuildCommand {
  return { cmd: 'x', args: [], cwd, env: {}, instructionsFile: null, directories: [], model: 'm', ...extra }
}

/** Filesystem identity plus bytes plus permission bits: what a user notices when their file comes back. */
function fingerprint(path: string): { ino: number; mode: number; bytes: string } {
  const st = statSync(path)
  return { ino: st.ino, mode: st.mode & 0o777, bytes: readFileSync(path).toString('base64') }
}

describe('projectInstructions / restoreProjectedInstructions', () => {
  test('existing file comes back with its bytes, mode and inode; binary survives replace', () => {
    const workdir = tmpDir()
    const file = join(workdir, 'AGENTS.md')
    writeFileSync(file, Buffer.from([0xff, 0xfe, 0x00, 0x41]))
    chmodSync(file, 0o640)
    const before = fingerprint(file)

    const projected = projectInstructions(workdir, 'AGENTS.md', 'injected')
    expect(readFileSync(file, 'utf-8')).toBe('injected\n')
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(fingerprint(projected.backupPath)).toEqual(before)

    restoreProjectedInstructions(projected)
    expect(fingerprint(file)).toEqual(before)
    expect(existsSync(join(workdir, LOCK))).toBe(false)
  })

  test('prepend keeps the original after a blank line and restores it exactly', () => {
    const workdir = tmpDir()
    const file = join(workdir, 'AGENTS.md')
    writeFileSync(file, 'original\n', 'utf-8')
    const projected = projectInstructions(workdir, 'AGENTS.md', 'injected', { mode: 'prepend' })
    expect(readFileSync(file, 'utf-8')).toBe('injected\n\noriginal\n')
    restoreProjectedInstructions(projected)
    expect(readFileSync(file, 'utf-8')).toBe('original\n')
  })

  test('markers replace the whole first well-ordered block, else fall back to the mode', () => {
    const workdir = tmpDir()
    const file = join(workdir, 'AGENTS.md')
    const markers = { start: '<!-- a -->', end: '<!-- /a -->' }
    writeFileSync(file, 'head\n<!-- /a -->stray\n<!-- a -->old<!-- /a -->\ntail\n', 'utf-8')
    const projected = projectInstructions(workdir, 'AGENTS.md', 'new', { replaceBetweenMarkers: markers })
    expect(readFileSync(file, 'utf-8')).toBe('head\n<!-- /a -->stray\nnew\ntail\n')
    restoreProjectedInstructions(projected)

    writeFileSync(file, 'no markers here\n', 'utf-8')
    const fallback = projectInstructions(workdir, 'AGENTS.md', 'new', { mode: 'prepend', replaceBetweenMarkers: markers })
    expect(readFileSync(file, 'utf-8')).toBe('new\n\nno markers here\n')
    restoreProjectedInstructions(fallback)
    expect(readFileSync(file, 'utf-8')).toBe('no markers here\n')
  })

  test('new nested file is created mode 600 and only the directories it created are pruned', () => {
    const workdir = tmpDir()
    mkdirSync(join(workdir, '.opencode'))
    writeFileSync(join(workdir, '.opencode', 'keep.txt'), 'keep', 'utf-8')
    const projected = projectInstructions(workdir, '.opencode/agents/flt.md', '')
    const file = join(workdir, '.opencode/agents/flt.md')
    expect(readFileSync(file, 'utf-8')).toBe('\n')
    expect(statSync(file).mode & 0o777).toBe(0o600)

    restoreProjectedInstructions(projected)
    expect(existsSync(file)).toBe(false)
    expect(existsSync(join(workdir, '.opencode/agents'))).toBe(false)
    expect(readFileSync(join(workdir, '.opencode', 'keep.txt'), 'utf-8')).toBe('keep')
    expect(existsSync(join(workdir, LOCK))).toBe(false)
  })

  test('a created directory that gained content is left in place', () => {
    const workdir = tmpDir()
    const projected = projectInstructions(workdir, 'sub/AGENTS.md', 'x')
    writeFileSync(join(workdir, 'sub', 'user.txt'), 'mine', 'utf-8')
    restoreProjectedInstructions(projected)
    expect(existsSync(join(workdir, 'sub/AGENTS.md'))).toBe(false)
    expect(readFileSync(join(workdir, 'sub', 'user.txt'), 'utf-8')).toBe('mine')
  })

  test('stale legacy backups are neither consumed nor restored', () => {
    const workdir = tmpDir()
    writeFileSync(join(workdir, '.harness-backup-AGENTS.md'), 'legacy\n', 'utf-8')
    const projected = projectInstructions(workdir, 'AGENTS.md', 'x')
    restoreProjectedInstructions(projected)
    expect(existsSync(join(workdir, 'AGENTS.md'))).toBe(false)
    expect(readFileSync(join(workdir, '.harness-backup-AGENTS.md'), 'utf-8')).toBe('legacy\n')
  })

  test('restore is idempotent after success', () => {
    const workdir = tmpDir()
    const projected = projectInstructions(workdir, 'AGENTS.md', 'x')
    restoreProjectedInstructions(projected)
    writeFileSync(join(workdir, 'AGENTS.md'), 'user wrote this later\n', 'utf-8')
    restoreProjectedInstructions(projected)
    expect(readFileSync(join(workdir, 'AGENTS.md'), 'utf-8')).toBe('user wrote this later\n')
  })

  test('invalid options reject before any write or lease', () => {
    const workdir = tmpDir()
    writeFileSync(join(workdir, 'AGENTS.md'), 'original\n', 'utf-8')
    const bogusMode = 'bogus' as 'replace'
    expectCode(() => projectInstructions(workdir, 'AGENTS.md', 'x', { mode: bogusMode }), 'invalid-options')
    expectCode(() => projectInstructions(workdir, 'AGENTS.md', 'x', { backup: false }), 'invalid-options')
    expectCode(() => projectInstructions(workdir, 'AGENTS.md', 'x', { replaceBetweenMarkers: { start: '', end: 'e' } }), 'invalid-options')
    expectCode(() => projectInstructions(workdir, '/etc/AGENTS.md', 'x'), 'invalid-options')
    expectCode(() => projectInstructions(workdir, '../AGENTS.md', 'x'), 'invalid-options')
    expectCode(() => projectInstructions(join(workdir, 'missing'), 'AGENTS.md', 'x'), 'invalid-options')
    expect(readFileSync(join(workdir, 'AGENTS.md'), 'utf-8')).toBe('original\n')
    expect(readdirSync(workdir)).toEqual(['AGENTS.md'])
  })

  test('symlink leaf, dangling symlink, symlinked ancestor and hard link are conflicts that touch nothing', () => {
    const workdir = tmpDir()
    const real = join(workdir, 'real.md')
    writeFileSync(real, 'real\n', 'utf-8')
    symlinkSync(real, join(workdir, 'AGENTS.md'))
    symlinkSync(join(workdir, 'nowhere'), join(workdir, 'DANGLING.md'))
    mkdirSync(join(workdir, 'outside'))
    symlinkSync(join(workdir, 'outside'), join(workdir, 'linked'))
    linkSync(real, join(workdir, 'HARD.md'))

    expectCode(() => projectInstructions(workdir, 'AGENTS.md', 'x'), 'instruction-conflict')
    expectCode(() => projectInstructions(workdir, 'DANGLING.md', 'x'), 'instruction-conflict')
    expectCode(() => projectInstructions(workdir, 'linked/AGENTS.md', 'x'), 'instruction-conflict')
    expectCode(() => projectInstructions(workdir, 'HARD.md', 'x'), 'instruction-conflict')

    expect(readFileSync(real, 'utf-8')).toBe('real\n')
    expect(lstatSync(join(workdir, 'AGENTS.md')).isSymbolicLink()).toBe(true)
    expect(lstatSync(join(workdir, 'DANGLING.md')).isSymbolicLink()).toBe(true)
    expect(readdirSync(join(workdir, 'outside'))).toEqual([])
    expect(statSync(join(workdir, 'HARD.md')).nlink).toBe(2)
    expect(existsSync(join(workdir, LOCK))).toBe(false)
  })

  test('a failed projection releases the lease and leaves the target untouched', () => {
    const workdir = tmpDir()
    const file = join(workdir, 'AGENTS.md')
    writeFileSync(file, Buffer.from([0xff, 0xfe]))
    const before = fingerprint(file)
    expectCode(() => projectInstructions(workdir, 'AGENTS.md', 'x', { mode: 'prepend' }), 'instruction-conflict')
    expect(fingerprint(file)).toEqual(before)
    expect(existsSync(join(workdir, LOCK))).toBe(false)
    // The workdir is free again.
    restoreProjectedInstructions(projectInstructions(workdir, 'AGENTS.md', 'x'))
  })

  test('unexpected lock entries prevent restoration and are preserved', () => {
    const workdir = tmpDir()
    const projected = projectInstructions(workdir, 'AGENTS.md', 'injected')
    writeFileSync(join(workdir, LOCK, 'user-file'), 'mine')
    expectCode(() => restoreProjectedInstructions(projected), 'instruction-conflict')
    expect(readFileSync(projected.filePath, 'utf-8')).toBe('injected\n')
    expect(readFileSync(join(workdir, LOCK, 'user-file'), 'utf-8')).toBe('mine')
  })

  test('partial-write failures restore originals without removing foreign replacements', () => {
    for (const foreign of [false, true]) {
      const workdir = tmpDir()
      const result = spawnSync(process.execPath, ['-e', `
        import assert from 'node:assert/strict';
        import { mock } from 'bun:test';
        import * as nativeFs from 'node:fs';
        const fs = { ...nativeFs };
        const workdir = ${JSON.stringify(workdir)};
        const file = workdir + '/AGENTS.md';
        fs.writeFileSync(file, 'original');
        const identity = fs.statSync(file).ino;
        let calls = 0;
        mock.module('node:fs', () => ({ ...fs, writeSync(fd, bytes, offset, length) {
          if (++calls === 1) return fs.writeSync(fd, bytes, offset, Math.min(2, length));
          if (${foreign}) { fs.unlinkSync(file); fs.writeFileSync(file, 'user replacement'); }
          throw new Error('synthetic disk failure');
        }}));
        // Load after installing the fault injector; a static import would bind before the mock.
        const { projectInstructions } = await import(${JSON.stringify(join(import.meta.dir, '../src/instructions.ts'))});
        assert.throws(() => projectInstructions(workdir, 'AGENTS.md', 'injected'));
        if (${foreign}) {
          assert.equal(fs.readFileSync(file, 'utf8'), 'user replacement');
          assert.equal(fs.readFileSync(workdir + '/.harness-run.lock/original-AGENTS.md', 'utf8'), 'original');
        } else {
          assert.equal(fs.readFileSync(file, 'utf8'), 'original');
          assert.equal(fs.statSync(file).ino, identity);
          assert.equal(fs.existsSync(workdir + '/.harness-run.lock'), false);
        }
      `], { encoding: 'utf-8' })
      expect(result.status, result.stderr).toBe(0)
    }
  })

  test('replaced preexisting parent preserves the current file and original backup', () => {
    const workdir = tmpDir()
    const directory = join(workdir, 'nested')
    mkdirSync(directory)
    const file = join(directory, 'AGENTS.md')
    writeFileSync(file, 'original\n')
    const projected = projectInstructions(workdir, 'nested/AGENTS.md', 'injected')
    const displaced = join(workdir, 'displaced')
    renameSync(directory, displaced)
    mkdirSync(directory)
    renameSync(join(displaced, 'AGENTS.md'), file)

    expectCode(() => restoreProjectedInstructions(projected), 'instruction-conflict')
    expect(readFileSync(file, 'utf-8')).toBe('injected\n')
    expect(readFileSync(projected.backupPath, 'utf-8')).toBe('original\n')
    expect(existsSync(join(workdir, LOCK))).toBe(true)
  })

  describe('drift during the run keeps the user file, the backup and the lease', () => {
    function drifted(mutate: (file: string) => void): { workdir: string; file: string; projected: InstructionProjection } {
      const workdir = tmpDir()
      const file = join(workdir, 'AGENTS.md')
      writeFileSync(file, 'original\n', 'utf-8')
      const projected = projectInstructions(workdir, 'AGENTS.md', 'injected')
      mutate(file)
      expectCode(() => restoreProjectedInstructions(projected), 'instruction-conflict')
      expect(readFileSync(projected.backupPath, 'utf-8')).toBe('original\n')
      expect(existsSync(join(workdir, LOCK))).toBe(true)
      // Still conflicting: the lease is retained so nothing else can mutate the workdir.
      expectCode(() => restoreProjectedInstructions(projected), 'instruction-conflict')
      expectCode(() => projectInstructions(workdir, 'OTHER.md', 'x'), 'instruction-conflict')
      return { workdir, file, projected }
    }

    test('edited in place', () => {
      const { file } = drifted((f) => writeFileSync(f, 'user edit\n', 'utf-8'))
      expect(readFileSync(file, 'utf-8')).toBe('user edit\n')
    })

    test('replaced by a new file with the same bytes', () => {
      const { file } = drifted((f) => {
        unlinkSync(f)
        writeFileSync(f, 'injected\n', 'utf-8')
      })
      expect(readFileSync(file, 'utf-8')).toBe('injected\n')
    })

    test('replaced by a symlink', () => {
      const { file } = drifted((f) => {
        unlinkSync(f)
        writeFileSync(`${f}.elsewhere`, 'elsewhere\n', 'utf-8')
        symlinkSync(`${f}.elsewhere`, f)
      })
      expect(lstatSync(file).isSymbolicLink()).toBe(true)
    })

    test('mode changed', () => {
      const { file } = drifted((f) => chmodSync(f, 0o644))
      expect(statSync(file).mode & 0o777).toBe(0o644)
    })

    test('deleted', () => {
      const { file } = drifted((f) => unlinkSync(f))
      expect(existsSync(file)).toBe(false)
    })

    test('backup tampered', () => {
      const workdir = tmpDir()
      const file = join(workdir, 'AGENTS.md')
      writeFileSync(file, 'original\n', 'utf-8')
      const projected = projectInstructions(workdir, 'AGENTS.md', 'injected')
      writeFileSync(projected.backupPath, 'tampered\n', 'utf-8')
      expectCode(() => restoreProjectedInstructions(projected), 'instruction-conflict')
      expect(readFileSync(file, 'utf-8')).toBe('injected\n')
      expect(existsSync(join(workdir, LOCK))).toBe(true)
    })
  })
})

describe('workdir lease', () => {
  test('an existing lock (another process or language) rejects without touching the workdir', () => {
    const workdir = tmpDir()
    writeFileSync(join(workdir, 'AGENTS.md'), 'theirs\n', 'utf-8')
    mkdirSync(join(workdir, LOCK), { mode: 0o700 })
    expectCode(() => projectInstructions(workdir, 'AGENTS.md', 'x'), 'instruction-conflict')
    expectCode(() => prepareCommand(command(workdir)), 'instruction-conflict')
    expect(readFileSync(join(workdir, 'AGENTS.md'), 'utf-8')).toBe('theirs\n')
    expect(readdirSync(join(workdir, LOCK))).toEqual([])
  })

  test('a symlink at the lock path is never followed or stolen', () => {
    const workdir = tmpDir()
    mkdirSync(join(workdir, 'elsewhere'))
    symlinkSync(join(workdir, 'elsewhere'), join(workdir, LOCK))
    expectCode(() => prepareCommand(command(workdir)), 'instruction-conflict')
    expect(lstatSync(join(workdir, LOCK)).isSymbolicLink()).toBe(true)
  })

  test('the same canonical workdir through a symlink alias is one lease; distinct workdirs are independent', () => {
    const workdir = tmpDir()
    const alias = join(ROOT, `alias-${counter++}`)
    symlinkSync(workdir, alias)
    const held = prepareCommand(command(alias))
    expect(existsSync(join(workdir, LOCK))).toBe(true)
    expectCode(() => prepareCommand(command(workdir)), 'instruction-conflict')
    expectCode(() => projectInstructions(alias, 'AGENTS.md', 'x'), 'instruction-conflict')

    const other = prepareCommand(command(tmpDir()))
    cleanupCommand(other)
    cleanupCommand(held)
    expect(existsSync(join(workdir, LOCK))).toBe(false)
  })

  test('a removed or replaced lock is a conflict at cleanup', () => {
    const workdir = tmpDir()
    const held = prepareCommand(command(workdir))
    rmSync(join(workdir, LOCK), { recursive: true })
    mkdirSync(join(workdir, LOCK))
    expectCode(() => cleanupCommand(held), 'instruction-conflict')
  })
})

describe('prepareCommand / cleanupCommand', () => {
  test('projects exact instruction bytes, creates planned directories, and restores everything', () => {
    const workdir = tmpDir()
    const dataDir = join(workdir, '.harness', 'crush-data')
    const built = command(workdir, {
      instructionsFile: join(workdir, 'AGENTS.md'),
      instructionContent: 'no trailing newline',
      directories: [dataDir],
    })
    const prepared = prepareCommand(built)
    expect(prepared.command).toBe(built)
    expect(readFileSync(join(workdir, 'AGENTS.md'), 'utf-8')).toBe('no trailing newline')
    expect(statSync(dataDir).isDirectory()).toBe(true)
    expect(existsSync(join(workdir, LOCK))).toBe(true)

    cleanupCommand(prepared)
    expect(existsSync(join(workdir, 'AGENTS.md'))).toBe(false)
    expect(existsSync(join(workdir, '.harness'))).toBe(false)
    expect(existsSync(join(workdir, LOCK))).toBe(false)
    cleanupCommand(prepared)
  })

  test('CLI outputs inside a created directory survive; preexisting directories are never removed', () => {
    const workdir = tmpDir()
    mkdirSync(join(workdir, '.harness'))
    const dataDir = join(workdir, '.harness', 'kilo')
    const prepared = prepareCommand(command(workdir, { directories: [dataDir] }))
    writeFileSync(join(dataDir, 'kilo.db'), 'db', 'utf-8')
    cleanupCommand(prepared)
    expect(readFileSync(join(dataDir, 'kilo.db'), 'utf-8')).toBe('db')

    const empty = prepareCommand(command(workdir, { directories: [join(workdir, '.harness', 'empty')] }))
    cleanupCommand(empty)
    expect(existsSync(join(workdir, '.harness', 'empty'))).toBe(false)
    expect(existsSync(join(workdir, '.harness'))).toBe(true)
  })

  test('a run without instructions still holds the lease so no other projection can appear underneath it', () => {
    const workdir = tmpDir()
    const prepared = prepareCommand(command(workdir))
    expectCode(() => projectInstructions(workdir, 'AGENTS.md', 'x'), 'instruction-conflict')
    expectCode(() => writeInstructions(workdir, 'AGENTS.md', 'x'), 'instruction-conflict')
    expect(existsSync(join(workdir, 'AGENTS.md'))).toBe(false)
    cleanupCommand(prepared)
  })

  test('a failed prepare rolls back its directories and releases the lease', () => {
    const workdir = tmpDir()
    symlinkSync(join(workdir, 'nowhere'), join(workdir, 'AGENTS.md'))
    const built = command(workdir, {
      instructionsFile: join(workdir, 'AGENTS.md'),
      instructionContent: 'x',
      directories: [join(workdir, '.harness', 'out')],
    })
    expectCode(() => prepareCommand(built), 'instruction-conflict')
    expect(existsSync(join(workdir, '.harness'))).toBe(false)
    expect(existsSync(join(workdir, LOCK))).toBe(false)
    expect(lstatSync(join(workdir, 'AGENTS.md')).isSymbolicLink()).toBe(true)
  })

  test('plans outside the workdir and missing workdirs are rejected before the lease', () => {
    const workdir = tmpDir()
    expectCode(() => prepareCommand(command(workdir, { directories: [join(ROOT, 'escape')] })), 'invalid-options')
    expectCode(() => prepareCommand(command(workdir, { instructionsFile: join(ROOT, 'AGENTS.md'), instructionContent: 'x' })), 'invalid-options')
    expectCode(() => prepareCommand(command(join(workdir, 'missing'))), 'invalid-options')
    expect(existsSync(join(workdir, LOCK))).toBe(false)
    expect(existsSync(join(ROOT, 'escape'))).toBe(false)
  })

  test('only handles issued by prepareCommand can clean up', () => {
    const workdir = tmpDir()
    const prepared = prepareCommand(command(workdir))
    expectCode(() => cleanupCommand({ command: prepared.command }), 'invalid-options')
    expect(existsSync(join(workdir, LOCK))).toBe(true)
    cleanupCommand(prepared)
  })
})

describe('writeInstructions', () => {
  test('creates exclusively, persists after the lease is released, and never truncates', () => {
    const workdir = tmpDir()
    expect(writeInstructions(workdir, 'AGENTS.md', null)).toBeNull()
    expect(writeInstructions(workdir, 'AGENTS.md', undefined)).toBeNull()
    expect(existsSync(join(workdir, 'AGENTS.md'))).toBe(false)

    const path = writeInstructions(workdir, 'nested/AGENTS.md', '')
    expect(path).toBe(join(workdir, 'nested/AGENTS.md'))
    expect(readFileSync(path!, 'utf-8')).toBe('')
    expect(existsSync(join(workdir, LOCK))).toBe(false)

    expectCode(() => writeInstructions(workdir, 'nested/AGENTS.md', 'overwrite'), 'instruction-conflict')
    expect(readFileSync(path!, 'utf-8')).toBe('')
    expect(existsSync(join(workdir, LOCK))).toBe(false)
  })

  test('rejects symlinks and unsafe names without creating anything', () => {
    const workdir = tmpDir()
    writeFileSync(join(workdir, 'real.md'), 'real\n', 'utf-8')
    symlinkSync(join(workdir, 'real.md'), join(workdir, 'LINK.md'))
    mkdirSync(join(workdir, 'outside'))
    symlinkSync(join(workdir, 'outside'), join(workdir, 'linked'))
    expectCode(() => writeInstructions(workdir, 'LINK.md', 'x'), 'instruction-conflict')
    expectCode(() => writeInstructions(workdir, 'linked/AGENTS.md', 'x'), 'instruction-conflict')
    expectCode(() => writeInstructions(workdir, '../AGENTS.md', 'x'), 'invalid-options')
    expect(readFileSync(join(workdir, 'real.md'), 'utf-8')).toBe('real\n')
    expect(readdirSync(join(workdir, 'outside'))).toEqual([])
    expect(existsSync(join(workdir, LOCK))).toBe(false)
  })
})
