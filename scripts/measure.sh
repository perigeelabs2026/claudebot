#!/bin/bash
# Resource use of the installed product: RSS and CPU of engine, workers, ClaudeBot gateway, and any Claude adapter processes.
# Usage: scripts/measure.sh [label]
set -euo pipefail
label="${1:-now}"
echo "== $label ($(date -u +%FT%TZ)) =="
printf "%-10s %-8s %-6s %s\n" PID RSS_MB CPU% COMMAND
ps -eo pid,rss,%cpu,command | /usr/bin/grep -E 'supervisor/main.ts|worker/main.ts|openclaw/dist/index.js gateway|claude-agent-acp/dist/index.js|\.local/bin/claude --output-format' | /usr/bin/grep -v grep | awk '{printf "%-10s %-8.1f %-6s ", $1, $2/1024, $3; for(i=4;i<=NF;i++) printf "%s ", $i; printf "\n"}' | cut -c1-150
ps -eo rss,command | /usr/bin/grep -E 'supervisor/main.ts|worker/main.ts|openclaw/dist/index.js gateway|claude-agent-acp/dist/index.js' | /usr/bin/grep -v grep | awk '{s+=$1} END {printf "total RSS: %.1f MB\n", s/1024}'
