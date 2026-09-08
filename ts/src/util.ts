// Shared utilities for session-aware adapter implementations.

const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '')
}

export function lastLines(s: string, n: number): string[] {
  const stripped = stripAnsi(s)
  return stripped.split('\n').map(l => l.trimEnd()).slice(-n)
}

export function lastNonEmptyJoin(s: string, n: number): string {
  return stripAnsi(s).split('\n').map(l => l.trim()).filter(Boolean).slice(-n).join('\n')
}

/**
 * Complete JSON objects from a JSON Lines stream, in order. Blank, malformed
 * and truncated lines are dropped, as are valid non-object values; JSON.parse
 * already rejects the non-standard NaN/Infinity constants. A complete final
 * line needs no trailing newline.
 */
export function parseJsonObjectLines(stdout: string): object[] {
  const objects: object[] = []
  for (const line of stdout.split('\n')) {
    const s = line.trim()
    if (!s) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(s)
    } catch {
      continue
    }
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) objects.push(parsed)
  }
  return objects
}
