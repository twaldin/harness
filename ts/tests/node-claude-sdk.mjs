import * as harness from '../dist/index.js'
import { claudeConformance } from './claude-sdk-conformance.mjs'

await claudeConformance(harness)
