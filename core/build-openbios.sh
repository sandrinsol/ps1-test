#!/usr/bin/env bash
# Rebuild data/bios/openbios.bin from PCSX-Redux's OpenBIOS (MIT licence).
# Needs a mipsel GCC and G++ (mipsel-none-elf-gcc, or gcc-mipsel-linux-gnu and
# g++-mipsel-linux-gnu on Debian/Ubuntu)
# and make. Usage: core/build-openbios.sh [git ref of pcsx-redux/nugget]
set -euo pipefail
REF="${1:-main}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

if command -v mipsel-none-elf-gcc >/dev/null; then PREFIX=mipsel-none-elf; FORMAT=elf32-littlemips
elif command -v mipsel-linux-gnu-gcc >/dev/null; then PREFIX=mipsel-linux-gnu; FORMAT=elf32-tradlittlemips
else echo "no mipsel GCC found (install gcc-mipsel-linux-gnu or mipsel-none-elf-gcc)" >&2; exit 1; fi

git clone --depth 1 --branch "$REF" https://github.com/pcsx-redux/nugget "$WORK/nugget" 2>/dev/null \
  || { git clone https://github.com/pcsx-redux/nugget "$WORK/nugget"; git -C "$WORK/nugget" checkout "$REF"; }
make -C "$WORK/nugget/openbios" PREFIX="$PREFIX" FORMAT="$FORMAT" -j"$(nproc 2>/dev/null || echo 2)"
mkdir -p "$ROOT/data/bios"
cp "$WORK/nugget/openbios/openbios.bin" "$ROOT/data/bios/openbios.bin"
echo "{\"source\": \"https://github.com/pcsx-redux/nugget\", \"commit\": \"$(git -C "$WORK/nugget" rev-parse HEAD)\", \"compiler\": \"$($PREFIX-gcc -dumpversion) ($PREFIX)\"}" > "$ROOT/data/bios/openbios.json"
echo "data/bios/openbios.bin updated ($(wc -c < "$ROOT/data/bios/openbios.bin") bytes)"
