#!/usr/bin/env bash
# Build libmips1rt.a: the compiler runtime helpers GCC calls (64-bit integer
# maths, bit counts, byte swaps and soft-float: float/double add, multiply,
# divide, compare, convert) compiled for the PS1's MIPS I CPU, from LLVM
# compiler-rt's portable C sources (Apache-2.0 WITH LLVM-exception).
#
# Debian/Ubuntu's mipsel-linux-gnu libgcc is built for MIPS32r2 with a hard
# float ABI: its integer helpers crash the R3000A ("reserved instruction") and
# its float helpers take arguments in FPU registers the PS1 doesn't have. Link
# this library before libgcc and both work.
#   build-mips1-rt.sh <prefix>        → <prefix>/lib/libmips1rt.a
set -euo pipefail
PREFIX="${1:?usage: build-mips1-rt.sh <prefix>}"
LLVM_TAG=llvmorg-19.1.7
CC="${CC:-mipsel-linux-gnu-gcc}"
AR="${AR:-mipsel-linux-gnu-ar}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

git clone -q --depth 1 --branch "$LLVM_TAG" --filter=blob:none --sparse https://github.com/llvm/llvm-project "$WORK/llvm"
git -C "$WORK/llvm" sparse-checkout set compiler-rt/lib/builtins
SRC="$WORK/llvm/compiler-rt/lib/builtins"

# No C library: GCC's freestanding headers plus the few limits.h macros needed.
mkdir -p "$WORK/shim"
cat > "$WORK/shim/limits.h" <<'H'
#pragma once
#define CHAR_BIT 8
#define INT_MAX __INT_MAX__
#define INT_MIN (-INT_MAX - 1)
#define UINT_MAX (INT_MAX * 2U + 1U)
#define LONG_MAX __LONG_MAX__
#define LONG_MIN (-LONG_MAX - 1L)
#define LLONG_MAX __LONG_LONG_MAX__
#define LLONG_MIN (-LLONG_MAX - 1LL)
H

INT="bswapsi2 bswapdi2 clzsi2 clzdi2 ctzsi2 ctzdi2 popcountsi2 popcountdi2 paritysi2 paritydi2 ffssi2 ffsdi2
     ashldi3 lshrdi3 ashrdi3 muldi3 negdi2 cmpdi2 ucmpdi2 udivmoddi4 divmoddi4 udivdi3 umoddi3 divdi3 moddi3"
FLOAT="addsf3 subsf3 mulsf3 divsf3 negsf2 comparesf2 fixsfsi fixunssfsi fixsfdi fixunssfdi floatsisf floatunsisf
       floatdisf floatundisf powisf2 adddf3 subdf3 muldf3 divdf3 negdf2 comparedf2 fixdfsi fixunsdfsi fixdfdi
       fixunsdfdi floatsidf floatunsidf floatdidf floatundidf powidf2 extendsfdf2 truncdfsf2 fp_mode"
mkdir -p "$WORK/obj"
for f in $INT $FLOAT; do
  "$CC" -O2 -march=r3000 -mtune=r3000 -mabi=32 -msoft-float -mno-abicalls -fno-pic -G0 -ffunction-sections -fdata-sections \
    -ffreestanding -fno-builtin -nostdinc -I"$WORK/shim" -isystem "$("$CC" -print-file-name=include)" -I"$SRC" \
    -c "$SRC/$f.c" -o "$WORK/obj/$f.o"
done
# Nothing in it may use an instruction the R3000A lacks (or the FPU).
if "${CC%gcc}objdump" -d "$WORK"/obj/*.o | grep -qE $'\t(clz|clo|seb|seh|wsbh|ext|ins|mul|movn|movz|madd|msub|lwc1|swc1|ldc1|sdc1|mtc1|mfc1|cfc1|ctc1|sync|[a-z]+\.[sd]) '; then
  echo "libmips1rt: MIPS32 instructions found" >&2; exit 1
fi
mkdir -p "$PREFIX/lib"
rm -f "$PREFIX/lib/libmips1rt.a"
"$AR" rcs "$PREFIX/lib/libmips1rt.a" "$WORK"/obj/*.o
cp "$WORK/llvm/compiler-rt/LICENSE.TXT" "$PREFIX/lib/libmips1rt.LICENSE.txt" 2>/dev/null || true
echo "libmips1rt.a installed in $PREFIX/lib"
