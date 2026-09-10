// Packaged Node -> optional @factory/droid-sdk (external in the bundle) -> synthetic peer. No provider, no credentials.
import * as api from '../dist/index.js'
import { runDroidConformance } from './droid-sdk-conformance.mjs'

console.log(`Packaged Node Factory Droid SDK: ${await runDroidConformance(api)} passed`)
