#!/bin/bash
# ClaudeBot installer for macOS. One line:
#
#   curl -fsSL https://raw.githubusercontent.com/perigeelabs2026/claudebot/main/install.sh | bash
#
# or, from a clone:  ./install.sh
#
# Walks through everything ClaudeBot needs and installs it into your home folder (no sudo):
#   1. Xcode Command Line Tools (macOS shows its own installer and this script waits for it)
#   2. Node.js 24 LTS            -> ~/.local/node   (checksum verified)
#   3. Claude Code (official)    -> ~/.local/bin/claude
#   4. OpenClaw + acpx plugin    -> ~/.local/bin/openclaw, profile "claudebot"
#   5. ClaudeBot engine and app  -> background service + /Applications/ClaudeBot.app
#   6. Claude sign-in            -> opens your browser once; uses your own Claude subscription
# Safe to run again any time (that is also how you update). Prints no secrets.
set -euo pipefail

REPO_URL="${CLAUDEBOT_REPO:-https://github.com/perigeelabs2026/claudebot.git}"
INSTALL_DIR="${CLAUDEBOT_DIR:-$HOME/ClaudeBot}"
NODE_VERSION="${CLAUDEBOT_NODE_VERSION:-24.21.0}"
OPENCLAW_VERSION="${CLAUDEBOT_OPENCLAW_VERSION:-2026.9.8}"
ACPX_PLUGIN="${CLAUDEBOT_ACPX_PLUGIN:-clawhub:@openclaw/acpx@2026.9.7}"
LOCAL="$HOME/.local"; BIN="$LOCAL/bin"; H="$HOME/.claudebot"
TOTAL=6

b()    { printf '\033[1m%s\033[0m' "$*"; }
step() { printf '\n\033[1m[%s/%s] %s\033[0m\n' "$1" "$TOTAL" "$2"; }
ok()   { printf '      \033[32m✓\033[0m %s\n' "$*"; }
info() { printf '      %s\n' "$*"; }
die()  { printf '\n\033[31m✗ %s\033[0m\n' "$1" >&2; [ -n "${2:-}" ] && printf '  How to fix: %s\n' "$2" >&2; printf '  Still stuck? Open an issue: https://github.com/perigeelabs2026/claudebot/issues\n' >&2; exit 1; }
trap 'die "The installer stopped unexpectedly (line $LINENO)." "Run it again; it picks up where it left off. If it fails at the same place, run ~/ClaudeBot/bin/claudebot doctor and include its output in an issue."' ERR

[ "$(uname -s)" = "Darwin" ] || die "ClaudeBot runs on macOS only." "Use a Mac with macOS 13 (Ventura) or newer."
[ "$(sw_vers -productVersion | cut -d. -f1)" -ge 13 ] || die "macOS $(sw_vers -productVersion) is too old." "Update to macOS 13 (Ventura) or newer in System Settings > General > Software Update."
case "$(uname -m)" in arm64) NODE_ARCH=arm64;; x86_64) NODE_ARCH=x64;; *) die "Unsupported processor: $(uname -m)";; esac
mkdir -p "$BIN"; export PATH="$BIN:$PATH"

printf '\n%s\n' "$(b 'Installing ClaudeBot')  ·  your AI team, running on your Mac and your Claude subscription"

step 1 "Xcode Command Line Tools"
if ! xcode-select -p >/dev/null 2>&1 || ! command -v swiftc >/dev/null 2>&1 || ! command -v git >/dev/null 2>&1; then
  info "macOS will show a window asking to install the Command Line Tools. Click $(b Install) and accept."
  xcode-select --install >/dev/null 2>&1 || true
  info "Waiting for the install to finish (this can take several minutes)..."
  for _ in $(seq 1 720); do xcode-select -p >/dev/null 2>&1 && command -v swiftc >/dev/null 2>&1 && break; sleep 5; done
  command -v swiftc >/dev/null 2>&1 || die "The Command Line Tools did not finish installing." "Run xcode-select --install yourself, wait for it to finish, then run this installer again."
fi
ok "Command Line Tools ready"

# Running from curl | bash: get the source, then continue from inside it.
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
if [ -z "$SELF_DIR" ] || [ ! -f "$SELF_DIR/install/install.sh" ]; then
  if [ -d "$INSTALL_DIR/.git" ]; then info "Updating $INSTALL_DIR"; git -C "$INSTALL_DIR" pull --ff-only -q || die "Could not update $INSTALL_DIR." "You have local changes there. Commit or discard them, or move the folder, and run again."
  else info "Downloading ClaudeBot to $INSTALL_DIR"; git clone -q "$REPO_URL" "$INSTALL_DIR" || die "Could not download ClaudeBot." "Check your internet connection and try again."; fi
  trap - ERR; exec bash "$INSTALL_DIR/install.sh" "$@"
fi
SRC="$SELF_DIR"

step 2 "Node.js"
node_ok() { [ -x "$BIN/node" ] && "$BIN/node" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit((a===24&&b>=16)||(a===26&&b>=1)||a>26?0:1)' 2>/dev/null; }
if node_ok; then ok "Node.js $("$BIN/node" -v) already installed"; else
  info "Downloading Node.js $NODE_VERSION..."
  TMP="$(mktemp -d)"; TARBALL="node-v$NODE_VERSION-darwin-$NODE_ARCH.tar.gz"
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/$TARBALL" -o "$TMP/$TARBALL" || die "Could not download Node.js." "Check your internet connection and try again."
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" -o "$TMP/SHASUMS256.txt"
  (cd "$TMP" && grep " $TARBALL\$" SHASUMS256.txt | shasum -a 256 -c - >/dev/null) || die "The Node.js download was corrupted." "Run the installer again."
  rm -rf "$LOCAL/node"; mkdir -p "$LOCAL/node"; tar -xzf "$TMP/$TARBALL" -C "$LOCAL/node" --strip-components 1; rm -rf "$TMP"
  for x in node npm npx; do ln -sf "$LOCAL/node/bin/$x" "$BIN/$x"; done
  ok "Node.js $("$BIN/node" -v) installed"
fi

step 3 "Claude Code"
if [ -x "$BIN/claude" ]; then ok "Claude Code $("$BIN/claude" --version 2>/dev/null | head -1) already installed"; else
  info "Installing the official Claude Code..."
  curl -fsSL https://claude.ai/install.sh | bash >/dev/null || die "Could not install Claude Code." "Install it from https://docs.claude.com/en/docs/claude-code/setup so that ~/.local/bin/claude exists, then run again."
  [ -x "$BIN/claude" ] || die "Claude Code installed somewhere other than ~/.local/bin/claude." "Link it there: ln -s \"\$(command -v claude)\" ~/.local/bin/claude"
  ok "Claude Code $("$BIN/claude" --version 2>/dev/null | head -1) installed"
fi

step 4 "OpenClaw gateway"
if [ -x "$BIN/openclaw" ] && "$BIN/openclaw" --version 2>/dev/null | grep -q "$OPENCLAW_VERSION"; then ok "OpenClaw $OPENCLAW_VERSION already installed"; else
  info "Installing OpenClaw $OPENCLAW_VERSION..."
  "$BIN/npm" install -g --silent --no-fund --no-audit --prefix "$LOCAL" "openclaw@$OPENCLAW_VERSION" >/dev/null || die "Could not install OpenClaw." "Check your internet connection and run again."
  ok "OpenClaw $OPENCLAW_VERSION installed"
fi
OCFG="$HOME/.openclaw-claudebot/openclaw.json"
if [ ! -s "$OCFG" ]; then mkdir -p "$(dirname "$OCFG")"; echo '{}' > "$OCFG"; chmod 600 "$OCFG"; fi
if [ ! -d "$HOME/.openclaw-claudebot/extensions/acpx" ]; then
  info "Adding the acpx plugin (connects OpenClaw to Claude Code)..."
  "$BIN/openclaw" --profile claudebot plugins install "$ACPX_PLUGIN" >/dev/null || die "Could not install the acpx plugin." "Run: ~/.local/bin/openclaw --profile claudebot plugins install $ACPX_PLUGIN"
fi
ok "acpx plugin ready"

step 5 "ClaudeBot engine and app"
info "Building the app and starting the background engine..."
mkdir -p "$H/backups"
if lsof -nP -iTCP:"${CLAUDEBOT_PORT:-48311}" -sTCP:LISTEN -Fc 2>/dev/null | grep '^c' | grep -qv '^cnode'; then die "Port ${CLAUDEBOT_PORT:-48311} is used by another app." "Quit the app using it (lsof -iTCP:${CLAUDEBOT_PORT:-48311} shows which), then run again."; fi
"$SRC/install/install.sh" || die "The engine did not start." "Run $SRC/bin/claudebot doctor to see what is wrong."
ln -sf "$SRC/bin/claudebot" "$BIN/claudebot"
ok "Engine running, app installed in Applications"

step 6 "Sign in to Claude"
signed_in() { CLAUDE_CONFIG_DIR="$H/claude" "$BIN/claude" auth status 2>/dev/null | "$BIN/node" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.exit(JSON.parse(s).loggedIn?0:1)}catch{process.exit(1)}})' 2>/dev/null; }
if signed_in; then ok "Already signed in"; else
  info "ClaudeBot uses your own Claude Pro or Max plan through the official Claude Code."
  info "Your browser will open. Sign in to Claude and approve, then come back here."
  if [ -r /dev/tty ]; then CLAUDE_CONFIG_DIR="$H/claude" "$BIN/claude" auth login --claudeai </dev/tty || true; fi
  if signed_in; then ok "Signed in"; else info "Not signed in yet. Run $(b 'claudebot login') whenever you are ready; ClaudeBot waits for you."; fi
fi
trap - ERR

case ":$PATH:" in *":$BIN:"*) ;; *) SHELLRC="$HOME/.zshrc"; [ "${SHELL##*/}" = bash ] && SHELLRC="$HOME/.bash_profile"
  grep -qs 'HOME/.local/bin' "$SHELLRC" || echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$SHELLRC";; esac

open "/Applications/ClaudeBot.app" 2>/dev/null || true
cat <<EOF

$(b '✓ ClaudeBot is ready.') It is opening now (find it any time in Applications).

  First steps
    1. Say hello to your Chief of Staff and tell it what you are working on.
    2. Ask for something real, e.g. "Research the best CRM for a 3-person team and write me a one-page summary."
    3. Watch the office on the right: click anyone to see what they are doing.

  Handy commands (open a new Terminal window first)
    claudebot doctor    check everything and show fixes
    claudebot login     sign in to Claude again
    claudebot update    get the latest version

EOF
