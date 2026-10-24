// Text views for the debugger and profiler: disassembly around an address, a
// call stack found by scanning the stack for return addresses, and profiler
// samples grouped by function.

import { disasm, isReturnAddress } from './mips.mjs';

const hex = (n) => '0x' + (n >>> 0).toString(16);
const h8 = (n) => (n >>> 0).toString(16).padStart(8, '0');
/** Main RAM in any segment (where code can return to). */
const inRam = (a) => { a = (a & 0x1fffffff) >>> 0; return a < 0x200000; };

/**
 * Disassembly listing: one line per instruction, "> " marking `mark`.
 * @param {Buffer} code the instruction words, from `addr`
 * @param {number} addr
 * @param {{ mark?: number, name?: (a: number, o?: { maxOffset?: number }) => string | null }} [opts]
 */
export function listing(code, addr, { mark = -1, name = () => null } = {}) {
  const lines = [];
  for (let o = 0; o + 4 <= code.length; o += 4) {
    const a = (addr + o) >>> 0, w = code.readUInt32LE(o);
    const at = name(a, { maxOffset: 0x10000 });
    lines.push(`${a === mark >>> 0 ? '>' : ' '} ${h8(a)}${at ? ` <${at}>` : ''}  ${h8(w)}  ${disasm(w, a, (t) => name(t, { maxOffset: 0x10000 })).text}`);
  }
  return lines;
}

/** Start address of the function `addr` is in, from its "name+off" (null without symbols). */
const funcStart = (addr, name) => {
  const n = name(addr, { maxOffset: 0x10000 });
  if (!n) return null;
  const m = /\+(\d+)$/.exec(n);
  return ((addr >>> 0) - (m ? +m[1] : 0)) >>> 0;
};

/**
 * Call stack, innermost first: the pc, then return addresses. MIPS code keeps no
 * frame pointers, so this scans the stack for words that point just past a call
 * (jal/jalr/bltzal/bgezal); with symbols, a `jal` must call the function the
 * frame above is in, which drops stale words. `ra` is used when nothing on the
 * stack matches the innermost function (a leaf that never saved it).
 * @param {{ pc: number, ra: number, sp: number, stack: Buffer,
 *   word: (addr: number) => number | null,
 *   name?: (a: number, o?: { maxOffset?: number }) => string | null, max?: number }} o
 * @returns {{ addr: number, at: string | null, via?: string }[]}
 */
export function callStack({ pc, ra, sp, stack, word, name = () => null, max = 12 }) {
  const frames = [{ addr: pc >>> 0, at: name(pc, { maxOffset: 0x10000 }) }];
  const callsInto = (ret, inner) => {
    if (!inRam(ret) || ret & 3) return false;
    const call = word((ret - 8) >>> 0);
    if (call === null || !isReturnAddress(call)) return false;
    if (call >>> 26 !== 3) return true;  // jalr / bltzal: target unknown
    const start = funcStart(inner, name);
    if (start === null) return true;
    const target = ((((ret - 4) & 0xf0000000) | ((call & 0x3ffffff) << 2)) >>> 0);
    return ((target & 0x1fffffff) >>> 0) === ((start & 0x1fffffff) >>> 0);
  };
  const words = [];
  for (let o = 0; o + 4 <= stack.length; o += 4) words.push({ addr: (sp + o) >>> 0, value: stack.readUInt32LE(o) });
  let from = 0;
  // A leaf function keeps its caller in ra only.
  const inner = frames[0].addr;
  if (callsInto(ra >>> 0, inner) && !words.some((w) => w.value === ra >>> 0)) frames.push({ addr: ra >>> 0, at: name(ra, { maxOffset: 0x10000 }), via: 'ra' });
  while (frames.length < max) {
    const prev = frames[frames.length - 1].addr;
    const i = words.findIndex((w, k) => k >= from && callsInto(w.value, prev));
    if (i < 0) break;
    frames.push({ addr: words[i].value, at: name(words[i].value, { maxOffset: 0x10000 }), via: `sp+${hex(words[i].addr - sp)}` });
    from = i + 1;
  }
  return frames;
}

/**
 * Profiler samples (pcs) grouped by function, most first.
 * @param {ArrayLike<number>} samples
 * @param {(a: number, o?: { maxOffset?: number }) => string | null} name
 * @returns {{ total: number, funcs: { name: string, count: number, pct: number, hot: { addr: number, count: number }[] }[] }}
 */
export function profileByFunction(samples, name) {
  const groups = new Map();
  for (let i = 0; i < samples.length; i++) {
    const pc = samples[i] >>> 0;
    let key;
    const n = name(pc, { maxOffset: 0x10000 });
    if (n) key = n.replace(/\+\d+$/, '');
    else if (pc >= 0xbfc00000) key = '(BIOS ROM)';
    else if (((pc & 0x1fffffff) >>> 0) < 0x10000) key = '(kernel)';
    else key = `(unknown ${hex(pc & ~0xff)})`;
    let g = groups.get(key);
    if (!g) groups.set(key, g = { name: key, count: 0, pcs: new Map() });
    g.count++;
    g.pcs.set(pc, (g.pcs.get(pc) ?? 0) + 1);
  }
  const total = samples.length;
  const funcs = [...groups.values()].sort((a, b) => b.count - a.count).map((g) => ({
    name: g.name, count: g.count, pct: total ? (g.count * 100) / total : 0,
    hot: [...g.pcs].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([addr, count]) => ({ addr, count })),
  }));
  return { total, funcs };
}
