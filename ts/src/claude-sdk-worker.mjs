// Optional Claude Agent SDK 0.3.263 worker for the `claude-code` live session
// backend. Runs under Node (default) or Bun, is spawned by the host as
// `<runtime> [--no-env-file] claude-sdk-worker.mjs <options JSON>` and is
// never imported by the host process. Copied beside the bundle at build time.
//
// The worker drives one `query` with streaming input against the
// caller-selected Claude Code 2.1.263 executable and speaks the host's JSONL
// framing: requests `get_state` / `prompt` / `abort` / `approval` answered by
// `{type:'response'}`, native SDK messages forwarded verbatim as
// `{type:'sdk_event', event}`, exactly one `{type:'sdk_settled', result}` per
// prompt, `{type:'sdk_reference'}` once a native hook reported the transcript
// and `{type:'sdk_failure'}` for fatal native failures. The SDK keeps control
// of the native process and its control protocol; the worker only bridges
// the permission callback, the identity hooks and the interrupt receipt.
import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { createInterface } from 'node:readline'
import { Transform } from 'node:stream'
import { pathToFileURL } from 'node:url'

const SDK_NAME = '@anthropic-ai/claude-agent-sdk'
const SDK_VERSION = '0.3.263'
const CLI_VERSION = '2.1.263'
const MAX_BYTES = 1_048_576
const LF = 0x0a
const CR = 0x0d
const VERSION_PROBE_MS = 10_000
/** Disposal budget below the host's 500 ms grace, so a clean stop exits before the group is killed. */
const DISPOSE_MS = 400
/** How long the native exit may trail its output EOF before the failure is classified as a disconnect. */
const NATIVE_EXIT_WAIT_MS = 250
const REJECT_MESSAGE = 'Rejected by the harness caller via respond_approval'

let options
let query
/** Owned native child once the SDK spawned it: `{child, exit: {code, signal} | null}`. */
let native = null
/** Selected (or resumed) identity; `sessionFile` fills in from the first native hook. */
let reference = null
/** The prompt in flight: `{settle, done}`; settled by its native `result`. */
let active = null
/** Pending `canUseTool` callbacks by bridge approval ID. */
const approvals = new Map()
let approvalSeq = 0
let closing
let failed = false
let failure = null
/** Native stdout frame under validation: retained fragments and their byte total. */
const frame = { parts: [], bytes: 0 }
const errorText = (error) => error instanceof Error ? error.message : String(error)
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

// ---- host framing ----

// Bound the pipe backlog instead of building an unbounded promise queue; the
// host's event queues enforce their own bound.
function emit(payload) {
  const line = `${JSON.stringify(payload)}\n`
  const bytes = Buffer.byteLength(line)
  if (bytes > MAX_BYTES || process.stdout.writableLength + bytes > MAX_BYTES) {
    throw new Error('Claude SDK worker output exceeded the 1 MiB transport bound')
  }
  process.stdout.write(line)
}
function send(payload) {
  if (closing || failure !== null) return
  emit(payload)
}
function response(request, success, data) {
  send({ type: 'response', id: request.id, command: request.type, success,
    ...(success ? { data } : { error: errorText(data) }) })
}

/** Report a fatal native failure once and dispose; the host adopts `status` and keeps everything already queued. */
function fail(status, error, raw) {
  if (closing || failure !== null) return
  failure = { status, error }
  try {
    emit({ type: 'sdk_failure', status, error, ...(raw === undefined ? {} : { raw }) })
  } catch (outputError) {
    failed = true
    process.stderr.write(`Claude SDK worker: ${errorText(outputError)}\n`)
  }
  void shutdown()
}

// ---- paths ----

function realpathOrSelf(path) {
  try { return realpathSync(path) } catch { return path }
}
/** Raw equality or equality after symlink resolution on both sides (macOS records `/private/tmp` for `/tmp`). */
function samePath(a, b) {
  return a === b || realpathOrSelf(a) === realpathOrSelf(b)
}

// ---- native stdout validation ----

// The SDK transport drops non-JSON stdout lines silently; the host contract
// treats them (and unterminated trailing frames and frames beyond 1 MiB) as protocol errors.
// Forward valid native messages here, in wire order, before a later malformed
// line can fail the session. The SDK still owns control routing and callbacks.
function checkLine(line) {
  if (line.length > 0 && line[line.length - 1] === CR) line = line.subarray(0, line.length - 1)
  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(line)
  } catch (error) {
    fail('protocol-error', `native stdout line is not strict UTF-8: ${errorText(error)}`)
    return
  }
  if (text.trim() === '') return
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    fail('protocol-error', `native stdout line is not JSON: ${errorText(error)}`)
    return
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail('protocol-error', 'native stdout line is not a JSON object')
    return
  }
  if (parsed.type !== 'control_request' && parsed.type !== 'control_response'
    && parsed.type !== 'control_cancel_request' && parsed.type !== 'keep_alive') {
    onMessage(parsed)
  }
}
function scan(chunk) {
  if (failure !== null || closing) return
  let from = 0
  while (from < chunk.length) {
    const at = chunk.indexOf(LF, from)
    if (at === -1) {
      frame.bytes += chunk.length - from
      if (frame.bytes > MAX_BYTES) {
        fail('protocol-error', `native stdout frame exceeds ${MAX_BYTES} bytes`)
        return
      }
      frame.parts.push(chunk.subarray(from))
      return
    }
    let line = chunk.subarray(from, at)
    if (frame.parts.length > 0) {
      frame.parts.push(line)
      line = Buffer.concat(frame.parts)
      frame.parts.length = 0
    }
    frame.bytes = 0
    from = at + 1
    if (line.length > MAX_BYTES) {
      fail('protocol-error', `native stdout frame exceeds ${MAX_BYTES} bytes`)
      return
    }
    checkLine(line)
    if (failure !== null) return
  }
}
function scanEnd() {
  if (failure !== null || closing || frame.parts.length === 0) return
  if (Buffer.concat(frame.parts).toString('utf8').trim() !== '') {
    fail('protocol-error', 'native stdout ended inside an unterminated frame')
  }
}

/** The SDK's supported spawn hook; retain native messages before handing the same stream to its control router. */
function spawnNative({ command, args, cwd, env, signal }) {
  const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'inherit'], signal, windowsHide: true })
  native = { child, exit: null }
  child.once('exit', (code, exitSignal) => { native.exit = { code, signal: exitSignal } })
  const tap = new Transform({
    transform(chunk, _encoding, callback) {
      scan(chunk)
      callback(null, chunk)
    },
    flush(callback) {
      scanEnd()
      callback()
    },
  })
  child.stdout.pipe(tap)
  return {
    stdin: child.stdin,
    stdout: tap,
    get killed() { return child.killed },
    get exitCode() { return child.exitCode },
    get signalCode() { return child.signalCode },
    kill: (killSignal) => child.kill(killSignal),
    on: (event, listener) => { child.on(event, listener) },
    once: (event, listener) => { child.once(event, listener) },
    off: (event, listener) => { child.off(event, listener) },
  }
}

/** Resolves `true` once the native child exited (or none was spawned), `false` at the deadline. */
function waitNativeExit(ms) {
  if (native === null || native.exit !== null) return Promise.resolve(true)
  return new Promise((resolve) => {
    const timer = setTimeout(() => { native.child.off('exit', onExit); resolve(false) }, ms)
    const onExit = () => { clearTimeout(timer); resolve(true) }
    native.child.once('exit', onExit)
  })
}

// ---- streaming prompt input ----

/** Push-driven `AsyncIterable<SDKUserMessage>` kept open for the session's lifetime; `query` consumes it as streaming input. */
function channel() {
  const items = []
  let waiter = null
  let ended = false
  return {
    push(item) {
      if (ended) return
      if (waiter !== null) {
        const wake = waiter
        waiter = null
        wake({ value: item, done: false })
      } else {
        items.push(item)
      }
    },
    end() {
      ended = true
      if (waiter !== null) {
        const wake = waiter
        waiter = null
        wake({ value: undefined, done: true })
      }
    },
    [Symbol.asyncIterator]() {
      return {
        next: () => {
          if (items.length > 0) return Promise.resolve({ value: items.shift(), done: false })
          if (ended) return Promise.resolve({ value: undefined, done: true })
          return new Promise((resolve) => { waiter = resolve })
        },
        return: () => {
          ended = true
          return Promise.resolve({ value: undefined, done: true })
        },
      }
    },
  }
}
const input = channel()

// ---- native callbacks ----

/**
 * `Options.canUseTool`: every native permission request becomes a
 * `claude_permission` event with a bridge-local ID; the SDK's callback
 * promise waits for the host's `approval` command, or for native
 * cancellation / disposal. `once` allows with the original input, `reject`
 * denies with a fixed message; nothing is ever persisted.
 */
function canUseTool(toolName, toolInput, context) {
  const { signal, ...serializable } = context
  const id = `approval-${++approvalSeq}`
  return new Promise((resolve) => {
    const cancel = () => {
      if (!approvals.delete(id)) return
      try {
        send({ type: 'sdk_event', event: { type: 'claude_permission_cancelled', id, tool_use_id: context.toolUseID } })
      } catch (error) { void shutdown(error) }
      // `null`: the SDK writes no control_response for a request the CLI already withdrew.
      resolve(null)
    }
    approvals.set(id, { resolve, input: toolInput, cancel })
    signal.addEventListener('abort', cancel, { once: true })
    try {
      send({ type: 'sdk_event', event: {
        type: 'claude_permission', id, tool_name: toolName, input: toolInput, tool_use_id: context.toolUseID, context: serializable,
      } })
    } catch (error) { void shutdown(error) }
  })
}

/**
 * SessionStart / Stop hook: the native session ID, working directory and
 * transcript path must describe the selected (or resumed) session; the first
 * observation of the transcript is reported as `sdk_reference`. Every hook
 * input is exposed verbatim under the `claude_session_hook` wrapper.
 */
async function sessionHook(hookInput) {
  if (closing || failure !== null) return {}
  const { session_id: sessionId, cwd, transcript_path: transcript, agent_id: agentId, hook_event_name: name } = hookInput
  // Main-thread hooks only carry the session's own identity; subagent hooks name the subagent.
  if (agentId === undefined) {
    if (sessionId !== reference.sessionId) {
      fail('protocol-error', `native ${name} hook reports session ${JSON.stringify(sessionId)}, not the selected ${JSON.stringify(reference.sessionId)}`, { input: hookInput })
    } else if (typeof cwd !== 'string' || !samePath(cwd, reference.workdir)) {
      fail('protocol-error', `native ${name} hook reports workdir ${JSON.stringify(cwd)}, not ${JSON.stringify(reference.workdir)}`, { input: hookInput })
    } else if (typeof transcript !== 'string' || !isAbsolute(transcript)) {
      fail('protocol-error', `native ${name} hook reports no absolute transcript_path`, { input: hookInput })
    } else if (options.resume !== null && !samePath(transcript, options.resume.sessionFile)) {
      fail('protocol-error', `Claude Code resumed transcript ${JSON.stringify(transcript)}, not the requested ${JSON.stringify(options.resume.sessionFile)}`, { input: hookInput })
    } else if (reference.sessionFile !== null && !samePath(reference.sessionFile, transcript)) {
      fail('protocol-error', `native ${name} hook moved the transcript from ${JSON.stringify(reference.sessionFile)} to ${JSON.stringify(transcript)}`, { input: hookInput })
    } else if (reference.sessionFile === null) {
      reference.sessionFile = transcript
      send({ type: 'sdk_reference', sessionId: reference.sessionId, sessionFile: transcript, workdir: reference.workdir })
    }
  }
  send({ type: 'sdk_event', event: { type: 'claude_session_hook', input: hookInput } })
  return {}
}

// ---- qualification ----

function probeCliVersion(cliPath, cwd, env) {
  return new Promise((resolve, reject) => {
    execFile(cliPath, ['--version'], { cwd, env, timeout: VERSION_PROBE_MS, maxBuffer: 65_536, windowsHide: true }, (error, stdout) => {
      if (error) {
        reject(new Error(`Claude Code executable ${cliPath} failed its version probe: ${errorText(error)}`))
        return
      }
      const reported = String(stdout).trim().split(/\s+/)[0] ?? ''
      if (reported !== CLI_VERSION) {
        reject(new Error(`Claude Code executable ${cliPath} reports version ${JSON.stringify(reported)}; this backend is qualified for ${CLI_VERSION} only`))
        return
      }
      resolve()
    })
  })
}

function requireString(value, name) {
  if (typeof value !== 'string' || value === '') throw new Error(`worker option ${name} must be a non-empty string`)
  return value
}

async function initialize() {
  const raw = JSON.parse(process.argv[2])
  const packageRoot = requireString(raw.packageRoot, 'packageRoot')
  const cliPath = requireString(raw.cliPath, 'cliPath')
  const configDir = requireString(raw.configDir, 'configDir')
  const cwd = requireString(raw.cwd, 'cwd')
  if (!Array.isArray(raw.settingSources) || raw.settingSources.some((source) => source !== 'user' && source !== 'project' && source !== 'local')) {
    throw new Error('worker option settingSources must list user, project or local')
  }
  const settingsFile = raw.settingsFile === null || raw.settingsFile === undefined ? null : requireString(raw.settingsFile, 'settingsFile')
  const model = raw.model === null || raw.model === undefined ? null : requireString(raw.model, 'model')
  let resume = null
  if (raw.resume !== null && raw.resume !== undefined) {
    resume = { sessionId: requireString(raw.resume.sessionId, 'resume.sessionId'), sessionFile: requireString(raw.resume.sessionFile, 'resume.sessionFile') }
  }
  options = { packageRoot, cliPath, configDir, cwd, settingSources: raw.settingSources, settingsFile, model, resume }

  const metadata = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
  if (metadata.name !== SDK_NAME || metadata.version !== SDK_VERSION) {
    throw new Error(`Claude SDK backend is qualified for ${SDK_NAME} ${SDK_VERSION} only; ${packageRoot} holds ${metadata.name} ${metadata.version}`)
  }
  const entry = metadata.exports?.['.']?.default ?? metadata.main
  if (typeof entry !== 'string') throw new Error('Claude SDK package has no import entry point')
  // Inherit the caller environment, then overlay the explicit config selection for the probe, the SDK and the native process alike.
  const env = { ...process.env, CLAUDE_CONFIG_DIR: configDir }
  await probeCliVersion(cliPath, cwd, env)
  const sdk = await import(pathToFileURL(join(packageRoot, entry)).href)
  if (typeof sdk.query !== 'function') throw new Error('Claude SDK package exports no query function')

  reference = resume === null
    ? { sessionId: randomUUID(), sessionFile: null, workdir: cwd }
    : { sessionId: resume.sessionId, sessionFile: resume.sessionFile, workdir: cwd }
  query = sdk.query({
    prompt: input,
    options: {
      cwd,
      env,
      pathToClaudeCodeExecutable: cliPath,
      settingSources: options.settingSources,
      includePartialMessages: true,
      ...(settingsFile === null ? {} : { settings: settingsFile }),
      ...(model === null ? {} : { model }),
      // Explicit fresh ID, or the exact transcript file (never a lookup by newest/title).
      ...(resume === null ? { sessionId: reference.sessionId } : { resume: resume.sessionFile }),
      canUseTool,
      hooks: { SessionStart: [{ hooks: [sessionHook] }], Stop: [{ hooks: [sessionHook] }] },
      spawnClaudeCodeProcess: spawnNative,
    },
  })
  void consume()
  await query.initializationResult()
}

const opening = initialize()

// ---- native message loop ----

function onMessage(message) {
  if (closing || failure !== null) return
  if (message.type !== 'result') {
    send({ type: 'sdk_event', event: message })
    return
  }
  if (active === null) {
    fail('protocol-error', 'native result arrived without an active prompt', { result: message })
    return
  }
  const turn = active
  active = null
  send({ type: 'sdk_event', event: message })
  send({ type: 'sdk_settled', result: message })
  turn.settle()
}

/** The SDK stream ended without the host asking: name the native exit (waiting briefly for it) and fail with the matching status. */
async function endedNaturally(error) {
  await waitNativeExit(NATIVE_EXIT_WAIT_MS)
  const exit = native?.exit ?? null
  const raw = {
    ...(error === null ? {} : { error: errorText(error), errorClass: typeof error?.errorClass === 'string' ? error.errorClass : null }),
    exitCode: exit?.code ?? null,
    signal: exit?.signal ?? null,
  }
  if (exit === null) {
    fail('disconnected', `Claude Code closed its output while still running${error === null ? '' : `: ${errorText(error)}`}`, raw)
  } else if (exit.signal !== null) {
    fail('signaled', `Claude Code was terminated by ${exit.signal}`, raw)
  } else {
    fail('exited', `Claude Code exited with code ${exit.code}`, raw)
  }
}

async function consume() {
  let error = null
  try {
    for await (const _message of query) {
      // Native messages already crossed the strict tap; consume the SDK iterator
      // for its control lifecycle without re-emitting or waiting to retain them.
    }
  } catch (streamError) {
    error = streamError
  }
  if (!closing && failure === null) await endedNaturally(error)
}

// ---- disposal ----

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
    process.stderr.write(`Claude SDK worker: ${errorText(error)}\n`)
  }
  if (closing) return closing
  closing = (async () => {
    try {
      await opening
    } catch (startupError) {
      if (!failed) process.stderr.write(`Claude SDK worker: ${errorText(startupError)}\n`)
      failed = true
    }
    input.end()
    for (const entry of approvals.values()) entry.resolve(null)
    approvals.clear()
    if (active !== null) {
      active.settle()
      active = null
    }
    if (query !== undefined) {
      // Cleanup ends the native stdin and rejects pending control waiters; the
      // SDK's own exit wait (2 s) exceeds our budget, so it is not awaited.
      query.return(undefined).catch(() => {})
      const exited = waitNativeExit(DISPOSE_MS)
      await Promise.race([exited, sleep(150)])
      // The host TERMs the whole group; TERM the owned child directly too. Never a group signal from here.
      if (native !== null && native.exit === null) {
        try { native.child.kill('SIGTERM') } catch { /* already gone */ }
      }
      if (!(await exited)) {
        failed = true
        process.stderr.write('Claude SDK worker: Claude Code did not exit within the disposal budget\n')
      }
    }
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
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
lines.on('close', requestShutdown)

// ---- host commands ----

async function command(request) {
  await opening
  if (closing) return
  if (!request || typeof request.id !== 'string' || typeof request.type !== 'string') {
    throw new Error('invalid Claude SDK worker request')
  }
  if (request.type === 'get_state') {
    response(request, true, { sessionId: reference.sessionId, sessionFile: reference.sessionFile, isStreaming: active !== null })
  } else if (request.type === 'prompt') {
    if (active !== null || typeof request.message !== 'string') throw new Error('invalid or concurrent SDK prompt')
    let settle
    const done = new Promise((resolve) => { settle = resolve })
    active = { settle, done }
    response(request, true, {})
    input.push({ type: 'user', message: { role: 'user', content: request.message }, parent_tool_use_id: null })
  } else if (request.type === 'abort') {
    const turn = active
    if (turn === null) {
      response(request, false, new Error('no active prompt to interrupt'))
      return
    }
    let receipt
    try {
      receipt = await query.interrupt()
    } catch (error) {
      response(request, false, error)
      return
    }
    if (receipt === undefined || !Array.isArray(receipt.still_queued)) {
      response(request, false, new Error('Claude Code acknowledged the interrupt without a receipt (interrupt_receipt_v1 unsupported)'))
      return
    }
    if (receipt.still_queued.length > 0) {
      response(request, false, new Error(`interrupt left ${receipt.still_queued.length} queued native message(s) behind`))
      fail('protocol-error', `interrupt left ${receipt.still_queued.length} queued native message(s) behind; this session admits one prompt at a time`, { receipt })
      return
    }
    send({ type: 'sdk_event', event: { type: 'claude_interrupt', receipt } })
    await turn.done
    response(request, true, receipt)
  } else if (request.type === 'approval') {
    const entry = typeof request.approvalId === 'string' ? approvals.get(request.approvalId) : undefined
    if (entry === undefined) {
      response(request, false, new Error(`no pending permission request ${JSON.stringify(request.approvalId)}`))
    } else if (request.response !== 'once' && request.response !== 'reject') {
      response(request, false, new Error(`approval response must be "once" or "reject", got ${JSON.stringify(request.response)}`))
    } else {
      approvals.delete(request.approvalId)
      entry.resolve(request.response === 'once'
        ? { behavior: 'allow', updatedInput: entry.input }
        : { behavior: 'deny', message: REJECT_MESSAGE })
      response(request, true, {})
    }
  } else {
    throw new Error(`unsupported Claude SDK worker request: ${request.type}`)
  }
}
lines.on('line', (line) => {
  if (closing) return
  try {
    if (Buffer.byteLength(line) > MAX_BYTES) throw new Error('SDK request exceeds 1 MiB')
    void command(JSON.parse(line)).catch((error) => shutdown(error))
  } catch (error) { void shutdown(error) }
})
opening.catch((error) => { void shutdown(error) })
