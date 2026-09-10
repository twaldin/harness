// Factory Droid SDK sessions: the same public API scenarios against Bun source
// and the packaged Node API. The "CLI" is the shared synthetic JSON-RPC peer
// ../../tests/helpers/droid_agent.py, selected through `executable` and driven
// by the real optional @factory/droid-sdk 0.9.1; no provider, credential or
// ambient config is touched. Every artifact lives in a per-session sandbox
// (isolated HOME, workdir, trace) and the session owns the peer's process
// group: nothing here discovers or kills processes by name.
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const peer = join(root, 'tests/helpers/droid_agent.py')
const cases = JSON.parse(readFileSync(join(root, 'tests/droid_sdk_cases.json'), 'utf8'))
/** Not a credential: the synthetic peer never reads it; the session only requires it to be present. */
const FAKE_KEY = 'synthetic-not-a-credential'
const STDERR_UNIT = 'synthetic stderr '

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms))
}

/** Isolated HOME + workdir + trace + `droid` wrapper; released by `dispose()`. */
function sandbox() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'harness-droid-')))
  const home = join(dir, 'home')
  const workdir = join(dir, 'work')
  const bin = join(dir, 'bin')
  for (const path of [home, workdir, bin]) mkdirSync(path)
  const droid = join(bin, 'droid')
  // `exec` keeps the peer as the group leader the session spawned; `-I` isolates Python from the user's site.
  writeFileSync(droid, `#!/bin/sh\nexec python3 -I ${JSON.stringify(peer)} "$@"\n`)
  chmodSync(droid, 0o755)
  const trace = join(dir, 'trace.jsonl')
  return {
    dir, home, workdir, droid, trace,
    spec(name, extra = {}) {
      const { env = {}, factoryDroid, ...rest } = extra
      return {
        harness: 'factory-droid', backend: 'sdk', workdir, executable: droid,
        // Both roots are pinned: an ambient FACTORY_HOME_OVERRIDE would otherwise redirect the fake native session files into operator config.
        env: { HOME: home, FACTORY_HOME_OVERRIDE: home, FACTORY_API_KEY: FAKE_KEY, HARNESS_DROID_CASE: name, HARNESS_DROID_TRACE: trace, ...env },
        ...(factoryDroid === undefined ? {} : { factoryDroid }),
        timeoutSeconds: 5, requestTimeoutSeconds: 2,
        ...rest,
      }
    },
    requests() {
      if (!existsSync(trace)) return []
      return readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
    },
    sessionFile(sessionId) {
      return join(home, '.factory', 'sessions', `-${workdir.replace(/^\/+|\/+$/g, '').replace(/\/+/g, '-')}`, `${sessionId}.jsonl`)
    },
    dispose() {
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

async function collect(turn, onEvent) {
  const events = []
  for await (const event of turn.events) {
    events.push(event)
    await onEvent?.(event)
  }
  return { events, result: await turn.result }
}

/** Every event of a turn is stamped with the native identity and this turn. */
function stamped(events, session, turn) {
  for (const event of events) {
    assert.equal(event.backend, 'sdk')
    assert.equal(event.harness, 'factory-droid')
    assert.equal(event.sessionId, session.reference.sessionId)
    assert.equal(event.turnId, turn.id)
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error.code === 'ESRCH') return false
    return true
  }
}

async function expectGone(pid, what) {
  for (let i = 0; i < 100 && alive(pid); i++) await sleep(20)
  assert.equal(alive(pid), false, `${what} (pid ${pid}) survived the owned teardown`)
}

async function rejects(promise, code, check) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`)
    check?.(error)
    return true
  })
}

/** Run one scenario in a fresh sandbox; the session is always closed and the sandbox always removed. */
async function scenario(name, run, extra = {}) {
  const box = sandbox()
  let session = null
  try {
    session = await run(box.spec(name, extra), box, (opened) => { session = opened })
  } catch (error) {
    throw new Error(`Factory Droid scenario ${name} failed`, { cause: error })
  } finally {
    try { await session?.close() } finally { box.dispose() }
  }
}

export async function runDroidConformance(api) {
  const caps = api.getSessionCapabilities('factory-droid', 'sdk')
  assert.deepEqual(caps, { backend: 'sdk', events: true, interrupt: true, followUp: true, resume: true, concurrentTurns: false, approval: false })
  assert.throws(() => api.getSessionCapabilities('factory-droid', 'rpc'), { code: 'unsupported-backend' })
  assert.throws(() => api.getSessionCapabilities('factory-droid', 'cli'), { code: 'unsupported-backend' })

  // ---- shared turn outcomes ----
  for (const turnCase of cases.turns) {
    await scenario(turnCase.name, async (spec, box, keep) => {
      const session = await api.openSession(spec)
      keep(session)
      assert.equal(session.reference.sessionId, cases.session_id)
      assert.equal(session.reference.workdir, box.workdir)
      assert.equal(session.reference.sessionFile, box.sessionFile(cases.session_id))
      assert.ok(existsSync(session.reference.sessionFile), 'the peer persists the native session at init')
      const turn = session.startTurn('go')
      assert.throws(() => session.startTurn('concurrent'), { code: 'unsupported-capability' })
      const { events, result } = await collect(turn)
      assert.equal(result.status, turnCase.status, `${turnCase.name}: ${result.error}`)
      assert.equal(result.sessionId, cases.session_id)
      assert.equal(result.turnId, turn.id)
      stamped(events, session, turn)
      const submitted = box.requests().find((entry) => entry.type === 'request' && entry.method === 'droid.add_user_message')
      if (!['prompt_reject', 'wrong_delta'].includes(turnCase.name)) {
        assert.ok(events.some((event) => event.type === 'assistant_text_delta' && event.raw.textDelta === cases.text), `${turnCase.name}: native delta retained verbatim`)
        assert.deepEqual(events.find((event) => event.type === 'synthetic_unknown')?.raw.detail, { preserved: true }, `${turnCase.name}: unknown notification retained`)
      }
      if (result.status === 'completed') {
        assert.equal(result.raw.type, 'agent_turn_completed')
        assert.equal(result.raw.reason, 'completed')
        assert.equal(result.raw.turnId, submitted.params.messageId)
        assert.deepEqual(result.raw.tokenUsage, cases.usage)
        assert.equal(result.error, null)
        assert.ok(events.some((event) => event.type === 'agent_turn_completed'), 'the terminal notification is delivered to the turn')
        assert.equal(session.closed, false)
        // Follow-up in the same native session: per-turn usage is unchanged, the cumulative snapshot advances, nothing is summed for the caller.
        const second = await collect(session.startTurn('again'))
        assert.equal(second.result.status, 'completed')
        assert.deepEqual(second.result.raw.tokenUsage, cases.usage)
        assert.equal(second.result.raw.cumulativeTokenUsage.inputTokens, cases.usage.inputTokens * 2)
        if (turnCase.name === 'success') assert.equal(second.events.find((event) => event.type === 'session_token_usage_changed').raw.tokenUsage.inputTokens, cases.usage.inputTokens * 2)
        return session
      }
      assert.equal(session.closed, turnCase.status !== 'agent-error')
      if (turnCase.name === 'prompt_reject') {
        assert.equal(result.raw.type, 'response')
        assert.equal(result.raw.error.message, 'synthetic prompt rejection')
      } else if (turnCase.name === 'agent_error') {
        assert.equal(result.raw.reason, 'error')
        assert.match(result.error, /"error"/)
      } else if (turnCase.status === 'protocol-error') {
        assert.notEqual(result.error, null)
      }
      if (turnCase.exit_code !== undefined) assert.equal(result.exitCode, turnCase.exit_code)
      if (turnCase.signal !== undefined) {
        assert.equal(result.signal, turnCase.signal)
        assert.equal(result.exitCode, -15)
      }
      if (turnCase.status === 'agent-error') {
        const retry = await collect(session.startTurn('retry after native failure'))
        assert.equal(retry.result.status, 'agent-error')
        assert.equal(retry.result.sessionId, result.sessionId)
      } else {
        assert.throws(() => session.startTurn('after failure'), { code: 'session-closed' })
      }
      await session.close()
      return session
    })
  }

  // ---- interrupts ----
  for (const name of cases.interrupts) {
    await scenario(name, async (spec, box, keep) => {
      const session = await api.openSession(spec)
      keep(session)
      const turn = session.startTurn('go')
      let interrupted = false
      const { result } = await collect(turn, async (event) => {
        if (event.type === 'assistant_text_delta' && !interrupted) {
          interrupted = true
          await session.interrupt()
        }
      })
      assert.equal(result.status, 'interrupted', `${name}: ${result.error}`)
      assert.equal(result.raw.reason, 'cancelled')
      assert.equal(box.requests().filter((entry) => entry.method === 'droid.interrupt_session').length, 1)
      assert.equal((await collect(session.startTurn('after interrupt'))).result.status, 'completed')
      await rejects(session.interrupt(), 'unsupported-capability')
      return session
    })
  }

  // ---- startup failures ----
  for (const startup of cases.startup) {
    await scenario(startup.name, async (spec, box) => {
      await rejects(api.openSession(spec), startup.code)
      assert.equal(existsSync(join(box.workdir, '.harness-run.lock')), false, 'the lease is released after a failed handshake')
      return null
    })
  }

  // ---- identity, resume and its refusals ----
  await scenario('success', async (spec, box, keep) => {
    let session = await api.openSession(spec)
    keep(session)
    const reference = session.reference
    assert.equal((await collect(session.startTurn('first'))).result.status, 'completed')
    await Promise.all([session.close(), session.close()])
    assert.equal(session.closed, true)
    assert.ok(existsSync(reference.sessionFile), 'saved native files are never deleted')
    session = await api.openSession({ ...spec, resume: reference })
    keep(session)
    assert.deepEqual(session.reference, reference)
    assert.equal((await collect(session.startTurn('after resume'))).result.status, 'completed')
    await session.close()
    const before = box.requests().length
    for (const [override, code] of [
      [{ resume: { ...reference, workdir: join(box.dir, 'elsewhere') } }, 'invalid-options'],
      [{ resume: { ...reference, sessionFile: join(box.home, 'invented.jsonl') } }, 'invalid-options'],
      [{ resume: { ...reference, sessionId: '22222222-2222-4222-8222-222222222222', sessionFile: box.sessionFile('22222222-2222-4222-8222-222222222222') } }, 'invalid-options'],
      [{ resume: { ...reference, sessionFile: null } }, 'invalid-options'],
      [{ resume: { ...reference, endpoint: 'http://127.0.0.1:1' } }, 'invalid-options'],
      [{ resume: reference, model: 'other-model' }, 'invalid-options'],
      [{ resume: reference, factoryDroid: { autonomy: 'high' } }, 'invalid-options'],
    ]) {
      await rejects(api.openSession({ ...spec, ...override }), code)
    }
    // A saved header that names another session must be rejected before anything is spawned.
    const tampered = '33333333-3333-4333-8333-333333333333'
    writeFileSync(box.sessionFile(tampered), `${JSON.stringify({ type: 'session_start', id: reference.sessionId, cwd: box.workdir, version: 2 })}\n`)
    await rejects(api.openSession({ ...spec, resume: { ...reference, sessionId: tampered, sessionFile: box.sessionFile(tampered) } }), 'invalid-options')
    writeFileSync(box.sessionFile(tampered), `${JSON.stringify({ type: 'session_start', id: tampered, cwd: join(box.dir, 'elsewhere'), version: 2 })}\n`)
    await rejects(api.openSession({ ...spec, resume: { ...reference, sessionId: tampered, sessionFile: box.sessionFile(tampered) } }), 'invalid-options')
    assert.equal(box.requests().length, before, 'refused resume targets never reach the CLI')
    return null
  })
  for (const name of cases.resume_failures) {
    await scenario('success', async (spec, box, keep) => {
      const session = await api.openSession(spec)
      keep(session)
      const reference = session.reference
      await session.close()
      await rejects(api.openSession({ ...spec, env: { ...spec.env, HARNESS_DROID_CASE: name }, resume: reference }), 'protocol-error')
      assert.equal(existsSync(join(box.workdir, '.harness-run.lock')), false)
      return null
    })
  }

  // ---- native permission callbacks ----
  const permission = async (factoryDroid, expect) => scenario('permission', async (spec, box, keep) => {
    const session = await api.openSession(spec)
    keep(session)
    const turn = session.startTurn('go')
    const { events, result } = await collect(turn)
    stamped(events, session, turn)
    const request = events.find((event) => event.type === 'request')
    assert.equal(request.requestId, 'permission-1')
    assert.equal(request.raw.method, 'droid.request_permission')
    assert.deepEqual(request.raw.params.options.map((option) => option.value), ['proceed_once', 'cancel'])
    assert.equal(result.status, expect.status, result.error)
    if (expect.error) assert.match(result.error, expect.error)
    assert.equal(existsSync(join(box.workdir, 'approved-marker')), expect.approved)
    const replies = box.requests().filter((entry) => entry.type === 'callback_response')
    assert.deepEqual(replies.map((entry) => entry.result?.selectedOption), expect.replies)
    if (expect.status !== 'completed') assert.equal(session.closed, expect.status !== 'interrupted')
    return session
  }, { factoryDroid })
  let seenParams = null
  await permission({ onPermission: (params) => { seenParams = params; return { selectedOption: 'proceed_once', comment: 'synthetic' } } }, { status: 'completed', approved: true, replies: ['proceed_once'] })
  assert.deepEqual(seenParams.options.map((option) => option.value), ['proceed_once', 'cancel'])
  assert.deepEqual(seenParams.toolUses, [])
  await permission({ onPermission: async () => ({ selectedOption: 'cancel' }) }, { status: 'interrupted', approved: false, replies: ['cancel'] })
  await permission({}, { status: 'interrupted', approved: false, replies: ['cancel'] })
  await permission({ onPermission: () => ({ selectedOption: 'proceed_always' }) }, { status: 'agent-error', approved: false, replies: [], error: /onPermission.*did not offer/ })
  // Editing the callback argument cannot widen what droid offered: the reply is checked against the native request, and the request event's `raw` stays intact.
  await permission({ onPermission: (params) => { params.options.push({ label: 'Always', value: 'proceed_always' }); return { selectedOption: 'proceed_always' } } }, { status: 'agent-error', approved: false, replies: [], error: /onPermission.*did not offer/ })
  await permission({ onPermission: () => ({ selectedOption: 'not-an-outcome' }) }, { status: 'agent-error', approved: false, replies: [], error: /onPermission.*invalid permission reply/ })
  await permission({ onPermission: () => { throw new Error('synthetic callback failure') } }, { status: 'agent-error', approved: false, replies: [], error: /onPermission.*synthetic callback failure/ })
  await permission({ onPermission: () => 'proceed_once' }, { status: 'agent-error', approved: false, replies: [], error: /onPermission returned string/ })
  await permission({ onPermission: () => new Promise(() => {}) }, { status: 'agent-error', approved: false, replies: [], error: /onPermission did not reply within requestTimeoutSeconds/ })

  // ---- native question callbacks ----
  const question = async (factoryDroid, expect) => scenario('question', async (spec, box, keep) => {
    const session = await api.openSession(spec)
    keep(session)
    const { events, result } = await collect(session.startTurn('go'))
    const request = events.find((event) => event.type === 'request')
    assert.equal(request.requestId, 'question-1')
    assert.equal(request.raw.params.toolCallId, 'question-tool')
    assert.equal(result.status, expect.status, result.error)
    if (expect.error) assert.match(result.error, expect.error)
    const replies = box.requests().filter((entry) => entry.type === 'callback_response')
    assert.deepEqual(replies.map((entry) => entry.result), expect.replies)
    return session
  }, { factoryDroid })
  const answer = { index: 1, question: 'Synthetic choice?', answer: 'yes' }
  await question({ onQuestion: () => ({ cancelled: false, answers: [answer] }) }, { status: 'completed', replies: [{ cancelled: false, answers: [answer] }] })
  await question({ onQuestion: () => ({ cancelled: true }) }, { status: 'interrupted', replies: [{ cancelled: true, answers: [] }] })
  await question({}, { status: 'interrupted', replies: [{ cancelled: true, answers: [] }] })
  await question({ onQuestion: () => ({ cancelled: false, answers: [{ ...answer, index: 2 }] }) }, { status: 'agent-error', replies: [], error: /onQuestion.*did not ask/ })
  await question({ onQuestion: () => ({ answers: [answer] }) }, { status: 'agent-error', replies: [], error: /onQuestion.*boolean "cancelled"/ })
  await question({ onQuestion: () => ({ cancelled: false, answers: [{ index: 1 }] }) }, { status: 'agent-error', replies: [], error: /onQuestion.*invalid question reply/ })

  // ---- deadlines, close during a turn, interrupt that never settles ----
  await scenario('hang', async (spec, box, keep) => {
    const session = await api.openSession({ ...spec, timeoutSeconds: 0.3 })
    keep(session)
    const { result } = await collect(session.startTurn('go'))
    assert.equal(result.status, 'timed-out')
    assert.equal(session.closed, true)
    assert.equal(box.requests().filter((entry) => entry.method === 'droid.interrupt_session').length, 0)
    return session
  })
  await scenario('hang', async (spec, box, keep) => {
    const session = await api.openSession(spec)
    keep(session)
    const turn = session.startTurn('go')
    const { result } = await collect(turn, async (event) => {
      if (event.type === 'assistant_text_delta') await Promise.all([session.close(), session.close()])
    })
    assert.equal(result.status, 'closed')
    assert.equal(box.requests().filter((entry) => entry.method === 'droid.close_session').length, 1, 'close is best effort but attempted while the CLI runs')
    assert.throws(() => session.startTurn('after close'), { code: 'session-closed' })
    return session
  })
  await scenario('hang', async (spec, box, keep) => {
    // A consumer that stops iterating does not interrupt the native turn: events stay buffered and the result still settles.
    const session = await api.openSession({ ...spec, timeoutSeconds: 0.5 })
    keep(session)
    const turn = session.startTurn('go')
    for await (const event of turn.events) {
      assert.equal(event.turnId, turn.id)
      break
    }
    assert.equal((await turn.result).status, 'timed-out')
    assert.equal(box.requests().filter((entry) => entry.method === 'droid.interrupt_session').length, 0)
    return session
  })
  await scenario('abort_hang', async (spec, box, keep) => {
    const session = await api.openSession({ ...spec, requestTimeoutSeconds: 1 })
    keep(session)
    const turn = session.startTurn('go')
    const { result } = await collect(turn, async (event) => {
      if (event.type === 'assistant_text_delta') await session.interrupt()
    })
    assert.equal(result.status, 'protocol-error')
    assert.match(result.error, /droid\.interrupt_session/)
    return session
  })

  // ---- bounded teardown: unanswered close, TERM-ignoring leader, descendants ----
  await scenario('close_hang', async (spec, box, keep) => {
    const session = await api.openSession(spec)
    keep(session)
    const leader = box.requests().find((entry) => entry.type === 'started').pid
    const started = performance.now()
    await session.close()
    assert.ok(performance.now() - started < 4000, 'close is bounded even when close_session is never answered and TERM is ignored')
    await expectGone(leader, 'TERM-ignoring peer')
    return session
  })
  for (const name of ['descendant', 'descendant_exit']) {
    await scenario(name, async (spec, box, keep) => {
      const session = await api.openSession(spec)
      keep(session)
      const turn = session.startTurn('go')
      const pidFile = join(box.workdir, 'synthetic-child.pid')
      for (let i = 0; i < 200 && !existsSync(pidFile); i++) await sleep(20)
      const child = Number(readFileSync(pidFile, 'utf8'))
      assert.equal(alive(child), true)
      if (name === 'descendant_exit') {
        const { result } = await collect(turn)
        assert.equal(result.status, 'exited')
        assert.equal(result.exitCode, 0)
      }
      await session.close()
      await expectGone(child, 'TERM-ignoring descendant')
      if (name === 'descendant') assert.equal((await turn.result).status, 'closed')
      return session
    })
  }

  // ---- bounds ----
  await scenario('flood', async (spec, box, keep) => {
    const session = await api.openSession({ ...spec, maxBufferBytes: 65_536 })
    keep(session)
    const turn = session.startTurn('go')
    const result = await turn.result
    assert.equal(result.status, 'protocol-error')
    assert.equal(result.eventsTruncated, true)
    const events = []
    for await (const event of turn.events) events.push(event)
    assert.ok(events.some((event) => event.type === 'synthetic_unknown' && event.raw.text?.length === 1024), 'queued events stay readable after overflow')
    return session
  })
  // stderr is a separate pipe: the peer writes 17 KiB per turn, so the follow-up turn's snapshot has at least the first turn's bytes.
  const STDERR_TURN = STDERR_UNIT.length * 1024
  await scenario('stderr', async (spec, box, keep) => {
    const session = await api.openSession(spec)
    keep(session)
    assert.equal((await collect(session.startTurn('go'))).result.status, 'completed')
    const { result } = await collect(session.startTurn('again'))
    assert.equal(result.status, 'completed')
    assert.ok(result.stderrBytes >= STDERR_TURN && result.stderrBytes <= 2 * STDERR_TURN, String(result.stderrBytes))
    assert.equal(result.stderrTruncated, false)
    assert.equal(Buffer.byteLength(result.stderr), result.stderrBytes)
    assert.ok(result.stderr.startsWith(STDERR_UNIT))
    return session
  })
  await scenario('stderr', async (spec, box, keep) => {
    const session = await api.openSession({ ...spec, maxBufferBytes: 4096 })
    keep(session)
    assert.equal((await collect(session.startTurn('go'))).result.status, 'completed')
    const { result } = await collect(session.startTurn('again'))
    assert.ok(result.stderrBytes >= STDERR_TURN)
    assert.equal(result.stderrTruncated, true)
    assert.equal(Buffer.byteLength(result.stderr), 4096)
    assert.ok(result.stderr.startsWith(STDERR_UNIT))
    return session
  })
  await scenario('idle_unknown', async (spec, box, keep) => {
    const session = await api.openSession(spec)
    keep(session)
    const idle = session.events[Symbol.asyncIterator]()
    const first = await idle.next()
    assert.equal(first.value.type, 'synthetic_idle')
    assert.equal(first.value.turnId, null)
    assert.equal(first.value.requestId, null)
    assert.deepEqual(first.value.raw.detail, { preserved: true })
    assert.equal((await collect(session.startTurn('go'))).result.status, 'completed')
    await session.close()
    assert.equal((await idle.next()).done, true)
    return session
  })

  // ---- validation before any spawn ----
  await scenario('success', async (spec, box) => {
    const trace = () => box.requests().length
    await rejects(api.openSession({ ...spec, env: { ...spec.env, FACTORY_API_KEY: '' } }), 'launch-failed', (error) => {
      assert.doesNotMatch(error.message, new RegExp(FAKE_KEY))
    })
    await rejects(api.openSession({ ...spec, backend: 'rpc' }), 'unsupported-backend')
    await rejects(api.openSession({ ...spec, permissionPolicy: 'bypass' }), 'unsupported-capability')
    for (const factoryDroid of [
      { autonomy: 'yolo' }, { disabledTools: 'Read' }, { disabledTools: [''] }, { autoRejectPermissionRequests: 'yes' }, { disableBuiltinSkills: 1 },
      { onPermission: 'not a function' }, { onQuestion: {} }, { enabledTools: ['Read'] }, { mcpServers: [] }, { additionalToolIds: [] }, 'off',
    ]) {
      await rejects(api.openSession({ ...spec, factoryDroid }), 'invalid-options')
    }
    await rejects(api.openSession({ ...spec, ompSdk: { packageRoot: box.dir, agentDir: box.dir, auth: 'environment' } }), 'invalid-options')
    await rejects(api.openSession({ ...spec, opencode: { endpoint: 'http://127.0.0.1:1', auth: 'none' } }), 'invalid-options')
    await rejects(api.openSession({ ...spec, env: { ...spec.env, FACTORY_UPSTREAM_CLIENT_TYPE: 'cli' } }), 'invalid-options')
    await rejects(api.openSession({ harness: 'pi', backend: 'rpc', workdir: box.workdir, factoryDroid: {} }), 'invalid-options')
    assert.equal(trace(), 0, 'rejected specs never spawn the CLI')
    assert.equal(existsSync(join(box.workdir, '.harness-run.lock')), false)
    return null
  })

  return `${cases.turns.length} shared turn outcomes; interrupts, startup failures, identity/resume, native callbacks, deadlines, bounded teardown, bounds and validation`
}
