// Optional Amp SDK compatibility worker. Shared by Python and TypeScript;
// never imported in a caller process. Every invocation belongs to the host's
// shared subprocess lifecycle (one fresh process group per SDK operation).
import childProcess from 'node:child_process'
import { syncBuiltinESMExports, createRequire } from 'node:module'
import { readFileSync, realpathSync } from 'node:fs'
import { join, isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PassThrough, Transform } from 'node:stream'
import { once } from 'node:events'

const SDK_VERSION = '0.1.0-20260823161614-g3631dc6'
const CLI_VERSION = '0.0.1788883237-g0b98e3'
const MAX_BYTES = 1_048_576
const THREAD_ID = /^T-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const nativeSpawn = childProcess.spawn
const text = error => error instanceof Error ? error.message : String(error)
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
let selectedChild
let protocolError = null

async function send(frame) {
  const line = JSON.stringify(frame) + '\n'
  if (Buffer.byteLength(line) > MAX_BYTES) throw new Error('SDK envelope exceeds 1 MiB')
  if (!process.stdout.write(line)) await once(process.stdout, 'drain')
}

async function request() {
  const chunks = []
  let size = 0
  for await (const chunk of process.stdin) {
    size += chunk.length
    if (size > MAX_BYTES) throw new Error('SDK request exceeds 1 MiB')
    chunks.push(chunk)
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
}

// Amp's SDK uses readline, which accepts partial final lines and replacement
// UTF-8. Guard the actual owned stdout before that parser. Bytes and native
// objects are not rewritten; unknown events remain visible.
class NativeOutput extends Transform {
  #parts = []
  #size = 0
  #total = 0
  #jsonl
  constructor(jsonl) { super(); this.#jsonl = jsonl }
  reject(error, callback) { protocolError ??= text(error); callback(error) }
  _transform(chunk, _encoding, callback) {
    try {
      if (!this.#jsonl) {
        this.#total += chunk.length
        if (this.#total > MAX_BYTES) throw new Error('SDK thread response exceeds 1 MiB')
        this.push(chunk)
        callback()
        return
      }
      let start = 0
      while (start < chunk.length) {
        const end = chunk.indexOf(10, start)
        const part = chunk.subarray(start, end < 0 ? chunk.length : end)
        this.#size += part.length
        if (this.#size > MAX_BYTES) throw new Error('native SDK frame exceeds 1 MiB')
        this.#parts.push(part)
        if (end < 0) break
        const line = Buffer.concat(this.#parts, this.#size)
        const decoded = new TextDecoder('utf-8', { fatal: true }).decode(line)
        if (!decoded.trim()) throw new Error('native SDK emitted an empty frame')
        const frame = JSON.parse(decoded)
        if (!object(frame) || typeof frame.type !== 'string' || !frame.type) throw new Error('native SDK frame requires an object and type')
        this.push(line)
        this.push(Buffer.from('\n'))
        this.#parts = []
        this.#size = 0
        start = end + 1
      }
      callback()
    } catch (error) { this.reject(error, callback) }
  }
  _flush(callback) {
    if (this.#jsonl && this.#size) this.reject(new Error('native SDK emitted a partial final frame'), callback)
    else callback()
  }
}

function cliCommand(cliPath) {
  return /\.(m?js|cjs)$/.test(cliPath) ? { command: process.execPath, args: [cliPath] } : { command: cliPath, args: [] }
}

async function version(cliPath) {
  const launch = cliCommand(cliPath)
  const proc = nativeSpawn(launch.command, [...launch.args, '--version'], { stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  const capture = chunk => {
    if (Buffer.byteLength(output) + chunk.length > 16384) { proc.kill('SIGTERM'); return }
    output += chunk.toString('utf8')
  }
  proc.stdout.on('data', capture)
  proc.stderr.on('data', capture)
  const [code] = await once(proc, 'close')
  if (code !== 0 || output.trim().split(/\s/)[0] !== CLI_VERSION) throw new Error(`Amp SDK requires CLI ${CLI_VERSION}`)
}

function guardSdkChildren(options) {
  const cli = realpathSync(options.cliPath)
  // SDK resolution prefers node_modules/@ampcode/cli over AMP_CLI_PATH. Refuse
  // that silent selection before importing/executing the SDK.
  const require = createRequire(join(options.packageRoot, 'package.json'))
  let installed
  try { installed = require.resolve('@ampcode/cli/package.json') }
  catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error }
  if (installed) {
    const metadata = JSON.parse(readFileSync(installed, 'utf8'))
    if (typeof metadata.bin?.amp !== 'string' || realpathSync(join(installed, '..', metadata.bin.amp)) !== cli) {
      throw new Error('SDK-local @ampcode/cli shadows the selected cliPath; select that exact CLI or install SDK without a conflicting CLI dependency')
    }
  }
  childProcess.spawn = function guardedSpawn(command, args = [], spawnOptions = {}) {
    if (selectedChild) throw new Error('Amp SDK attempted multiple CLI children in one operation')
    const script = /\.(m?js|cjs)$/.test(options.cliPath)
    const candidate = script ? args[0] : command
    if (typeof candidate !== 'string' || !isAbsolute(candidate) || realpathSync(candidate) !== cli) throw new Error('Amp SDK attempted an unselected executable')
    const nativeArgs = script ? args.slice(1) : [...args]
    if (nativeArgs.includes('--orb-execute') || nativeArgs.includes('--project') || nativeArgs.includes('--executor')) throw new Error('Amp SDK attempted an unsupported executor')
    const execute = nativeArgs.includes('--execute')
    // The pinned SDK accepts executor:local but omits its CLI flag. This
    // compatibility mapping prevents configured remote defaults taking over.
    const guardedArgs = execute ? [...args, '--executor', 'local'] : args
    const proc = nativeSpawn(command, guardedArgs, spawnOptions)
    const state = { proc, exitCode: null, signal: null, closed: null }
    selectedChild = state
    proc.once('exit', (code, signal) => { state.exitCode = code; state.signal = signal })
    state.closed = new Promise((resolve, reject) => {
      proc.once('error', reject)
      proc.once('close', (code, signal) => { state.exitCode = code; state.signal = signal; resolve() })
    })
    // A spawn error can precede the SDK attaching its own listeners.
    state.closed.catch(() => {})
    const rawOut = proc.stdout
    const checked = new NativeOutput(execute)
    checked.on('error', () => { if (proc.exitCode === null && !proc.killed) proc.kill('SIGTERM') })
    rawOut.on('error', error => checked.destroy(error))
    rawOut.pipe(checked)
    proc.stdout = checked
    // Drain native stderr immediately (the SDK otherwise waits for stdout EOF).
    // The host captures/counts it. Only a bounded prefix is replayed to the SDK
    // for its native error message; no caller settings or logs are inspected.
    const rawErr = proc.stderr
    const prefix = new PassThrough()
    let retained = 0
    rawErr.on('data', chunk => {
      if (!process.stderr.write(chunk)) { rawErr.pause(); process.stderr.once('drain', () => rawErr.resume()) }
      const size = Math.min(chunk.length, Math.max(0, options.maxBufferBytes - retained))
      if (size) { prefix.write(chunk.subarray(0, size)); retained += size }
    })
    rawErr.on('end', () => prefix.end())
    rawErr.on('error', error => prefix.destroy(error))
    prefix.on('error', () => {})
    proc.stderr = prefix
    return proc
  }
  syncBuiltinESMExports()
}

function threadId(value, endpoint) {
  if (typeof value !== 'string') throw new Error('Amp SDK returned no thread identity')
  if (THREAD_ID.test(value)) return value
  const url = new URL(value)
  const id = url.pathname.split('/').at(-1)
  if (url.origin !== endpoint || url.search || url.hash || !THREAD_ID.test(id ?? '')) throw new Error('Amp SDK returned an invalid thread URL')
  return id
}

async function main() {
  let options
  let sdk
  try {
    options = await request()
    if (process.versions.bun || Number(process.versions.node.split('.')[0]) < 22) throw new Error('Amp SDK worker requires Node >=22')
    if (!object(options) || !['open', 'turn'].includes(options.operation) || options.executor !== 'local') throw new Error('invalid Amp SDK operation or executor')
    if (options.sessionId !== null && !THREAD_ID.test(options.sessionId)) throw new Error('Amp SDK requires a full explicit thread ID')
    if (new URL(options.endpoint).origin !== options.endpoint) throw new Error('Amp endpoint must be a normalized origin')
    if (realpathSync(options.cwd) !== realpathSync(process.cwd())) throw new Error('Amp SDK worker cwd does not match request')
    if (typeof options.mode !== 'string' || !options.mode.trim()) throw new Error('Amp SDK mode must be explicit')
    if (!Number.isSafeInteger(options.maxBufferBytes) || options.maxBufferBytes < 0) throw new Error('invalid SDK buffer bound')
    const metadata = JSON.parse(readFileSync(join(options.packageRoot, 'package.json'), 'utf8'))
    if (metadata.name !== '@ampcode/sdk' || metadata.version !== SDK_VERSION) throw new Error(`Amp SDK requires @ampcode/sdk ${SDK_VERSION}`)
    process.env.AMP_SKIP_UPDATE_CHECK = '1'
    process.env.AMP_CLI_PATH = options.cliPath
    process.env.AMP_URL = options.endpoint
    if (options.settingsFile !== undefined) process.env.AMP_SETTINGS_FILE = options.settingsFile
    await version(options.cliPath)
    guardSdkChildren(options)
    const entry = metadata.exports?.['.']?.import ?? metadata.main
    if (typeof entry !== 'string') throw new Error('Amp SDK has no import entry point')
    sdk = await import(pathToFileURL(join(options.packageRoot, entry)).href)
    if (typeof sdk.execute !== 'function' || typeof sdk.threads?.new !== 'function' || typeof sdk.threads?.markdown !== 'function') throw new Error('Amp SDK is missing its qualified API')
  } catch (error) {
    await send({ type: 'amp_error', code: 'launch-failed', error: text(error) })
    return
  }
  let lastResult = null
  let failure = null
  let initialized = false
  try {
    if (options.operation === 'open') {
      let id = options.sessionId
      if (id === null) id = threadId(await sdk.threads.new(options.visibility === undefined ? {} : { visibility: options.visibility }), options.endpoint)
      else await sdk.threads.markdown({ threadId: id })
      if (selectedChild) await selectedChild.closed
      await send({ type: 'amp_open', sessionId: id, workdir: options.cwd, endpoint: options.endpoint })
    } else {
      if (!THREAD_ID.test(options.sessionId) || typeof options.prompt !== 'string') throw new Error('turn requires an explicit thread and prompt')
      const nativeOptions = { cwd: options.cwd, executor: 'local', continue: options.sessionId, mode: options.mode, noArchiveAfterExecute: true,
        ...(options.effort === undefined ? {} : { effort: options.effort }),
        ...(options.settingsFile === undefined ? {} : { settingsFile: options.settingsFile }) }
      for await (const event of sdk.execute({ prompt: options.prompt, options: nativeOptions })) {
        if (!object(event) || typeof event.type !== 'string' || !event.type) throw new Error('Amp SDK yielded an invalid native event')
        if (event.session_id !== undefined && event.session_id !== options.sessionId) throw new Error('Amp SDK returned a different thread ID')
        if (event.type === 'system' && event.subtype === 'init') {
          if (initialized || event.session_id !== options.sessionId || typeof event.cwd !== 'string' || realpathSync(event.cwd) !== realpathSync(options.cwd)) throw new Error('Amp SDK init identity/workdir mismatch')
          initialized = true
          await send({ type: 'amp_open', sessionId: options.sessionId, workdir: options.cwd, endpoint: options.endpoint })
        }
        if (event.type === 'result') {
          if (!initialized || lastResult || typeof event.is_error !== 'boolean') throw new Error('Amp SDK emitted an invalid or duplicate terminal result')
          lastResult = event
        }
        await send({ type: 'amp_event', event })
      }
      if (!initialized || !lastResult) throw new Error('Amp SDK ended without init and terminal result')
    }
  } catch (error) { failure = text(error) }
  if (selectedChild && !failure) {
    try { await selectedChild.closed } catch (error) { failure ??= text(error) }
  }
  const exitCode = selectedChild?.exitCode ?? null
  const signal = selectedChild?.signal ?? null
  const status = protocolError ? 'protocol-error' : signal ? 'signaled' : exitCode !== null && exitCode !== 0 ? 'exited' : failure ? 'protocol-error' : lastResult?.is_error ? 'agent-error' : 'completed'
  await send({ type: 'amp_done', status, raw: lastResult, error: protocolError ?? failure ?? (lastResult?.is_error ? String(lastResult.error ?? 'Amp agent failed') : null), exitCode, signal })
}

main().then(
  () => process.stdout.end(() => process.stderr.end(() => process.exit(0))),
  error => { process.stderr.end(`Amp SDK worker: ${text(error)}\n`, () => process.exit(1)) },
)
