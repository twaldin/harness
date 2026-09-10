import { test } from 'bun:test'
import * as api from '../src/index.js'
import { runOpenHandsConformance } from './openhands-conformance.mjs'

test('caller-owned OpenHands Agent Server HTTP/WebSocket conformance', async () => {
  await runOpenHandsConformance(api)
}, 120_000)
