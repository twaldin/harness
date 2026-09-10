// Harness TypeScript API guide: five selectable modes over the public package API.
//
// Install into an isolated consumer first; see ../../examples/README.md.
//   bun api-guide.ts one-shot --harness codex --executable /abs/path/to/cli
//   bun api-guide.ts config
//   bun api-guide.ts cancel   --harness codex --executable /abs/path/to/slow-cli
//   bun api-guide.ts stream   --harness codex --executable /abs/path/to/chatty-cli
//   bun api-guide.ts session  --executable /abs/path/to/pi
//
// Every symbol comes from the package root ('@twaldin/harness-ts').
// The selected CLI still owns its native configuration/authentication effects.
// --executable, --workdir, --model and --config-home are always the caller's
// choice, so each mode can be pointed at a synthetic CLI instead of a real
// provider. See ../../examples/README.md for exact commands and the behavior
// each synthetic executable needs.
//
// Only `pi` on backend `rpc` is exercised here. The other live-session backends
// (OMP, Claude Agent, Amp, Cline and Factory Droid SDKs; caller-owned OpenCode
// and OpenHands servers) share this same `openSession` surface but each needs a
// caller-installed SDK, CLI or running server — read their sections in
// ../../README.md and ../../SPEC.md instead of guessing from an example.
import {
  HarnessError,
  buildCommand,
  getCapabilities,
  getSessionCapabilities,
  openSession,
  run,
} from '@twaldin/harness-ts'
import type { LiveSession, OutputStream, RunResult, SessionSpec } from '@twaldin/harness-ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { parseArgs as parseOptions } from 'node:util'

const MODES = ['one-shot', 'config', 'cancel', 'stream', 'session'] as const
type Mode = (typeof MODES)[number]

interface Options {
  mode: Mode
  harness: string
  model?: string
  executable?: string
  workdir?: string
  configHome?: string
  prompt: string
  followUp?: string
  timeoutSeconds: number
  requestTimeoutSeconds: number
  inactivitySeconds?: number
  cancelAfterSeconds: number
}

function fail(message: string): never {
  console.error(message)
  process.exit(2)
}

function parseArgs(argv: string[]): Options {
  const { values, positionals } = parseOptions({
    args: argv,
    allowPositionals: true,
    options: {
      harness: { type: 'string' }, model: { type: 'string' },
      executable: { type: 'string' }, workdir: { type: 'string' },
      'config-home': { type: 'string' }, prompt: { type: 'string' },
      'follow-up': { type: 'string' }, timeout: { type: 'string' },
      'request-timeout': { type: 'string' }, inactivity: { type: 'string' },
      'cancel-after': { type: 'string' },
    },
  })
  const mode = positionals[0]
  if (positionals.length !== 1 || mode === undefined || !MODES.includes(mode as Mode)) {
    fail(`usage: api-guide.ts <${MODES.join('|')}> [--flag value ...]`)
  }
  const num = (raw: string | undefined, fallback: number): number => {
    if (raw === undefined) return fallback
    const value = Number(raw)
    if (!Number.isFinite(value) || value <= 0) fail(`expected positive finite seconds, got ${raw}`)
    return value
  }
  return {
    mode: mode as Mode,
    harness: values.harness ?? process.env.HARNESS_EXAMPLE_HARNESS ?? 'codex',
    model: values.model ?? process.env.HARNESS_EXAMPLE_MODEL,
    executable: values.executable ?? process.env.HARNESS_EXAMPLE_EXECUTABLE,
    workdir: values.workdir ?? process.env.HARNESS_EXAMPLE_WORKDIR,
    configHome: values['config-home'] ?? process.env.HARNESS_EXAMPLE_CONFIG_HOME,
    prompt: values.prompt ?? "Print the string 'hello from harness' and nothing else.",
    followUp: values['follow-up'],
    timeoutSeconds: num(values.timeout, 120),
    requestTimeoutSeconds: num(values['request-timeout'], 30),
    inactivitySeconds: values.inactivity === undefined ? undefined : num(values.inactivity, 1),
    cancelAfterSeconds: num(values['cancel-after'], 1),
  }
}

/** Report process status; native errors may also remain in raw/output. */
function report(result: RunResult): void {
  const cost = result.costUsd != null ? `$${result.costUsd.toFixed(4)}` : 'n/a'
  // Python exposes the same predicate as `RunResult.ok`.
  const ok = result.exitCode === 0 && !result.timedOut && !result.callbackError && !result.parseError
  console.log(`  harness=${result.harness} model=${result.model} ok=${ok}`)
  console.log(`  exit=${result.exitCode} termination=${result.termination} signal=${result.signal}`
    + ` timedOut=${result.timedOut} timeoutKind=${result.timeoutKind}`)
  console.log(`  wall=${result.durationSeconds.toFixed(2)}s cost=${cost} tokens=${result.tokensIn}/${result.tokensOut}`)
  console.log(`  stdout=${result.stdoutBytes}B truncated=${result.stdoutTruncated}`
    + `  stderr=${result.stderrBytes}B truncated=${result.stderrTruncated}`)
  for (const [label, detail] of [
    ['launchError', result.launchError],
    ['callbackError', result.callbackError],
    ['parseError', result.parseError],
  ] as const) {
    if (detail) console.log(`  ${label}: ${detail}`)
  }
}

/** One CLI invocation: build, execute, parse. */
async function oneShot(options: Options, workdir: string): Promise<void> {
  const result = await run({
    harness: options.harness,
    prompt: options.prompt,
    workdir,
    model: options.model, // undefined selects the adapter default
    executable: options.executable, // undefined selects the adapter's default binary
    timeoutSeconds: options.timeoutSeconds,
  })
  report(result)
  if (result.stdout) console.log(`  stdout head: ${JSON.stringify(result.stdout.slice(0, 200))}`)
}

/**
 * Explicit configuration, planned only: `buildCommand` runs no CLI and writes
 * no files, so this mode is safe with no `codex` installed at all.
 */
function planCommand(options: Options, workdir: string): void {
  const configHome = options.configHome ?? join(workdir, 'codex-home')
  if (!isAbsolute(configHome)) fail(`--config-home must be absolute, got ${configHome}`)
  const plan = buildCommand({
    harness: 'codex',
    prompt: options.prompt,
    workdir,
    model: options.model ?? 'gpt-5.3-codex',
    executable: options.executable ?? 'codex',
    // Absolute directory exported as CODEX_HOME; harness never creates, copies
    // or reads it. Planned here, not created.
    configHome,
    nativeOptions: { kind: 'codex', sandbox: 'read-only' },
    permissionPolicy: 'upstream', // default: no approval or bypass flag is injected
    timeoutSeconds: options.timeoutSeconds,
  })
  const caps = getCapabilities('codex')
  console.log(`  cmd=${plan.cmd}`)
  console.log(`  args=${JSON.stringify(plan.args)}`)
  console.log(`  cwd=${plan.cwd}`)
  console.log(`  env=${JSON.stringify(plan.env)}`) // adapter + caller additions only; process env is layered at exec
  console.log(`  model=${plan.model} instructionsFile=${plan.instructionsFile}`
    + ` directories=${JSON.stringify(plan.directories ?? [])}`)
  console.log(`  capabilities: nativeOptions=${caps.nativeOptions} configHomeEnv=${caps.configHomeEnv}`
    + ` configFileFlag=${caps.configFileFlag} streaming=${caps.streaming}`
    + ` cancellation=${caps.cancellation} sessions=${caps.sessions}`)
  console.log('  note: codex maps no config-file flag, so a spec with configFile is rejected'
    + " with unsupported-capability; permissionPolicy 'bypass' with a sandbox is rejected too.")
}

/**
 * Request cancellation while a run is pending. Use a slow synthetic peer to
 * observe in-flight cancellation; an already-aborted signal launches nothing.
 */
async function cancelInFlight(options: Options, workdir: string): Promise<void> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.cancelAfterSeconds * 1000)
  let result: RunResult
  try {
    result = await run({
      harness: options.harness,
      prompt: options.prompt,
      workdir,
      model: options.model,
      executable: options.executable,
      timeoutSeconds: options.timeoutSeconds,
      cancel: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }
  report(result)
  if (result.termination === 'cancelled') {
    console.log(`  cancelled in flight after ~${options.cancelAfterSeconds.toFixed(1)}s`
      + ' (an already-aborted signal launches nothing)')
  } else {
    console.log(`  the child finished on its own (termination=${result.termination});`
      + ' point --executable at something that outlives --cancel-after')
  }
}

/**
 * Live output. Chunk boundaries are arbitrary — not lines, not JSONL records —
 * so a consumer must buffer before parsing. Order is preserved per stream;
 * interleaving between stdout and stderr is not specified. A returned promise
 * pauses reading until it settles (backpressure).
 */
async function streamOutput(options: Options, workdir: string): Promise<void> {
  const chars: Record<OutputStream, number> = { stdout: 0, stderr: 0 }
  const result = await run({
    harness: options.harness,
    prompt: options.prompt,
    workdir,
    model: options.model,
    executable: options.executable,
    timeoutSeconds: options.timeoutSeconds,
    inactivityTimeoutSeconds: options.inactivitySeconds ?? null, // null disables the watchdog
    onOutput: (chunk, stream) => {
      chars[stream] += chunk.length
      console.log(`  ${stream.padEnd(6)} +${chunk.length}c ${JSON.stringify(chunk.slice(0, 72))}`)
    },
  })
  console.log(`  streamed stdout=${chars.stdout}c stderr=${chars.stderr}c`
    + ' (the capture cap does not cap callback delivery)')
  report(result)
}

/** One turn: consume its events, then read the single settled result. */
async function takeTurn(live: LiveSession, prompt: string): Promise<void> {
  const turn = live.startTurn(prompt)
  const counts: Record<string, number> = {}
  for await (const event of turn.events) {
    // Single consumer; the iterator ends when the turn settles and drains.
    counts[event.type] = (counts[event.type] ?? 0) + 1
  }
  const result = await turn.result // settles exactly once and never rejects
  console.log(`  turn ${result.turnId}: status=${result.status} events=${JSON.stringify(counts)}`
    + ` eventsTruncated=${result.eventsTruncated} exit=${result.exitCode} signal=${result.signal}`)
  if (result.error) console.log(`    error: ${result.error}`)
  if (result.stderr.trim()) {
    console.log(`    child stderr[${result.stderrBytes}B]: ${JSON.stringify(result.stderr.trim().slice(0, 160))}`)
  }
}

/**
 * A controlled Pi RPC session: one owned `pi --mode rpc` child, serial turns,
 * native events, guaranteed cleanup.
 */
async function liveSession(options: Options, workdir: string): Promise<void> {
  const caps = getSessionCapabilities('pi', 'rpc')
  console.log(`  capabilities: events=${caps.events} interrupt=${caps.interrupt} followUp=${caps.followUp}`
    + ` resume=${caps.resume} concurrentTurns=${caps.concurrentTurns} approval=${caps.approval}`)
  const spec: SessionSpec = {
    harness: 'pi',
    backend: 'rpc',
    workdir,
    model: options.model, // undefined keeps the native selection
    executable: options.executable ?? 'pi',
    timeoutSeconds: options.timeoutSeconds, // per-turn wall clock; expiry tears the session down
    requestTimeoutSeconds: options.requestTimeoutSeconds, // per native round trip
  }
  const live = await openSession(spec)
  try {
    console.log(`  sessionId=${live.reference.sessionId}`)
    console.log(`  sessionFile=${live.reference.sessionFile}`)
    await takeTurn(live, options.prompt)
    // Follow-ups reuse the same native session; one turn at a time.
    if (options.followUp) await takeTurn(live, options.followUp)
    console.log(`  closed=${live.closed} active=${live.active}`)
  } finally {
    // SIGTERM -> SIGKILL on the owned process group, bounded drain; runs even
    // when a turn throws.
    await live.close()
  }
  console.log('  resume: save the complete live.reference before close, then reopen the same'
    + ' spec with resume: reference and the same workdir.'
    + ' Keep that workdir/session file; this example removes a default temporary workdir.')
  console.log("  interrupt: `await live.interrupt()` aborts the active turn and waits for it to settle"
    + " (status 'interrupted' only when the backend confirms the abort).")
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2))
  const temporary = options.workdir === undefined
  const workdir = options.workdir === undefined
    ? mkdtempSync(join(tmpdir(), 'harness-guide-'))
    : resolve(options.workdir)
  console.log(`${options.mode}: workdir=${workdir}`)
  try {
    if (options.mode === 'one-shot') await oneShot(options, workdir)
    else if (options.mode === 'config') planCommand(options, workdir)
    else if (options.mode === 'cancel') await cancelInFlight(options, workdir)
    else if (options.mode === 'stream') await streamOutput(options, workdir)
    else await liveSession(options, workdir)
  } catch (err) {
    if (!(err instanceof HarnessError)) throw err
    console.log(`  HarnessError [${err.code}]: ${err.message}`)
    return 1
  } finally {
    if (temporary) rmSync(workdir, { recursive: true, force: true })
  }
  return 0
}

process.exitCode = await main()
