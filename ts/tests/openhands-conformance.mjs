// The same public API scenarios run against Bun source and the packaged Node API.
// Child ownership is the recorded ChildProcess handle; no host-wide discovery.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const workdir = '/synthetic/server/work'
const key = 'fixture-api-key'
const model = 'synthetic/fixture'
const profileId = '11111111-1111-4111-8111-111111111111'
const missingId = '33333333-3333-4333-8333-333333333333'
const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
// Startup variants rejected before anything is created on the server.
const preCreateVariants = new Set(['wrong-version', 'redirect', 'acp-profile', 'wrong-model'])
const cases = JSON.parse(await readFile(join(root, 'tests/openhands_cases.json'), 'utf8'))
let peerIndex = 0

async function bounded(promise, ms, label) {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), ms) })])
  } finally { clearTimeout(timer) }
}

async function peer(run, variant = 'normal') {
  const dir = await mkdtemp(join(tmpdir(), 'harness-openhands-'))
  const index = ++peerIndex
  const trace = join(dir, 'requests.jsonl')
  const child = spawn('python3', ['-I', join(root, 'tests/helpers/openhands_server.py'), '--lifetime', '60', '--trace', trace, '--variant', variant], { stdio: ['pipe', 'pipe', 'pipe'] })
  const exit = once(child, 'close')
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
  const lines = createInterface({ input: child.stdout })
  let primary
  let failed = false
  try {
    const [endpoint] = await bounded(once(lines, 'line'), 5000, 'synthetic peer startup deadline')
    assert.match(endpoint, /^http:\/\/127\.0\.0\.1:\d+$/)
    const spec = {
      harness: 'openhands', backend: 'rpc', workdir, model,
      openhands: { endpoint, apiKey: key, agentProfile: 'fixture-agent', confirmNoUnwantedCallbacks: true },
      timeoutSeconds: 3, requestTimeoutSeconds: 1,
    }
    const requests = async () => {
      try { return (await readFile(trace, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) }
      catch (error) { if (error.code === 'ENOENT') return []; throw error }
    }
    await run(spec, requests, child)
  } catch (error) {
    primary = error
    failed = true
    throw error
  } finally {
    lines.close()
    child.stdin.end()
    child.stdin.destroy()
    try { await bounded(exit, 3000, `owned synthetic peer ${index} (${variant}) failed to stop on stdin EOF; stderr=${stderr}`) }
    catch (error) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await exit
      throw new AggregateError(failed ? [primary, error] : [error], `synthetic peer cleanup: exit=${child.exitCode}, signal=${child.signalCode}, stderr=${stderr}`)
    } finally { await rm(dir, { recursive: true, force: true }) }
    if (!failed) {
      assert.equal(child.exitCode, 0, stderr)
      assert.equal(stderr, '')
    }
  }
}

// Test-only stdin acknowledgement: HTTP and the socket are independent channels,
// so server write order cannot prove client receipt.
function nudge(child, byte) {
  child.stdin.write(Buffer.from([byte]))
}

const inner = (event) => (event.raw.event && typeof event.raw.event === 'object' ? event.raw.event : {})
const isRunningEvent = (event) => event.type === 'ConversationStateUpdateEvent' && inner(event).key === 'execution_status' && inner(event).value === 'running'
const isFinalState = (event, status) => event.type === 'ConversationStateUpdateEvent' && inner(event).key === 'full_state' && inner(event).value.execution_status === status
function echoText(event) {
  const payload = inner(event)
  if (event.type !== 'MessageEvent' || payload.source !== 'user') return null
  return payload.llm_message.content.filter((part) => part.type === 'text').map((part) => part.text).join('')
}
const paths = (requests, suffix) => requests.filter((request) => request.path.endsWith(suffix) && !request.upgrade)
const promptTokens = (result) => result.raw.state.stats.usage_to_metrics.agent.accumulated_token_usage.prompt_tokens

function preserved(requests) {
  assert.ok(requests.length > 0, 'expected traced requests')
  for (const request of requests) {
    const { path, method, body } = request
    assert.ok(method === 'GET' || method === 'POST', JSON.stringify(request))
    assert.equal(request.expose_secrets, false, JSON.stringify(request))
    if (request.upgrade) {
      assert.equal(method, 'GET')
      assert.match(path, /^\/sockets\/session\//)
      assert.doesNotMatch(request.query, /session_api_key|after_seq/)
      continue
    }
    if (path === '/server_info' || path === '/api/agent-profiles/fixture-agent' || path === '/api/profiles/fixture-llm') {
      assert.equal(method, 'GET')
      assert.equal(body, null)
      continue
    }
    assert.match(path, /^\/api\/conversations/)
    assert.doesNotMatch(path, /pause|confirmation|secrets|switch|init|settings|goal|fork|navigate|condense|plugin|profile|search|count/)
    if (method === 'GET') { assert.equal(body, null); continue }
    const serialized = JSON.stringify(body)
    assert.doesNotMatch(serialized, new RegExp(`${key}|api_key|secret`))
    if (path === '/api/conversations') {
      assert.deepEqual(Object.keys(body).sort(), ['agent_profile_id', 'autotitle', 'conversation_id', 'workspace', 'worktree'])
      assert.equal(body.agent_profile_id, profileId)
      assert.deepEqual(body.workspace, { kind: 'LocalWorkspace', working_dir: workdir })
      assert.equal(body.worktree, false)
      assert.equal(body.autotitle, false)
    } else if (path.endsWith('/events')) {
      assert.deepEqual(Object.keys(body).sort(), ['content', 'role', 'run'])
      assert.equal(body.role, 'user')
      assert.equal(body.run, false)
      assert.equal(body.content.length, 1)
      assert.deepEqual(Object.keys(body.content[0]).sort(), ['text', 'type'])
      assert.equal(body.content[0].type, 'text')
    } else {
      assert.match(path, /\/(run|interrupt)$/)
      assert.equal(body, null)
    }
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

async function drainUntilFinished(session) {
  for await (const event of session.events) {
    if (isFinalState(event, 'finished')) return
  }
  assert.fail('idle stream closed before the remote run finished')
}

export async function runOpenHandsConformance(api) {
  const capabilities = api.getSessionCapabilities('openhands', 'rpc')
  assert.equal(capabilities.approval, false)
  assert.equal(capabilities.followUp, true)
  assert.equal(capabilities.resume, true)
  assert.equal(capabilities.concurrentTurns, false)
  for (const backend of ['sdk', 'cli']) assert.throws(() => api.getSessionCapabilities('openhands', backend), { code: 'unsupported-backend' })
  assert.throws(() => api.getSessionCapabilities('openhands-unknown', 'rpc'), { code: 'unknown-harness' })
  // Session-only harness: the one-shot registry never learns a fake CLI adapter.
  assert.throws(() => api.getAdapter('openhands'), { code: 'unknown-harness' })

  const primary = new Error('scenario failed before peer cleanup')
  await assert.rejects(peer(async (_spec, _requests, child) => {
    child.kill('SIGTERM')
    throw primary
  }), (error) => error === primary)

  for (const scenario of cases) {
    await peer(async (spec, requests, child) => {
      const session = await api.openSession({ ...spec, timeoutSeconds: scenario.timeout_seconds ?? spec.timeoutSeconds })
      try {
        const turn = session.startTurn(scenario.prompt)
        const { events, result } = await collect(turn, (event) => {
          if (scenario.partial && isRunningEvent(event)) nudge(child, 1)
        })
        assert.equal(result.status, scenario.status, `${scenario.prompt}: ${result.error ?? 'no error detail'}`)
        assert.equal(result.sessionId, session.reference.sessionId)
        assert.equal(result.turnId, turn.id)
        for (const event of events) {
          assert.equal(event.backend, 'rpc')
          assert.equal(event.harness, 'openhands')
          assert.equal(event.sessionId, session.reference.sessionId)
          assert.equal(event.turnId, turn.id)
          if (event.raw.type === 'durable' || event.raw.type === 'transient') {
            assert.equal(event.type, inner(event).kind)
            assert.equal(event.requestId, inner(event).id)
          } else {
            assert.equal(event.type, event.raw.type)
          }
        }
        if (scenario.event_types) assert.deepEqual(events.map((event) => event.type), scenario.event_types, scenario.prompt)
        if (scenario.partial) assert.ok(events.some(isRunningEvent), `${scenario.prompt}: received running transition must survive failure`)
        if (!scenario.no_echo) {
          const echo = events.find((event) => echoText(event) === scenario.prompt)
          assert.ok(echo, `${scenario.prompt}: the caller's own user echo is part of the turn`)
          assert.equal(echo.raw.type, 'durable')
          assert.equal(typeof echo.raw.seq, 'number')
        }
        if (scenario.unknown_event) {
          assert.deepEqual(events.find((event) => event.type === 'SyntheticFutureEvent').raw.event.nested, { value: 42 })
          assert.equal(events.find((event) => event.type === 'item_started').raw.attempt, 1)
        }
        if (scenario.error_envelope) assert.deepEqual(events.at(-1).raw, scenario.error_envelope)
        if (scenario.terminal) {
          assert.equal(result.raw.state.execution_status, scenario.terminal)
          assert.equal(result.raw.state.id, session.reference.sessionId)
          assert.equal(promptTokens(result), 7)
          assert.equal(result.raw.terminal_event.kind, 'ConversationStateUpdateEvent')
          assert.equal(result.raw.terminal_event.key, 'execution_status')
          assert.equal(result.raw.terminal_event.value, scenario.terminal)
          assert.ok(events.some((event) => isFinalState(event, scenario.terminal)))
        }
        if (scenario.text) {
          const reply = events.find((event) => event.type === 'MessageEvent' && inner(event).source === 'agent')
          assert.equal(inner(reply).llm_message.content[0].text, scenario.text)
        }
        if (scenario.http_status) {
          assert.equal(result.raw.http_status, scenario.http_status)
          assert.match(result.error, new RegExp(String(scenario.http_status)))
        }
        if ('error' in scenario) assert.equal(result.error, scenario.error)
        if (scenario.closes_session) assert.equal(session.closed, true)
        // Native outcomes and HTTP rejections are turn results; the transport stays usable.
        else if (scenario.terminal || scenario.http_status) assert.equal(session.closed, false)
        assert.equal(result.exitCode, null)
        assert.equal(result.signal, null)
      } finally { await session.close() }
      assert.equal(child.exitCode, null)
      const seen = await requests()
      preserved(seen)
      assert.equal(paths(seen, '/interrupt').length, 0)
      if (scenario.no_run) assert.equal(paths(seen, '/run').length, 0)
    })
  }

  await peer(async (spec, requests, child) => {
    let session = await api.openSession(spec)
    try {
      const reference = session.reference
      assert.equal(reference.workdir, workdir)
      assert.equal(reference.sessionFile, null)
      assert.equal(reference.endpoint, spec.openhands.endpoint)
      assert.match(reference.sessionId, uuidRe)
      const ids = []
      const tokens = []
      for (let i = 0; i < 2; i++) {
        const { result, events } = await collect(session.startTurn('success'))
        assert.equal(result.status, 'completed')
        assert.equal(result.sessionId, reference.sessionId)
        const echo = events.find((event) => echoText(event) === 'success')
        ids.push(echo.requestId)
        assert.equal(result.raw.state.last_user_message_id, echo.requestId)
        tokens.push(promptTokens(result))
      }
      assert.notEqual(ids[0], ids[1])
      // Native stats are cumulative; the harness reports them untouched.
      assert.deepEqual(tokens, [7, 14])
      await Promise.all([session.close(), session.close()])
      assert.equal(child.exitCode, null)
      session = await api.openSession({ ...spec, resume: { ...reference, endpoint: reference.endpoint.toUpperCase() + '/' } })
      assert.deepEqual(session.reference, reference)
      const { result } = await collect(session.startTurn('success'))
      assert.equal(result.status, 'completed')
      assert.equal(promptTokens(result), 21)
      const seen = await requests()
      const creates = seen.filter((request) => request.method === 'POST' && request.path === '/api/conversations')
      assert.equal(creates.length, 1)
      assert.equal(creates[0].body.conversation_id, reference.sessionId)
      assert.equal(paths(seen, '/events').length, 3)
      assert.equal(paths(seen, '/run').length, 3)
      assert.deepEqual(seen.filter((request) => request.upgrade).map((request) => request.path), [`/sockets/session/${reference.sessionId}`, `/sockets/session/${reference.sessionId}`])
    } finally { await session.close() }
    preserved(await requests())
  })

  await peer(async (spec, requests, child) => {
    const session = await api.openSession(spec)
    try {
      const turn = session.startTurn('hang')
      assert.throws(() => session.startTurn('concurrent'), { code: 'unsupported-capability' })
      const { result } = await collect(turn, async (event) => {
        if (isRunningEvent(event)) {
          nudge(child, 1)
          await session.interrupt()
        }
      })
      assert.equal(result.status, 'interrupted')
      assert.equal(result.raw.state.execution_status, 'paused')
      assert.equal(session.closed, false)
      assert.equal((await collect(session.startTurn('success'))).result.status, 'completed')
    } finally { await session.close() }
    const seen = await requests()
    assert.equal(paths(seen, '/interrupt').length, 1)
    assert.equal(paths(seen, '/events').length, 2)
    preserved(seen)
  })

  await peer(async (spec, requests, child) => {
    const session = await api.openSession(spec)
    try {
      const { result } = await collect(session.startTurn('interrupt-ack-only'), async (event) => {
        if (isRunningEvent(event)) {
          nudge(child, 1)
          await session.interrupt()
        }
      })
      assert.equal(result.status, 'protocol-error')
      assert.equal(session.closed, true)
    } finally { await session.close() }
    assert.equal(paths(await requests(), '/interrupt').length, 1)
    assert.equal(child.exitCode, null)
  })

  for (const prompt of ['interrupt-http-error', 'interrupt-http-timeout', 'interrupt-http-disconnect']) {
    await peer(async (spec, requests, child) => {
      const session = await api.openSession(spec)
      try {
        let interrupted
        const { result } = await collect(session.startTurn(prompt), (event) => {
          if (isRunningEvent(event)) {
            nudge(child, 1)
            interrupted = session.interrupt()
          }
          if (isFinalState(event, 'finished')) nudge(child, 3)
        })
        assert.ok(interrupted)
        await interrupted
        assert.equal(result.status, 'completed', prompt)
        assert.equal(result.raw.state.execution_status, 'finished')
        assert.equal(session.closed, true)
        assert.throws(() => session.startTurn('must not follow a failed interrupt mutation'))
      } finally { await session.close() }
      const seen = await requests()
      assert.equal(paths(seen, '/interrupt').length, 1)
      assert.equal(paths(seen, '/run').length, 1)
      assert.equal(child.exitCode, null)
    })
  }

  await peer(async (spec, requests, child) => {
    const session = await api.openSession(spec)
    try {
      const { result } = await collect(session.startTurn('interrupt-race'), async (event) => {
        if (isRunningEvent(event)) {
          nudge(child, 1)
          await session.interrupt()
        }
      })
      assert.equal(result.status, 'completed')
      assert.equal(result.raw.state.execution_status, 'finished')
    } finally { await session.close() }
    assert.equal(paths(await requests(), '/interrupt').length, 1)
  })

  await peer(async (spec, requests, child) => {
    const session = await api.openSession(spec)
    try {
      const { result } = await collect(session.startTurn('interrupt-late-paused'), async (event) => {
        if (isRunningEvent(event)) {
          nudge(child, 1)
          await session.interrupt()
        }
      })
      // The finished barrier latched while the interrupt request was pending;
      // paused frames arriving before its acknowledgement never rewrite it.
      assert.equal(result.status, 'completed')
      assert.equal(result.raw.state.execution_status, 'finished')
    } finally { await session.close() }
    assert.equal(paths(await requests(), '/interrupt').length, 1)
  })

  await peer(async (spec, requests, child) => {
    const session = await api.openSession(spec)
    try {
      const turn = session.startTurn('hang-eager')
      await session.interrupt()
      const { events, result } = await collect(turn)
      assert.equal(result.status, 'interrupted')
      assert.equal(result.raw.state.execution_status, 'paused')
      assert.ok(events.some((event) => echoText(event) === 'hang-eager'))
      assert.ok(events.some(isRunningEvent))
      assert.equal(session.closed, false)
      assert.equal((await collect(session.startTurn('success'))).result.status, 'completed')
    } finally { await session.close() }
    const seen = (await requests()).filter((request) => !request.upgrade).map((request) => request.path)
    assert.equal(seen.filter((path) => path.endsWith('/interrupt')).length, 1)
    // The interrupt targets the caller's own accepted run, never an earlier state.
    const [submitted, accepted, interrupted] = ['/events', '/run', '/interrupt'].map((suffix) => seen.findIndex((path) => path.endsWith(suffix)))
    assert.ok(submitted < accepted && accepted < interrupted, seen.join(' '))
    assert.equal(child.exitCode, null)
  })

  await peer(async (spec, requests) => {
    const session = await api.openSession(spec)
    try {
      const turn = session.startTurn('run-busy')
      await session.interrupt()
      const { result } = await collect(turn)
      assert.equal(result.status, 'agent-error')
      assert.equal(result.raw.http_status, 409)
    } finally { await session.close() }
    const seen = await requests()
    assert.equal(paths(seen, '/interrupt').length, 0)
    assert.equal(paths(seen, '/run').length, 1)
  })

  await peer(async (spec, requests, child) => {
    const session = await api.openSession(spec)
    const reference = session.reference
    const { result } = await collect(session.startTurn('close-active'), async (event) => {
      if (isRunningEvent(event)) {
        nudge(child, 1)
        await Promise.all([session.close(), session.close()])
      }
    })
    assert.equal(result.status, 'closed')
    assert.equal(child.exitCode, null)
    assert.throws(() => session.startTurn('after close'), { code: 'session-closed' })
    let seen = await requests()
    assert.equal(paths(seen, '/interrupt').length, 0)
    assert.equal(paths(seen, '/pause').length, 0)
    const sent = paths(seen, '/events').length
    // The server keeps running the turn; resume observes that honestly and
    // never appends into the still-running work.
    const resumed = await api.openSession({ ...spec, resume: reference })
    try {
      assert.deepEqual(resumed.reference, reference)
      const busyTurn = resumed.startTurn('success')
      // An immediate interrupt must not reach the foreign run either.
      await resumed.interrupt()
      const busy = (await collect(busyTurn)).result
      assert.equal(busy.status, 'agent-error')
      assert.match(busy.error, /running/)
      assert.equal(resumed.closed, false)
      assert.equal(paths(await requests(), '/events').length, sent)
      assert.equal(paths(await requests(), '/interrupt').length, 0)
      nudge(child, 2)
      await bounded(drainUntilFinished(resumed), 5000, 'remote run did not finish on the idle stream')
      assert.equal((await collect(resumed.startTurn('success'))).result.status, 'completed')
    } finally { await resumed.close() }
    seen = await requests()
    assert.equal(paths(seen, '/events').length, sent + 1)
    assert.equal(paths(seen, '/interrupt').length, 0)
    preserved(seen)
  })

  await peer(async (spec, requests, child) => {
    const session = await api.openSession({ ...spec, timeoutSeconds: 0.1 })
    try {
      assert.equal((await collect(session.startTurn('hang'))).result.status, 'timed-out')
      assert.equal(session.closed, true)
    } finally { await session.close() }
    assert.equal(child.exitCode, null)
    const seen = await requests()
    assert.equal(paths(seen, '/interrupt').length, 0)
    preserved(seen)
  })

  await peer(async (spec, requests) => {
    const session = await api.openSession({ ...spec, maxBufferBytes: 4096 })
    try {
      const turn = session.startTurn('overflow')
      const result = await turn.result
      assert.equal(result.status, 'protocol-error')
      assert.equal(result.eventsTruncated, true)
      const events = []
      for await (const event of turn.events) events.push(event)
      assert.ok(events.some(isRunningEvent))
    } finally { await session.close() }
    preserved(await requests())
  })

  for (const [variant, code] of [
    ['wrong-version', 'unsupported-backend'],
    ['redirect', 'launch-failed'],
    ['acp-profile', 'unsupported-capability'],
    ['wrong-model', 'protocol-error'],
    ['wrong-workdir', 'protocol-error'],
    ['wrong-identity', 'protocol-error'],
    ['profile-mismatch', 'protocol-error'],
    ['collision', 'protocol-error'],
    ['unknown-status', 'protocol-error'],
    ['ws-redirect', 'launch-failed'],
    ['ws-reject', 'launch-failed'],
  ]) {
    await peer(async (spec, requests, child) => {
      await assert.rejects(api.openSession(spec), { code })
      assert.equal(child.exitCode, null)
      const seen = await requests()
      assert.equal(paths(seen, '/events').length, 0)
      assert.equal(paths(seen, '/run').length, 0)
      assert.equal(seen.some((request) => request.path === '/sockets/redirected'), false, 'socket redirects must not be followed')
      const creates = seen.filter((request) => request.method === 'POST')
      if (preCreateVariants.has(variant)) {
        assert.equal(creates.length, 0, `${variant}: rejected before anything is created`)
        assert.equal(seen.filter((request) => request.upgrade).length, 0)
      } else {
        assert.equal(creates.length, 1, `${variant}: identity is verified once, never retried with a new UUID`)
        assert.equal(creates[0].path, '/api/conversations')
      }
    }, variant)
  }

  await peer(async (spec, requests) => {
    const secret = 'synthetic-wrong-secret'
    await assert.rejects(api.openSession({ ...spec, openhands: { ...spec.openhands, apiKey: secret } }), (error) => error.code === 'launch-failed' && !String(error).includes(secret))
    assert.deepEqual((await requests()).map((request) => request.path), ['/server_info', '/api/agent-profiles/fixture-agent'])
  })

  await peer(async (spec, requests) => {
    for (const override of [
      { instructions: 'must not write' }, { env: { HOME: '/synthetic' } }, { executable: 'python3' }, { permissionPolicy: 'bypass' },
      { openhands: undefined }, { model: undefined }, { model: '   ' }, { ompSdk: spec.openhands }, { backend: 'sdk' }, { backend: 'cli' },
    ]) {
      await assert.rejects(api.openSession({ ...spec, ...override }))
    }
    for (const [field, value] of [
      ['confirmNoUnwantedCallbacks', false], ['confirmNoUnwantedCallbacks', 'true'], ['confirmNoUnwantedCallbacks', 1],
      ['apiKey', ''], ['apiKey', 'a b'], ['apiKey', 'a\nb'], ['apiKey', 'clé'],
      ['agentProfile', ''], ['agentProfile', '.hidden'], ['agentProfile', 'a/b'], ['agentProfile', 'x'.repeat(65)], ['agentProfile', 'sp ace'],
    ]) {
      await assert.rejects(
        api.openSession({ ...spec, openhands: { ...spec.openhands, [field]: value } }),
        (error) => error.code === 'invalid-options' && !String(error).includes('a\nb') && !String(error).includes('clé'),
        `${field}=${JSON.stringify(value)}`,
      )
    }
    for (const endpoint of ['', 'http://user:secret@localhost:3000', 'http://localhost:3000/path', 'http://localhost:3000?x=1', 'ftp://localhost', 'ws://localhost:3000']) {
      await assert.rejects(api.openSession({ ...spec, openhands: { ...spec.openhands, endpoint } }))
    }
    await assert.rejects(
      api.openSession({ ...spec, openhands: { ...spec.openhands, endpoint: 'http://synthetic:fixture-api-key@[' } }),
      (error) => error.code === 'invalid-options' && !String(error).includes('fixture-api-key'),
    )
    assert.deepEqual(await requests(), [])
  })

  await peer(async (spec, requests) => {
    const session = await api.openSession(spec)
    const reference = session.reference
    await session.close()
    const before = await requests()
    for (const wrong of [
      { ...reference, endpoint: 'http://127.0.0.1:1' },
      { ...reference, workdir: '/synthetic/other' },
      { ...reference, sessionFile: '/synthetic/invented-history' },
      { ...reference, sessionId: 'ses_not_a_uuid' },
      { ...reference, sessionId: '' },
    ]) {
      await assert.rejects(api.openSession({ ...spec, resume: wrong }), { code: 'invalid-options' })
    }
    assert.deepEqual(await requests(), before)
    await assert.rejects(api.openSession({ ...spec, resume: { ...reference, sessionId: missingId } }), { code: 'launch-failed' })
    const later = (await requests()).slice(before.length)
    assert.ok(later.some((request) => request.method === 'GET' && request.path === `/api/conversations/${missingId}`))
    assert.equal(later.filter((request) => request.method === 'POST' || request.upgrade).length, 0, 'a missing conversation is never re-created or subscribed')
  })

  await peer(async (spec, requests) => {
    const session = await api.openSession(spec)
    try { await assert.rejects(session.respondApproval('synthetic-request', 'once'), { code: 'unsupported-capability' }) }
    finally { await session.close() }
    const seen = await requests()
    assert.equal(paths(seen, '/events').length, 0)
    assert.ok(!seen.some((request) => request.path.includes('confirmation')))
  })

  await peer(async (spec, requests, child) => {
    // Whether the identity re-check runs at open or before the first turn,
    // a >1 MiB JSON body is a protocol failure, never parsed leniently.
    let session
    try { session = await api.openSession(spec) }
    catch (error) { assert.equal(error.code, 'protocol-error') }
    if (session) {
      try { assert.equal((await collect(session.startTurn('success'))).result.status, 'protocol-error') }
      finally { await session.close() }
    }
    assert.equal(paths(await requests(), '/events').length, 0)
    assert.equal(child.exitCode, null)
  }, 'oversize-http')

  return `${cases.length} shared protocol cases; identity, follow-up/resume, interrupt, active close with busy resume, deadlines, bounds, startup qualification, auth and validation`
}
