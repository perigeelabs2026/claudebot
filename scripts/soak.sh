#!/bin/bash
# Long soak against a fresh engine with the simulated runtime (default 30 minutes). Asserts heartbeats, no phantom busy agents, no orphans.
set -euo pipefail
cd "$(dirname "$0")/../engine"
CLAUDEBOT_SOAK_MS="${CLAUDEBOT_SOAK_MS:-1800000}" node --test --test-name-pattern='soak' test/recovery/recovery.test.ts
