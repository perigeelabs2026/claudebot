#!/bin/bash
# Phase 2 runtime inside the assistants' computer: pinned Node, OpenClaw + acpx, the Claude ACP adapter, official native Claude Code,
# the OpenClaw gateway service (VM loopback, token-protected) and the claudebot tool bridge. Idempotent; versions from versions.json.
set -eux -o pipefail
V=/etc/claudebot/versions.json; U=$(systemctl show -p User --value computerd); [ -n "$U" ] || U=$(id -un 1000)
HOME_U=$(getent passwd "$U" | cut -d: -f6); D=$(ls -d /mnt/lima-*-data | head -1)
NODE_V=$(jq -r .node.version $V); NODE_SHA=$(jq -r .node.sha256_linux_arm64 $V)
if [ "$(/opt/node/bin/node --version 2>/dev/null)" != "$NODE_V" ]; then
  curl -fsSLo /tmp/node.tar.xz "https://nodejs.org/dist/$NODE_V/node-$NODE_V-linux-arm64.tar.xz"; echo "$NODE_SHA  /tmp/node.tar.xz" | sha256sum -c -
  rm -rf /opt/node && mkdir -p /opt/node && tar -xJf /tmp/node.tar.xz -C /opt/node --strip-components=1 && rm /tmp/node.tar.xz
fi
export PATH=/opt/node/bin:$PATH
OC=$(jq -r .runtime.openclaw $V); [ "$(openclaw --version 2>/dev/null | grep -o '[0-9.]*' | head -1)" = "$OC" ] || npm install -g --no-fund --no-audit --prefix /opt/node "openclaw@$OC"
install -d -m 755 /opt/claudebot/bin /opt/claudebot/acp
[ "$(jq -r .version /opt/claudebot/acp/node_modules/@agentclientprotocol/claude-agent-acp/package.json 2>/dev/null)" = "$(jq -r .runtime.claude_agent_acp $V)" ] || npm install --prefix /opt/claudebot/acp --no-fund --no-audit "@agentclientprotocol/claude-agent-acp@$(jq -r .runtime.claude_agent_acp $V)"
install -m 755 /etc/claudebot/claude-acp /opt/claudebot/bin/claude-acp; install -m 755 /etc/claudebot/chromium-wayland /opt/claudebot/bin/chromium-wayland; install -m 644 /etc/claudebot/broker-bridge.mjs /opt/claudebot/broker-bridge.mjs
CC=$(jq -r .runtime.claude_code $V); [ "$(sudo -u "$U" "$HOME_U/.local/bin/claude" --version 2>/dev/null | cut -d' ' -f1)" = "$CC" ] || sudo -u "$U" bash -c "curl -fsSL https://claude.ai/install.sh -o /tmp/claude-install.sh && bash /tmp/claude-install.sh $CC"
install -d -o "$U" -m 700 "$D/claude" "$D/openclaw" "$D/secrets" "$D/logs" "$D/workspace" "$D/workspace/_control"
# Build tasks: the checks (npm ci, tests, typecheck) run as a builder uid with no sudo that cannot read $D/secrets, the clone's .git
# or other worktrees; $D/repos is traverse-only so the builder reaches only the worktree it was handed.
id claudebot-builder >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/claudebot-builder --shell /bin/bash claudebot-builder
install -d -o "$U" -m 711 "$D/repos"
[ -s "$D/secrets/gateway.token" ] || (umask 077; head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$D/secrets/gateway.token"); chown "$U" "$D/secrets/gateway.token"
sudo -u "$U" env OPENCLAW_STATE_DIR="$D/openclaw" PATH=$PATH bash -c "[ -d '$D/openclaw/npm/projects' ] && ls '$D/openclaw/npm/projects' | grep -q acpx || openclaw --profile computer plugins install $(jq -r .runtime.acpx_plugin $V)"
install -o "$U" -m 600 /etc/claudebot/openclaw.json "$D/openclaw/openclaw.json"
install -d -o "$U" -m 700 "$D/tmp"; echo "d /tmp/openclaw 0755 root root -" > /etc/tmpfiles.d/claudebot-openclaw.conf; systemd-tmpfiles --create /etc/tmpfiles.d/claudebot-openclaw.conf; [ "$(stat -c %U /tmp/openclaw)" = root ] || { rm -rf /tmp/openclaw; install -d -o root -m 755 /tmp/openclaw; }
sed "s/__USER__/$U/; s/__UID__/$(id -u "$U")/" /etc/claudebot/openclaw-gateway.service > /etc/systemd/system/openclaw-gateway.service
systemctl daemon-reload; systemctl enable openclaw-gateway; systemctl restart openclaw-gateway
echo runtime-provisioned > /etc/claudebot/runtime-provisioned
