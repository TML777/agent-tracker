#!/bin/bash
# Builds ~/Applications/Agent Tracker.app: runs bin/open.sh, with assets/icon.svg as its icon.
# Run this again if you move the project folder, since the app has the path built in.
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$HOME/Applications/Agent Tracker.app"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$HOME/Applications"
osacompile -o "$APP" -e "do shell script quoted form of \"$ROOT/bin/open.sh\""

qlmanage -t -s 1024 -o "$WORK" "$ROOT/assets/icon.svg" >/dev/null 2>&1
mkdir "$WORK/app.iconset"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$WORK/icon.svg.png" --out "$WORK/app.iconset/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  sips -z "$double" "$double" "$WORK/icon.svg.png" --out "$WORK/app.iconset/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$WORK/app.iconset" -o "$APP/Contents/Resources/applet.icns"

# osacompile also adds its default icon as a compiled asset, which macOS shows instead of
# applet.icns. Remove it so our icon is the only one.
rm -f "$APP/Contents/Resources/Assets.car"
/usr/libexec/PlistBuddy -c 'Delete :CFBundleIconName' "$APP/Contents/Info.plist" 2>/dev/null || true

# Changing the icon invalidates the app's signature, so sign it again.
codesign --force --deep -s - "$APP" 2>/dev/null

# Finder and the Dock cache icons, so tell macOS the app changed.
touch "$APP"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP"
echo "Built $APP"
