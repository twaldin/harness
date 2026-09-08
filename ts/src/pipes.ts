// POSIX FIFOs keep reads under our control. Bun's subprocess pipe wrappers
// eagerly buffer output even when paused; using descriptors avoids that layer.
import { spawnSync } from 'node:child_process'
import { closeSync, constants, mkdtempSync, openSync, readSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export class OutputPipe {
  readonly buffer = Buffer.allocUnsafe(65_536)
  eof = false
  #closed = false

  constructor(readonly readFd: number, public writeFd: number | null) {}

  closeWriter(): void {
    if (this.writeFd !== null) {
      closeSync(this.writeFd)
      this.writeFd = null
    }
  }

  read(): Buffer | null {
    if (this.eof) return null
    try {
      const size = readSync(this.readFd, this.buffer, 0, this.buffer.length, null)
      if (size === 0) this.eof = true
      return size === 0 ? null : this.buffer.subarray(0, size)
    } catch (error) {
      if (error instanceof Error && 'code' in error && (error.code === 'EAGAIN' || error.code === 'EWOULDBLOCK')) return null
      throw error
    }
  }

  close(): void {
    this.closeWriter()
    if (!this.#closed) {
      this.#closed = true
      closeSync(this.readFd)
    }
  }
}

export function outputPipes(): [OutputPipe, OutputPipe] {
  const directory = mkdtempSync(join(tmpdir(), 'harness-pipes-'))
  const pipes: OutputPipe[] = []
  try {
    const paths = [join(directory, 'stdout'), join(directory, 'stderr')]
    const made = spawnSync('/usr/bin/mkfifo', paths, { stdio: 'ignore', timeout: 5000 })
    if (made.error) throw made.error
    if (made.status !== 0) throw new Error('Unable to create subprocess output pipes')
    for (const path of paths) {
      const readFd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK)
      try {
        pipes.push(new OutputPipe(readFd, openSync(path, constants.O_WRONLY)))
      } catch (error) {
        closeSync(readFd)
        throw error
      }
    }
    return [pipes[0]!, pipes[1]!]
  } catch (error) {
    for (const pipe of pipes) pipe.close()
    throw error
  } finally {
    // Open descriptors retain the FIFOs. No filesystem artifact survives launch.
    rmSync(directory, { recursive: true, force: true })
  }
}
