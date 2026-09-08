// Exercise the published ESM surface against the same synthetic RPC peer as Py/Bun.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openSession } from '../dist/index.js'

const root = fileURLToPath(new URL('../../', import.meta.url))
const cases = JSON.parse(await readFile(resolve(root, 'tests/session_cases.json'), 'utf8'))
const executable = resolve(root, 'tests/helpers/rpc_agent.py')
let passed = 0
for (const scenario of cases) {
  const workdir = await mkdtemp(resolve(tmpdir(), 'harness-node-session-'))
  let session
  try {
    session = await openSession({
      harness: 'pi', backend: 'rpc', workdir, executable,
      env: { HARNESS_RPC_CASE: scenario.name },
      timeoutSeconds: scenario.name === 'hang' ? 0.15 : 5,
      requestTimeoutSeconds: 3,
    })
    const turn = session.startTurn('synthetic prompt')
    const observed = []
    const consume = (async () => { for await (const event of turn.events) observed.push(event) })()
    const result = await turn.result
    await consume
    assert.equal(result.status, scenario.status, scenario.name)
    assert.equal(result.sessionId, session.reference.sessionId, scenario.name)
    assert.equal(result.turnId, turn.id, scenario.name)
    if (scenario.exit_code !== undefined) assert.equal(result.exitCode, scenario.exit_code, scenario.name)
    if (scenario.signal !== undefined) assert.equal(result.signal, scenario.signal, scenario.name)
    if (scenario.event_types) assert.deepEqual(observed.map(event => event.type), scenario.event_types, scenario.name)
    if (scenario.name === 'success') {
      const next = session.startTurn('synthetic follow-up')
      const drain = (async () => { for await (const _event of next.events) { /* drain bounded stream */ } })()
      const followup = await next.result
      await drain
      assert.equal(followup.status, 'completed')
      assert.equal(followup.sessionId, result.sessionId)
      assert.notEqual(next.id, turn.id)
    }
    passed++
  } finally {
    await session?.close()
    await rm(workdir, { recursive: true, force: true })
  }
}
console.log(`Node packaged RPC conformance: ${passed} shared scenarios passed`)
