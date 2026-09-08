import { test } from 'bun:test'
import * as api from '../src/index.js'
import { runOpenCodeConformance } from './opencode-conformance.mjs'

test('caller-owned OpenCode HTTP/SSE conformance', async () => {
  await runOpenCodeConformance(api)
}, 90_000)
