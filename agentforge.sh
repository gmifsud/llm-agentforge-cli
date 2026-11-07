#!/usr/bin/env bash
# agentforge — thin Bash forwarder to the Node core (src/cli/main.js).
# All logic lives in the core; this only locates node and forwards arguments.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if ! command -v node >/dev/null 2>&1; then
  echo "agentforge: node was not found on PATH (Node.js 20+ is required)" >&2
  exit 1
fi
exec node "$SCRIPT_DIR/src/cli/main.js" "$@"
