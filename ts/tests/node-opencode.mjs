import * as api from '../dist/index.js'
import { runOpenCodeConformance } from './opencode-conformance.mjs'

console.log(`Packaged Node OpenCode: ${await runOpenCodeConformance(api)} passed`)
