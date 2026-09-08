import type { SubprocOutcome } from './base.js'
import { HarnessError } from './base.js'
import { cancelledBeforeLaunch, prepareLaunch, runLifecycle, runLifecycleSync } from './lifecycle.js'
import type { RunSubprocessOptions } from './lifecycle.js'

export type { RunSubprocessOptions } from './lifecycle.js'

/**
 * Blocking execution with the full lifecycle contract (fresh process group,
 * bounded graceful-signal→KILL teardown of leftovers, bounded pipe drain, bounded
 * capture, stdin payload, wall and inactivity deadlines). Runs the async
 * engine in a per-invocation supervisor process so the calling thread can
 * block. `cancel` is only honored when already aborted at call time, and
 * `onOutput` is rejected: a callback cannot cross the supervisor boundary,
 * so streaming needs `runSubprocessAsync` (or `run`/`runAsync`).
 */
export function runSubprocess(cmd: string[], opts: RunSubprocessOptions): Required<SubprocOutcome> {
  const request = prepareLaunch(cmd, opts)
  if (opts.onOutput !== undefined) {
    throw new HarnessError('runSubprocess cannot stream output through onOutput; use runSubprocessAsync', 'unsupported-capability')
  }
  if (opts.cancel?.aborted) return cancelledBeforeLaunch()
  return runLifecycleSync(request)
}

/** Same lifecycle contract, in-process; `cancel` may abort at any time and `onOutput` streams as output arrives. */
export function runSubprocessAsync(cmd: string[], opts: RunSubprocessOptions): Promise<Required<SubprocOutcome>> {
  return runLifecycle(prepareLaunch(cmd, opts), opts.cancel, undefined, opts.onOutput)
}
