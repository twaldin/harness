import type { SubprocOutcome } from './base.js'
import { cancelledBeforeLaunch, prepareLaunch, runLifecycle, runLifecycleSync } from './lifecycle.js'
import type { RunSubprocessOptions } from './lifecycle.js'

export type { RunSubprocessOptions } from './lifecycle.js'

/**
 * Blocking execution with the full lifecycle contract (fresh process group,
 * bounded TERM→KILL teardown of leftovers, bounded pipe drain). Runs the
 * async engine in a per-invocation supervisor process so the calling thread
 * can block. `cancel` is only honored when already aborted at call time.
 */
export function runSubprocess(cmd: string[], opts: RunSubprocessOptions): Required<SubprocOutcome> {
  const request = prepareLaunch(cmd, opts)
  if (opts.cancel?.aborted) return cancelledBeforeLaunch()
  return runLifecycleSync(request)
}

/** Same lifecycle contract, in-process; `cancel` may abort at any time. */
export function runSubprocessAsync(cmd: string[], opts: RunSubprocessOptions): Promise<Required<SubprocOutcome>> {
  return runLifecycle(prepareLaunch(cmd, opts), opts.cancel)
}
