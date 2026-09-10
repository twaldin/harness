import * as api from '../dist/index.js'
import { clineConformance } from './cline-sdk-conformance.mjs'
await clineConformance(api)
console.log('Packaged Node Cline SDK conformance passed')
