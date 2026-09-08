import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { HarnessError } from '../src/base.js'
import type { ErrorCode } from '../src/base.js'
import { getSessionCapabilities, openSession } from '../src/sessions.js'
import type { LiveSession, SessionEvent, SessionSpec, SessionTurn, SessionTurnStatus } from '../src/sessions.js'
import '../src/adapters/index.js'

// The shared scenarios live in ../../tests/session_cases.json and run against
// the synthetic Pi RPC peer ../../tests/helpers/rpc_agent.py (both owned by
// the shared fixture set; tests/test_sessions.py mirrors them in Python and
// node-sessions.mjs replays the manifest against the built package).

const ROOT = resolve(import.meta.dir, '../..')
const EXECUTABLE = join(ROOT, 'tests/helpers/rpc_agent.py')
const LOCK = '.harness-run.lock'

interface SharedCase {
  name: string
  status: SessionTurnStatus
  event_types?: string[]
  exit_code?: number
  signal?: string
}

const CASES: SharedCase[] = JSON.parse(readFileSync(join(ROOT, 'tests/session_cases.json'), 'utf-8'))

const dirs: string[] = []
const sessions: LiveSession[] = []

function workdir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'harness-session-'))
  dirs.push(dir)
  return dir
}

function spec(scenario: string, dir: string, extra: Partial<SessionSpec> = {}): SessionSpec {
  return {
    harness: 'pi',
    backend: 'rpc',
    workdir: dir,
    executable: EXECUTABLE,
    env: { HARNESS_RPC_CASE: scenario },
    timeoutSeconds: 5,
    requestTimeoutSeconds: 3,
    ...extra,
  }
}

async function open(scenario: string, dir: string, extra: Partial<SessionSpec> = {}): Promise<LiveSession> {
  const session = await openSession(spec(scenario, dir, extra))
  sessions.push(session)
  return session
}

async function collect(turn: SessionTurn): Promise<SessionEvent[]> {
  const events: SessionEvent[] = []
  for await (const event of turn.events) events.push(event)
  return events
}

/** Consume a turn's events in the background; `seen(type)` resolves once that native event has arrived. */
function observe(turn: SessionTurn): { events: Promise<SessionEvent[]>; seen: (type: string) => Promise<void> } {
  const events: SessionEvent[] = []
  const waiters: { type: string; done: () => void }[] = []
  const done = (async () => {
    for await (const event of turn.events) {
      events.push(event)
      for (const waiter of waiters.splice(0)) {
        if (waiter.type === event.type) waiter.done()
        else waiters.push(waiter)
      }
    }
    for (const waiter of waiters.splice(0)) waiter.done()
    return events
  })()
  return {
    events: done,
    seen: (type) => events.some((event) => event.type === type)
      ? Promise.resolve()
      : new Promise((resolve) => { waiters.push({ type, done: resolve }) }),
  }
}

/** The forked descendant announces itself only through a pid file; there is no frame to await. */
async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 3000
  while (!existsSync(path) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 20))
}

async function expectCode(promise: Promise<unknown>, code: ErrorCode): Promise<HarnessError> {
  try {
    await promise
  } catch (err) {
    expect(err).toBeInstanceOf(HarnessError)
    expect((err as HarnessError).code).toBe(code)
    return err as HarnessError
  }
  throw new Error(`expected rejection with ${code}`)
}

afterEach(async () => {
  for (const session of sessions.splice(0)) {
    try {
      await session.close()
    } catch {}
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('shared session scenarios', () => {

  for (const scenario of CASES) {
    test(scenario.name, async () => {
      const dir = workdir()
      const session = await open(scenario.name, dir, { timeoutSeconds: scenario.name === 'hang' ? 0.15 : 5 })
      const turn = session.startTurn('synthetic prompt')
      const consuming = collect(turn)
      const result = await turn.result
      const events = await consuming
      expect(result.status).toBe(scenario.status)
      expect(result.sessionId).toBe(session.reference.sessionId)
      expect(result.turnId).toBe(turn.id)
      if (scenario.exit_code !== undefined) expect(result.exitCode).toBe(scenario.exit_code)
      if (scenario.signal !== undefined) expect(result.signal).toBe(scenario.signal)
      if (scenario.event_types) expect(events.map((event) => event.type)).toEqual(scenario.event_types)
      for (const event of events) {
        expect(event.turnId).toBe(turn.id)
        expect(event.sessionId).toBe(session.reference.sessionId)
        expect(event.backend).toBe('rpc')
        expect(event.harness).toBe('pi')
      }
      if (result.status !== 'completed' && result.status !== 'agent-error') {
        expect(session.closed).toBe(true)
        expect(() => session.startTurn('again')).toThrow(expect.objectContaining({ code: 'session-closed' }))
      }
      await session.close()
      expect(existsSync(join(dir, LOCK))).toBe(false)
    })
  }
})

describe('turn semantics', () => {
  test('completed turn keeps raw agent_end, retains request ids and allows a follow-up in the same native session', async () => {
    const dir = workdir()
    const session = await open('success', dir)
    const first = session.startTurn('one')
    const firstEvents = collect(first)
    const result = await first.result
    expect(result.raw?.type).toBe('agent_end')
    expect(result.error).toBeNull()
    expect(result.exitCode).toBeNull()
    expect(result.eventsTruncated).toBe(false)
    const response = (await firstEvents).find((event) => event.type === 'response')
    expect(response?.requestId).toBe('req-2')
    expect(response?.raw.command).toBe('prompt')
    expect(session.active).toBeNull()
    const second = session.startTurn('two')
    expect(second.id).not.toBe(first.id)
    const drain = collect(second)
    expect((await second.result).status).toBe('completed')
    expect((await drain).every((event) => event.turnId === second.id)).toBe(true)
    expect((await second.result).sessionId).toBe(result.sessionId)
  })

  test('rejected prompt settles agent-error with the response as raw and leaves the session usable', async () => {
    const dir = workdir()
    const session = await open('reject', dir)
    const turn = session.startTurn('nope')
    const result = await turn.result
    expect(result.status).toBe('agent-error')
    expect(result.error).toBe('synthetic rejection')
    expect(result.raw?.type).toBe('response')
    expect(session.closed).toBe(false)
    expect(session.startTurn('again').id).toBe('turn-2')
  })

  test('overlapping turns and empty prompts are refused before any write', async () => {
    const dir = workdir()
    const session = await open('hang', dir)
    expect(() => session.startTurn('')).toThrow(expect.objectContaining({ code: 'invalid-options' }))
    expect(() => session.startTurn('   ')).toThrow(expect.objectContaining({ code: 'invalid-options' }))
    expect(() => session.startTurn('a\0b')).toThrow(expect.objectContaining({ code: 'invalid-options' }))
    const turn = session.startTurn('first')
    expect(session.active?.id).toBe(turn.id)
    expect(() => session.startTurn('second')).toThrow(expect.objectContaining({ code: 'unsupported-capability' }))
    await session.close()
    expect((await turn.result).status).toBe('closed')
  })

  test('unknown native events and unicode separators pass through untouched', async () => {
    const dir = workdir()
    const session = await open('unicode', dir)
    const turn = session.startTurn('snow')
    const events = collect(turn)
    expect((await turn.result).status).toBe('completed')
    const update = (await events).find((event) => event.type === 'message_update' && typeof event.raw.assistantMessageEvent === 'object')
    const delta = (update?.raw.assistantMessageEvent as { delta?: string } | undefined)?.delta
    expect(delta).toBe('snowman \u2603 separator \u2028 and \u2029')
  })

  test('stderr is captured as a bounded prefix on every result', async () => {
    const dir = workdir()
    const session = await open('stderr', dir, { maxBufferBytes: 1000 })
    const turn = session.startTurn('noisy')
    const drain = collect(turn)
    const result = await turn.result
    await drain
    expect(result.status).toBe('completed')
    expect(result.stderrBytes).toBe(2200)
    expect(result.stderrTruncated).toBe(true)
    expect(result.stderr.length).toBe(1000)
    expect(result.stderr.startsWith('synthetic diagnostics')).toBe(true)
  })

  test('turn event iterator is single-consumer and ends after the result', async () => {
    const dir = workdir()
    const session = await open('success', dir)
    const turn = session.startTurn('x')
    const iterator = turn.events[Symbol.asyncIterator]()
    expect(() => turn.events[Symbol.asyncIterator]()).toThrow(expect.objectContaining({ code: 'unsupported-capability' }))
    await turn.result
    let count = 0
    for (;;) {
      const item = await iterator.next()
      if (item.done) break
      count++
    }
    expect(count).toBe(5)
    expect((await iterator.next()).done).toBe(true)
  })
})

describe('interrupt', () => {
  test('confirmed abort settles interrupted after both the ack and agent_settled', async () => {
    const dir = workdir()
    const session = await open('interrupt', dir)
    const turn = session.startTurn('long')
    const observed = observe(turn)
    await observed.seen('agent_start')
    let settled = false
    void turn.result.then(() => { settled = true })
    await session.interrupt()
    expect(settled).toBe(true)
    const result = await turn.result
    expect(result.status).toBe('interrupted')
    expect(result.error).toBeNull()
    expect((await observed.events).map((event) => event.type)).toEqual(['response', 'agent_start', 'agent_end', 'agent_settled', 'response'])
    expect(session.closed).toBe(false)
    expect(session.active).toBeNull()
  })

  test('late prompt ack cannot leak into the next turn', async () => {
    const dir = workdir()
    const session = await open('interrupt_before_ack', dir)
    const turn = session.startTurn('long')
    const observed = observe(turn)
    await observed.seen('agent_start')
    expect(() => session.startTurn('overlap')).toThrow(expect.objectContaining({ code: 'unsupported-capability' }))
    await session.interrupt()
    expect((await turn.result).status).toBe('interrupted')
    const events = await observed.events
    expect(events.map((event) => event.type)).toEqual(['agent_start', 'agent_end', 'agent_settled', 'response', 'response'])
    expect(events.map((event) => event.raw.command)).toEqual([undefined, undefined, undefined, 'abort', 'prompt'])
    const next = session.startTurn('follow-up')
    expect(next.id).toBe('turn-2')
  })

  test('unacknowledged abort is a protocol error after the request timeout', async () => {
    const dir = workdir()
    const session = await open('abort_hang', dir, { requestTimeoutSeconds: 0.3 })
    const turn = session.startTurn('long')
    const observed = observe(turn)
    await observed.seen('agent_start')
    await session.interrupt()
    await observed.events
    const result = await turn.result
    expect(result.status).toBe('protocol-error')
    expect(result.error).toContain('abort')
    expect(session.closed).toBe(true)
  })

  test('interrupt without an active turn or on a closed session is refused', async () => {
    const dir = workdir()
    const session = await open('success', dir)
    await expectCode(session.interrupt(), 'unsupported-capability')
    await session.close()
    await expectCode(session.interrupt(), 'session-closed')
  })
})

describe('buffering', () => {
  test('unconsumed events beyond maxBufferBytes fail the session but stay readable', async () => {
    const dir = workdir()
    const session = await open('flood', dir, { maxBufferBytes: 64 * 1024 })
    const turn = session.startTurn('flood')
    const result = await turn.result
    expect(result.status).toBe('protocol-error')
    expect(result.eventsTruncated).toBe(true)
    expect(result.error).toContain('maxBufferBytes')
    const events = await collect(turn)
    expect(events.length).toBeGreaterThan(1)
    expect(events[0]?.type).toBe('response')
  })

  test('idle frames flow through session.events with a null turnId', async () => {
    const dir = workdir()
    const session = await open('idle_unknown', dir)
    const iterator = session.events[Symbol.asyncIterator]()
    const idle = await iterator.next()
    expect(idle.done).toBe(false)
    expect(idle.value?.type).toBe('synthetic_idle')
    expect(idle.value?.turnId).toBeNull()
    expect(idle.value?.sessionId).toBe(session.reference.sessionId)
    expect(idle.value?.raw.nativeDetail).toEqual({ retained: true })
    await session.close()
    expect((await iterator.next()).done).toBe(true)
  })
})

describe('open and resume', () => {
  test('handshake failures reject after teardown with the lease released', async () => {
    for (const [scenario, code, extra] of [
      ['startup_hang', 'protocol-error', { requestTimeoutSeconds: 0.3 }],
      ['bad_state', 'protocol-error', {}],
    ] as const) {
      const dir = workdir()
      await expectCode(openSession(spec(scenario, dir, extra)), code)
      expect(existsSync(join(dir, LOCK))).toBe(false)
    }
  })

  test('spawn failure is launch-failed with the lease released', async () => {
    const dir = workdir()
    await expectCode(openSession(spec('success', dir, { executable: join(dir, 'missing-pi') })), 'launch-failed')
    expect(existsSync(join(dir, LOCK))).toBe(false)
  })

  test('resume verifies the header before spawn and the native id after', async () => {
    const dir = workdir()
    const first = await open('success', dir)
    const reference = first.reference
    await first.close()
    expect(reference.sessionFile).not.toBeNull()

    const resumed = await open('success', dir, { resume: reference })
    expect(resumed.reference.sessionId).toBe(reference.sessionId)
    expect(resumed.spec.resume).toEqual(reference)
    const turn = resumed.startTurn('again')
    const drain = collect(turn)
    expect((await turn.result).status).toBe('completed')
    await drain
    await resumed.close()

    await expectCode(openSession(spec('success', dir, { resume: { ...reference, sessionId: '11111111-2222' } })), 'invalid-options')
    await expectCode(openSession(spec('success', dir, { resume: { ...reference, sessionFile: null } })), 'invalid-options')
    await expectCode(openSession(spec('success', dir, { resume: { ...reference, sessionFile: join(dir, 'absent.jsonl') } })), 'invalid-options')
    const other = workdir()
    await expectCode(openSession(spec('success', other, { resume: reference })), 'invalid-options')
    const foreign = join(dir, 'foreign.jsonl')
    writeFileSync(foreign, `${JSON.stringify({ type: 'session', id: reference.sessionId, cwd: '/elsewhere' })}\n`)
    await expectCode(openSession(spec('success', dir, { resume: { ...reference, sessionFile: foreign } })), 'invalid-options')

    await expectCode(openSession(spec('wrong_session', dir, { resume: reference })), 'protocol-error')
    expect(existsSync(join(dir, LOCK))).toBe(false)
  })
})

describe('close and ownership', () => {
  test('close settles the active turn, is idempotent and concurrent-safe', async () => {
    const dir = workdir()
    const session = await open('close', dir, { instructions: 'session rules' })
    expect(readFileSync(join(dir, 'AGENTS.md'), 'utf-8')).toBe('session rules')
    expect(existsSync(join(dir, LOCK))).toBe(true)
    const turn = session.startTurn('long')
    const observed = observe(turn)
    await observed.seen('agent_start')
    await Promise.all([session.close(), session.close()])
    await session.close()
    const result = await turn.result
    await observed.events
    expect(result.status).toBe('closed')
    expect(result.error).toBeNull()
    expect(session.closed).toBe(true)
    expect(existsSync(join(dir, 'AGENTS.md'))).toBe(false)
    expect(existsSync(join(dir, LOCK))).toBe(false)
    expect(() => session.startTurn('again')).toThrow(expect.objectContaining({ code: 'session-closed' }))
  })

  test('close escalates to SIGKILL for a TERM-ignoring descendant holding the pipes and then restores the lease', async () => {
    const dir = workdir()
    const session = await open('descendant', dir, { instructions: 'held' })
    const turn = session.startTurn('fork')
    const observed = observe(turn)
    const pidFile = join(dir, 'synthetic-child.pid')
    await waitForFile(pidFile)
    const pid = Number(readFileSync(pidFile, 'utf-8'))
    expect(pid).toBeGreaterThan(0)
    process.kill(pid, 0)
    const started = performance.now()
    await session.close()
    const elapsed = performance.now() - started
    expect((await turn.result).status).toBe('closed')
    expect((await observed.events).map((event) => event.type)).toEqual(['response', 'agent_start'])
    expect(elapsed).toBeLessThan(2500)
    expect(() => process.kill(pid, 0)).toThrow()
    expect(existsSync(join(dir, 'AGENTS.md'))).toBe(false)
    expect(existsSync(join(dir, LOCK))).toBe(false)
  })

  test('a session holds the workdir lease for its lifetime', async () => {
    const dir = workdir()
    const session = await open('success', dir)
    await expectCode(openSession(spec('success', dir)), 'instruction-conflict')
    await session.close()
    const again = await open('success', dir)
    expect(again.closed).toBe(false)
  })
})

describe('spec validation and capabilities', () => {
  const base: SessionSpec = { harness: 'pi', backend: 'rpc', workdir: '.' }


  test('rejections', async () => {
    const cases: [Record<string, unknown>, ErrorCode][] = [
      [{ harness: 'nope' }, 'unknown-harness'],
      [{ harness: 'claude-code' }, 'unsupported-backend'],
      [{ backend: 'cli' }, 'unsupported-backend'],
      [{ backend: 'sdk' }, 'unsupported-backend'],
      [{ backend: 'grpc' }, 'invalid-options'],
      [{ backend: undefined }, 'invalid-options'],
      [{ permissionPolicy: 'bypass' }, 'unsupported-capability'],
      [{ permissionPolicy: 'yolo' }, 'invalid-options'],
      [{ model: '   ' }, 'invalid-options'],
      [{ executable: 'bin/pi' }, 'invalid-options'],
      [{ env: { A: 1 } }, 'invalid-options'],
      [{ timeoutSeconds: -1 }, 'invalid-options'],
      [{ requestTimeoutSeconds: 0 }, 'invalid-options'],
      [{ maxBufferBytes: 1.5 }, 'invalid-options'],
      [{ resume: { sessionId: '', sessionFile: '/x', workdir: '/x' } }, 'invalid-options'],
      [{ resume: { sessionId: 'id', sessionFile: 'relative', workdir: '/x' } }, 'invalid-options'],
      [{ workdir: '' }, 'invalid-options'],
    ]
    for (const [override, code] of cases) {
      await expect(openSession({ ...base, ...override } as SessionSpec)).rejects.toMatchObject({ code })
    }
  })

  test('getSessionCapabilities', () => {
    expect(getSessionCapabilities('pi')).toEqual({
      backend: 'rpc', events: true, interrupt: true, followUp: true, resume: true, concurrentTurns: false, approval: false,
    })
    expect(() => getSessionCapabilities('pi', 'cli')).toThrow(expect.objectContaining({ code: 'unsupported-backend' }))
    expect(() => getSessionCapabilities('codex')).toThrow(expect.objectContaining({ code: 'unsupported-backend' }))
    expect(() => getSessionCapabilities('missing')).toThrow(expect.objectContaining({ code: 'unknown-harness' }))
  })
})

test('startup events carry verified identity and preserve native payload', async () => {
  const session = await open('prelude', workdir())
  const iterator = session.events[Symbol.asyncIterator]()
  const entry = await iterator.next()
  expect(entry.done).toBe(false)
  expect(entry.value?.sessionId).toBe(session.reference.sessionId)
  expect(entry.value?.turnId).toBeNull()
  expect(entry.value?.raw.nativeDetail).toEqual({ retained: true })
})

for (const scenario of ['prelude_flood', 'relative_state']) {
  test(`${scenario} releases startup ownership`, async () => {
    const dir = workdir()
    await expectCode(openSession(spec(scenario, dir, { maxBufferBytes: 512 })), 'protocol-error')
    expect(existsSync(join(dir, LOCK))).toBe(false)
  })
}
