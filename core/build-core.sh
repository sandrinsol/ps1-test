#!/usr/bin/env bash
# Rebuild data/cores/pcsx_rearmed-wasm.data: the EmulatorJS pcsx_rearmed core
# with core/pcsx_rearmed-ps1test.patch applied (a GPU command / CPU exception log
# and pointers to RAM and VRAM for the ps1-test harness), linked by EmulatorJS's
# RetroArch fork exactly as the stock EmulatorJS 4.2.3 core was. GPL-2.0+; the
# patch is the only change, so this script plus the patch are the source.
#
# Needs: git, make, python3, 7z (p7zip-full), and network access to GitHub and
# to Emscripten's SDK downloads. Usage: core/build-core.sh [workdir]
set -euo pipefail

# The sources the stock 4.2.3 core was built from (pcsx_rearmed writes its
# commit into every save state: "STv4 PCSXra f29871d").
PCSX_REPO=https://github.com/EmulatorJS/pcsx_rearmed
PCSX_COMMIT=f29871d
RA_REPO=https://github.com/EmulatorJS/RetroArch
RA_COMMIT=6dd43539
EMSDK_VERSION=3.1.74
ZLIB_TAG=v1.2.13   # Emscripten 3.1.74's zlib port

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${1:-$(mktemp -d)}"
mkdir -p "$WORK"
cd "$WORK"
log() { echo "== $*"; }

if [ ! -d emsdk ]; then
  log "emsdk $EMSDK_VERSION"
  git clone --depth 1 https://github.com/emscripten-core/emsdk.git
  emsdk/emsdk install "$EMSDK_VERSION"
  emsdk/emsdk activate "$EMSDK_VERSION"
fi
# shellcheck disable=SC1091
source emsdk/emsdk_env.sh >/dev/null

# The zlib port, fetched with git (some networks block GitHub archive downloads).
ZPORT="$(em-config CACHE)/ports/zlib"
if [ ! -d "$ZPORT/zlib-${ZLIB_TAG#v}" ]; then
  log "zlib port $ZLIB_TAG"
  rm -rf "$ZPORT"
  git clone --depth 1 --branch "$ZLIB_TAG" https://github.com/madler/zlib "$ZPORT/zlib-${ZLIB_TAG#v}"
  echo "https://github.com/madler/zlib/archive/refs/tags/$ZLIB_TAG.tar.gz" > "$ZPORT/.emscripten_url"
fi
embuilder build zlib

log "pcsx_rearmed $PCSX_COMMIT + patch"
rm -rf pcsx_rearmed
git clone "$PCSX_REPO" pcsx_rearmed
git -C pcsx_rearmed checkout -q "$PCSX_COMMIT"
git -C pcsx_rearmed submodule update --init frontend/libpicofe
git -C pcsx_rearmed apply "$ROOT/core/pcsx_rearmed-ps1test.patch"
emmake make -C pcsx_rearmed -j"$(nproc)" -f Makefile.libretro platform=emscripten

log "RetroArch $RA_COMMIT"
rm -rf RetroArch EmulatorJS
git clone "$RA_REPO" RetroArch
git -C RetroArch checkout -q "$RA_COMMIT"
# Export the harness's functions too.
sed -i 's/_get_video_dimensions,EmscriptenSendCommand,EmscriptenReceiveCommandReply$/_get_video_dimensions,EmscriptenSendCommand,EmscriptenReceiveCommandReply, \\\n                     _ps1test_log_ctl,_ps1test_log_buf,_ps1test_log_len,_ps1test_log_flags,_ps1test_ptr/' RetroArch/Makefile.emulatorjs
grep -q _ps1test_ptr RetroArch/Makefile.emulatorjs
mkdir -p EmulatorJS/data/cores
# WebGL 2 build, then the WebGL 1 ("legacy") one EmulatorJS falls back to.
cp pcsx_rearmed/pcsx_rearmed_libretro_emscripten.bc RetroArch/emulatorjs/
(cd RetroArch/emulatorjs && emmake ./build-emulatorjs.sh --clean)
cp pcsx_rearmed/pcsx_rearmed_libretro_emscripten.bc RetroArch/emulatorjs/
(cd RetroArch/emulatorjs && emmake ./build-emulatorjs.sh --clean --legacy)

log "package"
python3 - "$ROOT" <<'PY'
import json, sys
root = sys.argv[1]
core = json.load(open(f'{root}/data/cores/cores.json'))[0]
json.dump(core, open('core.json', 'w'), separators=(',', ':'))
json.dump({"minimumEJSVersion": "4.2.2", "version": "2.0.2-ps1test"}, open('build.json', 'w'), indent=4)
PY
cp pcsx_rearmed/COPYING license.txt
# Repack each core without timestamps, so identical builds give identical files.
for v in wasm legacy-wasm; do
  rm -rf "pack-$v" && mkdir "pack-$v"
  7z x -o"pack-$v" "EmulatorJS/data/cores/pcsx_rearmed-$v.data" >/dev/null
  cp core.json license.txt build.json "pack-$v/"
  rm -f "$ROOT/data/cores/pcsx_rearmed-$v.data"
  (cd "pack-$v" && 7z a -t7z -mmt=1 -mtm=off -mtc=off -mta=off "$ROOT/data/cores/pcsx_rearmed-$v.data" \
    pcsx_rearmed_libretro.js pcsx_rearmed_libretro.wasm core.json license.txt build.json >/dev/null)
done
python3 - "$ROOT" "$PCSX_COMMIT" "$RA_COMMIT" "$EMSDK_VERSION" <<'PY'
import json, sys, hashlib
root, pcsx, ra, em = sys.argv[1:]
sha = lambda v: hashlib.sha256(open(f'{root}/data/cores/pcsx_rearmed-{v}.data', 'rb').read()).hexdigest()
json.dump({"core": "pcsx_rearmed", "pcsx_rearmed": pcsx, "patch": "core/pcsx_rearmed-ps1test.patch",
           "retroarch": ra, "emscripten": em, "sha256": {v: sha(v) for v in ("wasm", "legacy-wasm")}},
          open(f'{root}/data/cores/reports/pcsx_rearmed-ps1test.json', 'w'), indent=2)
PY
log "data/cores/pcsx_rearmed-wasm.data and -legacy-wasm.data updated"
