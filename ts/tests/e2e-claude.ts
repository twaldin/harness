import '../src/adapters/index.js'
import { run } from '../src/registry.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Deliberately not a *.test.ts file: ordinary CI never invokes a provider.
if (!process.argv.includes('--live')) {
  console.error('Opt-in provider smoke: rerun with --live. Requires local Claude authentication and may incur cost.')
  process.exit(2)
}

const workdir = mkdtempSync(join(tmpdir(), 'harness-live-claude-'))

try {
  const result = await run({
    harness: 'claude-code',
    prompt: 'Print the number 42 and nothing else.',
    workdir,
    model: 'claude-haiku-4-5-20251001',
    timeoutSeconds: 120,
  })

  // Report metadata only; raw provider output is not public fixture evidence.
  console.log({
    termination: result.termination,
    exitCode: result.exitCode,
    durationSeconds: result.durationSeconds,
    costUsd: result.costUsd,
    tokensIn: result.tokensIn,
    tokensOut: result.tokensOut,
  })
  if (result.termination !== 'exited' || result.exitCode !== 0 ||
      result.parseError != null || result.tokensIn === null) {
    throw new Error('Provider smoke failed: expected clean execution and parsed usage')
  }
} finally {
  rmSync(workdir, { recursive: true, force: true })
}
