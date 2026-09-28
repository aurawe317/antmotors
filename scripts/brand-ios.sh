#!/usr/bin/env bash
#
# Brand the iOS app icon from the committed 1024px source.
# Run AFTER `npx cap add ios` / `npx cap sync ios` — it overwrites the default
# Capacitor robot icon with the Antoto brand icon so locally-built and
# CI-built IPAs look identical. The iOS asset catalog references a single
# 1024px universal image (AppIcon-512@2x.png); Xcode derives every size from it.
#
# Usage: scripts/brand-ios.sh [ios-project-dir]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IOS_DIR="${1:-$ROOT/native/ios}"
SRC="$ROOT/brand/antoto-icon-1024.png"
DEST="$IOS_DIR/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png"

if [ ! -f "$SRC" ]; then
  echo "::error::Brand source not found at $SRC" >&2
  exit 1
fi

if [ ! -d "$(dirname "$DEST")" ]; then
  echo "::error::iOS AppIcon dir not found at $(dirname "$DEST") — run 'npx cap add ios' first." >&2
  exit 1
fi

cp -f "$SRC" "$DEST"
echo "iOS AppIcon branded from $SRC -> $DEST"
