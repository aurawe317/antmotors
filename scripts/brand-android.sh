#!/usr/bin/env bash
#
# Brand the Android app icons from committed sources.
# Run AFTER `npx cap add android` / `npx cap sync android` — it overwrites the
# default Capacitor robot icons with the Antoto brand icons (committed under
# brand/android-icons) so locally-built and CI-built APKs look identical.
#
# Usage: scripts/brand-android.sh [android-project-dir]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ANDROID_DIR="${1:-$ROOT/native/android}"
SRC="$ROOT/brand/android-icons"
DEST="$ANDROID_DIR/app/src/main/res"

if [ ! -d "$DEST" ]; then
  echo "::error::Android res dir not found at $DEST — run 'npx cap add android' first." >&2
  exit 1
fi

for density in mdpi hdpi xhdpi xxhdpi xxxhdpi; do
  src="$SRC/mipmap-$density"
  dst="$DEST/mipmap-$density"
  [ -d "$src" ] || { echo "::error::missing brand source $src" >&2; exit 1; }
  mkdir -p "$dst"
  cp -f "$src/ic_launcher.png"       "$dst/ic_launcher.png"
  cp -f "$src/ic_launcher_round.png" "$dst/ic_launcher_round.png"
done

# Remove the adaptive-icon overlay so the full brand PNG is used on every
# Android version (no rounded mask cropping the artwork).
if [ -d "$DEST/mipmap-anydpi-v26" ]; then
  rm -rf "$DEST/mipmap-anydpi-v26"
  echo "Removed adaptive-icon overlay (mipmap-anydpi-v26)."
fi

echo "Android icons branded from $SRC"
