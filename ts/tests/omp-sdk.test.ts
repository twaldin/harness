import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { HarnessError } from '../src/base.js'
import type { ErrorCode } from '../src/base.js'
import { getSessionCapabilities, openSession } from '../src/sessions.js'
import type { LiveSession, OmpSdkOptions, SessionEvent, SessionSpec, SessionTurn, SessionTurnStatus } from '../src/sessions.js'
import '../src/adapters/index.js'

// The `omp` / `sdk` backend runs the shared bridge worker
// ../../src/harness/_omp_sdk.mjs under Bun against the synthetic
// @oh-my-pi/pi-coding-agent package in ../../tests/helpers/omp_sdk (selected
// through `ompSdk.packageRoot`, never installed). The synthetic SDK picks its
// behaviour from the prompt text; ../../tests/omp_sdk_cases.json lists the
// shared prompt → status expectations that tests/test_omp_sdk.py mirrors.

const ROOT = resolve(import.meta.dir, '../..')
const PACKAGE_ROOT = join(ROOT, 'tests/helpers/omp_sdk')
const LOCK = '.harness-run.lock'
/** Bridge framing that must never surface as a session event. */
const BRIDGE_TYPES: Readonly<Record<string, true>> = { sdk_event: true, sdk_settled: true }

interface SharedCase {
  prompt: string
  status: SessionTurnStatus
  event_types?: string[]
}

const CASES: SharedCase[] = JSON.parse(readFileSync(join(ROOT, 'tests/omp_sdk_cases.json'), 'utf-8'))

const dirs: string[] = []
const sessions: LiveSession[] = []

/** One isolated tree per session: workdir, agent profile, HOME and the lifecycle trace, none shared with the parent. */
interface Sandbox {
  workdir: string
  agentDir: string
  home: string
  trace: string
}

function sandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), 'harness-omp-sdk-'))
  dirs.push(root)
  const box = { workdir: join(root, 'work'), agentDir: join(root, 'agent'), home: join(root, 'home'), trace: join(root, 'trace.log') }
  mkdirSync(box.workdir)
  mkdirSync(box.agentDir)
  mkdirSync(box.home)
  return box
}

function options(box: Sandbox, extra: Partial<OmpSdkOptions> = {}): OmpSdkOptions {
  return { packageRoot: PACKAGE_ROOT, agentDir: box.agentDir, auth: 'environment', ...extra }
}

function spec(box: Sandbox, extra: Partial<SessionSpec> = {}): SessionSpec {
  return {
    harness: 'omp',
    backend: 'sdk',
    workdir: box.workdir,
    executable: process.execPath,
    ompSdk: options(box),
    env: { HOME: box.home, HARNESS_SDK_TRACE: box.trace },
    timeoutSeconds: 5,
    requestTimeoutSeconds: 3,
    ...extra,
  }
}

async function open(box: Sandbox, extra: Partial<SessionSpec> = {}): Promise<LiveSession> {
  const session = await openSession(spec(box, extra))
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

/** Text of the last assistant message in an `agent_end` payload. */
function assistantText(raw: Record<string, unknown> | null): string {
  const messages = raw?.messages
  if (!Array.isArray(messages)) return ''
  const last: unknown = messages[messages.length - 1]
  if (typeof last !== 'object' || last === null || !('content' in last) || !Array.isArray(last.content)) return ''
  return last.content
    .map((part: unknown) => (typeof part === 'object' && part !== null && 'text' in part && typeof part.text === 'string' ? part.text : ''))
    .join('')
}

function traceOf(box: Sandbox): string {
  return existsSync(box.trace) ? readFileSync(box.trace, 'utf-8') : ''
}

function expectOwnedResourcesReleased(box: Sandbox): void {
  expect(existsSync(join(box.workdir, LOCK))).toBe(false)
  expect(existsSync(join(box.workdir, 'AGENTS.md'))).toBe(false)
}

afterEach(async () => {
  for (const session of sessions.splice(0)) {
    try {
      await session.close()
    } catch {}
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})


describe('shared SDK scenarios', () => {
  for (const scenario of CASES) {
    test(scenario.prompt, async () => {
      const box = sandbox()
      const session = await open(box)
      const turn = session.startTurn(scenario.prompt)
      const consuming = collect(turn)
      const result = await turn.result
      const events = await consuming
      expect(result.status).toBe(scenario.status)
      expect(result.sessionId).toBe(session.reference.sessionId)
      expect(result.turnId).toBe(turn.id)
      if (scenario.event_types) expect(events.map((event) => event.type)).toEqual(scenario.event_types)
      for (const event of events) {
        expect(event.turnId).toBe(turn.id)
        expect(event.sessionId).toBe(session.reference.sessionId)
        expect(event.backend).toBe('sdk')
        expect(event.harness).toBe('omp')
        expect(BRIDGE_TYPES[event.type]).toBeUndefined()
        expect(event.raw.type).toBe(event.type)
      }
      // Native agent_settled is an ordinary event on sdk; the session stays usable after any settled turn.
      expect(session.closed).toBe(false)
      await session.close()
      expectOwnedResourcesReleased(box)
    })
  }
})

describe('turn semantics', () => {
  test('completed turns expose the native agent_end, request ids and sequence across a follow-up', async () => {
    const box = sandbox()
    const session = await open(box, { instructions: 'sdk rules' })
    expect(readFileSync(join(box.workdir, 'AGENTS.md'), 'utf-8')).toBe('sdk rules')
    const first = session.startTurn('success')
    const firstEvents = collect(first)
    const result = await first.result
    expect(result.status).toBe('completed')
    expect(result.raw?.type).toBe('agent_end')
    expect(result.error).toBeNull()
    expect(result.exitCode).toBeNull()
    expect(assistantText(result.raw)).toContain('reply-1')
    const events = await firstEvents
    const response = events.find((event) => event.type === 'response')
    expect(response?.requestId).toBe('req-2')
    expect(response?.raw.command).toBe('prompt')
    expect(response?.raw.success).toBe(true)
    const update = events.find((event) => event.type === 'message_update')
    expect(update?.raw.assistantMessageEvent).toEqual({ type: 'text_delta', delta: 'reply-1' })
    expect(session.active).toBeNull()

    const second = session.startTurn('success')
    expect(second.id).not.toBe(first.id)
    const drain = collect(second)
    const again = await second.result
    expect(again.status).toBe('completed')
    expect(again.sessionId).toBe(result.sessionId)
    expect(assistantText(again.raw)).toContain('reply-2')
    expect((await drain).every((event) => event.turnId === second.id)).toBe(true)
  })

  test('native agent_settled never completes an SDK turn; the bridge settle does', async () => {
    const box = sandbox()
    const session = await open(box)
    const turn = session.startTurn('native_settled')
    const observed = observe(turn)
    await observed.seen('agent_settled')
    let settled = false
    void turn.result.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    // The worker's `sdk_settled` follows the native event on the same pipe; the result must not settle before it.
    const result = await turn.result
    expect(result.status).toBe('completed')
    const types = (await observed.events).map((event) => event.type)
    expect(types).toContain('agent_settled')
    expect(types).not.toContain('sdk_settled')
  })

  test('a failing settle is agent-error carrying the bridge frame and leaves the session usable', async () => {
    const box = sandbox()
    const session = await open(box)
    const turn = session.startTurn('reject')
    const drain = collect(turn)
    const result = await turn.result
    expect(result.status).toBe('agent-error')
    expect(result.raw?.type).toBe('sdk_settled')
    expect(typeof result.error).toBe('string')
    expect(result.error).not.toBe('')
    expect((await drain).some((event) => event.type === 'sdk_settled')).toBe(false)
    expect(session.closed).toBe(false)
    expect(session.startTurn('success').id).toBe('turn-2')
  })

  test('unknown native events pass through with their payload as raw', async () => {
    const box = sandbox()
    const session = await open(box)
    const turn = session.startTurn('unknown')
    const drain = collect(turn)
    expect((await turn.result).status).toBe('completed')
    const unknown = (await drain).find((event) => event.type === 'synthetic_unknown')
    expect(unknown).toBeDefined()
    expect(Object.keys(unknown?.raw ?? {}).length).toBeGreaterThan(1)
  })
})

describe('interrupt', () => {
  test('interrupting a hanging turn settles interrupted and allows a follow-up', async () => {
    const box = sandbox()
    const session = await open(box)
    const turn = session.startTurn('hang')
    const observed = observe(turn)
    await observed.seen('message_update')
    let settled = false
    void turn.result.then(() => { settled = true })
    await session.interrupt()
    expect(settled).toBe(true)
    const result = await turn.result
    expect(result.status).toBe('interrupted')
    expect(result.error).toBeNull()
    expect(result.raw?.type).toBe('agent_end')
    const events = await observed.events
    expect(events.map((event) => event.type)).toContain('agent_end')
    expect(events.filter((event) => event.type === 'response').map((event) => event.raw.command)).toEqual(['prompt', 'abort'])
    expect(session.closed).toBe(false)
    expect(session.active).toBeNull()

    const next = session.startTurn('success')
    const drain = collect(next)
    const again = await next.result
    expect(again.status).toBe('completed')
    expect(again.sessionId).toBe(result.sessionId)
    await drain
  })

  test('interrupt without an active turn or on a closed session is refused', async () => {
    const box = sandbox()
    const session = await open(box)
    await expectCode(session.interrupt(), 'unsupported-capability')
    await session.close()
    await expectCode(session.interrupt(), 'session-closed')
  })
})

describe('buffering', () => {
  test('unconsumed events beyond maxBufferBytes fail the session but stay readable', async () => {
    const box = sandbox()
    const session = await open(box, { maxBufferBytes: 64 * 1024 })
    const turn = session.startTurn('flood')
    const result = await turn.result
    expect(result.status).toBe('protocol-error')
    expect(result.eventsTruncated).toBe(true)
    expect(result.error).toContain('maxBufferBytes')
    const events = await collect(turn)
    expect(events.length).toBeGreaterThan(1)
    expect(events[0]?.type).toBe('response')
    expect(session.closed).toBe(true)
    expectOwnedResourcesReleased(box)
  })
})

describe('open and resume', () => {
  test('a fresh session persists a header the resume path verifies, and resume keeps the native id', async () => {
    const box = sandbox()
    const first = await open(box)
    const reference = first.reference
    expect(reference.workdir).toBe(box.workdir)
    expect(reference.sessionFile).not.toBeNull()
    const firstTurn = first.startTurn('success')
    const firstDrain = collect(firstTurn)
    expect((await firstTurn.result).status).toBe('completed')
    await firstDrain
    await first.close()

    const resumed = await open(box, { resume: reference })
    expect(resumed.reference.sessionId).toBe(reference.sessionId)
    expect(resumed.reference.sessionFile).toBe(reference.sessionFile)
    expect(resumed.spec.resume).toEqual(reference)
    const turn = resumed.startTurn('success')
    const drain = collect(turn)
    const result = await turn.result
    expect(result.status).toBe('completed')
    expect(result.sessionId).toBe(reference.sessionId)
    await drain
    await resumed.close()

    await expectCode(openSession(spec(box, { resume: { ...reference, sessionId: '11111111-2222' } })), 'invalid-options')
    await expectCode(openSession(spec(box, { resume: { ...reference, sessionFile: null } })), 'invalid-options')
    await expectCode(openSession(spec(box, { resume: { ...reference, sessionFile: join(box.workdir, 'absent.jsonl') } })), 'invalid-options')
    const other = sandbox()
    await expectCode(openSession(spec(other, { resume: reference })), 'invalid-options')
    const foreign = join(box.workdir, 'foreign.jsonl')
    writeFileSync(foreign, `${JSON.stringify({ type: 'session', id: reference.sessionId, cwd: '/elsewhere' })}\n`)
    await expectCode(openSession(spec(box, { resume: { ...reference, sessionFile: foreign } })), 'invalid-options')
    expectOwnedResourcesReleased(box)
  })

  test('a worker that cannot load the SDK package fails the launch with its stderr and no retained ownership', async () => {
    const box = sandbox()
    const empty = join(box.home, 'no-package')
    mkdirSync(empty)
    const err = await expectCode(openSession(spec(box, { ompSdk: options(box, { packageRoot: empty }) })), 'launch-failed')
    expect(err.message).toContain('stderr')
    expectOwnedResourcesReleased(box)
    expect(traceOf(box)).toBe('')
  })

  test('a missing Bun binary is launch-failed with the lease released', async () => {
    const box = sandbox()
    await expectCode(openSession(spec(box, { executable: join(box.workdir, 'missing-bun') })), 'launch-failed')
    expectOwnedResourcesReleased(box)
  })

  test('the default executable is bun and the resolved spec is a frozen snapshot', async () => {
    const box = sandbox()
    const selection = options(box)
    const session = await open(box, { executable: undefined, ompSdk: selection })
    expect(session.spec.executable).toBe('bun')
    expect(session.spec.backend).toBe('sdk')
    expect(session.spec.harness).toBe('omp')
    expect(session.spec.ompSdk).toEqual(selection)
    expect(session.spec.ompSdk).not.toBe(selection)
    expect(Object.isFrozen(session.spec.ompSdk)).toBe(true)
    expect(Object.isFrozen(session.spec)).toBe(true)
  })

  test('the parent process env and cwd are untouched by an open session', async () => {
    const box = sandbox()
    const before = { agent: process.env.PI_CODING_AGENT_DIR, config: process.env.PI_CONFIG_DIR, home: process.env.HOME, cwd: process.cwd() }
    const session = await open(box)
    expect(session.spec.env).toEqual({ HOME: box.home, HARNESS_SDK_TRACE: box.trace })
    expect(process.env.PI_CODING_AGENT_DIR).toBe(before.agent)
    expect(process.env.PI_CONFIG_DIR).toBe(before.config)
    expect(process.env.HOME).toBe(before.home)
    expect(process.cwd()).toBe(before.cwd)
    await session.close()
    expect(traceOf(box)).toContain('subscribe')
  })
})

describe('close and disposal', () => {
  test('close unsubscribes and disposes once, settles the active turn, and is idempotent and concurrent-safe', async () => {
    const box = sandbox()
    const session = await open(box, { instructions: 'held' })
    expect(existsSync(join(box.workdir, LOCK))).toBe(true)
    const turn = session.startTurn('hang')
    const observed = observe(turn)
    await observed.seen('message_update')
    await Promise.all([session.close(), session.close()])
    await session.close()
    const result = await turn.result
    await observed.events
    expect(result.status).toBe('closed')
    expect(result.error).toBeNull()
    expect(session.closed).toBe(true)
    expect(() => session.startTurn('again')).toThrow(expect.objectContaining({ code: 'session-closed' }))
    expectOwnedResourcesReleased(box)
    const trace = traceOf(box)
    for (const step of ['subscribe', 'unsubscribe', 'beginDispose', 'dispose']) {
      expect(trace.split(step).length - 1).toBeGreaterThanOrEqual(1)
    }
    expect(trace.indexOf('unsubscribe')).toBeLessThan(trace.indexOf('beginDispose'))
    expect(trace.indexOf('beginDispose')).toBeLessThan(trace.lastIndexOf('dispose'))
    expect(trace.split('beginDispose').length - 1).toBe(1)
  })

  test('a failing SDK disposal surfaces from close as adapter-error after the owned teardown', async () => {
    const box = sandbox()
    const session = await open(box, { env: { HOME: box.home, HARNESS_SDK_TRACE: box.trace, HARNESS_SDK_DISPOSE_ERROR: '1' }, instructions: 'held' })
    const err = await expectCode(session.close(), 'adapter-error')
    expect(err.message).toContain('dispose')
    expect(session.closed).toBe(true)
    expectOwnedResourcesReleased(box)
    // Idempotent: the same failure is reported again, never disposal success.
    await expectCode(session.close(), 'adapter-error')
  })

  test('a session holds the workdir lease for its lifetime', async () => {
    const box = sandbox()
    const session = await open(box)
    await expectCode(openSession(spec(box)), 'instruction-conflict')
    await session.close()
    const again = await open(box)
    expect(again.closed).toBe(false)
  })
})

describe('spec validation and capabilities', () => {
  test('invalid selections are rejected before the lease, the profile or the SDK are touched', async () => {
    const box = sandbox()
    const cases: [Partial<SessionSpec>, ErrorCode][] = [
      [{ ompSdk: undefined }, 'invalid-options'],
      [{ backend: 'rpc' }, 'unsupported-backend'],
      [{ harness: 'pi' }, 'unsupported-backend'],
      [{ harness: 'pi', backend: 'rpc' }, 'invalid-options'],
      [{ harness: 'codex' }, 'unsupported-backend'],
      [{ ompSdk: options(box, { packageRoot: 'tests/helpers/omp_sdk' }) }, 'invalid-options'],
      [{ ompSdk: options(box, { agentDir: 'agent' }) }, 'invalid-options'],
      [{ ompSdk: { packageRoot: PACKAGE_ROOT, agentDir: box.agentDir } as OmpSdkOptions }, 'invalid-options'],
      [{ ompSdk: options(box, { auth: 'keychain' as OmpSdkOptions['auth'] }) }, 'invalid-options'],
      [{ env: { PI_CODING_AGENT_DIR: join(box.home, 'other') } }, 'invalid-options'],
      [{ env: { PI_CONFIG_DIR: join(box.home, 'other') } }, 'invalid-options'],
      [{ env: { OMP_PROFILE: 'other' } }, 'invalid-options'],
      [{ env: { PI_PROFILE: 'other' } }, 'invalid-options'],
      [{ ompSdk: { ...options(box), unsupported: true } as OmpSdkOptions }, 'invalid-options'],
      [{ permissionPolicy: 'bypass' }, 'unsupported-capability'],
      [{ executable: 'bin/bun' }, 'invalid-options'],
    ]
    for (const [override, code] of cases) {
      await expectCode(openSession({ ...spec(box), ...override }), code)
    }
    expectOwnedResourcesReleased(box)
    expect(readdirSync(box.agentDir)).toEqual([])
    expect(readdirSync(box.home)).toEqual([])
    expect(existsSync(box.trace)).toBe(false)
  })

  test('env entries equal to the owned profile values are accepted', async () => {
    const box = sandbox()
    const session = await open(box, { env: { HOME: box.home, HARNESS_SDK_TRACE: box.trace, PI_CODING_AGENT_DIR: box.agentDir, PI_CONFIG_DIR: box.agentDir } })
    expect(session.closed).toBe(false)
  })

  test('getSessionCapabilities reports the sdk backend for omp and keeps pi on rpc', () => {
    expect(getSessionCapabilities('omp', 'sdk')).toEqual({
      backend: 'sdk', events: true, interrupt: true, followUp: true, resume: true, concurrentTurns: false, approval: false,
    })
    expect(getSessionCapabilities('pi', 'rpc').backend).toBe('rpc')
    expect(() => getSessionCapabilities('omp')).toThrow(expect.objectContaining({ code: 'unsupported-backend' }))
    expect(() => getSessionCapabilities('omp', 'cli')).toThrow(expect.objectContaining({ code: 'unsupported-backend' }))
    expect(() => getSessionCapabilities('pi', 'sdk')).toThrow(expect.objectContaining({ code: 'unsupported-backend' }))
    expect(() => getSessionCapabilities('codex', 'sdk')).toThrow(expect.objectContaining({ code: 'unsupported-backend' }))
  })
})
