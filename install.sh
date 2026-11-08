#!/usr/bin/env bash
# curl -fsSL https://raw.githubusercontent.com/VladUdri/quotapus/main/install.sh | bash
#
# Installs Quotapus.app into ~/Applications (so Spotlight finds it) and a `quotapus` command into ~/.local/bin.
# No Node or npm needed: it downloads the prebuilt app from the latest GitHub release plus the official
# Electron runtime (checksum-verified), and assembles them into a menu bar app (no Dock icon).
set -euo pipefail

REPO="VladUdri/quotapus"
APPDIR="$HOME/Applications"
APP="$APPDIR/Quotapus.app"
BIN="$HOME/.local/bin"

[ "$(uname)" = "Darwin" ] || { echo "quotapus is macOS only."; exit 1; }
case "$(uname -m)" in arm64) ARCH=arm64 ;; x86_64) ARCH=x64 ;; *) echo "Unsupported CPU: $(uname -m)"; exit 1 ;; esac

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
# Stop a running copy (current layout, and the older ~/.quotapus layout).
pkill -f "$APP/Contents" 2>/dev/null || true
pkill -f "$HOME/.quotapus/electron" 2>/dev/null || true

echo "Downloading quotapus..."
# Public repo: plain curl. Fallback: the GitHub CLI (`gh`), if logged in.
if ! curl -fsSL "https://github.com/$REPO/releases/latest/download/quotapus-app.tar.gz" -o "$TMP/app.tgz" 2>/dev/null; then
  if ! { command -v gh >/dev/null && gh release download -R "$REPO" -p quotapus-app.tar.gz -O "$TMP/app.tgz"; }; then
    echo "Couldn't download the latest release."; exit 1
  fi
fi
mkdir "$TMP/app" && tar xzf "$TMP/app.tgz" -C "$TMP/app"

# Which Electron does this version of the app need? (pinned in package.json)
EV="$(sed -n 's/.*"electron": "\([^"]*\)".*/\1/p' "$TMP/app/package.json")"
VERSION="$(sed -n 's/.*"version": "\([^"]*\)".*/\1/p' "$TMP/app/package.json" | head -1)"
mkdir -p "$APPDIR" "$BIN"

STAMP="$APP/Contents/Resources/.electron-version"
if [ "$(cat "$STAMP" 2>/dev/null)" != "$EV-$ARCH" ]; then
  echo "Downloading Electron $EV ($ARCH)..."
  ZIP="electron-v$EV-darwin-$ARCH.zip"
  BASE="https://github.com/electron/electron/releases/download/v$EV"
  curl -fSL --progress-bar "$BASE/$ZIP" -o "$TMP/$ZIP"
  # Verify the download against Electron's published checksums before running anything from it.
  EXPECT="$(curl -fsSL "$BASE/SHASUMS256.txt" | grep " \*$ZIP\$" | cut -d' ' -f1)"
  [ -n "$EXPECT" ] && [ "$(shasum -a 256 "$TMP/$ZIP" | cut -d' ' -f1)" = "$EXPECT" ] || { echo "Checksum mismatch, aborting."; exit 1; }
  mkdir "$TMP/el" && unzip -q "$TMP/$ZIP" -d "$TMP/el"
  rm -rf "$APP" && mv "$TMP/el/Electron.app" "$APP"
  echo "$EV-$ARCH" > "$STAMP"
  # Make it a proper menu bar app: its own name and id, and no Dock icon.
  P="$APP/Contents/Info.plist"
  plutil -replace CFBundleName -string "Quotapus" "$P"
  plutil -replace CFBundleDisplayName -string "Quotapus" "$P"
  plutil -replace CFBundleIdentifier -string "dev.quotapus.app" "$P"
  plutil -replace LSUIElement -bool true "$P"
fi

rm -rf "$APP/Contents/Resources/app" && mv "$TMP/app" "$APP/Contents/Resources/app"
cp "$APP/Contents/Resources/app/assets/icon.icns" "$APP/Contents/Resources/electron.icns" 2>/dev/null || true
plutil -replace CFBundleShortVersionString -string "$VERSION" "$APP/Contents/Info.plist"
plutil -replace CFBundleVersion -string "$VERSION" "$APP/Contents/Info.plist"
# Changing the bundle invalidates Electron's signature; re-sign ad hoc ("-") so Apple Silicon will run it.
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || true
mdimport "$APP" >/dev/null 2>&1 || true      # have Spotlight index it right away
rm -rf "$HOME/.quotapus"                     # leftover from the older install layout

# The `quotapus` command.
# Written to a temp file and moved into place: a running older launcher (`quotapus update`) keeps reading its old file.
cat > "$BIN/quotapus.new" <<'L'
#!/usr/bin/env bash
APP="$HOME/Applications/Quotapus.app"
case "${1:-start}" in
  start)  pgrep -f "$APP/Contents" >/dev/null && { echo "quotapus is already running (look in your menu bar)."; exit 0; }
          nohup "$APP/Contents/MacOS/Electron" >/dev/null 2>&1 & disown; echo "quotapus started. Look for the gauge icon in your menu bar." ;;
  stop)   pkill -f "$APP/Contents" && echo stopped || echo "not running" ;;
  update) { curl -fsSL "https://raw.githubusercontent.com/VladUdri/quotapus/main/install.sh" 2>/dev/null \
            || gh api repos/VladUdri/quotapus/contents/install.sh -H "Accept: application/vnd.github.raw"; } | bash ;;
  uninstall)
          pkill -f "$APP/Contents" 2>/dev/null
          # If "Read limits from Claude Code" was on, give Claude Code its original status line back
          # before the shim it points to is deleted. Uses Electron as a plain Node runtime.
          ELECTRON_RUN_AS_NODE=1 "$APP/Contents/MacOS/Electron" -e '
            const path = require("path"), os = require("os");
            const settings = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "settings.json");
            try { require(path.join(process.argv[1], "dist/statusline.js")).disable(settings, path.join(os.homedir(), "Library/Application Support/quotapus")); } catch (e) {}
          ' "$APP/Contents/Resources/app" 2>/dev/null
          rm -rf "$APP" "$HOME/.quotapus" "$HOME/Library/Application Support/quotapus" "$HOME/Library/LaunchAgents/dev.quotapus.plist" "$0"
          echo "quotapus removed." ;;
  *)      echo "usage: quotapus [start|stop|update|uninstall]" ;;
esac
L
chmod +x "$BIN/quotapus.new" && mv -f "$BIN/quotapus.new" "$BIN/quotapus"

case ":$PATH:" in
  *":$BIN:"*) ;;
  *) echo "export PATH=\"$BIN:\$PATH\"" >> "$HOME/.zshrc"; export PATH="$BIN:$PATH"
     echo "Added $BIN to PATH in ~/.zshrc (open a new terminal to use \`quotapus\`)." ;;
esac

"$BIN/quotapus" start
echo
echo "Done. Find it any time by searching \"Quotapus\" in Spotlight, or run: quotapus [start|stop|update|uninstall]"
echo "Tip: open the popup, click the gear, and enable 'Launch at login'."
