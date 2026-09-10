// Real optional Cline SDK and finite synthetic provider; no provider account.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, access, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createInterface } from 'node:readline'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const packageRoot = join(root, 'ts/node_modules/@cline/sdk')
const cases = JSON.parse(await readFile(join(root, 'tests/cline_sdk_cases.json'), 'utf8'))
const collect = async turn => { const events = []; for await (const event of turn.events) events.push(event); return events }
const missing = path => assert.rejects(access(path), { code: 'ENOENT' })
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function within(promise, ms) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('synthetic peer deadline')), ms) })]) }
  finally { clearTimeout(timer) }
}

async function configure(directory, scenario) {
  const workdir = join(directory, scenario, 'work')
  const home = join(directory, scenario, 'home')
  const configDir = join(directory, scenario, 'config')
  await Promise.all([mkdir(workdir, { recursive: true }), mkdir(home, { recursive: true }), mkdir(join(configDir, 'data/settings'), { recursive: true })])
  const provider = spawn(process.env.PYTHON ?? 'python3', [join(root, 'tests/helpers/cline_provider.py'), workdir, scenario], { detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const exit = new Promise((resolve, reject) => { provider.once('exit', resolve); provider.once('error', reject) })
  const lines = createInterface({ input: provider.stdout })
  const stop = async () => {
    provider.stdin.end()
    try { await within(exit, 5000) }
    catch (error) {
      if (provider.pid && provider.exitCode === null && provider.signalCode === null) process.kill(-provider.pid, 'SIGKILL')
      await within(exit, 2000)
      throw error
    } finally { lines.close(); provider.stderr.destroy() }
  }
  try {
    const next = await within(lines[Symbol.asyncIterator]().next(), 5000)
    const { endpoint } = JSON.parse(next.value)
    await writeFile(join(configDir, 'data/settings/providers.json'), JSON.stringify({ version: 1, modes: {}, lastUsedProvider: 'openai-compatible', providers: {
      'openai-compatible': { settings: { provider: 'openai-compatible', model: 'synthetic', apiKey: 'synthetic', baseUrl: endpoint }, updatedAt: '2026-09-10T00:00:00Z', tokenSource: 'manual' },
    } }))
    return { stop, spec: {
      harness: 'cline', backend: 'sdk', workdir, executable: process.env.HARNESS_TEST_NODE ?? 'node', model: 'synthetic', requestTimeoutSeconds: 10, timeoutSeconds: 12,
      env: { HOME: home, NODE_OPTIONS: `--import=${pathToFileURL(join(root, 'tests/helpers/cline_faults.mjs')).href}`, HARNESS_TEST_CLINE_PACKAGE_ROOT: packageRoot, HARNESS_TEST_CLINE_SCENARIO: scenario },
      clineSdk: { packageRoot, configDir, provider: 'openai-compatible', features: 'builtin-only', approval: 'callback' },
    } }
  } catch (error) { await stop(); throw error }
}

export async function clineConformance(api) {
  const directory = await mkdtemp(join(tmpdir(), 'harness-cline-sdk-'))
  let completed = false
  try {
    for (const scenario of cases) {
      const { spec, stop } = await configure(directory, scenario.name)
      let session
      try {
        session = await api.openSession(spec)
        const turn = session.startTurn(scenario.name)
        const events = []
        let operation
        for await (const event of turn.events) {
          events.push(event)
          if (event.type === 'cline_permission') await session.respondApproval(event.raw.id, scenario.reply ?? 'once')
          const native = event.raw.payload?.event
          if (native?.contentType === 'tool' && native.type === 'content_update' && scenario.operation && !operation) {
            operation = scenario.operation === 'interrupt' ? session.interrupt() : session.close()
          }
        }
        const result = await turn.result
        await operation
        assert.equal(result.status, scenario.status, scenario.name)
        assert.equal(result.sessionId, session.reference.sessionId)
        assert.deepEqual(events.find(event => event.type === 'future_native_event')?.raw.payload.future, { preserved: true })
        if (scenario.name === 'success') {
          assert.equal(result.raw.text, 'synthetic native reply')
          assert.equal(result.raw.usage.inputTokens, 11)
          assert.equal(result.raw.usage.outputTokens, 3)
        }
        if (scenario.name === 'command-error') {
          const tool = events.find(event => event.type === 'agent_event' && event.raw.payload.event.contentType === 'tool' && event.raw.payload.event.type === 'content_end')
          assert.equal(tool.raw.payload.event.output[0].success, false)
        }
        if (scenario.name === 'partial-wire') assert.ok(events.some(event => event.raw.payload?.event?.contentType === 'text'))
        if (scenario.name === 'worker-loss') assert.equal(result.signal, 'SIGKILL')
        await session.close()
        await missing(join(spec.workdir, '.harness-run.lock'))
        if (['interrupt', 'close', 'worker-loss'].includes(scenario.name)) await delay(3200)
        await missing(join(spec.workdir, 'survived'))
      } finally { try { await session?.close() } finally { await stop() } }
    }
    const { spec, stop } = await configure(directory, 'followup')
    spec.instructions = 'Cline-owned instruction sentinel 8f26'
    const instructionFile = join(spec.workdir, 'CLINE.md')
    await writeFile(instructionFile, 'original caller instructions')
    let session
    try {
      session = await api.openSession(spec)
      for (const prompt of ['original-history', 'followup-history']) {
        const turn = session.startTurn(prompt)
        await collect(turn)
        assert.equal((await turn.result).status, 'completed')
      }
      const reference = session.reference
      await session.close()
      assert.equal(await readFile(instructionFile, 'utf8'), 'original caller instructions')
      session = await api.openSession({ ...spec, resume: reference })
      assert.deepEqual(session.reference, reference)
      const turn = session.startTurn('resumed-history')
      await collect(turn)
      const result = await turn.result
      assert.equal(result.status, 'completed')
      assert.equal(result.raw.usage.inputTokens, 11)
      await session.close()
      const requests = (await readFile(join(spec.workdir, 'provider-requests.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
      const history = JSON.stringify(requests.at(-1).messages)
      for (const prompt of ['original-history', 'followup-history', 'resumed-history']) assert.ok(history.includes(prompt))
      assert.ok(history.includes(spec.instructions))
      assert.equal(await readFile(instructionFile, 'utf8'), 'original caller instructions')
      const before = await readFile(reference.sessionFile, 'utf8')
      const manifest = JSON.parse(before)
      assert.equal(manifest.metadata.usage.inputTokens, 33)
      assert.equal(manifest.metadata.usage.outputTokens, 9)
      await assert.rejects(api.openSession({ ...spec, resume: { ...reference, sessionId: 'unknown-exact-id' } }))
      assert.equal(await readFile(reference.sessionFile, 'utf8'), before)
      manifest.cwd = dirname(spec.workdir)
      await writeFile(reference.sessionFile, JSON.stringify(manifest))
      await assert.rejects(api.openSession({ ...spec, resume: reference }))
      await assert.rejects(api.openSession({ ...spec, clineSdk: { ...spec.clineSdk, features: 'native-hooks' } }), { code: 'unsupported-capability' })
      await assert.rejects(api.openSession({ ...spec, clineSdk: { ...spec.clineSdk, packageRoot: join(spec.workdir, 'missing-sdk') } }), { code: 'launch-failed' })
      await missing(join(spec.workdir, '.harness-run.lock'))
    } finally { try { await session?.close() } finally { await stop() } }
    completed = true
  } finally { if (completed) await rm(directory, { recursive: true }) }
}
