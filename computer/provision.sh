#!/bin/bash
# Provisioning for the assistants' computer (runs as root at first boot and on every `computer update`). Idempotent.
set -eux -o pipefail
export DEBIAN_FRONTEND=noninteractive
PKGS="$(cat /etc/claudebot/packages)"
apt-get update
apt-get install -y --no-install-recommends "linux-modules-extra-$(uname -r)" $PKGS
# 2 GiB compressed swap: a memory spike pages instead of killing the browser.
sed -i 's/^#\?SIZE=.*/SIZE='"$(cat /etc/claudebot/zram_mb)"'/; s/^#\?ALGO=.*/ALGO=zstd/; s/^PERCENT=.*//' /etc/default/zramswap; modprobe zram || true; systemctl restart zramswap || true
snap list chromium >/dev/null 2>&1 || snap install chromium
snap connect chromium:removable-media || true      # the browser profile lives on the data disk (/mnt)
# Nothing in the VM listens for the network except computerd (and Lima's own ssh): no printing service.
snap stop --disable cups 2>/dev/null || true; systemctl disable --now cups.service cups.socket cups-browsed.service 2>/dev/null || true
U=lima; UID_=$(id -u $U); loginctl enable-linger $U
DATA=$(ls -d /mnt/lima-*-data | head -1); install -d -o $U -g $U -m 700 $DATA/computerd $DATA/workspace $DATA/browser-profile
install -d -m 755 /opt/claudebot/computerd && install -m 644 /etc/claudebot/computerd.mjs /opt/claudebot/computerd/server.mjs
cat > /etc/systemd/system/computerd.service <<UNIT
[Unit]
Description=ClaudeBot computerd (token-guarded access to the assistants' computer)
After=network-online.target
[Service]
User=$U
Environment=COMPUTERD_TOKEN_FILE=$DATA/computerd/token
Environment=COMPUTERD_DATA=$DATA
Environment=COMPUTERD_HOST=127.0.0.1
Environment=COMPUTERD_SCREENS=$(cat /etc/claudebot/screens)
ExecStart=/usr/bin/node /opt/claudebot/computerd/server.mjs
Restart=always
RestartSec=2
[Install]
WantedBy=multi-user.target
UNIT
# The desktop: headless sway with one output per screen, and a VNC server per screen on guest loopback only.
UD=/home/$U.linux/.config/systemd/user; [ -d /home/$U.linux ] || UD=/home/$U/.config/systemd/user; install -d -o $U -g $U "$UD" "$(dirname "$UD")/sway"
N=$(cat /etc/claudebot/screens); CONF="$(dirname "$UD")/sway/config"; : > "$CONF"
for i in $(seq 1 $N); do echo "output HEADLESS-$i resolution 1280x800 position $(( (i-1)*1280 )) 0" >> "$CONF"; echo "workspace $i output HEADLESS-$i" >> "$CONF"; done
echo "default_border none" >> "$CONF"; chown $U:$U "$CONF"
cat > "$UD/sway.service" <<UNIT
[Unit]
Description=Headless sway for the assistants' screens
[Service]
Environment=WLR_BACKENDS=headless WLR_HEADLESS_OUTPUTS=$N WLR_LIBINPUT_NO_DEVICES=1 WLR_RENDERER=pixman
ExecStart=/usr/bin/sway -c $CONF
Restart=always
[Install]
WantedBy=default.target
UNIT
cat > "$UD/wayvnc@.service" <<'UNIT'
[Unit]
Description=VNC for screen %i (guest loopback only; computerd is the only way in)
After=sway.service
Requires=sway.service
[Service]
Environment=WAYLAND_DISPLAY=wayland-1
ExecStartPre=/bin/sleep 2
EnvironmentFile=-/run/user/%U/wayvnc-%i.env
ExecStartPre=/bin/sh -c '[ -f /run/user/%U/wayvnc-%i.env ] || echo WAYVNC_FLAGS=--disable-input > /run/user/%U/wayvnc-%i.env'
ExecStart=/bin/sh -c 'exec /usr/bin/wayvnc $WAYVNC_FLAGS -o HEADLESS-%i -S /run/user/%U/wayvnc-%i.sock 127.0.0.1 $((5899+%i))'
Restart=always
[Install]
WantedBy=default.target
UNIT
chown -R $U:$U "$UD"
systemctl daemon-reload; systemctl enable --now computerd; systemctl restart computerd
sudo -u $U XDG_RUNTIME_DIR=/run/user/$UID_ systemctl --user daemon-reload
sudo -u $U XDG_RUNTIME_DIR=/run/user/$UID_ systemctl --user enable --now sway.service
for i in $(seq 1 $N); do sudo -u $U XDG_RUNTIME_DIR=/run/user/$UID_ systemctl --user enable "wayvnc@$i.service"; sudo -u $U XDG_RUNTIME_DIR=/run/user/$UID_ systemctl --user restart "wayvnc@$i.service"; done
echo provisioned > /etc/claudebot/provisioned
