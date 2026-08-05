#!/usr/bin/env bash
set -e
DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)"
export PI_CODING_AGENT_DIR="$DIR/.pi-agent"
exec node "$DIR/pi/packages/coding-agent/dist/cli.js" "$@"
