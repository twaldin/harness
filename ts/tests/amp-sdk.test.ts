import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { HarnessError } from '../src/base.js'
import type { ErrorCode } from '../src/base.js'
import { getSessionCapabilities, openSession } from '../src/sessions.js'
import type { AmpSdkOptions, LiveSession, SessionEvent, SessionSpec, SessionTurn, SessionTurnStatus } from '../src/sessions.js'
import '../src/adapters/index.js'

// The `amp` / `sdk` backend runs the shared worker ../../src/harness/_amp_sdk.mjs
// under Node (one finite process group per operation) against the synthetic
// @ampcode/sdk package in ../../tests/helpers/amp_sdk and the synthetic CLI
// ../../tests/helpers/amp_cli.mjs, both selected explicitly, never installed.
// The synthetic CLI picks its behaviour from the prompt text and keeps its
// thread state in the disposable workdir; ../../tests/amp_sdk_cases.json lists
// the shared prompt → status expectations that tests/test_amp_sdk.py mirrors.

const ROOT = resolve(import.meta.dir, '../..')
const PACKAGE_ROOT = join(ROOT, 'tests/helpers/amp_sdk')
const CLI_PATH = join(ROOT, 'tests/helpers/amp_cli.mjs')
const LOCK = '.harness-run.lock'
const ENDPOINT = 'https://ampcode.com'

interface SharedCase {
  name: string
  prompt: string
  status: SessionTurnStatus
  exitCode?: number
  rawType?: string
}

interface Fixture {
  sessionId: string
  sdkVersion: string
  cliVersion: string
  cases: SharedCase[]
}

const FIXTURE: Fixture = JSON.parse(readFileSync(join(ROOT, 'tests/amp_sdk_cases.json'), 'utf-8'))
const THREAD = FIXTURE.sessionId

const dirs: string[] = []
const sessions: LiveSession[] = []

/** One isolated tree per session: workdir (where the synthetic thread state lives) and HOME. */
interface Sandbox {
  workdir: string
  home: string
}

function sandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), 'harness-amp-sdk-'))
  dirs.push(root)
  const box = { workdir: join(root, 'work'), home: join(root, 'home') }
  mkdirSync(box.workdir)
  mkdirSync(box.home)
  return box
}

function options(extra: Partial<AmpSdkOptions> = {}): AmpSdkOptions {
  return { packageRoot: PACKAGE_ROOT, cliPath: CLI_PATH, executor: 'local', mode: 'low', ...extra }
}

function spec(box: Sandbox, extra: Partial<SessionSpec> = {}): SessionSpec {
  return {
    harness: 'amp',
    backend: 'sdk',
    workdir: box.workdir,
    ampSdk: options(),
    env: { HOME: box.home },
    timeoutSeconds: 8,
    requestTimeoutSeconds: 8,
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

function expectOwnedResourcesReleased(box: Sandbox): void {
  expect(existsSync(join(box.workdir, LOCK))).toBe(false)
  expect(existsSync(join(box.workdir, 'AGENTS.md'))).toBe(false)
}

/** Every event of a turn carries the session identity and the exact native object, never a worker envelope. */
function expectNativeEvents(events: SessionEvent[], turnId: string): void {
  for (const event of events) {
    expect(event.backend).toBe('sdk')
    expect(event.harness).toBe('amp')
    expect(event.sessionId).toBe(THREAD)
    expect(event.turnId).toBe(turnId)
    expect(event.requestId).toBeNull()
    expect(event.type.startsWith('amp_')).toBe(false)
    expect(event.raw.type).toBe(event.type)
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/** The synthetic CLI writes its grandchild marker after the last event we can await; nothing else signals it, so poll the file. */
async function until(check: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (check()) return true
    await new Promise((done) => setTimeout(done, 20))
  }
  return check()
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

  for (const scenario of FIXTURE.cases) {
    test(`${scenario.name}: "${scenario.prompt}" → ${scenario.status}`, async () => {
      const box = sandbox()
      const session = await open(box, { requestTimeoutSeconds: 3 })
      expect(session.reference).toEqual({ sessionId: THREAD, sessionFile: null, workdir: box.workdir, endpoint: ENDPOINT })
      const turn = session.startTurn(scenario.prompt)
      const events = await collect(turn)
      const result = await turn.result
      expect(result.status).toBe(scenario.status)
      expect(result.sessionId).toBe(THREAD)
      expect(result.turnId).toBe(turn.id)
      if (scenario.exitCode !== undefined) expect(result.exitCode).toBe(scenario.exitCode)
      if (scenario.rawType !== undefined) expect(result.raw?.type).toBe(scenario.rawType)
      expectNativeEvents(events, turn.id)
      // Native protocol violations invalidate the session; native completion, agent errors and CLI exits settle the turn only.
      expect(session.closed).toBe(scenario.status === 'protocol-error')
      if (scenario.status !== 'protocol-error') expect(session.active).toBeNull()
      await session.close()
      expectOwnedResourcesReleased(box)
    }, 10_000)
  }
})

describe('turn semantics', () => {
  test('follow-up turns continue the same thread and expose the native result and usage untouched', async () => {
    const box = sandbox()
    const session = await open(box)
    const first = session.startTurn('success')
    expect(session.active?.id).toBe('turn-1')
    const events = await collect(first)
    expect(events.map((event) => event.type)).toEqual(['system', 'assistant', 'future_event', 'result'])
    expect(events[2]?.raw).toEqual({ type: 'future_event', session_id: THREAD, value: 17 })
    const result = await first.result
    expect(result.status).toBe('completed')
    expect(result.error).toBeNull()
    expect(result.raw?.result).toBe('synthetic turn 1')
    expect(result.raw?.usage).toEqual({ input_tokens: null, output_tokens: 2, max_tokens: 123, cache_creation: { ephemeral_5m_input_tokens: 4 } })
    expect(result.exitCode).toBe(0)
    expect(result.signal).toBeNull()
    expect(result.eventsTruncated).toBe(false)
    expect(session.active).toBeNull()

    const second = session.startTurn('success')
    expect(second.id).toBe('turn-2')
    await collect(second)
    expect((await second.result).raw?.result).toBe('synthetic turn 2')
    expect(session.reference.sessionId).toBe(THREAD)
  })

  test('agent errors keep the native result and the session', async () => {
    const box = sandbox()
    const session = await open(box)
    const turn = session.startTurn('agent-error')
    await collect(turn)
    const result = await turn.result
    expect(result.status).toBe('agent-error')
    expect(result.error).toBe('synthetic native rejection')
    expect(result.raw?.subtype).toBe('error_during_execution')
    expect(session.closed).toBe(false)
    const next = session.startTurn('success')
    await collect(next)
    expect((await next.result).status).toBe('completed')
  })

  test('the turn result carries the CLI exit the worker observed and this turn\'s worker stderr', async () => {
    const box = sandbox()
    const session = await open(box, { maxBufferBytes: 1024 })
    const turn = session.startTurn('stderr')
    const consumed = collect(turn)
    const result = await turn.result
    await consumed
    expect(result.status).toBe('completed')
    expect(result.stderr.startsWith('synthetic-stderr\n')).toBe(true)
    expect(result.stderrBytes).toBe('synthetic-stderr\n'.length * 100)
    expect(result.stderrTruncated).toBe(true)
    const quiet = session.startTurn('success')
    await collect(quiet)
    expect((await quiet.result).stderrBytes).toBe(0)
  })

  test('concurrent turns and prompts are rejected without touching the thread', async () => {
    const box = sandbox()
    const session = await open(box)
    const turn = session.startTurn('hang')
    const watching = observe(turn)
    await watching.seen('assistant')
    expect(() => session.startTurn('success')).toThrow(expect.objectContaining({ code: 'unsupported-capability' }))
    expect(() => session.startTurn('')).toThrow(expect.objectContaining({ code: 'invalid-options' }))
    await expectCode(session.respondApproval('per_x', 'once'), 'unsupported-capability')
    await session.interrupt()
    expect((await turn.result).status).toBe('interrupted')
    await watching.events
  })
})

describe('interrupt', () => {
  test('interrupt stops the worker group, settles as interrupted and keeps the thread for the next turn', async () => {
    const box = sandbox()
    const session = await open(box)
    const turn = session.startTurn('child-hang')
    const watching = observe(turn)
    await watching.seen('assistant')
    const marker = join(box.workdir, '.amp-synthetic-child.json')
    expect(await until(() => existsSync(marker), 3000)).toBe(true)
    const { pid, parent }: { pid: number; parent: number } = JSON.parse(readFileSync(marker, 'utf-8'))
    expect(pidAlive(parent)).toBe(true)
    await session.interrupt()
    const result = await turn.result
    expect(result.status).toBe('interrupted')
    expect(result.error).toBeNull()
    expect(result.raw).toBeNull()
    expect(result.exitCode).toBeNull()
    expect((await watching.events).map((event) => event.type)).toEqual(['system', 'assistant'])
    expect(pidAlive(parent)).toBe(false)
    expect(pidAlive(pid)).toBe(false)
    expect(session.closed).toBe(false)
    const next = session.startTurn('success')
    await collect(next)
    const followUp = await next.result
    expect(followUp.status).toBe('completed')
    expect(followUp.sessionId).toBe(THREAD)
    expect(followUp.raw?.result).toBe('synthetic turn 2')
  })

  test('interrupt without an active turn and after close are rejected', async () => {
    const box = sandbox()
    const session = await open(box)
    await expectCode(session.interrupt(), 'unsupported-capability')
    await session.close()
    await expectCode(session.interrupt(), 'session-closed')
  })
})

describe('deadlines and buffering', () => {
  // Real 1 s deadline on purpose: the runner's wall clock and group teardown run against the platform clock.
  test('the turn wall deadline tears the worker down and invalidates the session', async () => {
    const box = sandbox()
    const session = await open(box, { timeoutSeconds: 1 })
    const turn = session.startTurn('hang')
    const events = collect(turn)
    const result = await turn.result
    expect(result.status).toBe('timed-out')
    expect(result.error).toContain('timeoutSeconds (1)')
    await events
    expect(session.closed).toBe(true)
    expect(() => session.startTurn('success')).toThrow(expect.objectContaining({ code: 'session-closed' }))
    await session.close()
    expectOwnedResourcesReleased(box)
  })

  test('unconsumed events beyond maxBufferBytes fail the turn as a protocol error', async () => {
    const box = sandbox()
    const session = await open(box, { maxBufferBytes: 4096 })
    const turn = session.startTurn('overflow')
    const result = await turn.result
    expect(result.status).toBe('protocol-error')
    expect(result.eventsTruncated).toBe(true)
    expect(result.error).toContain('maxBufferBytes (4096)')
    const events = await collect(turn)
    expect(events.length).toBeGreaterThan(0)
    expect(session.closed).toBe(true)
  })

  test('a stopped consumer keeps the bounded queue semantics; the worker still completes', async () => {
    const box = sandbox()
    const session = await open(box)
    const turn = session.startTurn('success')
    const iterator = turn.events[Symbol.asyncIterator]()
    expect((await iterator.next()).value?.type).toBe('system')
    expect((await turn.result).status).toBe('completed')
    expect(() => turn.events[Symbol.asyncIterator]()).toThrow(expect.objectContaining({ code: 'unsupported-capability' }))
    const rest: string[] = []
    for (;;) {
      const item = await iterator.next()
      if (item.done) break
      rest.push(item.value.type)
    }
    expect(rest).toEqual(['assistant', 'future_event', 'result'])
  })
})

describe('open and resume', () => {
  test('open creates the thread through the SDK and projects instructions for the session lifetime', async () => {
    const box = sandbox()
    const session = await open(box, { instructions: 'Be brief.' })
    expect(readFileSync(join(box.workdir, 'AGENTS.md'), 'utf-8')).toBe('Be brief.')
    expect(existsSync(join(box.workdir, LOCK))).toBe(true)
    const state: { id: string; turns: number; visibility: string | null } = JSON.parse(readFileSync(join(box.workdir, '.amp-synthetic-thread.json'), 'utf-8'))
    expect(state).toEqual({ id: THREAD, turns: 0, visibility: null })
    await session.close()
    expectOwnedResourcesReleased(box)
  })

  test('visibility is applied at creation only', async () => {
    const box = sandbox()
    const session = await open(box, { ampSdk: options({ visibility: 'workspace' }) })
    const state: { visibility: string | null } = JSON.parse(readFileSync(join(box.workdir, '.amp-synthetic-thread.json'), 'utf-8'))
    expect(state.visibility).toBe('workspace')
    const reference = session.reference
    await session.close()
    await expectCode(openSession(spec(box, { ampSdk: options({ visibility: 'workspace' }), resume: reference })), 'invalid-options')
  })

  test('close then resume continues the exact thread after verifying it through the SDK', async () => {
    const box = sandbox()
    const first = await open(box)
    const reference = first.reference
    const turn = first.startTurn('success')
    await collect(turn)
    await first.close()
    expectOwnedResourcesReleased(box)

    const second = await open(box, { resume: reference })
    expect(second.reference).toEqual(reference)
    const next = second.startTurn('success')
    const events = await collect(next)
    expectNativeEvents(events, 'turn-1')
    expect((await next.result).raw?.result).toBe('synthetic turn 2')
  })

  test('resuming a thread the SDK cannot verify rejects with the native failure and releases the lease', async () => {
    const box = sandbox()
    const err = await expectCode(openSession(spec(box, {
      resume: { sessionId: 'T-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', sessionFile: null, workdir: box.workdir, endpoint: ENDPOINT },
    })), 'launch-failed')
    expect(err.message).toContain('exited with code 3')
    expectOwnedResourcesReleased(box)
  })

  test('a workdir lease held by another run rejects before any worker starts', async () => {
    const box = sandbox()
    mkdirSync(join(box.workdir, LOCK))
    await expectCode(openSession(spec(box)), 'instruction-conflict')
    expect(existsSync(join(box.workdir, '.amp-synthetic-thread.json'))).toBe(false)
  })
})

describe('missing dependencies', () => {
  test('a package root without the qualified SDK fails open explicitly', async () => {
    const box = sandbox()
    const err = await expectCode(openSession(spec(box, { ampSdk: options({ packageRoot: box.home }) })), 'launch-failed')
    expect(err.message).toContain('package.json')
    expectOwnedResourcesReleased(box)
  })

  test('a CLI that does not report the pinned version fails open explicitly', async () => {
    const box = sandbox()
    const err = await expectCode(openSession(spec(box, { ampSdk: options({ cliPath: join(box.home, 'missing-amp.mjs') }) })), 'launch-failed')
    expect(err.message).toContain('Amp SDK requires CLI')
    expectOwnedResourcesReleased(box)
  })

  test('a missing worker runtime fails open explicitly', async () => {
    const box = sandbox()
    const err = await expectCode(openSession(spec(box, { executable: join(box.home, 'no-such-node') })), 'launch-failed')
    expect(err.message).toContain('ENOENT')
    expectOwnedResourcesReleased(box)
  })
})

describe('close', () => {
  test('close during a turn settles it as closed and stops the worker group', async () => {
    const box = sandbox()
    const session = await open(box)
    const turn = session.startTurn('hang')
    const watching = observe(turn)
    await watching.seen('assistant')
    await Promise.all([session.close(), session.close()])
    expect((await turn.result).status).toBe('closed')
    await watching.events
    expect(session.closed).toBe(true)
    expectOwnedResourcesReleased(box)
  })

  test('the idle event stream ends on close', async () => {
    const box = sandbox()
    const session = await open(box)
    const idle = (async () => {
      const events: SessionEvent[] = []
      for await (const event of session.events) events.push(event)
      return events
    })()
    await session.close()
    expect(await idle).toEqual([])
  })
})

describe('spec validation and capabilities', () => {
  test('invalid selections are rejected before the lease or the worker are touched', async () => {
    const box = sandbox()
    const cases: [Partial<SessionSpec>, ErrorCode][] = [
      [{ ampSdk: undefined }, 'invalid-options'],
      [{ backend: 'rpc' }, 'unsupported-backend'],
      [{ harness: 'omp' }, 'invalid-options'],
      [{ harness: 'codex' }, 'unsupported-backend'],
      [{ model: 'gpt-5' }, 'invalid-options'],
      [{ ompSdk: { packageRoot: '/x', agentDir: '/y', auth: 'environment' } }, 'invalid-options'],
      [{ ampSdk: options({ packageRoot: 'tests/helpers/amp_sdk' }) }, 'invalid-options'],
      [{ ampSdk: options({ cliPath: 'amp' }) }, 'invalid-options'],
      [{ ampSdk: options({ executor: 'remote' as AmpSdkOptions['executor'] }) }, 'invalid-options'],
      [{ ampSdk: options({ mode: '  ' }) }, 'invalid-options'],
      [{ ampSdk: options({ effort: 'huge' as AmpSdkOptions['effort'] }) }, 'invalid-options'],
      [{ ampSdk: options({ visibility: 'public' as AmpSdkOptions['visibility'] }) }, 'invalid-options'],
      [{ ampSdk: options({ settingsFile: 'settings.json' }) }, 'invalid-options'],
      [{ ampSdk: { ...options(), model: 'x' } as AmpSdkOptions }, 'invalid-options'],
      [{ ampSdk: { packageRoot: PACKAGE_ROOT, cliPath: CLI_PATH, executor: 'local' } as AmpSdkOptions }, 'invalid-options'],
      [{ env: { AMP_SKIP_UPDATE_CHECK: '0' } }, 'invalid-options'],
      [{ env: { AMP_URL: 'https://ampcode.com/threads' } }, 'invalid-options'],
      [{ env: { AMP_URL: 'ampcode.com' } }, 'invalid-options'],
      [{ resume: { sessionId: THREAD, sessionFile: null, workdir: box.workdir } }, 'invalid-options'],
      [{ resume: { sessionId: THREAD, sessionFile: null, workdir: box.workdir, endpoint: 'https://other.example' } }, 'invalid-options'],
      [{ resume: { sessionId: THREAD, sessionFile: join(box.home, 'thread.json'), workdir: box.workdir, endpoint: ENDPOINT } }, 'invalid-options'],
      [{ resume: { sessionId: 'T-11111111', sessionFile: null, workdir: box.workdir, endpoint: ENDPOINT } }, 'invalid-options'],
      [{ resume: { sessionId: 'T-AAAAAAAA-bbbb-4ccc-8ddd-eeeeeeeeeeee', sessionFile: null, workdir: box.workdir, endpoint: ENDPOINT } }, 'invalid-options'],
      [{ resume: { sessionId: THREAD, sessionFile: null, workdir: box.home, endpoint: ENDPOINT } }, 'invalid-options'],
      [{ permissionPolicy: 'bypass' }, 'unsupported-capability'],
      [{ executable: 'bin/node' }, 'invalid-options'],
    ]
    for (const [override, code] of cases) {
      await expectCode(openSession({ ...spec(box), ...override }), code)
    }
    expectOwnedResourcesReleased(box)
    expect(existsSync(join(box.workdir, '.amp-synthetic-thread.json'))).toBe(false)
  })

  test('the endpoint follows AMP_URL from the session env, normalized to its origin', async () => {
    const box = sandbox()
    const session = await open(box, {
      env: { HOME: box.home, AMP_URL: 'HTTPS://AMPCODE.COM:443/', AMP_SKIP_UPDATE_CHECK: '1' },
    })
    expect(session.reference.endpoint).toBe(ENDPOINT)
    const reference = session.reference
    await session.close()
    const resumed = await open(box, { env: { HOME: box.home, AMP_URL: 'https://ampcode.com/' }, resume: reference })
    expect(resumed.reference).toEqual(reference)
  })

  test('getSessionCapabilities reports the sdk backend for amp without approval', () => {
    expect(getSessionCapabilities('amp', 'sdk')).toEqual({
      backend: 'sdk', events: true, interrupt: true, followUp: true, resume: true, concurrentTurns: false, approval: false,
    })
    expect(() => getSessionCapabilities('amp')).toThrow(expect.objectContaining({ code: 'unsupported-backend' }))
    expect(() => getSessionCapabilities('amp', 'cli')).toThrow(expect.objectContaining({ code: 'unsupported-backend' }))
    expect(() => getSessionCapabilities('amp', 'rpc')).toThrow(expect.objectContaining({ code: 'unsupported-backend' }))
  })
})
