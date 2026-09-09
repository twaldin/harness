// Packaged Node -> shared Amp SDK worker (dist/amp-sdk.mjs). Synthetic SDK and CLI only, no provider.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openSession, getSessionCapabilities } from '../dist/index.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const fixture = JSON.parse(readFileSync(join(root, 'tests/amp_sdk_cases.json'), 'utf8'))
const home = mkdtempSync(join(tmpdir(), 'harness-node-amp-'))
const workdir = join(home, 'work')
mkdirSync(workdir)
const spec = {
  harness: 'amp', backend: 'sdk', workdir,
  ampSdk: { packageRoot: join(root, 'tests/helpers/amp_sdk'), cliPath: join(root, 'tests/helpers/amp_cli.mjs'), executor: 'local', mode: 'low' },
  env: { HOME: home, XDG_CONFIG_HOME: join(home, 'config'), XDG_DATA_HOME: join(home, 'data'), AMP_URL: 'https://ampcode.com' }, requestTimeoutSeconds: 3, timeoutSeconds: 8,
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(check) {
  const deadline = Date.now() + 3000
  while (!check()) {
    assert.ok(Date.now() < deadline, 'owned fixture did not reach its expected lifecycle state')
    await delay(20)
  }
}
function alive(pid) {
  try { process.kill(pid, 0); return true }
  catch (error) { if (error.code === 'ESRCH') return false; throw error }
}
let session
try {
  assert.deepEqual(getSessionCapabilities('amp', 'sdk'), {
    backend: 'sdk', events: true, interrupt: true, followUp: true, resume: true, concurrentTurns: false, approval: false,
  })
  session = await openSession(spec)
  const reference = session.reference
  assert.equal(reference.sessionId, fixture.sessionId)
  assert.equal(reference.sessionFile, null)
  assert.equal(reference.endpoint, 'https://ampcode.com')
  let turns = 0
  for (const scenario of fixture.cases) {
    // Native protocol violations invalidate the session: resume the exact thread for the next case.
    if (session.closed) {
      session = await openSession({ ...spec, resume: reference })
      assert.deepEqual(session.reference, reference)
    }
    const turn = session.startTurn(scenario.prompt)
    const events = []
    for await (const event of turn.events) {
      assert.equal(event.backend, 'sdk')
      assert.equal(event.harness, 'amp')
      assert.equal(event.sessionId, reference.sessionId)
      assert.equal(event.requestId, null)
      assert.ok(!event.type.startsWith('amp_'), event.type)
      events.push(event.type)
    }
    const result = await turn.result
    turns += 1
    assert.equal(result.status, scenario.status, scenario.name)
    if (scenario.exitCode !== undefined) assert.equal(result.exitCode, scenario.exitCode, scenario.name)
    if (scenario.rawType !== undefined) assert.equal(result.raw?.type, scenario.rawType, scenario.name)
    if (scenario.status === 'completed') {
      assert.deepEqual(events, ['system', 'assistant', 'future_event', 'result'])
      assert.equal(result.raw.result, `synthetic turn ${turns}`)
      assert.deepEqual(result.raw.usage, { input_tokens: null, output_tokens: 2, max_tokens: 123, cache_creation: { ephemeral_5m_input_tokens: 4 } })
    }
    if (scenario.prompt === 'permission-rejection') assert.deepEqual(result.raw.permission_denials, ['synthetic-tool'])
    if (scenario.prompt === 'preinit-error') assert.deepEqual(events, ['error'])
    assert.equal(session.closed, scenario.status === 'protocol-error', scenario.name)
  }
  await session.close()
  assert.ok(!existsSync(join(workdir, '.harness-run.lock')))
  session = await openSession({ ...spec, resume: reference })
  const turn = session.startTurn('child-hang')
  let descendant
  const consume = (async () => {
    for await (const event of turn.events) {
      if (event.type === 'assistant') {
        const marker = join(workdir, '.amp-synthetic-child.json')
        await until(() => existsSync(marker))
        descendant = JSON.parse(readFileSync(marker, 'utf8')).pid
        assert.ok(alive(descendant))
        await session.interrupt()
      }
    }
  })()
  await consume
  assert.equal((await turn.result).status, 'interrupted')
  await until(() => !alive(descendant))
  assert.equal(session.closed, false)
  const followUp = session.startTurn('success')
  for await (const _event of followUp.events) { /* drain */ }
  assert.equal((await followUp.result).status, 'completed')
  await Promise.all([session.close(), session.close()])
  assert.ok(!existsSync(join(workdir, '.harness-run.lock')))
  session = await openSession({ ...spec, resume: reference, timeoutSeconds: 0.8, instructions: 'Synthetic timeout lease' })
  const timeout = session.startTurn('hang')
  for await (const _event of timeout.events) { /* drain */ }
  assert.equal((await timeout.result).status, 'timed-out')
  assert.equal(session.closed, true)
  await session.close()
  assert.ok(!existsSync(join(workdir, 'AGENTS.md')))
  assert.ok(!existsSync(join(workdir, '.harness-run.lock')))

  session = await openSession({ ...spec, resume: reference, instructions: 'Synthetic close lease' })
  const closing = session.startTurn('hang')
  for await (const event of closing.events) {
    if (event.type === 'assistant') await session.close()
  }
  assert.equal((await closing.result).status, 'closed')
  assert.ok(!existsSync(join(workdir, 'AGENTS.md')))
  assert.ok(!existsSync(join(workdir, '.harness-run.lock')))

  session = await openSession({ ...spec, resume: reference, maxBufferBytes: 4096 })
  const overflow = session.startTurn('overflow')
  const overflowResult = await overflow.result
  assert.equal(overflowResult.status, 'protocol-error')
  assert.equal(overflowResult.eventsTruncated, true)
  await session.close()

  session = await openSession({ ...spec, resume: reference, maxBufferBytes: 1024 })
  const noisy = session.startTurn('stderr')
  for await (const _event of noisy.events) { /* drain */ }
  const noisyResult = await noisy.result
  assert.equal(noisyResult.status, 'completed')
  assert.equal(noisyResult.stderrTruncated, true)
  assert.ok(noisyResult.stderrBytes >= 1700)
  assert.ok(Buffer.byteLength(noisyResult.stderr) <= 1024)
  await session.close()
  await assert.rejects(openSession({ ...spec, ampSdk: { ...spec.ampSdk, packageRoot: join(home, 'missing') } }), { code: 'launch-failed' })
  assert.ok(!existsSync(join(workdir, '.harness-run.lock')))
  console.log(`Packaged Node Amp SDK worker: ${fixture.cases.length} shared cases, resume, owned-child interruption, timeout, close, overflow and stderr bounds passed`)
} finally {
  await session?.close()
  rmSync(home, { recursive: true, force: true })
}
