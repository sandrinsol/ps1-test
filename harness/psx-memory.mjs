// Read PlayStation memory out of a pcsx_rearmed save state (RASTATE container
// around pcsx's own "STv4" freeze format). This gives real RAM, scratchpad, I/O,
// VRAM and SPU RAM reads with no core rebuild: the harness takes a state of the
// paused machine and indexes it by PS1 address.
//
// Layout of the "MEM " chunk (libpcsxcore/misc.c SaveState):
//   header[32] "STv4 PCSX…", u32 version, u8 hle, u8 origin_info[0x9000 - 3 … ]
//   psxM 2 MB main RAM | psxR 512 KB BIOS | psxH 64 KB (scratchpad 0x000-0x3ff,
//   I/O 0x1000-0x2fff) | psxRegisters (GPR, CP0, GTE data + control, pc, …)
//   GPUFreeze_t { u32 version = 1, u32 status, u32 control[256], VRAM 1 MB }
//   u32 spuSize, SPUFreeze_t { name[8], u32 ver, u32 size, ports[0x200], RAM 512 KB, … }
//   then SIO, CD-ROM, HW, root counters, MDEC, dynarec, pads.

const SCREENPIC = 128 * 96 * 3;
const OFF = {
  ram: 32 + 4 + 1 + SCREENPIC,
  ramSize: 0x200000, biosSize: 0x80000, hwSize: 0x10000,
};
OFF.bios = OFF.ram + OFF.ramSize;
OFF.hw = OFF.bios + OFF.biosSize;
OFF.regs = OFF.hw + OFF.hwSize;
// offsetof(psxRegisters, gteBusyCycle): 34 GPR + 32 CP0 + 64 GTE + pc/code/cycle/
// interrupt, intCycle[20] pairs, event_cycles[20], 4 more words.
const REGS_SIZE = (34 + 32 + 64 + 4) * 4 + 20 * 8 + 20 * 4 + 4 * 4;
OFF.gpu = OFF.regs + REGS_SIZE;
OFF.vram = OFF.gpu + 8 + 256 * 4;
OFF.spuSize = OFF.vram + 1024 * 512 * 2;
OFF.spuPorts = OFF.spuSize + 4 + 16;
OFF.spuRam = OFF.spuPorts + 0x200;

export const VRAM_W = 1024, VRAM_H = 512;

/** The "MEM " chunk (the raw retro_serialize output) of a RASTATE buffer. A bare
 *  pcsx freeze (starting "STv4") is accepted as is. */
export function memChunk(state) {
  if (state.toString('latin1', 0, 4) === 'STv4') return state;
  if (state.toString('latin1', 0, 7) !== 'RASTATE') throw new Error('not a RASTATE save state');
  let off = 8;
  while (off + 8 <= state.length) {
    const tag = state.toString('latin1', off, off + 4);
    const size = state.readUInt32LE(off + 4);
    if (tag === 'MEM ') return state.subarray(off + 8, off + 8 + size);
    off += 8 + size;
    if (tag === 'END ' || size === 0) break;
  }
  throw new Error('no MEM chunk in save state');
}

/** Parse a save state into typed views of every PS1 memory area. The views alias
 *  the state buffer, so writing them patches the state.
 *  { ram, scratchpad, io, bios, vram, spuRam, spuRegs, gpuStatus, gpuControl, hle } */
export function parseState(state) {
  const m = memChunk(state);
  if (m.toString('latin1', 0, 4) !== 'STv4') throw new Error('not a pcsx_rearmed save state (no STv4 header)');
  if (m.readUInt32LE(OFF.gpu) !== 1) throw new Error('unexpected pcsx_rearmed save state layout (GPU block not found)');
  const spuSize = m.readUInt32LE(OFF.spuSize);
  if (spuSize < 0x80000) throw new Error('unexpected pcsx_rearmed save state layout (SPU block not found)');
  const view = (start, len) => m.subarray(start, start + len);
  const hw = view(OFF.hw, OFF.hwSize);
  return {
    ram: view(OFF.ram, OFF.ramSize),
    bios: view(OFF.bios, OFF.biosSize),
    scratchpad: hw.subarray(0, 0x400),
    io: hw.subarray(0x1000, 0x3000),
    vram: view(OFF.vram, VRAM_W * VRAM_H * 2),
    spuRegs: view(OFF.spuPorts, 0x200),
    spuRam: view(OFF.spuRam, 0x80000),
    gpuStatus: m.readUInt32LE(OFF.gpu + 4),
    gpuControl: view(OFF.gpu + 8, 256 * 4),
    hle: m[32 + 4] !== 0,
    frameCounter: hw.readUInt32LE(0xf000 + 0x1c),
  };
}

/** Map a PS1 address to [region buffer, offset]. KUSEG/KSEG0/KSEG1 mirrors all
 *  work (0x00…, 0x80…, 0xA0…), and the 2 MB of RAM repeats up to 8 MB. */
function locate(r, addr) {
  const a = addr >>> 0;
  const phys = (a >>> 29) === 4 || (a >>> 29) === 5 ? a & 0x1fffffff : a; // KSEG0/1 → physical
  if (phys < 0x00800000) return [r.ram, phys & 0x1fffff];
  if (phys >= 0x1f800000 && phys < 0x1f800400) return [r.scratchpad, phys - 0x1f800000];
  if (phys >= 0x1f801000 && phys < 0x1f803000) return [r.io, phys - 0x1f801000];
  if (phys >= 0x1fc00000 && phys < 0x1fc80000) return [r.bios, phys - 0x1fc00000];
  throw new Error(`address 0x${a.toString(16)} is not in RAM, the scratchpad, I/O or the BIOS`);
}

/** Read `length` bytes at a PS1 address from a parsed state (or raw state buffer). */
export function readMemory(stateOrParsed, addr, length = 1) {
  const r = Buffer.isBuffer(stateOrParsed) ? parseState(stateOrParsed) : stateOrParsed;
  const out = Buffer.alloc(length);
  for (let i = 0; i < length; i++) {
    const [buf, off] = locate(r, (addr + i) >>> 0);
    out[i] = buf[off];
  }
  return out;
}

/** Patch memory at a PS1 address inside a save-state buffer (in place). BIOS
 *  writes are refused (it's ROM). */
export function writeMemory(state, addr, data) {
  const r = parseState(state);
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
  for (let i = 0; i < bytes.length; i++) {
    const [buf, off] = locate(r, (addr + i) >>> 0);
    if (buf === r.bios) throw new Error('the BIOS is read-only');
    buf[off] = bytes[i];
  }
  return state;
}

const offsetIn = (state, view) => view.byteOffset - state.byteOffset;

/** Save-state byte offsets of `length` bytes at a PS1 address. */
export function stateOffsets(state, addr, length = 1) {
  const r = parseState(state);
  return Array.from({ length }, (_, i) => { const [buf, o] = locate(r, (addr + i) >>> 0); return offsetIn(state, buf) + o; });
}

/** [start, length] ranges holding what determines the picture: the part of VRAM
 *  being displayed (and, for speed, nothing else) plus the GPU control words. */
export function videoRanges(state) {
  const r = parseState(state);
  const d = display(r);
  const ranges = [];
  for (let y = d.y; y < Math.min(VRAM_H, d.y + d.h); y++) {
    ranges.push([offsetIn(state, r.vram) + (y * VRAM_W + d.x) * 2, Math.min(d.w * (d.depth24 ? 3 : 2), (VRAM_W - d.x) * 2)]);
  }
  ranges.push([offsetIn(state, r.gpuControl), 0x40]);
  return ranges;
}

/** The display set-up decoded from the GPU's GP1 control words and status. */
export function display(r) {
  const c = (i) => r.gpuControl.readUInt32LE(i * 4) & 0xffffff;
  const st = r.gpuStatus;
  const start = c(5), hr = c(6), vr = c(7);
  const hres = [256, 320, 512, 640][(st >>> 17) & 3];
  const w = (st >>> 16) & 1 ? 368 : hres;
  const interlaced = !!((st >>> 22) & 1) && !!((st >>> 19) & 1);
  const pal = !!((st >>> 20) & 1);
  const lines = ((vr >>> 10) & 0x3ff) - (vr & 0x3ff);
  const h = Math.max(1, Math.min(interlaced ? 480 : 240, lines > 0 ? lines * (interlaced ? 2 : 1) : (interlaced ? 480 : 240)));
  return {
    x: start & 0x3ff, y: (start >>> 10) & 0x1ff, w, h,
    depth24: !!((st >>> 21) & 1), interlaced, pal,
    enabled: !((st >>> 23) & 1),
    hRange: [hr & 0xfff, (hr >>> 12) & 0xfff], vRange: [vr & 0x3ff, (vr >>> 10) & 0x3ff],
  };
}

const GPR = ['zero', 'at', 'v0', 'v1', 'a0', 'a1', 'a2', 'a3', 't0', 't1', 't2', 't3', 't4', 't5', 't6', 't7',
  's0', 's1', 's2', 's3', 's4', 's5', 's6', 's7', 't8', 't9', 'k0', 'k1', 'gp', 'sp', 'fp', 'ra'];
const EXC = ['Int', 'Mod', 'TLBL', 'TLBS', 'AdEL', 'AdES', 'IBE', 'DBE', 'Syscall', 'Bp', 'RI', 'CpU', 'Ov'];

/** R3000A registers, COP0 status and the GTE's registers from the state.
 *  @returns {Record<string, any> & { pc: number, sp: number, ra: number, hi: number, lo: number }} */
export function cpu(state) {
  const m = memChunk(state);
  const u = (i) => m.readUInt32LE(OFF.regs + i * 4);
  /** @type {Record<string, number>} */
  const r = Object.fromEntries(GPR.map((n, i) => [n, u(i)]));
  const cp0 = (i) => u(34 + i);
  const sr = cp0(12), cause = cp0(13);
  return {
    pc: u(130), ...r, sp: r.sp, ra: r.ra, hi: u(32), lo: u(33),
    cop0: { sr, cause, epc: cp0(14), badVaddr: cp0(8), exception: EXC[(cause >>> 2) & 0x1f] ?? `code ${(cause >>> 2) & 0x1f}` },
    interruptsEnabled: !!(sr & 1),
    gte: { data: Array.from({ length: 32 }, (_, i) => u(66 + i)), control: Array.from({ length: 32 }, (_, i) => u(98 + i)) },
    cycle: u(132),
  };
}

/** BGR555 VRAM → RGBA pixels of a rectangle (15-bit view; 4/8-bit textures are
 *  decoded by texture()). */
export function vramRgba(r, x = 0, y = 0, w = VRAM_W, h = VRAM_H) {
  const out = Buffer.alloc(w * h * 4);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const p = r.vram.readUInt16LE((((y + j) & 511) * VRAM_W + ((x + i) & 1023)) * 2);
      const o = (j * w + i) * 4;
      out[o] = (p & 31) * 255 / 31 | 0;
      out[o + 1] = ((p >>> 5) & 31) * 255 / 31 | 0;
      out[o + 2] = ((p >>> 10) & 31) * 255 / 31 | 0;
      out[o + 3] = 255;
    }
  }
  return out;
}

/** The displayed area as RGBA, decoding 24-bit mode too: what the TV shows,
 *  independent of the frontend's scaling. */
export function displayRgba(r) {
  const d = display(r);
  if (!d.depth24) return { w: d.w, h: d.h, rgba: vramRgba(r, d.x, d.y, d.w, d.h) };
  const out = Buffer.alloc(d.w * d.h * 4);
  for (let j = 0; j < d.h; j++) {
    const row = ((d.y + j) & 511) * VRAM_W * 2 + d.x * 2;
    for (let i = 0; i < d.w; i++) {
      const o = (j * d.w + i) * 4, s = row + i * 3;
      out[o] = r.vram[s % r.vram.length]; out[o + 1] = r.vram[(s + 1) % r.vram.length]; out[o + 2] = r.vram[(s + 2) % r.vram.length]; out[o + 3] = 255;
    }
  }
  return { w: d.w, h: d.h, rgba: out };
}
