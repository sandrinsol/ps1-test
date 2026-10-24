// A MIPS I (R3000A) disassembler for the debugger: one instruction word → text,
// with branch/jump targets resolved to addresses (and names, given a lookup).

const R = ['zero', 'at', 'v0', 'v1', 'a0', 'a1', 'a2', 'a3', 't0', 't1', 't2', 't3', 't4', 't5', 't6', 't7',
  's0', 's1', 's2', 's3', 's4', 's5', 's6', 's7', 't8', 't9', 'k0', 'k1', 'gp', 'sp', 'fp', 'ra'];
export const REG_NAMES = R;

const hex = (n) => '0x' + (n >>> 0).toString(16);
const simm = (w) => (w << 16) >> 16;
const imm = (w) => { const v = simm(w); return v < 0 ? '-' + hex(-v) : hex(v); };

const SPECIAL = {
  0x00: 'sll', 0x02: 'srl', 0x03: 'sra', 0x04: 'sllv', 0x06: 'srlv', 0x07: 'srav', 0x08: 'jr', 0x09: 'jalr',
  0x0c: 'syscall', 0x0d: 'break', 0x10: 'mfhi', 0x11: 'mthi', 0x12: 'mflo', 0x13: 'mtlo',
  0x18: 'mult', 0x19: 'multu', 0x1a: 'div', 0x1b: 'divu', 0x20: 'add', 0x21: 'addu', 0x22: 'sub', 0x23: 'subu',
  0x24: 'and', 0x25: 'or', 0x26: 'xor', 0x27: 'nor', 0x2a: 'slt', 0x2b: 'sltu',
};
const IMM = { 0x08: 'addi', 0x09: 'addiu', 0x0a: 'slti', 0x0b: 'sltiu', 0x0c: 'andi', 0x0d: 'ori', 0x0e: 'xori' };
const MEM = { 0x20: 'lb', 0x21: 'lh', 0x22: 'lwl', 0x23: 'lw', 0x24: 'lbu', 0x25: 'lhu', 0x26: 'lwr',
  0x28: 'sb', 0x29: 'sh', 0x2a: 'swl', 0x2b: 'sw', 0x2e: 'swr', 0x32: 'lwc2', 0x3a: 'swc2' };
const GTE = { 0x01: 'rtps', 0x06: 'nclip', 0x0c: 'op', 0x10: 'dpcs', 0x11: 'intpl', 0x12: 'mvmva', 0x13: 'ncds',
  0x14: 'cdp', 0x16: 'ncdt', 0x1b: 'nccs', 0x1c: 'cc', 0x1e: 'ncs', 0x20: 'nct', 0x28: 'sqr', 0x29: 'dcpl',
  0x2a: 'dpct', 0x2d: 'avsz3', 0x2e: 'avsz4', 0x30: 'rtpt', 0x3d: 'gpf', 0x3e: 'gpl', 0x3f: 'ncct' };

/**
 * Disassemble one instruction.
 * @param {number} w the instruction word
 * @param {number} pc its address (for branch and jump targets)
 * @param {(addr: number) => string | null} [name] symbol lookup for targets
 * @returns {{ text: string, target?: number, isCall?: boolean, isBranch?: boolean }}
 */
export function disasm(w, pc, name = () => null) {
  w >>>= 0;
  const op = w >>> 26, rs = (w >>> 21) & 31, rt = (w >>> 16) & 31, rd = (w >>> 11) & 31, sa = (w >>> 6) & 31, fn = w & 63;
  const tgt = (t) => { const n = name(t); return n ? `${hex(t)} <${n}>` : hex(t); };
  if (w === 0) return { text: 'nop' };
  if (op === 0) {
    const m = SPECIAL[fn];
    if (!m) return { text: `.word ${hex(w)}` };
    if (fn <= 0x03) return { text: `${m} ${R[rd]}, ${R[rt]}, ${sa}` };
    if (fn <= 0x07) return { text: `${m} ${R[rd]}, ${R[rt]}, ${R[rs]}` };
    if (fn === 0x08) return { text: `jr ${R[rs]}`, isBranch: true };
    if (fn === 0x09) return { text: rd === 31 ? `jalr ${R[rs]}` : `jalr ${R[rd]}, ${R[rs]}`, isCall: true };
    if (fn === 0x0c || fn === 0x0d) return { text: m };
    if (fn === 0x10 || fn === 0x12) return { text: `${m} ${R[rd]}` };
    if (fn === 0x11 || fn === 0x13) return { text: `${m} ${R[rs]}` };
    if (fn >= 0x18 && fn <= 0x1b) return { text: `${m} ${R[rs]}, ${R[rt]}` };
    if (fn === 0x21 && rt === 0) return { text: `move ${R[rd]}, ${R[rs]}` };
    return { text: `${m} ${R[rd]}, ${R[rs]}, ${R[rt]}` };
  }
  if (op === 1) {
    const t = (pc + 4 + (simm(w) << 2)) >>> 0;
    const m = { 0x00: 'bltz', 0x01: 'bgez', 0x10: 'bltzal', 0x11: 'bgezal' }[rt] ?? 'bcond';
    return { text: `${m} ${R[rs]}, ${tgt(t)}`, target: t, isBranch: true, isCall: rt >= 0x10 };
  }
  if (op === 2 || op === 3) {
    const t = (((pc + 4) & 0xf0000000) | ((w & 0x3ffffff) << 2)) >>> 0;
    return { text: `${op === 3 ? 'jal' : 'j'} ${tgt(t)}`, target: t, isBranch: true, isCall: op === 3 };
  }
  if (op >= 4 && op <= 7) {
    const t = (pc + 4 + (simm(w) << 2)) >>> 0;
    const m = ['beq', 'bne', 'blez', 'bgtz'][op - 4];
    if (op === 4 && rs === 0 && rt === 0) return { text: `b ${tgt(t)}`, target: t, isBranch: true };
    return { text: op <= 5 ? `${m} ${R[rs]}, ${R[rt]}, ${tgt(t)}` : `${m} ${R[rs]}, ${tgt(t)}`, target: t, isBranch: true };
  }
  if (IMM[op]) {
    if (op === 0x09 && rs === 0) return { text: `li ${R[rt]}, ${imm(w)}` };
    const v = op >= 0x0c ? hex(w & 0xffff) : imm(w);
    return { text: `${IMM[op]} ${R[rt]}, ${R[rs]}, ${v}` };
  }
  if (op === 0x0f) return { text: `lui ${R[rt]}, ${hex(w & 0xffff)}` };
  if (MEM[op]) return { text: `${MEM[op]} ${op === 0x32 || op === 0x3a ? '$' + rt : R[rt]}, ${imm(w)}(${R[rs]})` };
  if (op === 0x10 || op === 0x12) {
    const c = op === 0x10 ? 0 : 2;
    if (rs === 0) return { text: `mfc${c} ${R[rt]}, $${rd}` };
    if (rs === 2) return { text: `cfc${c} ${R[rt]}, $${rd}` };
    if (rs === 4) return { text: `mtc${c} ${R[rt]}, $${rd}` };
    if (rs === 6) return { text: `ctc${c} ${R[rt]}, $${rd}` };
    if (op === 0x10 && fn === 0x10) return { text: 'rfe' };
    if (op === 0x12 && (w & (1 << 25))) return { text: GTE[fn] ?? `cop2 ${hex(w & 0x1ffffff)}` };
  }
  return { text: `.word ${hex(w)}` };
}

/** Whether `ret` looks like a return address: the instruction two before it is a call. */
export function isReturnAddress(wordBefore2) {
  const op = wordBefore2 >>> 26;
  return op === 3 || (op === 0 && (wordBefore2 & 63) === 9) || (op === 1 && ((wordBefore2 >>> 16) & 31) >= 0x10);
}
