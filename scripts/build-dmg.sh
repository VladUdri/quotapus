#!/usr/bin/env bash
# Builds Quotapus.app (+ a .dmg) from the official Electron runtime and our compiled code.
# Usage: scripts/build-dmg.sh arm64|x64      (run `npm run build` first)
# The app is only ad-hoc signed (no Apple Developer account), so macOS will quarantine a DMG that was
# downloaded with a browser; see README ("Install from a DMG") for the one-time "Open Anyway" step.
set -euo pipefail
ARCH="${1:?usage: build-dmg.sh arm64|x64}"
cd "$(dirname "$0")/.."
VERSION="$(sed -n 's/.*"version": "\([^"]*\)".*/\1/p' package.json | head -1)"
EV="$(sed -n 's/.*"electron": "\([^"]*\)".*/\1/p' package.json)"
OUT="release"; WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
mkdir -p "$OUT" .cache

ZIP="electron-v$EV-darwin-$ARCH.zip"; BASE="https://github.com/electron/electron/releases/download/v$EV"
if [ ! -f ".cache/$ZIP" ]; then curl -fSL --progress-bar "$BASE/$ZIP" -o ".cache/$ZIP"; fi
EXPECT="$(curl -fsSL "$BASE/SHASUMS256.txt" | grep " \*$ZIP\$" | cut -d' ' -f1)"
[ "$(shasum -a 256 ".cache/$ZIP" | cut -d' ' -f1)" = "$EXPECT" ] || { echo "checksum mismatch"; rm -f ".cache/$ZIP"; exit 1; }

unzip -q ".cache/$ZIP" -d "$WORK/electron"
APP="$WORK/Quotapus.app"; mv "$WORK/electron/Electron.app" "$APP"
mkdir "$APP/Contents/Resources/app"
cp -R package.json dist assets "$APP/Contents/Resources/app/"
find "$APP/Contents/Resources/app" -name '*.test.js' -delete
cp assets/icon.icns "$APP/Contents/Resources/electron.icns"

# Keep the executable name ("Electron"): Chromium finds its helper processes by that name.
P="$APP/Contents/Info.plist"
plutil -replace CFBundleName -string "Quotapus" "$P"
plutil -replace CFBundleDisplayName -string "Quotapus" "$P"
plutil -replace CFBundleIdentifier -string "dev.quotapus.app" "$P"
plutil -replace CFBundleShortVersionString -string "$VERSION" "$P"
plutil -replace CFBundleVersion -string "$VERSION" "$P"
plutil -insert LSUIElement -bool true "$P"   # menu bar app: no Dock icon

# Changing the bundle invalidated Electron's signature; re-sign ad hoc ("-") so Apple Silicon will run it.
codesign --force --deep --sign - "$APP"
codesign --verify --deep --strict "$APP"

mkdir "$WORK/stage"; mv "$APP" "$WORK/stage/"; ln -s /Applications "$WORK/stage/Applications"
DMG="$OUT/Quotapus-$VERSION-$ARCH.dmg"; rm -f "$DMG"
hdiutil create -quiet -volname "Quotapus" -srcfolder "$WORK/stage" -ov -format UDZO "$DMG"
echo "built $DMG ($(du -h "$DMG" | cut -f1))"
