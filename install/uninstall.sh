#!/bin/bash
# Removes the ClaudeBot engine LaunchAgent, its gateway service and the app. Keeps your data in ~/.claudebot unless --purge.
set -euo pipefail
launchctl bootout "gui/$(id -u)/com.claudebot.engine" 2>/dev/null || true; rm -f "$HOME/Library/LaunchAgents/com.claudebot.engine.plist"
"${CLAUDEBOT_OPENCLAW_BIN:-$HOME/.local/bin/openclaw}" --profile claudebot gateway uninstall 2>/dev/null || true
rm -rf "/Applications/ClaudeBot.app"
if [ "${1:-}" = "--purge" ]; then rm -rf "$HOME/.claudebot" "$HOME/.openclaw-claudebot"; echo "Deleted ~/.claudebot and ~/.openclaw-claudebot"; else echo "Kept your data in ~/.claudebot (delete it with --purge)"; fi
echo "ClaudeBot uninstalled."
