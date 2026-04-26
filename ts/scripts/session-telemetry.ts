import '../src/adapters/index.js'
import { getAdapter } from '../src/registry.js'

const [adapterName, method, arg] = process.argv.slice(2)
if (!adapterName || !method || !arg) {
  console.error('usage: bun ts/scripts/session-telemetry.ts <adapter> <sessionLogPath|parseSessionLog> <arg>')
  process.exit(2)
}

const adapter = getAdapter(adapterName)
if (method === 'sessionLogPath') {
  const out = adapter.sessionLogPath?.(arg) ?? null
  console.log(JSON.stringify(out))
  process.exit(0)
}
if (method === 'parseSessionLog') {
  const out = adapter.parseSessionLog?.(arg) ?? null
  console.log(JSON.stringify(out))
  process.exit(0)
}

console.error(`unknown method: ${method}`)
process.exit(2)
