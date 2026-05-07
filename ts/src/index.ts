import './adapters/index.js'

export type {
  RunSpec, BuildCommand, SubprocOutcome, RunResult, ParsedOutput, Adapter,
  ReadyState, AgentStatus, SessionTelemetry, InstallMeta, ScrollKeys,
} from './base.js'
export type { InstructionProjection, ProjectInstructionsOptions } from './subproc.js'
export { HarnessError } from './base.js'
export { register, listAdapters, getAdapter, buildCommand, parseOutput, run, runAsync } from './registry.js'
export {
  writeInstructions,
  projectInstructions,
  restoreProjectedInstructions,
  runSubprocess,
  runSubprocessAsync,
} from './subproc.js'
export { stripAnsi, lastLines, lastNonEmptyJoin } from './util.js'
export { lookupPricing, deriveCost } from './pricing.js'
export type { ModelPricing } from './pricing.js'
