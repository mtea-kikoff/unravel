#!/bin/bash
# Build a distributable Unravel.dmg from the packaged .app.
set -euo pipefail
cd "$(dirname "$0")/.."

APP="dist/Unravel-darwin-arm64/Unravel.app"
STAGE="dist/dmg-stage"
DMG="dist/Unravel.dmg"

if [ ! -d "$APP" ]; then
  echo "error: $APP not found — run 'npm run pack' first." >&2
  exit 1
fi

rm -rf "$STAGE" "$DMG"
mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/Unravel.app"
ln -s /Applications "$STAGE/Applications"
cp build/dmg-readme.txt "$STAGE/Read Me First.txt"

hdiutil create \
  -volname "Unravel" \
  -srcfolder "$STAGE" \
  -ov -format UDZO \
  "$DMG" >/dev/null

rm -rf "$STAGE"
echo "Built $DMG ($(du -h "$DMG" | cut -f1))"
