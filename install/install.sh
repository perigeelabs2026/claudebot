#!/bin/bash
# Installs the ClaudeBot engine and app for the current user (called by ../install.sh after prerequisites are in place):
# runtime dirs, local tokens, Claude Code settings, the OpenClaw "claudebot" gateway profile and service, the engine
# LaunchAgent (com.claudebot.engine) and /Applications/ClaudeBot.app. Idempotent. Prints no secrets.
set -euo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"; H="$HOME/.claudebot"; umask 077
OC="${CLAUDEBOT_OPENCLAW_BIN:-$HOME/.local/bin/openclaw}"; NODE="$HOME/.local/bin/node"; PORT="${CLAUDEBOT_PORT:-48311}"
mkdir -p "$H"/{data,secrets,run,logs,backups,workspaces,claude}; chmod 700 "$H" "$H/secrets" "$H/run"
[ -s "$H/secrets/ui.token" ] || python3 -c 'import secrets;print(secrets.token_urlsafe(36))' > "$H/secrets/ui.token"
[ -s "$H/secrets/gateway.token" ] || python3 -c 'import secrets;print(secrets.token_urlsafe(36))' > "$H/secrets/gateway.token"
chmod 600 "$H"/secrets/*.token
cp "$SRC/install/claude-settings.json" "$H/claude/settings.json"; chmod 600 "$H/claude/settings.json"
(cd "$SRC/engine" && { npm ci --silent >/dev/null 2>&1 || npm install --silent >/dev/null; })
"$SRC/install/openclaw-profile.sh" >/dev/null
"$OC" --profile claudebot gateway install --runtime-path "$NODE" --force >/dev/null 2>&1 || "$OC" --profile claudebot gateway install --runtime-path "$NODE" >/dev/null
for _ in $(seq 1 30); do sleep 1; "$OC" --profile claudebot gateway health >/dev/null 2>&1 && break; done
"$OC" --profile claudebot browser create-profile --name claudebot >/dev/null 2>&1 || true
PL="$HOME/Library/LaunchAgents/com.claudebot.engine.plist"; mkdir -p "$(dirname "$PL")"
sed -e "s|@SRC@|$SRC|g" -e "s|@HOME@|$HOME|g" "$SRC/install/launchd/com.claudebot.engine.plist.tmpl" > "$PL"; chmod 644 "$PL"
launchctl bootout "gui/$(id -u)/com.claudebot.engine" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PL"
launchctl kickstart -k "gui/$(id -u)/com.claudebot.engine"
"$SRC/shell/build.sh" >/dev/null
rm -rf "/Applications/ClaudeBot.app"; ln -s "$SRC/dist/ClaudeBot.app" "/Applications/ClaudeBot.app" 2>/dev/null || cp -R "$SRC/dist/ClaudeBot.app" "/Applications/ClaudeBot.app"
for _ in $(seq 1 40); do sleep 1; curl -sf -H "x-claudebot-token: $(cat "$H/secrets/ui.token")" "http://127.0.0.1:$PORT/api/health" >/dev/null && exit 0; done
echo "The ClaudeBot engine did not answer on 127.0.0.1:$PORT. Run: $SRC/bin/claudebot doctor" >&2; exit 1
