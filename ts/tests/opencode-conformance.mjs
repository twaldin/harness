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
const directory = '/synthetic/server/work'
const cases = JSON.parse(await readFile(join(root, 'tests/opencode_cases.json'), 'utf8'))
let peerIndex = 0

async function bounded(promise, ms, label) {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), ms) })])
  } finally { clearTimeout(timer) }
}

async function peer(run, variant = 'normal') {
  const dir = await mkdtemp(join(tmpdir(), 'harness-opencode-'))
  const index = ++peerIndex
  const trace = join(dir, 'requests.jsonl')
  const child = spawn('python3', ['-I', join(root, 'tests/helpers/opencode_server.py'), '--lifetime', '60', '--trace', trace, '--variant', variant], { stdio: ['pipe', 'pipe', 'pipe'] })
  const exit = once(child, 'close')
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
  const lines = createInterface({ input: child.stdout })
  let primary
  try {
    const [endpoint] = await bounded(once(lines, 'line'), 5000, 'synthetic peer startup deadline')
    assert.match(endpoint, /^http:\/\/127\.0\.0\.1:\d+$/)
    const spec = { harness: 'opencode', backend: 'rpc', workdir: directory, opencode: { endpoint, auth: 'basic', username: 'synthetic', password: 'fixture-password' }, timeoutSeconds: 3, requestTimeoutSeconds: 1 }
    const requests = async () => {
      try { return (await readFile(trace, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) }
      catch (error) { if (error.code === 'ENOENT') return []; throw error }
    }
    await run(spec, requests, child)
  } catch (error) {
    primary = error
    throw error
  } finally {
    lines.close()
    child.stdin.end()
    child.stdin.destroy()
    try { await bounded(exit, 3000, `owned synthetic peer ${index} (${variant}) failed to stop on stdin EOF; stderr=${stderr}`) }
    catch (error) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await exit
      throw new AggregateError([primary, error].filter(Boolean), `synthetic peer cleanup: exit=${child.exitCode}, signal=${child.signalCode}, stderr=${stderr}`)
    } finally { await rm(dir, { recursive: true, force: true }) }
    assert.equal(child.exitCode, 0, stderr)
    assert.equal(stderr, '')
  }
}

function preserved(requests) {
  for (const request of requests) {
    assert.notEqual(request.method, 'DELETE')
    assert.doesNotMatch(request.path, /dispose|config|provider|auth|tui/)
    assert.match(request.path, /^\/(global\/health|path|event|session(?:\/status|\/ses_[^/]+(?:\/message|\/abort)?)?|permission\/per_[^/]+\/reply)$/)
  }
}

async function collect(turn, onEvent) {
  const events = []
  for await (const event of turn.events) {
    events.push(event)
    onEvent?.(event)
  }
  return { events, result: await turn.result }
}

export async function runOpenCodeConformance(api) {
  assert.equal(api.getSessionCapabilities('opencode', 'rpc').approval, true)
  for (const scenario of cases) {
    await peer(async (spec, requests, child) => {
      const session = await api.openSession({ ...spec, timeoutSeconds: scenario.timeout_seconds ?? spec.timeoutSeconds })
      try {
        const turn = session.startTurn(scenario.prompt)
        const { events, result } = await collect(turn, (event) => {
          if (scenario.partial && event.type === 'message.part.delta') child.stdin.write(Buffer.from([1]))
        })
        assert.equal(result.status, scenario.status, scenario.prompt)
        assert.equal(result.sessionId, session.reference.sessionId)
        assert.equal(result.turnId, turn.id)
        for (const event of events) {
          assert.equal(event.backend, 'rpc')
          assert.equal(event.harness, 'opencode')
          assert.equal(event.sessionId, session.reference.sessionId)
          assert.equal(event.turnId, turn.id)
        }
        if (scenario.event_types) assert.deepEqual(events.map((event) => event.type), scenario.event_types)
        if (scenario.partial) assert.ok(events.some((event) => event.type === 'message.part.delta' && event.raw.properties.delta === 'partial λ'), `${scenario.prompt}: received partial output must survive failure`)
        if (scenario.unknown_event) assert.deepEqual(events.find((event) => event.type === 'synthetic.unknown').raw.properties.nested, { value: 42 })
        if (scenario.text) {
          assert.equal(result.raw.parts[0].text, scenario.text)
          assert.equal(result.raw.info.cost, 0)
        }
        assert.equal(result.exitCode, null)
        assert.equal(result.signal, null)
      } finally { await session.close() }
      assert.equal(child.exitCode, null)
      preserved(await requests())
    })
  }

  await peer(async (spec, requests, child) => {
    let session = await api.openSession(spec)
    try {
      const reference = session.reference
      assert.equal(reference.workdir, directory)
      assert.equal(reference.sessionFile, null)
      assert.equal(reference.endpoint, spec.opencode.endpoint)
      const ids = []
      for (let i = 0; i < 2; i++) {
        const { result, events } = await collect(session.startTurn('success'))
        assert.equal(result.status, 'completed')
        const user = events.find((event) => event.type === 'message.updated' && event.raw.properties.info.role === 'user').raw.properties.info
        ids.push(user.id)
        assert.equal(result.raw.info.parentID, user.id)
      }
      assert.notEqual(ids[0], ids[1])
      await Promise.all([session.close(), session.close()])
      assert.equal(child.exitCode, null)
      session = await api.openSession({ ...spec, resume: reference })
      assert.deepEqual(session.reference, reference)
      assert.equal((await collect(session.startTurn('success'))).result.status, 'completed')
    } finally { await session.close() }
    assert.equal((await requests()).filter((request) => request.method === 'POST' && request.path === '/session').length, 1)
    preserved(await requests())
  })

  await peer(async (spec, requests) => {
    const session = await api.openSession(spec)
    try {
      const turn = session.startTurn('hang')
      assert.throws(() => session.startTurn('concurrent'), { code: 'unsupported-capability' })
      for await (const event of turn.events) {
        if (event.type === 'message.part.delta') await session.interrupt()
      }
      assert.equal((await turn.result).status, 'interrupted')
      assert.equal((await collect(session.startTurn('success'))).result.status, 'completed')
    } finally { await session.close() }
    assert.equal((await requests()).filter((request) => request.path.endsWith('/abort')).length, 1)
  })

  for (const reply of ['once', 'reject']) {
    await peer(async (spec, requests) => {
      const session = await api.openSession(spec)
      try {
        let requestId
        const turn = session.startTurn('approval')
        for await (const event of turn.events) {
          if (event.type === 'permission.asked') {
            requestId = event.raw.properties.id
            await assert.rejects(session.respondApproval(requestId, 'always'), { code: 'unsupported-capability' })
            await session.respondApproval(requestId, reply)
          }
        }
        const result = await turn.result
        assert.equal(result.status, 'completed')
        assert.equal(result.raw.parts[0].text, reply === 'reject' ? 'permission rejected' : 'permission granted')
        await assert.rejects(session.respondApproval(requestId, reply))
      } finally { await session.close() }
      const replies = (await requests()).filter((request) => request.path.startsWith('/permission/'))
      assert.equal(replies.length, 1)
      assert.deepEqual(replies[0].body, { reply })
      assert.deepEqual(replies[0].directory, [directory])
    })
  }

  await peer(async (spec, requests, child) => {
    const session = await api.openSession(spec)
    try {
      const turn = session.startTurn('close-active')
      for await (const event of turn.events) {
        if (event.type === 'message.part.delta') await Promise.all([session.close(), session.close()])
      }
      assert.equal((await turn.result).status, 'closed')
      assert.equal(child.exitCode, null)
      assert.throws(() => session.startTurn('after close'), { code: 'session-closed' })
    } finally { await session.close() }
    assert.equal((await requests()).filter((request) => request.path.endsWith('/abort')).length, 0)
    preserved(await requests())
  })

  await peer(async (spec, requests) => {
    const session = await api.openSession({ ...spec, timeoutSeconds: 0.1 })
    try {
      assert.equal((await collect(session.startTurn('hang'))).result.status, 'timed-out')
      assert.equal(session.closed, true)
    } finally { await session.close() }
    assert.equal((await requests()).filter((request) => request.path.endsWith('/abort')).length, 0)
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
      assert.ok(events.some((event) => event.type === 'message.part.delta'))
    } finally { await session.close() }
    preserved(await requests())
  })

  for (const [variant, code] of [['wrong-version', 'unsupported-backend'], ['wrong-directory', 'protocol-error'], ['redirect', 'launch-failed']]) {
    await peer(async (spec, requests, child) => {
      await assert.rejects(api.openSession(spec), { code })
      assert.equal(child.exitCode, null)
      assert.equal((await requests()).filter((request) => request.method === 'POST').length, 0)
    }, variant)
  }

  await peer(async (spec, requests) => {
    const password = 'synthetic-wrong-secret'
    await assert.rejects(api.openSession({ ...spec, opencode: { ...spec.opencode, password } }), (error) => error.code === 'launch-failed' && !String(error).includes(password))
    assert.deepEqual((await requests()).map((request) => request.path), ['/global/health'])
  })

  await peer(async (spec, requests) => {
    for (const override of [{ instructions: 'must not write' }, { env: { HOME: '/synthetic' } }, { executable: 'python3' }, { permissionPolicy: 'bypass' }, { opencode: undefined }]) {
      await assert.rejects(api.openSession({ ...spec, ...override }))
    }
    for (const endpoint of ['', 'http://user:secret@localhost:4096', 'http://localhost:4096/path', 'http://localhost:4096?workspace=foreign', 'ftp://localhost']) {
      await assert.rejects(api.openSession({ ...spec, opencode: { ...spec.opencode, endpoint } }))
    }
    await assert.rejects(
      api.openSession({ ...spec, opencode: { ...spec.opencode, endpoint: 'http://synthetic:fixture-password@[' } }),
      (error) => error.code === 'invalid-options' && !String(error).includes('fixture-password'),
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
    ]) {
      await assert.rejects(api.openSession({ ...spec, resume: wrong }), { code: 'invalid-options' })
    }
    assert.deepEqual(await requests(), before)
    await assert.rejects(api.openSession({ ...spec, resume: { ...reference, sessionId: 'ses_missing' } }), { code: 'launch-failed' })
    assert.equal((await requests()).filter((request) => request.method === 'POST' && request.path === '/session').length, 1)
  })

  await peer(async (spec, requests) => {
    const session = await api.openSession({ ...spec, opencode: { endpoint: spec.opencode.endpoint, auth: 'none' } })
    try { assert.equal((await collect(session.startTurn('success'))).result.status, 'completed') }
    finally { await session.close() }
    preserved(await requests())
  }, 'no-auth')

  return `${cases.length} shared protocol cases; identity, follow-up/resume, interrupt, approval/rejection, local close, deadlines, bounds, auth and validation`
}
