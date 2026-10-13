#!/bin/bash
# Parity certification on an isolated temporary engine home. Never writes to the production database.
set -euo pipefail
cd "$(dirname "$0")/.."
exec "${CLAUDEBOT_NODE:-$HOME/.local/bin/node}" parity/run.ts "$@"
