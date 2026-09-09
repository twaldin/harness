// Deliberately synthetic SDK, not an upstream/provider qualification fixture.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
const trace = (event) => {
  if (process.env.HARNESS_SDK_TRACE) appendFileSync(process.env.HARNESS_SDK_TRACE, `${event}\n`)
}
export class Settings {
  static async loadReadOnly({ agentDir }) {
    return { agentDir }
  }
}
export class AuthStorage {
  static async create() { return new AuthStorage() }
  async reload() {}
  close() { trace('auth_close') }
}
export class ModelRegistry {
  constructor(authStorage) { this.authStorage = authStorage }
}
export class AgentRegistry {}
export class SessionManager {
  constructor(cwd, file, id, count = 0) {
    this.cwd = cwd
    this.file = file
    this.id = id
    this.count = count
  }
  static getDefaultSessionDir(cwd, agentDir) { return join(agentDir, 'sessions') }
  static create(cwd, dir) {
    mkdirSync(dir, { recursive: true })
    const id = randomUUID()
    const manager = new SessionManager(cwd, join(dir, `${id}.jsonl`), id)
    manager.persist()
    return manager
  }
  static async open(file) {
    const lines = readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse)
    return new SessionManager(lines[1].cwd, file, lines[1].id, lines[2]?.count ?? 0)
  }
  getCwd() { return this.cwd }
  getSessionId() { return this.id }
  persist() {
    writeFileSync(this.file, `${JSON.stringify({ type: 'title', v: 1, title: '', pad: '' })}\n${JSON.stringify({ type: 'session', id: this.id, cwd: this.cwd })}\n${JSON.stringify({count: this.count})}\n`)
  }
  async close() { this.persist() }
}
export async function createAgentSession({ sessionManager: manager }) {
  let listener
  let abort
  let disposeCall
  const emit = (event) => listener?.(event)
  const end = (stopReason = 'stop', extra = {}) => emit({
    type: 'agent_end', messages: [{ role: 'assistant', stopReason,
      ...(stopReason === 'error' ? {errorMessage: 'synthetic agent error'} : {}),
      content: [{type: 'text', text: `reply-${manager.count}`}],
      usage: { input: 7, output: 3, cost: { total: 0 } },
    }], ...extra,
  })
  const session = {
    sessionId: manager.id,
    sessionFile: manager.file,
    isStreaming: false,
    subscribe(fn) {
      listener = fn
      trace('subscribe')
      return () => { listener = undefined; trace('unsubscribe') }
    },
    async prompt(prompt) {
      if (prompt === 'reject') throw new Error('synthetic prompt rejection')
      if (prompt === 'local') return false
      manager.count++
      session.isStreaming = true
      emit({type: 'agent_start'})
      if (prompt === 'retry') {
        end('error', {isTerminal: false})
        emit({type: 'auto_retry_start'})
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      if (prompt === 'native_settled') {
        emit({type: 'agent_settled'})
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      if (prompt === 'unknown') emit({ type: 'synthetic_unknown', nested: { value: 42 }, nativeId: manager.id })
      if (prompt === 'flood') {
        for (let i = 0; i < 10000; i++) emit({type: 'message_update', text: 'x'.repeat(1024)})
      }
      emit({type: 'message_update', assistantMessageEvent: {type: 'text_delta', delta: `reply-${manager.count}`}})
      if (prompt === 'hang') {
        await new Promise(resolve => { abort = resolve })
        end('aborted')
      } else end(prompt === 'error' ? 'error' : 'stop')
      session.isStreaming = false
      manager.persist()
      return true
    },
    async waitForIdle() {},
    hasPendingAsyncWork() { return false },
    async settleAsyncWork() {},
    async abort() { abort?.(); trace('abort') },
    beginDispose() { trace('beginDispose'); abort?.() },
    dispose() {
      if (!disposeCall) disposeCall = (async () => {
        trace('dispose')
        abort?.()
        await manager.close()
        if (process.env.HARNESS_SDK_DISPOSE_ERROR === '1') throw new Error('synthetic disposal failure')
      })()
      return disposeCall
    },
  }
  return { session }
}
