import { test } from 'bun:test'
import * as api from '../src/index.js'
import { runDroidConformance } from './droid-sdk-conformance.mjs'

// `factory-droid` / `sdk`: the real optional @factory/droid-sdk 0.9.1 public
// DroidClient over a Harness-owned stdio transport, against the synthetic
// JSON-RPC peer ../../tests/helpers/droid_agent.py selected through
// `executable`. ../../tests/droid_sdk_cases.json lists the shared
// expectations that tests/test_droid_sdk.py mirrors.
test('Factory Droid SDK conformance', async () => {
  await runDroidConformance(api)
}, 180_000)
