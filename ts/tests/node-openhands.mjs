import * as api from '../dist/index.js'
import { runOpenHandsConformance } from './openhands-conformance.mjs'

console.log(`Packaged Node OpenHands: ${await runOpenHandsConformance(api)} passed`)
