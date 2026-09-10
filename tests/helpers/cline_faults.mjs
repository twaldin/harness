// Test-only additions around the real SDK. No provider/model substitution.
// Exercises future event retention and malformed native-wire/worker-loss paths.
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

if (/_cline_sdk\.mjs$|cline-sdk\.mjs$/.test(process.argv[1] ?? '')) {
  const { ClineCore } = await import(pathToFileURL(join(process.env.HARNESS_TEST_CLINE_PACKAGE_ROOT, 'dist/index.js')).href)
  const create = ClineCore.create
  ClineCore.create = async function (...args) {
    const core = await create.apply(this, args)
    const subscribe = core.subscribe.bind(core)
    core.subscribe = (listener, ...options) => subscribe(event => {
      listener(event)
      if (event.type === 'agent_event' && event.payload.event.type === 'iteration_start') {
        listener({ type: 'future_native_event', payload: { sessionId: event.payload.sessionId, future: { preserved: true } } })
      }
      if (process.env.HARNESS_TEST_CLINE_SCENARIO === 'partial-wire' && event.type === 'agent_event' && event.payload.event.type === 'content_start' && event.payload.event.contentType === 'text') {
        process.stdout.write('[malformed-native-frame\n')
      }
    }, ...options)
    return core
  }
  if (process.env.HARNESS_TEST_CLINE_SCENARIO === 'worker-loss') {
    let buffer = ''
    process.stdin.on('data', bytes => {
      buffer += bytes.toString('utf8')
      for (;;) {
        const newline = buffer.indexOf('\n')
        if (newline < 0) break
        const frame = JSON.parse(buffer.slice(0, newline))
        buffer = buffer.slice(newline + 1)
        if (frame.type === 'shell_output') process.kill(process.pid, 'SIGKILL')
      }
    })
  }
}
