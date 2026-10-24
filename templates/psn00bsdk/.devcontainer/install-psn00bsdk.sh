#!/usr/bin/env bash
# Install PSn00bSDK with Debian/Ubuntu's MIPS cross compiler (gcc-mipsel-linux-gnu)
# into $PREFIX (default /opt/psn00bsdk). Used by the dev container and CI.
#   sudo .devcontainer/install-psn00bsdk.sh [prefix]
set -euo pipefail
PREFIX="${1:-/opt/psn00bsdk}"
VERSION=v0.24
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends gcc-mipsel-linux-gnu g++-mipsel-linux-gnu binutils-mipsel-linux-gnu \
  cmake ninja-build git ca-certificates build-essential
WORK="$(mktemp -d)"
git clone --depth 1 --branch "$VERSION" --recurse-submodules --shallow-submodules https://github.com/Lameguy64/PSn00bSDK "$WORK/psn00bsdk"
# elf2x reads every program header, and the Linux-targeted linker adds a
# PT_GNU_STACK one at address 0 (the EXE would start at 0 and be 2 GB): convert
# PT_LOAD segments only, sized by where they end.
git -C "$WORK/psn00bsdk" apply "$(cd "$(dirname "$0")" && pwd)/elf2x-ptload.patch"
cmake -S "$WORK/psn00bsdk" -B "$WORK/build" -G Ninja -DPSN00BSDK_TARGET=mipsel-linux-gnu -DSKIP_EXAMPLES=ON -DCMAKE_INSTALL_PREFIX="$PREFIX"
cmake --build "$WORK/build"
cmake --install "$WORK/build"
rm -rf "$WORK"
echo "PSn00bSDK $VERSION installed in $PREFIX: set PSN00BSDK_LIBS=$PREFIX/lib/libpsn00b and add $PREFIX/bin to PATH"
