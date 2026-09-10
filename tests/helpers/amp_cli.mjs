// Synthetic native CLI for the Amp SDK conformance suite. No network/auth or
// host settings. All state belongs to the test's disposable working directory.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { spawn } from 'node:child_process'

const args = process.argv.slice(2)
const id = 'T-11111111-2222-4333-8444-555555555555'
const otherId = 'T-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const state = '.amp-synthetic-thread.json'
const emit = event => process.stdout.write(JSON.stringify(event) + '\n')
// A hard finite lifetime belongs to every synthetic process, including the
// owned grandchild. The shared lifecycle should terminate them earlier.
const lifetime = setTimeout(() => process.exit(0), 10000)
lifetime.unref()
if (args.includes('--version')) {
  console.log('0.0.1788883237-g0b98e3')
} else if (args[0] === '--owned-child') {
  setInterval(() => {}, 100)
} else if (args[0] === 'threads' && args[1] === 'new') {
  writeFileSync(state, JSON.stringify({ id, turns: 0, visibility: args.includes('--visibility') ? args[args.indexOf('--visibility') + 1] : null }))
  console.log(`https://ampcode.com/threads/${id}`)
} else if (args[0] === 'threads' && args[1] === 'markdown') {
  if (!existsSync(state) || args[2] !== JSON.parse(readFileSync(state, 'utf8')).id) process.exitCode = 3
  else console.log('# Synthetic thread')
} else {
  if (!args.includes('--executor') || args[args.indexOf('--executor') + 1] !== 'local') throw new Error('caller did not select the local executor')
  if (process.env.AMP_SKIP_UPDATE_CHECK !== '1') throw new Error('automatic update checks were not disabled')
  if (args[2] !== id || !existsSync(state)) throw new Error('thread identity not preserved')
  let prompt = ''
  for await (const chunk of process.stdin) prompt += chunk
  prompt = prompt.trim()
  const saved = JSON.parse(readFileSync(state, 'utf8'))
  saved.turns += 1
  writeFileSync(state, JSON.stringify(saved))
  if (prompt === 'init-hang') {
    setInterval(() => {}, 100)
    await new Promise(() => {})
  }
  if (prompt === 'preinit-error') {
    await new Promise(resolve => process.stdout.write(JSON.stringify({ type: 'error', session_id: id, error: 'synthetic pre-init rejection' }) + '\n', resolve))
    process.exit(3)
  }
  const sessionId = prompt === 'wrong-id' ? otherId : id
  emit({ type: 'system', subtype: 'init', session_id: sessionId, cwd: prompt === 'wrong-cwd' ? '/' : process.cwd(), tools: [], mcp_servers: [] })
  const assistant = { type: 'assistant', session_id: id, message: { role: 'assistant', content: [{ type: 'text', text: 'synthetic partial' }], stop_reason: 'end_turn' } }
  emit(assistant)
  const result = { type: 'result', subtype: 'success', is_error: false, session_id: id, result: `synthetic turn ${saved.turns}`, duration_ms: 1, num_turns: 1, usage: { input_tokens: null, output_tokens: 2, max_tokens: 123, cache_creation: { ephemeral_5m_input_tokens: 4 } } }
  if (prompt === 'hang' || prompt === 'child-hang') {
    if (prompt === 'child-hang') {
      const child = spawn(process.execPath, [process.argv[1], '--owned-child'], { stdio: 'ignore' })
      writeFileSync('.amp-synthetic-child.json', JSON.stringify({ pid: child.pid, parent: process.pid }))
    }
    setInterval(() => {}, 100)
  } else if (prompt === 'partial') {
    process.stdout.write(JSON.stringify(result))
  } else if (prompt === 'invalid-json') {
    process.stdout.write('{broken}\n')
  } else if (prompt === 'invalid-utf8') {
    process.stdout.write(Buffer.from([0xff, 10]))
  } else if (prompt === 'missing-result') {
    // Native EOF after partial assistant output, without terminal result.
  } else if (prompt === 'overflow') {
    for (let i = 0; i < 200; i++) emit({ type: 'future_event', session_id: id, data: 'x'.repeat(1024) })
    emit(result)
  } else {
    emit({ type: 'future_event', session_id: id, value: 17 })
    if (prompt === 'agent-error' || prompt === 'permission-rejection') {
      result.is_error = true
      result.subtype = 'error_during_execution'
      result.error = 'synthetic native rejection'
      if (prompt === 'permission-rejection') result.permission_denials = ['synthetic-tool']
    }
    if (prompt === 'stderr') process.stderr.write('synthetic-stderr\n'.repeat(100))
    emit(result)
    if (prompt === 'duplicate-result') emit(result)
    if (prompt === 'exit-after-result') process.exitCode = 3
  }
}
