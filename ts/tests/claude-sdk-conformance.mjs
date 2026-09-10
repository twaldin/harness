// Real optional SDK, finite synthetic CLI. No native provider or credentials.
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, access, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(import.meta.url)
const packageRoot = dirname(require.resolve('@anthropic-ai/claude-agent-sdk'))
const cases = JSON.parse(await readFile(join(root, 'tests/claude_sdk_cases.json'), 'utf8'))
const collect = async turn => { const events = []; for await (const event of turn.events) events.push(event); return events }
const missing = async path => { await assert.rejects(access(path), { code: 'ENOENT' }) }

export async function claudeConformance(api) {
  const { openSession, getSessionCapabilities } = api
  const directory = await mkdtemp(join(tmpdir(), 'harness-claude-sdk-'))
  const workdir = join(directory, 'work')
  const home = join(directory, 'home')
  await Promise.all([mkdir(workdir), mkdir(home)])
  const spec = {
    harness: 'claude-code', backend: 'sdk', workdir,
    executable: process.execPath, model: 'synthetic-model',
    env: { HOME: home, HARNESS_TEST_CLAUDE_VERSION: '2.1.263' },
    requestTimeoutSeconds: 10, timeoutSeconds: 5,
    claudeSdk: { packageRoot, cliPath: join(root, 'tests/helpers/claude_cli.py'), configDir: join(directory, 'config'), settingSources: ['project'] },
  }
  let session
  try {
    for (const scenario of cases) {
      session = await openSession(spec)
      try {
        const turn = session.startTurn(scenario.prompt)
        const events = await collect(turn)
        const result = await turn.result
        assert.equal(result.status, scenario.status, scenario.prompt)
        assert.equal(result.sessionId, session.reference.sessionId)
        assert.deepEqual(events.find(event => event.type === 'future_native_event').raw.payload, { preserve: true })
        const assistant = events.find(event => event.type === 'assistant')
        assert.ok(assistant, `${scenario.prompt}: prior assistant missing; observed ${events.map(event => event.type).join(', ')}`)
        assert.deepEqual(assistant.raw.future_assistant_field, { preserve: true })
        assert.deepEqual(assistant.raw.message.content.at(-1), { type: 'future_content', preserve: true })
        assert.ok(events.every(event => event.harness === 'claude-code' && event.backend === 'sdk' && event.turnId === turn.id))
        if (scenario.terminal) {
          assert.deepEqual(result.raw.future_result_field, { preserve: true })
          assert.equal(result.raw.total_cost_usd, 0.01)
          assert.equal(result.raw.modelUsage['synthetic-model'].inputTokens, 10)
        }
        if (scenario.status === 'agent-error') {
          assert.deepEqual(result.raw.errors, ['synthetic native failure'])
          assert.ok(result.error)
        }
      } finally { await session.close() }
      await missing(join(workdir, '.harness-run.lock'))
    }
    session = await openSession(spec)
    const selectedId = session.reference.sessionId
    for (const number of [1, 2]) {
      const turn = session.startTurn('success')
      await collect(turn)
      const result = await turn.result
      assert.equal(result.status, 'completed')
      assert.equal(result.sessionId, selectedId)
      assert.equal(result.raw.total_cost_usd, 0.01 * number)
    }
    const reference = session.reference
    await access(reference.sessionFile)
    await session.close()
    session = await openSession({ ...spec, resume: reference })
    let turn = session.startTurn('success')
    await collect(turn)
    assert.equal((await turn.result).sessionId, selectedId)
    assert.equal(session.reference.sessionFile, reference.sessionFile)
    await session.close()
    await assert.rejects(openSession({ ...spec, resume: { ...reference, sessionId: '00000000-0000-4000-8000-000000000000' } }))
    await missing(join(workdir, '.harness-run.lock'))

    const uppercaseId = 'ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF'
    const uppercaseFile = join(workdir, 'uppercase-native.jsonl')
    await writeFile(uppercaseFile, JSON.stringify({ type: 'user', sessionId: uppercaseId, cwd: workdir }) + '\n')
    const uppercaseReference = { sessionId: uppercaseId, sessionFile: uppercaseFile, workdir }
    session = await openSession({ ...spec, resume: uppercaseReference })
    turn = session.startTurn('success')
    await collect(turn)
    const uppercaseResult = await turn.result
    assert.equal(uppercaseResult.status, 'completed')
    assert.equal(uppercaseResult.sessionId, uppercaseId)
    assert.equal(session.reference.sessionFile, uppercaseFile)
    await session.close()
    await assert.rejects(openSession({ ...spec, resume: { ...uppercaseReference, sessionId: uppercaseId.toLowerCase() } }))
    await missing(join(workdir, '.harness-run.lock'))

    for (const [prompt, expected] of [['hang', 'interrupted'], ['race', 'completed']]) {
      session = await openSession(spec)
      turn = session.startTurn(prompt)
      let interruption
      const events = []
      for await (const event of turn.events) {
        events.push(event)
        if (event.type === 'assistant') {
          assert.throws(() => session.startTurn('concurrent'), { code: 'unsupported-capability' })
          interruption = session.interrupt()
        }
      }
      assert.ok(interruption)
      await interruption
      assert.equal((await turn.result).status, expected)
      assert.deepEqual(events.find(event => event.type === 'claude_interrupt').raw.receipt.still_queued, [])
      const follow = session.startTurn('success')
      await collect(follow)
      assert.equal((await follow.result).status, 'completed')
      await session.close()
    }

    session = await openSession({ ...spec, env: { ...spec.env, HARNESS_TEST_CLAUDE_RECEIPT: 'missing' } })
    turn = session.startTurn('hang')
    for await (const event of turn.events) {
      if (event.type === 'assistant') {
        const outcomes = await Promise.allSettled([session.interrupt(), session.interrupt()])
        assert.ok(outcomes.every(outcome => outcome.status === 'rejected' && outcome.reason.code === 'adapter-error'))
        await session.close()
      }
    }
    assert.equal((await turn.result).status, 'closed')

    assert.equal(getSessionCapabilities('claude-code', 'sdk').approval, true)
    for (const [decision, expected] of [['once', 'allow'], ['reject', 'deny']]) {
      session = await openSession(spec)
      turn = session.startTurn('permission')
      let requestId
      for await (const event of turn.events) {
        if (event.type === 'claude_permission') {
          requestId = event.requestId
          assert.equal(event.raw.tool_name, 'Bash')
          await session.respondApproval(requestId, decision)
        }
      }
      assert.equal((await turn.result).raw.result, `permission ${expected}`)
      assert.ok(requestId)
      await assert.rejects(session.respondApproval(requestId, decision), { code: 'invalid-options' })
      await session.close()
    }

    const instruction = join(workdir, 'CLAUDE.md')
    await writeFile(instruction, 'original instructions')
    session = await openSession({ ...spec, instructions: 'temporary instructions' })
    turn = session.startTurn('hang')
    const consuming = collect(turn)
    await Promise.all([session.close(), session.close()])
    await consuming
    assert.equal((await turn.result).status, 'closed')
    assert.equal(await readFile(instruction, 'utf8'), 'original instructions')
    await missing(join(workdir, '.harness-run.lock'))

    session = await openSession({ ...spec, timeoutSeconds: 0.3 })
    turn = session.startTurn('permission')
    const pendingPermission = await collect(turn)
    assert.ok(pendingPermission.some(event => event.type === 'claude_permission'))
    assert.equal((await turn.result).status, 'timed-out')
    await session.close()
    await missing(join(workdir, '.harness-run.lock'))

    await assert.rejects(openSession({ ...spec, permissionPolicy: 'bypass' }), { code: 'unsupported-capability' })
    await assert.rejects(openSession({ ...spec, claudeSdk: { ...spec.claudeSdk, packageRoot: join(directory, 'missing') } }), { code: 'launch-failed' })
    await missing(join(workdir, '.harness-run.lock'))
    await assert.rejects(openSession({ ...spec, env: { ...spec.env, HARNESS_TEST_CLAUDE_VERSION: '0.0.0' } }), { code: 'launch-failed' })
    await missing(join(workdir, '.harness-run.lock'))
    console.log(`Claude SDK: ${cases.length} shared scenarios, follow-up/resume, receipts, approval/rejection and disposal passed`)
  } finally {
    await session?.close()
    await rm(directory, { recursive: true, force: true })
  }
}
