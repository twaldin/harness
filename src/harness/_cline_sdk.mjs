// Owned Node bridge for the caller-installed Cline SDK. The Harness parent
// owns shell groups; this worker never launches a replacement shell itself.
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import * as module from 'node:module'
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'

const MAX_BYTES = 1_048_576
const options = JSON.parse(process.argv[2])
let core, session, shared
let active = null
let closing = false
let shutdownPromise
let unsubscribe
let sequence = 0
const shells = new Map()
const approvals = new Map()
const describe = error => error instanceof Error ? `${error.name}: ${error.message}` : String(error)
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const samePath = (a, b) => typeof a === 'string' && typeof b === 'string' && isAbsolute(a) && isAbsolute(b) && (a === b || realpathSync(a) === realpathSync(b))

// SDK diagnostics must not enter the strict JSONL protocol.
for (const name of ['log', 'info', 'warn', 'error', 'debug']) {
  console[name] = (...values) => process.stderr.write(`${values.map(describe).join(' ')}\n`)
}
function send(frame) {
  if (closing) return
  const line = `${JSON.stringify(frame, (_key, value) => value instanceof Error ? { ...value, name: value.name, message: value.message, stack: value.stack } : value)}\n`
  const bytes = Buffer.byteLength(line)
  if (bytes > MAX_BYTES || process.stdout.writableLength + bytes > MAX_BYTES) {
    throw new Error('Cline SDK output exceeded the 1 MiB transport bound')
  }
  process.stdout.write(line)
}
function response(request, success, data) {
  send({ type: 'response', id: request.id, command: request.type, success,
    ...(success ? { data } : { error: describe(data) }) })
}
function readObject(file) {
  if (statSync(file).size > MAX_BYTES) throw new Error('Cline metadata exceeds the 1 MiB bound')
  const value = JSON.parse(readFileSync(file, 'utf8'))
  if (!object(value)) throw new Error('Cline metadata is not an object')
  return value
}
function packageEntry(root, name) {
  const metadata = readObject(join(root, 'package.json'))
  if (metadata.name !== name || metadata.version !== '0.0.82') {
    throw new Error(`Cline SDK requires ${name} 0.0.82`)
  }
  const entry = metadata.exports?.['.']?.import ?? metadata.main
  if (typeof entry !== 'string') throw new Error(`${name} has no import entry point`)
  return join(root, entry)
}
function dependencyEntry(name, parent) {
  const metadata = module.findPackageJSON(name, pathToFileURL(parent).href)
  if (!metadata) throw new Error(`Cline SDK dependency ${name} is not installed`)
  return packageEntry(dirname(metadata), name)
}

async function bash(command, cwd, context) {
  if (closing || context.signal?.aborted) throw new Error('Cline command aborted before launch')
  const direct = typeof command !== 'string' && 'args' in command
  const shell = shared.getDefaultShell(process.platform)
  const invocation = direct ? { args: command.args ?? [] } : shared.getShellInvocation(shell, typeof command === 'string' ? command : command.command)
  const cmd = [direct ? command.command : shell, ...invocation.args]
  const id = `shell-${++sequence}`
  const cancel = () => send({ type: 'shell_cancel', id })
  try {
    return await new Promise((resolve, reject) => {
      shells.set(id, { resolve, reject, context })
      context.signal?.addEventListener('abort', cancel, { once: true })
      send({ type: 'shell_request', id, cmd, cwd, stdin: invocation.input ?? null })
      if (context.signal?.aborted) cancel()
    })
  } finally {
    context.signal?.removeEventListener('abort', cancel)
    shells.delete(id)
  }
}
function requestApproval(request) {
  if (closing) return { approved: false, reason: 'Session closing' }
  const id = `permission-${++sequence}`
  return new Promise(resolve => {
    approvals.set(id, resolve)
    send({ type: 'sdk_event', event: { type: 'cline_permission', id, request } })
  })
}
function cancelApprovals() {
  for (const [id, resolve] of approvals) {
    resolve({ approved: false, reason: 'Session interrupted' })
    send({ type: 'sdk_event', event: { type: 'cline_permission_cancelled', id } })
  }
  approvals.clear()
}

async function initialize() {
  const [major, minor] = process.versions.node.split('.').map(Number)
  if (typeof Bun !== 'undefined' || major < 22 || major === 22 && minor < 14 || typeof module.findPackageJSON !== 'function') {
    throw new Error('Cline SDK bridge requires Node >=22.14; select executable explicitly')
  }
  if (options.features !== 'builtin-only') throw new Error('Cline SDK supports only explicit builtin-only features')
  if (!['upstream', 'callback'].includes(options.approval)) throw new Error('Unsupported Cline approval selection')
  for (const name of ['packageRoot', 'configDir', 'cwd', 'tempDir']) {
    if (typeof options[name] !== 'string' || !isAbsolute(options[name])) throw new Error(`Cline ${name} must be absolute`)
  }
  // Every native storage override is confined to the selected profile. In
  // particular, the local host's detached-log recovery must see only our temp.
  const data = join(options.configDir, 'data')
  for (const name of Object.keys(process.env)) {
    if (name.startsWith('CLINE_') && (name.endsWith('_DIR') || name.endsWith('_PATH'))) delete process.env[name]
  }
  Object.assign(process.env, {
    CLINE_DIR: options.configDir, CLINE_DATA_DIR: data,
    CLINE_SESSION_DATA_DIR: join(data, 'sessions'), CLINE_DB_DATA_DIR: join(data, 'db'),
    CLINE_SESSION_BACKEND_MODE: 'local', CLINE_NO_AUTO_UPDATE: '1', CLINE_RUN_AS_HUB_DAEMON: '0',
    TMPDIR: options.tempDir,
  })
  const entry = packageEntry(options.packageRoot, '@cline/sdk')
  const coreEntry = dependencyEntry('@cline/core', entry)
  const sharedEntry = dependencyEntry('@cline/shared', coreEntry)
  dependencyEntry('@cline/agents', coreEntry)
  dependencyEntry('@cline/llms', coreEntry)
  const sdk = await import(pathToFileURL(entry).href)
  shared = await import(pathToFileURL(sharedEntry).href)
  // Explicit identity avoids upstream machine-id discovery or persistence.
  core = await sdk.ClineCore.create({ backendMode: 'local', distinctId: 'harness',
    ...(options.approval === 'callback' ? { toolPolicies: { '*': { autoApprove: false } } } : {}),
    capabilities: { toolExecutors: { bash }, ...(options.approval === 'callback' ? { requestToolApproval: requestApproval } : {}) },
  })
  const settings = new sdk.ProviderSettingsManager({ filePath: sdk.resolveProviderSettingsPath() })
  const stored = settings.getProviderSettings(options.provider)
  const model = options.model ?? stored?.model
  if (typeof model !== 'string' || !model.trim()) throw new Error('Select a Cline model explicitly or in the selected provider profile')
  let manifest, initialMessages, initialCompactionState
  const resume = options.resume
  if (resume !== null) {
    if (!/^[0-9A-Za-z_-]+$/.test(resume.sessionId)) throw new Error('Invalid full native Cline session ID')
    const expected = join(data, 'sessions', resume.sessionId, `${resume.sessionId}.json`)
    if (!samePath(expected, resume.sessionFile)) throw new Error('Cline resume manifest is outside the selected session profile')
    manifest = readObject(resume.sessionFile)
    if (manifest.session_id !== resume.sessionId || !samePath(manifest.cwd, options.cwd) || !samePath(manifest.workspace_root, options.cwd)) {
      throw new Error('Cline resume manifest has a different native ID or workdir')
    }
    if (manifest.enable_spawn !== false || manifest.enable_teams !== false || manifest.status === 'running' || manifest.provider !== options.provider || manifest.model !== model) {
      throw new Error('Cline resume profile, model or active-session state is unsupported')
    }
    const record = await core.get(resume.sessionId)
    if (!record || record.sessionId !== resume.sessionId || !samePath(record.cwd, options.cwd) || !samePath(record.workspaceRoot, options.cwd) || record.isSubagent || record.parentSessionId) throw new Error('Unknown or inconsistent native Cline root session record')
    const messagesPath = join(dirname(expected), `${resume.sessionId}.messages.json`)
    if (!samePath(manifest.messages_path, messagesPath) || !samePath(record.messagesPath, messagesPath)) throw new Error('Cline resume messages are outside the selected session')
    const messageFile = readObject(messagesPath)
    if (messageFile.sessionId !== resume.sessionId || messageFile.agent !== 'lead' || !Array.isArray(messageFile.messages) || messageFile.messages.length === 0) throw new Error('Cline resume requires readable nonempty native root history')
    initialMessages = messageFile.messages
    initialCompactionState = await core.readSessionCompactionState(resume.sessionId)
  }
  unsubscribe = core.subscribe(event => {
    try { send({ type: 'sdk_event', event }) } catch (error) { void shutdown(error) }
  })
  session = await core.start({ interactive: true,
    // No prompt on start: otherwise upstream can overwrite a resumed manifest.
    ...(resume === null ? {} : { initialMessages, initialCompactionState }),
    localRuntime: { configExtensions: [] },
    config: {
      ...(resume === null ? {} : { sessionId: resume.sessionId }),
      cwd: options.cwd, workspaceRoot: options.cwd, providerId: options.provider, modelId: model,
      ...(process.env.CLINE_API_KEY ? { apiKey: process.env.CLINE_API_KEY } : {}),
      systemPrompt: sdk.getClineDefaultSystemPrompt({ rootPath: options.cwd, providerId: options.provider, planModeSwitchTool: false }),
      enableTools: true, enableSpawnAgent: false, enableAgentTeams: false, disableMcpSettingsTools: true,
      checkpoint: { enabled: false },
    },
  })
  if (!session || !samePath(session.manifest.cwd, options.cwd) || !samePath(session.manifest.workspace_root, options.cwd) || resume !== null && session.sessionId !== resume.sessionId) {
    throw new Error('Cline started a different native session or workdir')
  }
  const expected = join(data, 'sessions', session.sessionId, `${session.sessionId}.json`)
  if (!samePath(session.manifestPath, expected)) throw new Error('Cline selected an unexpected native manifest location')
}

function shellFrame(frame) {
  const pending = shells.get(frame.id)
  if (!pending) throw new Error('Unknown Cline shell response ID')
  if (frame.type === 'shell_output') {
    if (!['stdout', 'stderr'].includes(frame.stream) || typeof frame.chunk !== 'string') throw new Error('Malformed Cline shell output')
    pending.context.emitUpdate?.({ stream: frame.stream, chunk: frame.chunk })
  } else {
    if (typeof frame.output !== 'string' || frame.error !== undefined && typeof frame.error !== 'string') throw new Error('Malformed Cline shell result')
    shells.delete(frame.id)
    frame.error === undefined ? pending.resolve(frame.output) : pending.reject(new Error(`${frame.error}\n${frame.output}`))
  }
}
async function command(request) {
  if (!object(request) || typeof request.id !== 'string' || typeof request.type !== 'string') throw new Error('Malformed Cline worker request')
  if (request.type === 'shell_output' || request.type === 'shell_result') { shellFrame(request); return }
  await opening
  if (closing) return
  if (request.type === 'get_state') {
    response(request, true, { sessionId: session.sessionId, sessionFile: session.manifestPath, workdir: session.manifest.cwd, isStreaming: active !== null })
  } else if (request.type === 'prompt') {
    if (active || typeof request.message !== 'string') throw new Error('Invalid or concurrent Cline prompt')
    response(request, true, {})
    active = (async () => {
      let result, error
      try {
        const prompt = options.instructions ? `Follow the instructions in @./CLINE.md\n\n${request.message}` : request.message
        result = await core.send({ sessionId: session.sessionId, prompt })
        if (!object(result)) throw new Error('Cline returned no native turn result')
      } catch (cause) { error = describe(cause) }
      active = null
      cancelApprovals()
      send({ type: 'sdk_settled', ...(error === undefined ? { result } : { error }) })
    })()
    active.catch(error => { void shutdown(error) })
  } else if (request.type === 'abort') {
    try { cancelApprovals(); await core.abort(session.sessionId); await active; response(request, true, {}) }
    catch (error) { response(request, false, error) }
  } else if (request.type === 'approval') {
    const resolve = approvals.get(request.approvalId)
    if (!resolve || !['once', 'reject'].includes(request.response)) { response(request, false, 'Unknown or invalid Cline approval'); return }
    approvals.delete(request.approvalId)
    resolve({ approved: request.response === 'once', ...(request.response === 'reject' ? { reason: 'Rejected by Harness caller' } : {}) })
    response(request, true, {})
  } else throw new Error(`Unsupported Cline worker request: ${request.type}`)
}
function drain(stream) {
  return new Promise(resolve => { if (stream.destroyed) resolve(); else stream.write('', resolve) })
}
function shutdown(error) {
  if (shutdownPromise) return shutdownPromise
  closing = true
  unsubscribe?.()
  shutdownPromise = (async () => {
    let failed = Boolean(error)
    if (error) process.stderr.write(`Cline SDK bridge: ${describe(error)}\n`)
    cancelApprovals()
    for (const pending of shells.values()) pending.reject(new Error('Cline session closing'))
    shells.clear()
    try { await opening } catch (cause) { failed = true; if (!error) process.stderr.write(`Cline startup: ${describe(cause)}\n`) }
    try { unsubscribe?.(); await core?.dispose(); await active } catch (cause) { failed = true; process.stderr.write(`Cline disposal: ${describe(cause)}\n`) }
    await Promise.all([drain(process.stdout), drain(process.stderr)])
    process.exit(failed ? 1 : 0)
  })()
  return shutdownPromise
}
const opening = initialize()
opening.catch(error => { void shutdown(error) })
const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
input.on('line', line => {
  if (closing) return
  try {
    if (Buffer.byteLength(line) > MAX_BYTES) throw new Error('Cline worker request exceeds 1 MiB')
    void command(JSON.parse(line)).catch(error => shutdown(error))
  } catch (error) { void shutdown(error) }
})
input.on('close', () => { void shutdown() })
process.on('SIGTERM', () => { void shutdown() })
process.on('SIGINT', () => { void shutdown() })
