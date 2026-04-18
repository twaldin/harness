# agentelo — TS bridge to harness CLI

[agentelo](https://github.com/twaldin/agentelo) is a Bradley-Terry leaderboard for AI coding agents on real GitHub bugs. Its `bin/agentelo` (Node) currently has ~800 lines of per-harness spawn / env-setup / token-parsing logic, mirrored from the same patterns now living in `harness`'s adapters.

## Migration plan: TS shells out to `harness run --json`

Rather than port harness to TS, agentelo will call the Python `harness` CLI as a subprocess and parse its `--json` output. The Python startup cost (~150ms) is negligible against 15-25min agent runs.

Sketch:

```javascript
// bin/agentelo (post-migration sketch)
const { spawnSync } = require('child_process')

function runHarness({ harness, model, workdir, prompt, instructionsFile, timeoutSeconds }) {
  const args = [
    'run',
    '--harness', harness,
    '--model', model,
    '--workdir', workdir,
    '--timeout', String(timeoutSeconds),
    '--json',
  ]
  if (instructionsFile) args.push('--instructions', instructionsFile)
  args.push(prompt)

  const proc = spawnSync('harness', args, { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 })
  if (proc.status !== 0 && !proc.stdout) {
    throw new Error(`harness failed (${proc.status}): ${proc.stderr.slice(0, 500)}`)
  }
  return JSON.parse(proc.stdout)
  // -> { harness, model, exit_code, duration_seconds, timed_out, cost_usd,
  //      tokens_in, tokens_out, stdout, stderr }
}
```

## What agentelo gets out of this

- ~800 lines of `if (harness === 'X')` blocks deleted from `bin/agentelo`
- adding a new harness becomes "ship a new adapter in harness", no agentelo edit
- shared knowledge: token parsers fixed once apply everywhere
- inactivity watchdog logic, when ported into harness, becomes universal

## Status

Migration not yet done — TS↔Python boundary deserves a focused refactor session, not a tired-3am reshuffle. Tracked as future work.
