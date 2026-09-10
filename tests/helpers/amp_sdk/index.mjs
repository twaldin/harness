// Synthetic SDK public API; it launches only the explicitly selected fixture
// CLI. This exercises the real Harness worker and its owned-child guards.
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

function launch(args) {
  const child = spawn(process.execPath, [process.env.AMP_CLI_PATH, ...args], { stdio: ['pipe', 'pipe', 'pipe'] })
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
  closed.catch(() => {})
  return { child, closed }
}
async function command(args) {
  const { child, closed } = launch(args)
  child.stdin.end()
  let output = ''
  for await (const chunk of child.stdout) output += chunk.toString()
  const { code } = await closed
  if (code !== 0) throw new Error(`Amp CLI process exited with code ${code}`)
  return output.trim()
}
export const threads = {
  new: options => command(['threads', 'new', ...(options.visibility ? ['--visibility', options.visibility] : [])]),
  markdown: options => command(['threads', 'markdown', options.threadId]),
}
export async function* execute({ prompt, options }) {
  const { child, closed } = launch(['threads', 'continue', options.continue, '--execute', '--stream-json', '--mode', options.mode, '--no-archive-after-execute', ...(options.effort ? ['--effort', options.effort] : []), ...(options.settingsFile ? ['--settings-file', options.settingsFile] : [])])
  child.stdin.end(prompt + '\n')
  const input = createInterface({ input: child.stdout, crlfDelay: Infinity })
  try {
    for await (const line of input) yield JSON.parse(line)
    const { code, signal } = await closed
    if (signal) throw new Error(`Amp CLI process was killed by signal ${signal}`)
    if (code !== 0) throw new Error(`Amp CLI process exited with code ${code}`)
  } finally { input.close() }
}
