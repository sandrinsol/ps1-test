// Text for the debugger tools: where the CPU is (disassembly, registers, a
// probable call stack), what a breakpoint/watchpoint hit was, and the profiler's
// time per function.

import { disasm, isReturnAddress, REG_NAMES } from './mips.mjs';

const hex = (n) => '0x' + (n >>> 0).toString(16).padStart(8, '0');

/** A function-level name for an address: the symbol without "+offset", or the
 *  memory area it is in. */
export function functionOf(addr, symbols) {
  const n = symbols?.nameOf(addr, { maxOffset: 0x8000 });
  if (n) return n.replace(/\+\d+$/, '');
  const a = addr >>> 0;
  if ((a & 0x1fffffff) >= 0x1fc00000) return '(BIOS ROM)';
  if ((a & 0x1fffffff) < 0x10000) return '(BIOS kernel in RAM)';
  return `(${hex(a & ~0xff)}…)`;
}

const KIND = { exec: 'breakpoint', read: 'read', write: 'write' };

/** One line per hit: "write 0x8001088a (box_x) 2B 30 → 31 by sh … at 0x80010488 (main+136)".
 *  @param {any} h a hit from EmuHarness.debugState
 *  @param {{ symbols?: any, label?: (addr: number) => string }} [opts] */
export function hitLine(h, { symbols, label } = {}) {
  const at = symbols?.nameOf(h.pc);
  const where = `${hex(h.pc)}${at ? ` (${at})` : ''}`;
  if (h.kind === 'exec') {
    const ra = symbols?.nameOf(h.ra);
    return `breakpoint #${h.index} at ${where}; a0-a3 ${h.args.slice(1).map(hex).join(' ')}${ra ? `, called from ${ra}` : ''}`;
  }
  const what = label ? label(h.addr) : hex(h.addr);
  const change = h.kind === 'write' ? `${h.old} → ${h.value}` : `= ${h.value}`;
  return `${KIND[h.kind]} ${what} ${h.size}B ${change} by ${disasm(h.code, h.pc).text} at ${where}`;
}

/**
 * Where the CPU is: the instructions around pc, the registers, and a probable
 * call stack (ra, then return addresses found on the stack — a call instruction
 * precedes each; MIPS keeps no frame pointers, so this is a heuristic).
 * @param {{ regs: { r: number[], pc: number, lo: number, hi: number, sr: number, cause: number, epc: number } }} st
 * @param {(addr: number, len: number) => Promise<Buffer>} read
 */
export async function whereText(st, read, symbols, { before = 3, after = 4 } = {}) {
  const { r, pc } = st.regs;
  const name = (a) => symbols?.nameOf(a) ?? null;
  const lines = [];
  const start = (pc - before * 4) >>> 0;
  let code = null;
  try { code = await read(start, (before + after + 1) * 4); } catch {}
  if (code) {
    for (let i = 0; i < before + after + 1; i++) {
      const a = (start + i * 4) >>> 0, w = code.readUInt32LE(i * 4);
      const n = name(a);
      lines.push(`${a === pc ? '→' : ' '} ${hex(a)}${n && !n.includes('+') ? ` <${n}>` : ''}  ${disasm(w, a, (t) => name(t)).text}`);
    }
  }
  const regs = [];
  for (let i = 1; i < 32; i += 8) regs.push(REG_NAMES.slice(i, i + 8).map((n, k) => `${n}=${(r[i + k] >>> 0).toString(16)}`).join(' '));
  lines.push(`regs: ${regs.join('\n      ')}\n      hi=${(st.regs.hi >>> 0).toString(16)} lo=${(st.regs.lo >>> 0).toString(16)}`);
  lines.push(`stack (probable): ${(await callStack(st, read, symbols)).map((a) => name(a) ?? hex(a)).join(' ← ') || '?'}`);
  return lines.join('\n');
}

/** pc, then likely return addresses: ra and words on the stack that follow a call. */
export async function callStack(st, read, symbols, { depth = 8, scan = 2048 } = {}) {
  const { r, pc } = st.regs;
  const out = [pc >>> 0];
  const isCode = (a) => a % 4 === 0 && ((a >>> 0) & 0x1fffffff) >= 0x10000 && ((a >>> 0) & 0x1fffffff) < 0x200000;
  const callsBefore = async (a) => {
    try { return isReturnAddress((await read((a - 8) >>> 0, 4)).readUInt32LE(0)); } catch { return false; }
  };
  const ra = r[31] >>> 0;
  if (isCode(ra) && await callsBefore(ra)) out.push(ra);
  const sp = r[29] >>> 0;
  let stack = null;
  try { stack = await read(sp, scan); } catch {}
  if (stack) {
    for (let o = 0; o + 4 <= stack.length && out.length < depth; o += 4) {
      const w = stack.readUInt32LE(o);
      if (!isCode(w) || out.includes(w)) continue;
      if (await callsBefore(w)) out.push(w);
    }
  }
  return out;
}

/**
 * The profiler's samples as a table of functions by share of the time.
 * @param {Uint32Array} samples pcs sampled at a fixed CPU-cycle interval
 */
export function profileTable(samples, symbols, { top = 15 } = {}) {
  const counts = new Map();
  for (const pc of samples) {
    const f = functionOf(pc, symbols);
    counts.set(f, (counts.get(f) ?? 0) + 1);
  }
  const total = samples.length || 1;
  const rows = [...counts].sort((a, b) => b[1] - a[1]);
  const idle = rows.filter(([n]) => /vsync|wait|idle|halt|(BIOS)/i.test(n)).reduce((s, [, c]) => s + c, 0);
  const lines = rows.slice(0, top).map(([n, c]) => `${(c * 100 / total).toFixed(1).padStart(5)}%  ${n}`);
  if (rows.length > top) lines.push(`  … ${rows.length - top} more function(s)`);
  return {
    text: lines.join('\n'),
    idlePct: idle * 100 / total,
    functions: rows.length,
  };
}
