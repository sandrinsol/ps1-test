// Hardware rules for the `check` tool: what the PS-EXE header and disc must look
// like, and what to watch for while the game runs — crashes (CPU exceptions,
// hangs), lag, CPU load, a blank or frozen screen, GPU commands the console drops
// or that read the framebuffer as a texture, DMA from outside RAM, and the stack
// running into the program's data.
//
// Findings: { level: 'error' | 'warn' | 'ok' | 'info', msg }.

import { exeInfo, isoFile, systemCnf } from './disc.mjs';
import { bounds } from './gpu.mjs';
import { display, displayRgba } from './psx-memory.mjs';

const hex = (n) => '0x' + (n >>> 0).toString(16);
const EXC_NAMES = { 1: 'TLB modification', 2: 'TLB load', 3: 'TLB store', 4: 'address error on load/fetch (AdEL: unaligned or bad address)', 5: 'address error on store (AdES: unaligned or bad address)', 6: 'bus error on instruction fetch (IBE)', 7: 'bus error on data access (DBE)', 9: 'breakpoint (BREAK)', 10: 'reserved instruction (RI)', 11: 'coprocessor unusable (CpU)', 12: 'arithmetic overflow (Ov)' };

/** Problems in a PS-EXE header. `region` is the console region the game runs as. */
export function exeIssues(buf, { region = null } = {}) {
  let x;
  try { x = exeInfo(buf); } catch (e) { return [{ level: 'error', msg: e.message }]; }
  const out = [];
  const end = x.load + x.size;
  if (!x.region) out.push({ level: 'info', msg: 'PS-EXE has no region marker ("Sony Computer Entertainment Inc. for … area" at 0x4C): the BIOS ignores it, but some loaders and emulators use it to pick NTSC or PAL' });
  else out.push({ level: 'ok', msg: `PS-EXE region ${x.region}` });
  if (region && x.region && ((region === 'pal') !== (x.region === 'PAL'))) out.push({ level: 'warn', msg: `PS-EXE is marked ${x.region} but runs as ${region.toUpperCase()}: a console of the other region won't boot it, and frame timing differs (50 vs 60 Hz)` });
  if ((x.load & 0x1fffffff) < 0x10000) out.push({ level: 'error', msg: `loads at ${hex(x.load)}, over the BIOS kernel's RAM (0x80000000-0x8000FFFF): load at 0x80010000 or above` });
  if (x.entry < x.load || x.entry >= end) out.push({ level: 'error', msg: `entry point ${hex(x.entry)} is outside the loaded image (${hex(x.load)}-${hex(end)})` });
  if ((end & 0x1fffffff) > 0x200000) out.push({ level: 'error', msg: `the image ends at ${hex(end)}, past the 2 MB of RAM` });
  else if ((end & 0x1fffffff) > 0x1f0000) out.push({ level: 'warn', msg: `the image ends at ${hex(end)}: under 64 KB left for the stack and heap` });
  if (x.size % 2048) out.push({ level: 'warn', msg: `code size ${x.size} isn't a multiple of 2048 (the BIOS loads whole CD sectors; some loaders reject it)` });
  if (x.stack && ((x.stack & 0x1fffffff) > 0x200000 || x.stack < end)) out.push({ level: 'warn', msg: `initial stack ${hex(x.stack)} is outside RAM or inside the image` });
  return out;
}

/** Problems in a disc image (its data track): SYSTEM.CNF and the EXE it boots. */
export function discIssues(img, opts = {}) {
  const out = [];
  const cnf = systemCnf(img);
  if (!cnf) {
    const psx = isoFile(img, 'PSX.EXE');
    if (psx) { out.push({ level: 'warn', msg: 'no SYSTEM.CNF: the BIOS falls back to PSX.EXE with default settings' }); return [...out, ...exeIssues(psx, opts)]; }
    return [{ level: 'error', msg: 'the disc has neither SYSTEM.CNF nor PSX.EXE: the BIOS has nothing to boot' }];
  }
  if (!cnf.boot) return [{ level: 'error', msg: 'SYSTEM.CNF has no BOOT line' }];
  const m = /^cdrom:\\?\\?(.+?)(;1)?$/i.exec(cnf.boot);
  if (!m) return [{ level: 'error', msg: `SYSTEM.CNF BOOT = ${cnf.boot}: expected cdrom:\\NAME.EXE;1` }];
  if (!m[2]) out.push({ level: 'warn', msg: `SYSTEM.CNF BOOT = ${cnf.boot} has no ";1" version suffix (some BIOS versions need it)` });
  const exe = isoFile(img, m[1].replace(/\\/g, '/'));
  if (!exe) return [...out, { level: 'error', msg: `SYSTEM.CNF boots ${m[1]}, which isn't on the disc` }];
  out.push({ level: 'ok', msg: `SYSTEM.CNF boots ${m[1]}${cnf.stack ? `, stack ${cnf.stack}` : ''}` });
  // Sector 4 of a pressed disc holds the license text (and the region the drive's
  // copy protection expects); homebrew discs without it need a modchip or softmod.
  const lic = licenseText(img);
  out.push(lic ? { level: 'ok', msg: `license data: "${lic}"` } : { level: 'info', msg: 'no license data in sector 4: an unmodified console won\'t boot the disc (it needs a modchip, a softmod such as UniROM / FreePSXBoot, or an emulator); add the license sectors with mkpsxiso\'s <license> for your region' });
  return [...out, ...exeIssues(exe, opts)];
}

/** The license text in sector 4 of a disc's data track, or null. */
function licenseText(img) {
  const raw = img.length % 2352 === 0;
  const off = raw ? 4 * 2352 + (img[16 * 2352 + 15] === 2 ? 24 : 16) : 4 * 2048;
  const t = img.toString('latin1', off, off + 2048);
  const m = /(Licensed\s+by\s+Sony[^\0]{0,60}|Sony Computer Entertainment[^\0]{0,40})/.exec(t);
  return m ? m[1].replace(/\s+/g, ' ').trim() : null;
}

/** Watches a run frame by frame. Feed observe() once per frame. */
export class RunChecker {
  /** @param {{ frameCounter?: number | null, cpuUsage?: number | null, symbols?: any, dataEnd?: number | null }} [opts] */
  constructor({ frameCounter = null, cpuUsage = null, symbols = null, dataEnd = null } = {}) {
    this.frameCounter = frameCounter; this.cpuUsage = cpuUsage; this.symbols = symbols; this.dataEnd = dataEnd;
    this.frames = 0; this.lag = 0; this.lastCounter = null; this.cpu = [];
    this.exceptions = new Map(); this.pcs = []; this.minSp = Infinity;
    /** @type {Array<number | null>} */ this.counters = [];
    /** @type {boolean[]} */ this.drew = [];
    this.blank = 0; this.displayOff = 0; this.sameScreen = 0; this.lastScreen = null;
    this.gpu = { frames: 0, prims: 0, offArea: 0, tooBig: 0, texFb: new Set(), clutFb: new Set(), emptyClut: new Set(), dmaOutside: 0, unaligned: 0, leftover: 0, noPrims: 0, overflow: 0 };
  }

  name(addr) { return this.symbols?.nameOf(addr) ?? null; }

  /** @param {{ regions: any, cpu: any, cap?: any, counter?: number | null, cpuPct?: number | null }} o */
  observe({ regions: r, cpu, cap = null, counter = null, cpuPct = null }) {
    this.frames++;
    this.counters.push(counter);
    this.drew.push(!!cap && cap.prims.length > 0);
    if (counter !== null) {
      if (this.lastCounter !== null && counter === this.lastCounter) this.lag++;
      this.lastCounter = counter;
    }
    if (cpuPct !== null) this.cpu.push(cpuPct);
    this.pcs.push(cpu.pc);
    if (cpu.sp >= 0x80000000 && cpu.sp < 0x80200000 && (cpu.pc >>> 0) < 0xbfc00000) this.minSp = Math.min(this.minSp, cpu.sp);

    const d = display(r);
    if (!d.enabled) this.displayOff++;
    // The displayed part of VRAM: blank = one colour; frozen = same as last frame.
    const screen = displayRgba(r).rgba;
    let uniform = true;
    for (let i = 4; i < screen.length && uniform; i += 4) if (screen[i] !== screen[0] || screen[i + 1] !== screen[1] || screen[i + 2] !== screen[2]) uniform = false;
    if (uniform) this.blank++;
    if (this.lastScreen && this.lastScreen.equals(screen)) this.sameScreen++;
    this.lastScreen = screen;

    if (!cap) return;
    for (const e of cap.exceptions) {
      const key = `${e.code}:${e.epc}`;
      const prev = this.exceptions.get(key);
      this.exceptions.set(key, { ...e, count: (prev?.count ?? 0) + 1, frame: prev?.frame ?? this.frames });
    }
    const g = this.gpu;
    g.frames++;
    if (cap.overflow) g.overflow++;
    if (cap.leftover) g.leftover++;
    const draws = cap.prims.filter((p) => ['poly3', 'poly4', 'line', 'polyline', 'rect', 'sprite', 'dot'].includes(p.kind));
    g.prims += draws.length;
    if (!draws.length && !cap.prims.some((p) => p.kind === 'fill')) g.noPrims++;
    const a = cap.env.drawArea;
    const fb = [{ x0: a.x0, y0: a.y0, x1: a.x1, y1: a.y1 }, { x0: d.x, y0: d.y, x1: d.x + d.w - 1, y1: d.y + d.h - 1 }];
    const hits = (b) => fb.some((f) => b.x0 <= f.x1 && b.x1 >= f.x0 && b.y0 <= f.y1 && b.y1 >= f.y0);
    for (const p of draws) {
      const b = bounds(p);
      // Each primitive is drawn with the environment in force when it was sent;
      // the end-of-frame one is a close stand-in for "outside the screen".
      if (b && (b.x1 < a.x0 || b.x0 > a.x1 || b.y1 < a.y0 || b.y0 > a.y1)) g.offArea++;
      if (b && (p.kind.startsWith('poly') || p.kind === 'line') && (b.x1 - b.x0 > 1023 || b.y1 - b.y0 > 511)) {
        g.tooBig++;
        g.tooBigAt ??= p;
      }
      if (p.texpage) {
        const w = p.texpage.depth === '4bit' ? 64 : p.texpage.depth === '8bit' ? 128 : 256;
        const uv = p.uv ?? [[0, 0]];
        const us = uv.map((t) => t[0]), vs = uv.map((t) => t[1]);
        const tw = p.texpage.depth === '4bit' ? 4 : p.texpage.depth === '8bit' ? 2 : 1;
        const used = { x0: p.texpage.x + Math.floor(Math.min(...us) / tw), y0: p.texpage.y + Math.min(...vs), x1: p.texpage.x + Math.min(w - 1, Math.floor((Math.max(...us) + (p.size?.[0] ?? 0)) / tw)), y1: p.texpage.y + Math.max(...vs) + (p.size?.[1] ?? 0) - 1 };
        if (hits(used)) g.texFb.add(`${p.texpage.x},${p.texpage.y}`);
        if (p.clut) {
          const n = p.texpage.depth === '4bit' ? 16 : 256;
          if (hits({ x0: p.clut.x, y0: p.clut.y, x1: p.clut.x + n - 1, y1: p.clut.y })) g.clutFb.add(`${p.clut.x},${p.clut.y}`);
          let any = false;
          for (let i = 0; i < n && !any; i++) if (r.vram.readUInt16LE((p.clut.y * 1024 + p.clut.x + i) * 2) !== 0) any = true;
          if (!any) g.emptyClut.add(`${p.clut.x},${p.clut.y}`);
        }
      }
      if (p.src === 'dma' && !p.addr) g.dmaOutside++;
    }
    for (const c of cap.chains) if (c & 3) g.unaligned++;
  }

  /** @returns {Array<{ level: string, msg: string }>} */
  findings() {
    const out = [];
    const n = this.frames;
    for (const e of this.exceptions.values()) {
      const fn = this.name(e.epc);
      // A reserved instruction or FPU use inside a compiler helper (__bswapsi2,
      // __udivdi3, __addsf3…): a libgcc built for a newer MIPS than the PS1's
      // MIPS I, or with hard float.
      const helper = fn && /^__\w+/.test(fn);
      const fix = 'Link a runtime built for MIPS I ahead of libgcc: libmips1rt.a (templates/psn00bsdk/.devcontainer/build-mips1-rt.sh; the template links it), or use a MIPS I mipsel-none-elf toolchain';
      const hint = helper && e.code === 10
        ? `: a compiler runtime helper using instructions the R3000A lacks — the toolchain's libgcc was built for a newer MIPS (e.g. Debian/Ubuntu's mipsel-linux-gnu, MIPS32r2). ${fix}`
        : helper && e.code === 11
          ? `: a float/double helper using the FPU (coprocessor 1), which the PS1 doesn't have — the toolchain's libgcc is built for hard float (e.g. Debian/Ubuntu's mipsel-linux-gnu). ${fix}`
          : '';
      out.push({ level: 'error', msg: `CPU exception: ${EXC_NAMES[e.code] ?? `code ${e.code}`} at ${hex(e.epc)}${fn ? ` (${fn})` : ''}${e.code === 4 || e.code === 5 ? `, address ${hex(e.badVaddr)}` : ''}; first on frame ${e.frame} of the run${e.count > 1 ? `, ${e.count} times` : ''}${hint}` });
    }
    // In the BIOS/kernel at every frame boundary AND no sign of the game running
    // (games that wait for VSync through the kernel's interrupt handler are at
    // 0x80000080 every frame while running fine).
    const progressed = this.counters.some((c, i) => i > 0 && c !== null && c !== this.counters[i - 1]) || this.drew.some(Boolean);
    const inBios = !progressed && this.pcs.every((p) => (p >>> 0) >= 0xbfc00000 || (p & 0x1fffffff) < 0x10000);
    if (inBios && !this.exceptions.size) out.push({ level: 'warn', msg: 'the CPU was in the BIOS for the whole run: the game hadn\'t started yet (still booting from disc?). Run more frames first.' });
    // Hung: the PC on one address for 30 frames AND the game making no progress
    // (its frame counter still, or no GPU work). A healthy game is also always at
    // the same PC at a frame boundary — in its VSync wait.
    const last = this.pcs.slice(-30);
    const stillCounter = this.counters.slice(-30).every((c) => c === this.counters[this.counters.length - 1]);
    const noProgress = this.frameCounter !== null ? stillCounter : this.drew.slice(-30).every((d) => !d);
    if (last.length >= 30 && last.every((p) => p === last[0]) && noProgress && !(inBios && !this.exceptions.size)) {
      out.push({ level: 'error', msg: `the CPU stayed at ${hex(last[0])}${this.name(last[0]) ? ` (${this.name(last[0])})` : ''} for the last ${last.length} frames with no progress: hung${(last[0] >>> 0) >= 0xbfc00000 ? ' in the BIOS (after an exception)' : ''}` });
    }
    if (this.frameCounter !== null) {
      if (this.lastCounter !== null && this.lag === n - 1 && n > 1) out.push({ level: inBios ? 'info' : 'error', msg: `the frame counter never changed in ${n} frames: the main loop isn't running` });
      else if (this.lag) out.push({ level: 'warn', msg: `${this.lag} lag frame(s) in ${n}: the main loop missed VSync (${(this.lag / n * 100).toFixed(1)}%)` });
      else out.push({ level: 'ok', msg: `no lag frames in ${n}` });
    }
    if (this.cpu.length) {
      const max = Math.max(...this.cpu), avg = this.cpu.reduce((a, b) => a + b, 0) / this.cpu.length;
      out.push({ level: max >= 100 ? 'warn' : 'ok', msg: `CPU load ${Math.min(...this.cpu)}-${max}% (average ${avg.toFixed(0)}%)${max >= 100 ? ': over budget, frames will drop' : max >= 90 ? ': close to the frame budget' : ''}` });
    }
    if (this.displayOff === n) out.push({ level: inBios ? 'info' : 'error', msg: 'the display was off (GP1 0x03 "display disable") for the whole run' });
    else if (this.blank === n) out.push({ level: 'warn', msg: 'the screen was one flat colour for the whole run' });
    if (n > 1 && this.sameScreen === n - 1 && this.blank !== n) out.push({ level: 'info', msg: 'the picture didn\'t change during the run (a static screen, or frozen)' });
    if (this.minSp !== Infinity && this.dataEnd !== null) {
      const room = this.minSp - this.dataEnd;
      if (room < 0) out.push({ level: 'error', msg: `the stack went down to ${hex(this.minSp)}, into the program's data/heap (which ends at ${hex(this.dataEnd)})` });
      else if (room < 4096) out.push({ level: 'warn', msg: `the stack came within ${room} bytes of the program's data (lowest ${hex(this.minSp)}, data ends ${hex(this.dataEnd)})` });
      else out.push({ level: 'ok', msg: `stack low point ${hex(this.minSp)}, ${(room / 1024).toFixed(0)} KB above the data` });
    }
    const g = this.gpu;
    if (g.frames) {
      if (g.overflow) out.push({ level: 'warn', msg: `the GPU log overflowed on ${g.overflow} frame(s): GPU checks saw part of those frames` });
      if (g.noPrims === g.frames) out.push({ level: 'info', msg: 'no primitives were drawn' });
      else out.push({ level: 'ok', msg: `${(g.prims / g.frames).toFixed(0)} primitives per frame` });
      if (g.tooBig) out.push({ level: 'error', msg: `${g.tooBig} polygon(s)/line(s) wider than 1023 or taller than 511 pixels: the GPU skips those entirely (e.g. #${g.tooBigAt.n} ${g.tooBigAt.kind} at ${bounds(g.tooBigAt).x0},${bounds(g.tooBigAt).y0})` });
      if (g.offArea) out.push({ level: 'warn', msg: `${g.offArea} primitive(s) entirely outside the drawing area: never visible, but they still cost GPU time (wrong offset, or missing culling)` });
      if (g.texFb.size) out.push({ level: 'warn', msg: `texture page(s) ${[...g.texFb].join('; ')} overlap the framebuffer: textures read what was just drawn (fine for deliberate effects, otherwise garbage)` });
      if (g.clutFb.size) out.push({ level: 'warn', msg: `CLUT(s) ${[...g.clutFb].join('; ')} lie inside the framebuffer and get drawn over` });
      if (g.emptyClut.size) out.push({ level: 'warn', msg: `CLUT(s) ${[...g.emptyClut].join('; ')} are all zero (fully transparent): sprites using them are invisible — was the palette uploaded?` });
      if (g.dmaOutside) out.push({ level: 'error', msg: `${g.dmaOutside} GPU DMA transfer(s) from outside main RAM (the scratchpad can't be a DMA source)` });
      if (g.unaligned) out.push({ level: 'error', msg: `${g.unaligned} GPU DMA chain(s) started at an unaligned address` });
      if (g.leftover) out.push({ level: 'warn', msg: `a GP0 command was left incomplete at the end of ${g.leftover} frame(s) (a packet with the wrong word count?)` });
    }
    if (!this.exceptions.size) out.push({ level: 'ok', msg: 'no CPU exceptions' });
    return out;
  }
}
