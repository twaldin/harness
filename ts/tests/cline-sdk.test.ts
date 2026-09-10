import { test } from 'bun:test'
import * as api from '../src/index.js'
import { clineConformance } from './cline-sdk-conformance.mjs'

test('Cline SDK native session conformance', async () => {
  await clineConformance(api)
}, 120_000)
