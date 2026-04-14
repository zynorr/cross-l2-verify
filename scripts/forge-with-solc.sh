#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: forge-with-solc.sh <forge-subcommand> [args...]" >&2
  exit 1
fi

if [[ -n "${SOLC_BINARY:-}" ]]; then
  exec forge "$1" --use "$SOLC_BINARY" "${@:2}"
fi

exec forge "$@"
