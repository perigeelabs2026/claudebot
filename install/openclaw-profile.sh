#!/bin/bash
# Applies the ClaudeBot configuration to the isolated OpenClaw `claudebot` profile. Idempotent. Prints no secrets.
set -euo pipefail
OC="${CLAUDEBOT_OPENCLAW_BIN:-$HOME/.local/bin/openclaw}"
PROFILE="${CLAUDEBOT_OPENCLAW_PROFILE:-claudebot}"
HOME_DIR="${CLAUDEBOT_HOME:-$HOME/.claudebot}"
SRC="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${CLAUDEBOT_GATEWAY_PORT:-48310}"
CFG="$HOME/.openclaw-$PROFILE/openclaw.json"
oc() { "$OC" --profile "$PROFILE" "$@"; }
umask 077
mkdir -p "$HOME_DIR/secrets" "$HOME_DIR/workspaces" "$HOME_DIR/run" "$HOME_DIR/logs"
if [ ! -s "$HOME_DIR/secrets/gateway.token" ]; then python3 -c 'import secrets;print(secrets.token_urlsafe(36))' > "$HOME_DIR/secrets/gateway.token"; fi
chmod 600 "$HOME_DIR/secrets/gateway.token"
cp -p "$CFG" "$HOME_DIR/backups/openclaw.json.$(date +%Y%m%d%H%M%S).bak" 2>/dev/null || true

ROLES="control parity"
for r in $ROLES; do mkdir -p "$HOME_DIR/workspaces/_$r"; done

python3 - "$CFG" "$HOME_DIR" "$SRC" "$PORT" "$ROLES" <<'PY'
import json, sys, os
cfg_path, home, src, port, roles = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4]), sys.argv[5].split()
cfg = json.load(open(cfg_path))
def setp(d, path, value):
    cur = d
    for k in path[:-1]:
        cur = cur.setdefault(k, {})
    cur[path[-1]] = value
# Gateway: loopback, token via file SecretRef (never plaintext in config)
setp(cfg, ['gateway','mode'], 'local'); setp(cfg, ['gateway','bind'], 'loopback'); setp(cfg, ['gateway','port'], port)
setp(cfg, ['secrets','providers','claudebot'], {'source':'file','path': os.path.join(home,'secrets','gateway.token'),'mode':'singleValue'})
setp(cfg, ['gateway','auth','mode'], 'token')
setp(cfg, ['gateway','auth','token'], {'source':'file','provider':'claudebot','id':'value'})
# ACP: Claude only
setp(cfg, ['acp'], {'enabled': True, 'dispatch': {'enabled': True}, 'backend': 'acpx', 'defaultAgent': 'claude', 'allowedAgents': ['claude'], 'stream': {'deliveryMode': 'live'}})
# acpx plugin: wrapper command, conservative permissions, Claude as probe agent
setp(cfg, ['plugins','entries','acpx','enabled'], True)
setp(cfg, ['plugins','entries','acpx','config'], {
    'permissionMode': 'approve-reads', 'nonInteractivePermissions': 'deny', 'probeAgent': 'claude', 'timeoutSeconds': 180,
    'pluginToolsMcpBridge': False, 'openClawToolsMcpBridge': False,
    'agents': {'claude': {'command': os.path.join(src,'bin','claude-acp'), 'args': []}},
})
# No OpenAI/Codex route, no local llama
for pid in ['codex','agentsapi','openai','llama-cpp','migrate-claude']:
    setp(cfg, ['plugins','entries',pid,'enabled'], False)
# Native default model must not be OpenAI; the product never issues native turns.
setp(cfg, ['agents','defaults','model'], 'anthropic/claude-opus-5-5')
setp(cfg, ['agents','defaults','workspace'], os.path.join(home,'workspaces','_control'))
setp(cfg, ['agents','defaults','heartbeat'], {'every': '0m'})
setp(cfg, ['agents','defaults','subagents'], {'runTimeoutSeconds': 3600})
# The product never issues native OpenClaw tool turns; ACP harness sessions run on the host and are blocked from sandboxed
# requesters, so the OpenClaw Docker sandbox is off for these agents. Claude Code's confinement is its own permission rules + the broker.
setp(cfg, ['agents','defaults','sandbox'], {'mode': 'off'})
cfg.setdefault('agents',{}).setdefault('entries',{})
# Control sessions carry only gateway-local /acp commands (never model turns); one for the product, one for the parity runner.
for r in roles:
    cfg['agents']['entries'][r] = {'workspace': os.path.join(home,'workspaces','_'+r), 'sandbox': {'mode': 'off'}}
# Retire the old per-role entries from the revenue build.
for old in ['chief_of_staff','market_research','offer_product','gtm_strategy','revenue_ops','content_campaigns','sales','customer_success','finance_ops','reviewer']:
    cfg['agents']['entries'].pop(old, None)
# Free ACP spawns are keyed agent:<harness>:acp:<uuid>; the owning OpenClaw agent must exist. Per-job cwd is set at spawn time.
cfg['agents']['entries']['claude'] = {'workspace': os.path.join(home,'workspaces','_control'), 'sandbox': {'mode': 'off'}, 'runtime': {'type':'acp','acp': {'agent':'claude','backend':'acpx','mode':'persistent','cwd': os.path.join(home,'workspaces')}}}
setp(cfg, ['agents','ownership'], 'explicit')
# Browser: managed dedicated profile only; no system-profile import
setp(cfg, ['browser','enabled'], True); setp(cfg, ['browser','defaultProfile'], 'claudebot'); setp(cfg, ['browser','allowSystemProfileImport'], False)
# Keep the rest locked down
setp(cfg, ['cron','enabled'], False); setp(cfg, ['tools','elevated','enabled'], False)
setp(cfg, ['memory','search','enabled'], False); setp(cfg, ['telemetry','enabled'], False)
tmp = cfg_path + '.tmp'; json.dump(cfg, open(tmp,'w'), indent=2); os.chmod(tmp, 0o600); os.replace(tmp, cfg_path)
print('ClaudeBot gateway config written (no secrets printed)')
PY
oc config validate 2>&1 | tail -5
oc secrets audit 2>&1 | tail -12
