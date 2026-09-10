import { test } from 'bun:test'
import * as harness from '../src/index.js'
import { claudeConformance } from './claude-sdk-conformance.mjs'

test('Claude SDK native-protocol conformance', async () => {
  await claudeConformance(harness)
}, 120_000)
