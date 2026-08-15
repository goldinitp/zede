#!/usr/bin/env bash
# Build Zede.app (and optionally a DMG) from the release binary.
#
#   ./scripts/bundle-mac.sh          -> target/bundle/Zede.app
#   ./scripts/bundle-mac.sh --dmg    -> also target/bundle/Zede-<version>.dmg
#
# The bundle is ad-hoc signed: locally built apps run without notarization.
# Distribution builds need an Apple Developer cert (see the Electron app's
# CONTRIBUTING notes); until then, build-from-source is the install path.
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=$(grep '^version' Cargo.toml | head -1 | cut -d'"' -f2)
ICON_SRC="../build/icon.icns" # shared with the Electron app — one brand
APP_DIR="target/bundle/Zede.app"

cargo build --release

rm -rf target/bundle
mkdir -p "$APP_DIR/Contents/MacOS" "$APP_DIR/Contents/Resources"
cp target/release/zede "$APP_DIR/Contents/MacOS/zede"
if [[ -f "$ICON_SRC" ]]; then
  cp "$ICON_SRC" "$APP_DIR/Contents/Resources/zede.icns"
else
  echo "warning: $ICON_SRC not found; bundling without an icon" >&2
fi

cat > "$APP_DIR/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleIdentifier</key><string>com.zede.native</string>
  <key>CFBundleName</key><string>Zede</string>
  <key>CFBundleDisplayName</key><string>Zede</string>
  <key>CFBundleExecutable</key><string>zede</string>
  <key>CFBundleIconFile</key><string>zede</string>
  <key>CFBundleShortVersionString</key><string>${VERSION}</string>
  <key>CFBundleVersion</key><string>${VERSION}</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSSupportsAutomaticGraphicsSwitching</key><true/>
</dict>
</plist>
PLIST

plutil -lint "$APP_DIR/Contents/Info.plist" >/dev/null

# Ad-hoc signature over the whole bundle. If codesign is unavailable the
# linker's ad-hoc signature on the binary still lets the app launch locally.
codesign --force -s - "$APP_DIR" 2>/dev/null \
  || echo "warning: codesign unavailable; relying on the linker's ad-hoc signature" >&2

echo "Bundled: $APP_DIR"

if [[ "${1:-}" == "--dmg" ]]; then
  DMG="target/bundle/Zede-${VERSION}.dmg"
  hdiutil create -volname "Zede" -srcfolder "$APP_DIR" -ov -format UDZO "$DMG" >/dev/null
  echo "DMG: $DMG"
fi
