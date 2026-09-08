// Packaged Node -> optional Bun SDK bridge. Synthetic SDK only, no provider.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openSession, getSessionCapabilities } from '../dist/index.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const cases = JSON.parse(readFileSync(join(root, 'tests/omp_sdk_cases.json'), 'utf8'))
const home = mkdtempSync(join(tmpdir(), 'harness-node-sdk-'))
const workdir = join(home, 'work')
mkdirSync(workdir)
const spec = {
  harness: 'omp', backend: 'sdk', workdir,
  ompSdk: { packageRoot: join(root, 'tests/helpers/omp_sdk'), agentDir: join(home, 'agent'), auth: 'environment' },
  env: { HOME: home }, requestTimeoutSeconds: 5, timeoutSeconds: 5,
}
let session
try {
  assert.equal(getSessionCapabilities('omp', 'sdk').resume, true)
  session = await openSession(spec)
  const reference = session.reference
  for (const scenario of cases) {
    const turn = session.startTurn(scenario.prompt)
    const events = []
    for await (const event of turn.events) {
      assert.equal(event.backend, 'sdk')
      assert.equal(event.harness, 'omp')
      assert.equal(event.sessionId, reference.sessionId)
      events.push(event.type)
    }
    assert.equal((await turn.result).status, scenario.status, scenario.prompt)
    if (scenario.event_types) assert.deepEqual(events, scenario.event_types)
  }
  await session.close()
  session = await openSession({ ...spec, resume: reference })
  assert.equal(session.reference.sessionId, reference.sessionId)
  const turn = session.startTurn('hang')
  const consume = (async () => {
    for await (const event of turn.events) {
      if (event.type === 'message_update') await session.interrupt()
    }
  })()
  await consume
  assert.equal((await turn.result).status, 'interrupted')
  await Promise.all([session.close(), session.close()])
  console.log(`Packaged Node SDK bridge: ${cases.length} shared cases, resume, interrupt and disposal passed`)
} finally {
  await session?.close()
  rmSync(home, { recursive: true, force: true })
}
