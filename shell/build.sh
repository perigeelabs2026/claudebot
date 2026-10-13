#!/bin/bash
# Builds dist/ClaudeBot.app with swiftc (no Xcode project needed) and signs it ad-hoc.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; APP="$ROOT/dist/ClaudeBot.app"; BIN="$APP/Contents/MacOS"
rm -rf "$APP"; mkdir -p "$BIN" "$APP/Contents/Resources"
swiftc -O -target "$(uname -m)-apple-macos13.0" -framework Cocoa -framework WebKit -framework AVFoundation -framework Speech -o "$BIN/ClaudeBot" "$ROOT/shell/Sources/main.swift" "$ROOT/shell/Sources/voice.swift"
cp "$ROOT/shell/Resources/Info.plist" "$APP/Contents/Info.plist"
echo -n 'APPL????' > "$APP/Contents/PkgInfo"
# A stable local identity (CLAUDEBOT_SIGN_IDENTITY, e.g. a self-signed certificate) keeps macOS privacy grants (microphone,
# speech recognition) across rebuilds: TCC keys ad-hoc apps by their code hash, which changes on every build.
if [ -n "${CLAUDEBOT_SIGN_IDENTITY:-}" ] && security find-identity -v -p codesigning | grep -q "\"$CLAUDEBOT_SIGN_IDENTITY\""; then
  codesign --force --sign "$CLAUDEBOT_SIGN_IDENTITY" --identifier com.claudebot.app "$APP" >/dev/null 2>&1 || { echo "identity signing failed; ad-hoc"; codesign --force --sign - --identifier com.claudebot.app "$APP" >/dev/null 2>&1; }
else
  codesign --force --sign - --identifier com.claudebot.app "$APP" >/dev/null 2>&1 || echo "ad-hoc codesign skipped"
fi
echo "built: $APP"; codesign -dv "$APP" 2>&1 | grep -E 'Identifier|Signature' || true
