import '../src/adapters/index.js'
import { run } from '../src/registry.js'
import { mkdirSync } from 'fs'

const workdir = '/tmp/harness-e2e-test'
mkdirSync(workdir, { recursive: true })

console.log('Running claude-code e2e test...')
const result = await run({
  harness: 'claude-code',
  prompt: 'Print the number 42 and nothing else.',
  workdir,
  model: 'claude-haiku-4-5-20251001',
  timeoutSeconds: 120,
})

console.log('exitCode:', result.exitCode)
console.log('timedOut:', result.timedOut)
console.log('durationSeconds:', result.durationSeconds.toFixed(2))
console.log('costUsd:', result.costUsd)
console.log('tokensIn:', result.tokensIn)
console.log('tokensOut:', result.tokensOut)
console.log('stdout (first 200):', result.stdout.slice(0, 200))

if (result.tokensIn === null) {
  console.error('FAIL: tokensIn is null — parseOutput did not extract tokens from stdout')
  process.exit(1)
}
console.log('PASS: tokensIn is non-null')
