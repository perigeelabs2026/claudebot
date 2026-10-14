#!/bin/bash
# Live checks for the builder uid, run inside the assistants' computer as its main user (claudebot computer exec, or ssh).
# 1. An unlisted host is refused, directly and through the proxy, and so are Anthropic and any resolver but the VM's.
# 2. Allowed hosts work through the proxy.
# 3. The builder cannot read the secret store or a clone's .git.
set -u; D=/mnt/lima-claudebot-computer-data; P=http://127.0.0.1:18799; fail=0
b() { sudo -n -u claudebot-builder -H "$@"; }
ok() { echo "PASS $1"; }; bad() { echo "FAIL $1"; fail=1; }
b curl -sS -m 5 -o /dev/null https://example.com 2>/dev/null && bad "direct egress to example.com" || ok "direct egress to example.com refused"
b curl -sS -m 5 -o /dev/null -x $P https://example.com 2>/dev/null && bad "proxy let example.com through" || ok "proxy refused example.com"
b curl -sS -m 10 -o /dev/null -x $P https://registry.npmjs.org/ && ok "npm reachable through the proxy" || bad "npm not reachable through the proxy"
b curl -sS -m 5 -o /dev/null -x $P https://api.anthropic.com/ 2>/dev/null && bad "proxy let Anthropic through" || ok "proxy refused Anthropic"
b timeout 5 bash -c '</dev/tcp/1.1.1.1/53' 2>/dev/null && bad "builder reached an outside resolver" || ok "outside resolver refused"
b getent ahostsv4 registry.npmjs.org >/dev/null && ok "names resolve through the VM's resolver" || bad "the VM's resolver is unreachable"
b timeout 5 bash -c '</dev/tcp/host.lima.internal/22' 2>/dev/null && bad "builder reached the host on a port other than the engine's" || ok "host ports other than the engine's refused"
b cat "$D/secrets/gateway.token" >/dev/null 2>&1 && bad "builder read the secret store" || ok "secret store unreadable"
for g in "$D"/repos/*/.git; do [ -d "$g" ] || continue; b ls "$g" >/dev/null 2>&1 && bad "builder read $g" || ok "$g unreadable"; done
exit $fail
