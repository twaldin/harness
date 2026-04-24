#!/usr/bin/env bash
set -euo pipefail

required=(codex opencode pi cn droid openclaude)
optional=(kilo crush)

echo "required binaries"
for bin in "${required[@]}"; do
  printf '  %-12s' "$bin"
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "MISSING"
    continue
  fi
  version="$($bin --version 2>/dev/null || $bin -v 2>/dev/null || echo 'version-unknown')"
  echo "OK    ${version%%$'\n'*}"
done

echo
echo "optional binaries"
for bin in "${optional[@]}"; do
  printf '  %-12s' "$bin"
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "missing"
    continue
  fi
  version="$($bin --version 2>/dev/null || $bin -v 2>/dev/null || echo 'version-unknown')"
  echo "OK    ${version%%$'\n'*}"
done

echo
echo "mini-swe wrapper"
for wrapper in "${SWE_WRAPPER:-}" "$HOME/agentelo/bin/run-mini-swe.py"; do
  [ -n "$wrapper" ] || continue
  if [ -f "$wrapper" ]; then
    echo "  OK    $wrapper"
    exit 0
  fi
done
echo "  missing (set SWE_WRAPPER or install ~/agentelo/bin/run-mini-swe.py)"
