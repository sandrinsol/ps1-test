#!/usr/bin/env bash
# Rebuild the bundled demo (demo.cue/.bin/.exe/.elf) from templates/psn00bsdk.
# Needs PSn00bSDK (PSN00BSDK_LIBS set) and a MIPS GCC: see that template's README.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cp -r "$ROOT/templates/psn00bsdk/." "$WORK/"
rm -rf "$WORK/build"
(cd "$WORK" && cmake --preset default >/dev/null && cmake --build build)
cp "$WORK/build/game.bin" "$ROOT/demo/demo.bin"
cp "$WORK/build/game.exe" "$ROOT/demo/demo.exe"
cp "$WORK/build/game.elf" "$ROOT/demo/demo.elf"
sed 's/game\.bin/demo.bin/' "$WORK/build/game.cue" > "$ROOT/demo/demo.cue"
echo "demo/ updated"
