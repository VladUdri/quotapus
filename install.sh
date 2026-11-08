#!/usr/bin/env bash
# Public repo:  curl -fsSL https://raw.githubusercontent.com/VladUdri/quotapus/main/install.sh | bash
# Private repo: gh api repos/VladUdri/quotapus/contents/install.sh -H "Accept: application/vnd.github.raw" | bash
#
# No Node or npm needed: we download the prebuilt app from the latest GitHub release,
# plus the official Electron runtime (checksum-verified).
set -euo pipefail

REPO="VladUdri/quotapus"
DIR="$HOME/.quotapus"
BIN="$HOME/.local/bin"

[ "$(uname)" = "Darwin" ] || { echo "quotapus is macOS only."; exit 1; }
case "$(uname -m)" in arm64) ARCH=arm64 ;; x86_64) ARCH=x64 ;; *) echo "Unsupported CPU: $(uname -m)"; exit 1 ;; esac

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
pkill -f "$DIR/electron/Electron.app" 2>/dev/null || true   # stop the old version if running

echo "Downloading quotapus..."
# Public repo: plain curl. Private repo: fall back to the GitHub CLI (`gh`), if logged in.
if ! curl -fsSL "https://github.com/$REPO/releases/latest/download/quotapus-app.tar.gz" -o "$TMP/app.tgz" 2>/dev/null; then
  if ! { command -v gh >/dev/null && gh release download -R "$REPO" -p quotapus-app.tar.gz -O "$TMP/app.tgz"; }; then
    echo "Couldn't download the latest release."; exit 1
  fi
fi
mkdir "$TMP/app" && tar xzf "$TMP/app.tgz" -C "$TMP/app"

# Which Electron does this version of the app need? (pinned in package.json)
EV="$(sed -n 's/.*"electron": "\([^"]*\)".*/\1/p' "$TMP/app/package.json")"
mkdir -p "$DIR" "$BIN"
if [ "$(cat "$DIR/electron/.version" 2>/dev/null)" != "$EV-$ARCH" ]; then
  echo "Downloading Electron $EV ($ARCH)..."
  ZIP="electron-v$EV-darwin-$ARCH.zip"
  BASE="https://github.com/electron/electron/releases/download/v$EV"
  curl -fSL --progress-bar "$BASE/$ZIP" -o "$TMP/$ZIP"
  # Verify the download against Electron's published checksums before running anything from it.
  EXPECT="$(curl -fsSL "$BASE/SHASUMS256.txt" | grep " \*$ZIP\$" | cut -d' ' -f1)"
  [ -n "$EXPECT" ] && [ "$(shasum -a 256 "$TMP/$ZIP" | cut -d' ' -f1)" = "$EXPECT" ] || { echo "Checksum mismatch, aborting."; exit 1; }
  rm -rf "$DIR/electron" && mkdir "$DIR/electron" && unzip -q "$TMP/$ZIP" -d "$DIR/electron"
  echo "$EV-$ARCH" > "$DIR/electron/.version"
fi

rm -rf "$DIR/app" && mv "$TMP/app" "$DIR/app"
# Swap Electron's default icon for ours (shown in notifications and Activity Monitor).
cp "$DIR/app/assets/icon.icns" "$DIR/electron/Electron.app/Contents/Resources/electron.icns" 2>/dev/null || true

# The `quotapus` command.
cat > "$BIN/quotapus" <<'L'
#!/usr/bin/env bash
DIR="$HOME/.quotapus"
EL="$DIR/electron/Electron.app"
case "${1:-start}" in
  start)  pgrep -f "$EL" >/dev/null && { echo "quotapus is already running (look in your menu bar)."; exit 0; }
          nohup "$EL/Contents/MacOS/Electron" "$DIR/app" >/dev/null 2>&1 & disown; echo "quotapus started. Look for the gauge icon in your menu bar." ;;
  stop)   pkill -f "$EL" && echo stopped || echo "not running" ;;
  update) { curl -fsSL "https://raw.githubusercontent.com/VladUdri/quotapus/main/install.sh" 2>/dev/null \
            || gh api repos/VladUdri/quotapus/contents/install.sh -H "Accept: application/vnd.github.raw"; } | bash ;;
  uninstall)
          pkill -f "$EL" 2>/dev/null
          # If "Read limits from Claude Code" was on, give Claude Code its original status line back
          # before the shim it points to is deleted. Uses Electron as a plain Node runtime.
          ELECTRON_RUN_AS_NODE=1 "$EL/Contents/MacOS/Electron" -e '
            const path = require("path"), os = require("os");
            const settings = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "settings.json");
            try { require(path.join(process.argv[1], "dist/statusline.js")).disable(settings, path.join(os.homedir(), "Library/Application Support/quotapus")); } catch (e) {}
          ' "$DIR/app" 2>/dev/null
          rm -rf "$DIR" "$HOME/Library/Application Support/quotapus" "$HOME/Library/LaunchAgents/dev.quotapus.plist" "$0"
          echo "quotapus removed." ;;
  *)      echo "usage: quotapus [start|stop|update|uninstall]" ;;
esac
L
chmod +x "$BIN/quotapus"

case ":$PATH:" in
  *":$BIN:"*) ;;
  *) echo "export PATH=\"$BIN:\$PATH\"" >> "$HOME/.zshrc"; export PATH="$BIN:$PATH"
     echo "Added $BIN to PATH in ~/.zshrc (open a new terminal to use \`quotapus\`)." ;;
esac

"$BIN/quotapus" start
echo
echo "Done. Commands: quotapus [start|stop|update|uninstall]"
echo "Tip: open the popup, click the gear, and enable 'Launch at login'."
