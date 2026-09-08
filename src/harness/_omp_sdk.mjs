// Optional OMP 18.1.14 embedding worker. Shared verbatim by the Python wheel
// and TypeScript package. Never imported by the Harness host process.
import { readFileSync, realpathSync } from 'node:fs'
import { join, relative } from 'node:path'
import { homedir } from 'node:os'
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'

const MAX_BYTES = 1_048_576
let session
let manager
let authStorage
let unsubscribe
let closing
let active = null
let failed = false
let disposalStarted = false
const errorText = (error) => error instanceof Error ? error.message : String(error)

// Native listeners are synchronous. Bound the pipe backlog instead of building
// an unbounded promise queue; parent-side event queues enforce their own bound.
function send(frame) {
  if (closing) return
  const line = `${JSON.stringify(frame)}\n`
  const bytes = Buffer.byteLength(line)
  if (bytes > MAX_BYTES || process.stdout.writableLength + bytes > MAX_BYTES) {
    throw new Error('OMP SDK event output exceeded the 1 MiB transport bound')
  }
  process.stdout.write(line)
}
function response(request, success, data) {
  send({ type: 'response', id: request.id, command: request.type, success,
    ...(success ? { data } : { error: errorText(data) }) })
}

async function initialize() {
  const options = JSON.parse(process.argv[2])
  const { packageRoot, agentDir, auth, cwd, model, resume } = options
  if (typeof Bun === 'undefined' || Bun.semver.order(Bun.version, '1.3.14') < 0) {
    throw new Error('OMP SDK requires Bun >=1.3.14; select executable explicitly')
  }
  const metadata = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
  if (metadata.name !== '@oh-my-pi/pi-coding-agent' || metadata.version !== '18.1.14') {
    throw new Error('OMP SDK backend is qualified for @oh-my-pi/pi-coding-agent 18.1.14 only')
  }
  const entry = metadata.exports?.['.']?.import ?? metadata.main
  if (typeof entry !== 'string') throw new Error('OMP SDK package has no import entry point')
  // OMP treats PI_CONFIG_DIR as a path joined onto HOME, not an absolute
  // override. Pin both its root and default-profile resolver before import.
  process.env.PI_CONFIG_DIR = relative(homedir(), agentDir) || '.'
  process.env.OMP_PROFILE = 'default'
  process.env.PI_PROFILE = 'default'
  const sdk = await import(pathToFileURL(join(packageRoot, entry)).href)
  // OMP's CLI-oriented postmortem handlers exit 130/143 independently of SDK
  // disposal. This dedicated process gives termination ownership to the bridge,
  // which calls the native disposal API before exiting.
  for (const signal of ['SIGINT', 'SIGTERM']) {
    for (const listener of process.listeners(signal)) {
      if (listener !== requestShutdown) process.removeListener(signal, listener)
    }
  }
  // Read settings without migration/persistence. All process-global SDK state
  // lives in this owned child. Credentials are never discovered or copied.
  const settings = await sdk.Settings.loadReadOnly({ cwd, agentDir })
  authStorage = await sdk.AuthStorage.create(auth === 'local' ? join(agentDir, 'agent.db') : ':memory:')
  await authStorage.reload()
  const modelRegistry = new sdk.ModelRegistry(authStorage, join(agentDir, 'models.yml'), {
    settings, cacheDbPath: join(agentDir, 'models.db'),
  })
  const sessionDir = sdk.SessionManager.getDefaultSessionDir(cwd, agentDir)
  manager = resume === null
    ? sdk.SessionManager.create(cwd, sessionDir)
    : await sdk.SessionManager.open(resume.sessionFile, sessionDir)
  if (resume !== null && (manager.getSessionId() !== resume.sessionId || realpathSync(manager.getCwd()) !== realpathSync(cwd))) {
    throw new Error('OMP SDK opened a different native session ID or workdir')
  }
  const created = await sdk.createAgentSession({
    cwd, agentDir, settings, authStorage, modelRegistry, sessionManager: manager,
    agentRegistry: new sdk.AgentRegistry(),
    ...(model === null ? {} : { modelPattern: model }),
  })
  session = created.session
  unsubscribe = session.subscribe((event) => {
    try { send({ type: 'sdk_event', event }) }
    catch (error) { void shutdown(error) }
  })
  if (created.modelFallbackMessage) {
    send({ type: 'sdk_event', event: { type: 'harness_model_fallback', message: created.modelFallbackMessage } })
  }
}

const opening = initialize()

function beginClosing() {
  unsubscribe?.()
  unsubscribe = undefined
  if (session && !disposalStarted) {
    disposalStarted = true
    session.beginDispose()
  }
}

function drainOutput(stream) {
  return new Promise((resolve) => {
    if (stream.destroyed) { failed = true; resolve(); return }
    stream.end((error) => {
      if (error) failed = true
      resolve()
    })
  })
}

function shutdown(error) {
  if (error) {
    failed = true
    process.stderr.write(`OMP SDK bridge: ${errorText(error)}\n`)
  }
  if (closing) return closing
  // The admission barrier and unsubscribe precede the first asynchronous drain.
  beginClosing()
  closing = (async () => {
    try {
      await opening
    } catch (startupError) {
      if (!failed) process.stderr.write(`OMP SDK bridge: ${errorText(startupError)}\n`)
      failed = true
    }
    try {
      beginClosing()
      if (session) {
        await session.dispose()
      } else if (manager) {
        await manager.close()
      }
    } catch (disposeError) {
      failed = true
      process.stderr.write(`OMP SDK disposal failed: ${errorText(disposeError)}\n`)
    } finally {
      try { authStorage?.close() }
      catch (authError) {
        failed = true
        process.stderr.write(`OMP SDK auth disposal failed: ${errorText(authError)}\n`)
      }
    }
    // Drain pipe writes before hard exit; native process-global handles may
    // otherwise keep the disposed SDK alive. The parent bounds this drain.
    await Promise.all([drainOutput(process.stdout), drainOutput(process.stderr)])
    process.exit(failed ? 1 : 0)
  })()
  return closing
}
function requestShutdown() { void shutdown() }
process.on('SIGTERM', requestShutdown)
process.on('SIGINT', requestShutdown)
process.stdout.on('error', (error) => { void shutdown(error) })
process.stderr.on('error', () => { failed = true; requestShutdown() })
const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
input.on('close', requestShutdown)

async function command(request) {
  await opening
  if (closing) return
  if (!request || typeof request.id !== 'string' || typeof request.type !== 'string') {
    throw new Error('invalid SDK bridge request')
  }
  if (request.type === 'get_state') {
    response(request, true, { sessionId: session.sessionId, sessionFile: session.sessionFile ?? null, isStreaming: session.isStreaming })
  } else if (request.type === 'prompt') {
    if (active || typeof request.message !== 'string') throw new Error('invalid or concurrent SDK prompt')
    response(request, true, {})
    active = (async () => {
      let error
      try {
        await session.prompt(request.message)
        // Includes event persistence and post-prompt recovery, unlike an
        // intermediate agent_end (isTerminal:false) or request acknowledgement.
        await session.waitForIdle()
        while (session.hasPendingAsyncWork()) {
          await session.settleAsyncWork()
        }
      } catch (cause) { error = errorText(cause) }
      active = null
      send({ type: 'sdk_settled', ...(error === undefined ? {} : { error }) })
    })()
    active.catch((error) => { void shutdown(error) })
  } else if (request.type === 'abort') {
    try {
      await session.abort()
      await active
      response(request, true, {})
    } catch (error) { response(request, false, error) }
  } else {
    throw new Error(`unsupported SDK bridge request: ${request.type}`)
  }
}
input.on('line', (line) => {
  if (closing) return
  try {
    if (Buffer.byteLength(line) > MAX_BYTES) throw new Error('SDK request exceeds 1 MiB')
    void command(JSON.parse(line)).catch((error) => shutdown(error))
  } catch (error) { void shutdown(error) }
})
opening.catch((error) => { void shutdown(error) })
