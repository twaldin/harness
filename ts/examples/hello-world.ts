// Minimal harness usage: invoke claude-code, print cost + result.
// Run: bun ts/examples/hello-world.ts  (from repo root)
// Or:  bun hello-world.ts              (from ts/examples/)
import { run } from '../src/index.js'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const wd = mkdtempSync(join(tmpdir(), 'harness-'))

const r = await run({
  harness: 'claude-code',
  model: 'sonnet',
  prompt: "Print the string 'hello from harness' and nothing else.",
  workdir: wd,
  timeoutSeconds: 120,
})

const cost = r.costUsd != null ? `$${r.costUsd.toFixed(4)}` : 'n/a'
console.log(`exit=${r.exitCode}  cost=${cost}  tokens=${r.tokensIn}/${r.tokensOut}  wall=${r.durationSeconds.toFixed(1)}s`)
console.log(r.stdout.slice(0, 400))
