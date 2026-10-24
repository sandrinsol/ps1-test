/*
 * The libgcc helpers GCC calls on 32-bit MIPS, written in plain C so they
 * compile for the PS1's MIPS I CPU. Only built with Debian/Ubuntu's
 * mipsel-linux-gnu toolchain (see CMakeLists.txt): its libgcc is compiled for
 * MIPS32r2 and uses instructions the R3000A doesn't have (wsbh, seb, ext, ...),
 * so calling it crashes with a "reserved instruction" exception. Definitions in
 * the program take precedence over libgcc's.
 *
 * Covered: byte swaps, bit counts, 64-bit shifts, multiply, divide and modulo,
 * comparisons. Not covered: floating point. Only used when libmips1rt.a (built
 * by .devcontainer/build-mips1-rt.sh, which also has soft-float) isn't installed.
 */
#include <stdint.h>

uint32_t __bswapsi2(uint32_t x) {
	return (x >> 24) | ((x >> 8) & 0xff00) | ((x << 8) & 0xff0000) | (x << 24);
}
uint64_t __bswapdi2(uint64_t x) {
	return ((uint64_t)__bswapsi2((uint32_t)x) << 32) | __bswapsi2((uint32_t)(x >> 32));
}

int __clzsi2(uint32_t x) {
	int n = 0;
	if (!x) return 32;
	while (!(x & 0x80000000u)) { x <<= 1; n++; }
	return n;
}
int __ctzsi2(uint32_t x) {
	int n = 0;
	if (!x) return 32;
	while (!(x & 1)) { x >>= 1; n++; }
	return n;
}
int __popcountsi2(uint32_t x) {
	x = x - ((x >> 1) & 0x55555555u);
	x = (x & 0x33333333u) + ((x >> 2) & 0x33333333u);
	x = (x + (x >> 4)) & 0x0f0f0f0fu;
	return (int)((x * 0x01010101u) >> 24);
}
int __paritysi2(uint32_t x) { return __popcountsi2(x) & 1; }
int __ffssi2(uint32_t x) { return x ? __ctzsi2(x) + 1 : 0; }

/* 64-bit values as two halves, so nothing here needs a 64-bit helper itself. */
typedef union { uint64_t u; int64_t s; struct { uint32_t lo, hi; } w; } dw;

int64_t __ashldi3(int64_t a, int b) {
	dw x = { .s = a };
	if (b >= 32) { x.w.hi = x.w.lo << (b - 32); x.w.lo = 0; }
	else if (b) { x.w.hi = (x.w.hi << b) | (x.w.lo >> (32 - b)); x.w.lo <<= b; }
	return x.s;
}
uint64_t __lshrdi3(uint64_t a, int b) {
	dw x = { .u = a };
	if (b >= 32) { x.w.lo = x.w.hi >> (b - 32); x.w.hi = 0; }
	else if (b) { x.w.lo = (x.w.lo >> b) | (x.w.hi << (32 - b)); x.w.hi >>= b; }
	return x.u;
}
int64_t __ashrdi3(int64_t a, int b) {
	dw x = { .s = a };
	if (b >= 32) { x.w.lo = (uint32_t)((int32_t)x.w.hi >> (b - 32)); x.w.hi = (uint32_t)((int32_t)x.w.hi >> 31); }
	else if (b) { x.w.lo = (x.w.lo >> b) | (x.w.hi << (32 - b)); x.w.hi = (uint32_t)((int32_t)x.w.hi >> b); }
	return x.s;
}

int64_t __muldi3(int64_t a, int64_t b) {
	dw x = { .s = a }, y = { .s = b }, r;
	/* lo*lo as a full 64-bit product, from 16-bit pieces. */
	uint32_t a0 = x.w.lo & 0xffff, a1 = x.w.lo >> 16, b0 = y.w.lo & 0xffff, b1 = y.w.lo >> 16;
	uint32_t p00 = a0 * b0, p01 = a0 * b1, p10 = a1 * b0, p11 = a1 * b1;
	uint32_t mid = (p00 >> 16) + (p01 & 0xffff) + (p10 & 0xffff);
	r.w.lo = (p00 & 0xffff) | (mid << 16);
	r.w.hi = p11 + (p01 >> 16) + (p10 >> 16) + (mid >> 16);
	r.w.hi += x.w.lo * y.w.hi + x.w.hi * y.w.lo;
	return r.s;
}

static int lt64(dw a, dw b) { return a.w.hi < b.w.hi || (a.w.hi == b.w.hi && a.w.lo < b.w.lo); }

uint64_t __udivmoddi4(uint64_t n, uint64_t d, uint64_t *rem) {
	dw num = { .u = n }, den = { .u = d }, q = { .u = 0 }, r = { .u = 0 };
	if (!den.w.hi && !den.w.lo) { if (rem) *rem = n; return 0; } /* (division by zero) */
	for (int i = 63; i >= 0; i--) {
		/* r = (r << 1) | bit i of n */
		r.w.hi = (r.w.hi << 1) | (r.w.lo >> 31);
		r.w.lo = (r.w.lo << 1) | ((i >= 32 ? num.w.hi >> (i - 32) : num.w.lo >> i) & 1);
		if (!lt64(r, den)) {
			uint32_t lo = r.w.lo - den.w.lo;
			r.w.hi = r.w.hi - den.w.hi - (r.w.lo < den.w.lo);
			r.w.lo = lo;
			if (i >= 32) q.w.hi |= 1u << (i - 32); else q.w.lo |= 1u << i;
		}
	}
	if (rem) *rem = r.u;
	return q.u;
}
uint64_t __udivdi3(uint64_t a, uint64_t b) { return __udivmoddi4(a, b, 0); }
uint64_t __umoddi3(uint64_t a, uint64_t b) { uint64_t r; __udivmoddi4(a, b, &r); return r; }

static uint64_t abs64(int64_t v) { dw x = { .s = v }; if ((int32_t)x.w.hi < 0) { x.w.lo = ~x.w.lo + 1; x.w.hi = ~x.w.hi + (x.w.lo == 0); } return x.u; }
static int64_t neg64(uint64_t v) { dw x = { .u = v }; x.w.lo = ~x.w.lo + 1; x.w.hi = ~x.w.hi + (x.w.lo == 0); return x.s; }
int64_t __divdi3(int64_t a, int64_t b) {
	uint64_t q = __udivmoddi4(abs64(a), abs64(b), 0);
	return ((a < 0) != (b < 0)) ? neg64(q) : (int64_t)q;
}
int64_t __moddi3(int64_t a, int64_t b) {
	uint64_t r;
	__udivmoddi4(abs64(a), abs64(b), &r);
	return a < 0 ? neg64(r) : (int64_t)r;
}
int64_t __negdi2(int64_t a) { return neg64((uint64_t)a); }
int __cmpdi2(int64_t a, int64_t b) { dw x = { .s = a }, y = { .s = b }; return (int32_t)x.w.hi < (int32_t)y.w.hi ? 0 : (int32_t)x.w.hi > (int32_t)y.w.hi ? 2 : x.w.lo < y.w.lo ? 0 : x.w.lo > y.w.lo ? 2 : 1; }
int __ucmpdi2(uint64_t a, uint64_t b) { dw x = { .u = a }, y = { .u = b }; return x.w.hi < y.w.hi ? 0 : x.w.hi > y.w.hi ? 2 : x.w.lo < y.w.lo ? 0 : x.w.lo > y.w.lo ? 2 : 1; }
