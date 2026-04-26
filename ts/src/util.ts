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
