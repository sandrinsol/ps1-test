// PlayStation test harness driver.
//
// Boots the bundled EmulatorJS pcsx_rearmed core in headless Chromium and exposes
// a scripting-style API (buttons, analog sticks, frame stepping, screenshots,
// save states, RAM, VRAM, memory cards) so AI/CI can test PS1 games and homebrew
// with no third-party emulator.
//
// Usage as a library:
//   import { EmuHarness } from './driver.mjs';
//   const emu = await EmuHarness.launch('game.cue');
//   await emu.waitFrames(300);
//   await emu.tap('START');
//   await emu.screenshot('out/title.png');
//   await emu.close();
//
// Usage as a CLI (quick smoke shot):
//   node driver.mjs shot <disc-or-exe> [frames=300] [out.png=out/shot.png]

import http from 'node:http';
import { readFile, writeFile, stat, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createReadStream, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as psxMem from './psx-memory.mjs';
import { findSymbols, loadSymbols, parseAddress } from './symbols.mjs';
import { discFiles, exeInfo } from './disc.mjs';
import { decodeLog } from './gpu.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..'); // the repo root (served to the browser)

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm',
  '.data': 'application/octet-stream', '.bin': 'application/octet-stream',
  '.png': 'image/png', '.map': 'application/json',
};

/** The frame every launch and reset leaves the machine on (see _settle). */
export const BOOT_FRAME = 10;

/** Where the bundled OpenBIOS lives (served to the page; MIT, from PCSX-Redux). */
export const OPENBIOS = path.join(ROOT, 'data', 'bios', 'openbios.bin');

/** The BIOS to boot with: 'openbios' (default), 'hle' (the core's built-in
 *  emulation, no file), or a path to a BIOS image (e.g. a SCPH1001 dump, 512 KB).
 *  PS1TEST_BIOS sets the default. */
export function resolveBios(bios) {
  const b = bios ?? process.env.PS1TEST_BIOS ?? 'openbios';
  if (b === 'hle' || b === 'openbios') return b;
  return path.resolve(process.cwd(), b);
}

// Serves the repo root, plus each loaded ROM in place at /__rom/<token>/<name>
// (no copying, so ROMs can live anywhere and the install dir can be read-only).
function startServer(rootDir, roms) {
  const server = http.createServer(async (req, res) => {
    try {
      const urlPath = decodeURIComponent(req.url.split('?')[0]);
      let filePath;
      const m = /^\/__rom\/([^/]+)\/(.*)$/.exec(urlPath);
      if (m) {
        // A disc's .cue names its track files relative to itself: serve those too.
        const entry = roms.get(m[1]);
        if (!entry) { res.writeHead(404).end(); return; }
        filePath = typeof entry === 'string' ? entry : entry[m[2]];
        if (!filePath) { res.writeHead(404).end(); return; }
      } else {
        filePath = path.join(rootDir, path.normalize(urlPath));
        if (!filePath.startsWith(rootDir)) { res.writeHead(403).end(); return; }
      }
      if (Buffer.isBuffer(filePath)) { res.writeHead(200, { 'Content-Type': 'application/octet-stream' }).end(filePath); return; }
      const info = await stat(filePath);
      if (info.isDirectory()) { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
      createReadStream(filePath).pipe(res);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: /** @type {import('node:net').AddressInfo} */ (server.address()).port }));
  });
}

// Browser + static server, launched once and shared by every `reuse: true` harness
// (the MCP server uses this so load_rom doesn't cold-start Chromium each time).
let sharedHost = null;

async function startHost({ headless = true } = {}) {
  const { chromium } = await import('playwright');
  const roms = new Map(); // token -> absolute ROM path
  const { server, port } = await startServer(ROOT, roms);
  let browser;
  try {
    browser = await chromium.launch({
      headless,
      // Optional: use a preinstalled Chromium instead of Playwright's download.
      executablePath: process.env.PS1TEST_CHROMIUM || undefined,
      args: [
        '--use-gl=angle', '--use-angle=swiftshader',
        '--ignore-gpu-blocklist', '--enable-webgl',
        '--autoplay-policy=no-user-gesture-required',
        '--mute-audio', '--hide-scrollbars',
      ],
    });
  } catch (e) {
    await new Promise((r) => server.close(r));
    if (/executable doesn't exist|ENOENT/i.test(e.message)) {
      throw new Error('Chromium is not installed. Run `npx playwright install chromium` (in the folder with this package), '
        + 'or set PS1TEST_CHROMIUM to an existing Chrome/Chromium binary.'
        + (process.env.PS1TEST_CHROMIUM ? ` (PS1TEST_CHROMIUM=${process.env.PS1TEST_CHROMIUM} was not found.)` : ''));
    }
    throw e;
  }
  return {
    browser, server, port, roms,
    async close() { await browser.close().catch(() => {}); await new Promise((r) => server.close(r)); },
  };
}

export class EmuHarness {
  constructor({ host, shared, context, page, romToken, system, blocked, options }) {
    this._state = null;      // cached raw state of the current frame (see _rawState)
    /** @type {import("./symbols.mjs").Symbols | null} */
    this.symbols = null; this.symbolsError = null;
    this.cheats = [];
    this.host = host; this._shared = shared;
    this.browser = host.browser; this.server = host.server;
    this.context = context; this.page = page;
    this._romToken = romToken; // this harness's entry in host.roms
    this.system = system;    // 'psx'
    /** How the machine was booted: { bios, region, pad1, pad2, rom, exe? } */
    this.options = options;
    this.blockedRequests = blocked; // external URLs the page tried to fetch (blocked: offline)
    /** The core has the ps1-test instrumentation (live memory, GPU log); set by launch. */
    this.live = false;
  }

  /** Boot a disc image (.cue/.bin/.iso/.img) or a PS-EXE (.exe/.psx). Options:
   *  - bios: 'openbios' (default; bundled), 'hle', or a path to a BIOS image.
   *  - region: 'ntsc' (default, 60 Hz), 'pal' (50 Hz) or 'auto' (from the disc).
   *  - pad1 / pad2: 'dualshock' (default for port 1), 'digital', 'analog', 'none'
   *    (default for port 2).
   *  - fast (default true): fast-forward long waits (results stay bit-identical).
   *  - reuse (default false): share one browser + server across harnesses; close()
   *    then only closes this page. Call EmuHarness.shutdown() when done.
   *  - symbols (default true): a symbol file (.elf/.map/.sym) path, true to look
   *    for one next to the disc/EXE, or false. Addresses can then be names.
   *  @param {string} romPath
   *  @param {{ headless?: boolean, timeout?: number, fast?: boolean, reuse?: boolean, symbols?: boolean | string | null,
   *    bios?: string, region?: string, pad1?: string, pad2?: string }} [opts] */
  static async launch(romPath, { headless = true, timeout = 60000, fast = true, reuse = false, symbols = true, bios, region = 'ntsc', pad1 = 'dualshock', pad2 = 'none' } = {}) {
    const absRom = path.resolve(process.cwd(), romPath);
    await stat(absRom).catch(() => { throw new Error(`disc image or EXE not found: ${absRom}`); });
    region = String(region).toLowerCase();
    if (!['ntsc', 'pal', 'auto'].includes(region)) throw new Error('region must be "ntsc", "pal" or "auto"');
    for (const p of [pad1, pad2]) if (!['dualshock', 'digital', 'analog', 'none'].includes(p)) throw new Error(`pad type "${p}": use dualshock, digital, analog or none`);
    const biosChoice = resolveBios(bios);
    if (biosChoice !== 'hle' && biosChoice !== 'openbios') {
      const st = await stat(biosChoice).catch(() => null);
      if (!st) throw new Error(`BIOS not found: ${biosChoice}`);
      if (st.size !== 512 * 1024) throw new Error(`BIOS ${biosChoice} is ${st.size} bytes; a PS1 BIOS is 524288 (512 KB)`);
    }
    // Fail early (with the reason) on a malformed PS-EXE or a .cue with missing tracks.
    const files = await discFiles(absRom);
    const exe = files.exe ? exeInfo(await readFile(absRom)) : null;

    let host;
    if (reuse) {
      if (!sharedHost || !sharedHost.browser.isConnected()) sharedHost = await startHost({ headless });
      host = sharedHost;
    } else {
      host = await startHost({ headless });
    }
    const romToken = randomUUID();
    host.roms.set(romToken, files.serve);
    const romUrlPath = `/__rom/${romToken}/${encodeURIComponent(files.url)}`;
    // The core finds a BIOS in its system folder by name: serve the user's under
    // a name it looks for.
    let biosParam = 'hle';
    if (biosChoice === 'openbios') biosParam = '/data/bios/openbios.bin';
    else if (biosChoice !== 'hle') { files.serve['scph1001.bin'] = biosChoice; biosParam = `/__rom/${romToken}/scph1001.bin`; }
    const context = await host.browser.newContext({
      viewport: { width: 640, height: 480 }, deviceScaleFactor: 1, reducedMotion: 'reduce',
    });
    // Offline guard: everything is bundled, so any non-local request is a bug
    // (e.g. EmulatorJS falling back to its CDN for a missing core). Block + record it.
    const blocked = [];
    await context.route('**/*', (route) => {
      const u = new URL(route.request().url());
      if (u.hostname === '127.0.0.1' || u.protocol === 'data:' || u.protocol === 'blob:') return route.continue();
      blocked.push(u.href);
      return route.abort('blockedbyclient');
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => { errors.push(e.message); });

    const cleanup = async () => {
      await context.close().catch(() => {});
      host.roms.delete(romToken);
      if (!reuse) await host.close();
    };
    const q = new URLSearchParams({ rom: romUrlPath, bios: biosParam, region, pad1, pad2 });
    if (!fast) q.set('fast', '0');
    const url = `http://127.0.0.1:${host.port}/harness/page.html?${q}`;
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => window.EJS_emulator && window.EJS_emulator.gameManager, { timeout });
      // Bound the wait for the 'start' event so a disc that never boots fails fast.
      await page.evaluate((ms) => Promise.race([
        window.Emu.ready(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('game did not start (the disc image or EXE may be unsupported or damaged)')), ms)),
      ]), timeout);
    } catch (e) {
      await cleanup();
      const extra = [
        errors.length ? `page errors: ${errors.join('; ')}` : '',
        blocked.length ? `blocked external requests (missing bundled file?): ${blocked.join(', ')}` : '',
      ].filter(Boolean).join('; ');
      throw new Error(`Emulator failed to start${extra ? ` (${extra})` : ''}: ${e.message}`);
    }

    // Hold the machine still between calls (it only runs inside waits).
    const system = await page.evaluate(() => { window.Emu.pause(); window.Emu.initAudio(); return window.Emu.system; });
    const options = { rom: absRom, bios: biosChoice, region, pad1, pad2, ...(exe ? { exe } : {}) };
    const emu = new EmuHarness({ host, shared: reuse, context, page, romToken, system, blocked, options });
    emu.live = await page.evaluate(() => window.Emu.hasInstrumentation());
    await emu._settle();
    if (exe) await page.evaluate(() => window.Emu.captureBoot());
    await emu.useSymbols(symbols === true ? await findSymbols(absRom) : symbols || null);
    return emu;
  }

  /** Bring a freshly booted (or reset) machine to frame BOOT_FRAME, the same
   *  frame on every run: EmulatorJS starts the core on its own schedule, so the
   *  frame it is paused on at first varies, and input sent then would land on
   *  different frames. On the way, "analog" pads get their analog mode: a
   *  DualShock goes analog on L1+R1+SELECT, which the core handles itself (the
   *  game never sees it). */
  async _settle() {
    const start = Math.max(await this.frameNum(), BOOT_FRAME - 4);
    await this.waitUntilFrame(start);
    const combos = [this.options.pad1, this.options.pad2].flatMap((p, i) => (p === 'analog' ? ['L1', 'R1', 'SELECT'].map((b) => (i ? `P2:${b}` : b)) : []));
    if (combos.length) {
      await this.setButtons(combos, true);
      await this.waitUntilFrame(start + 2);
      await this.setButtons(combos, false);
    }
    await this.waitUntilFrame(BOOT_FRAME);
  }

  /** Close the shared browser + server used by `reuse: true` harnesses. */
  static async shutdown() {
    const h = sharedHost; sharedHost = null;
    if (h) await h.close();
  }

  /** Load a symbol file (null clears). A file that fails to parse is reported in
   *  `symbolsError` instead of throwing. */
  async useSymbols(file) {
    this.symbols = null; this.symbolsError = null;
    if (!file) return null;
    try { this.symbols = await loadSymbols(path.resolve(file)); } catch (e) { this.symbolsError = e.message; }
    return this.symbols;
  }

  /** An address as a number: numbers, hex strings, or symbol names. */
  addr(a) { return parseAddress(a, this.symbols); }

  frameNum() { return this.page.evaluate(() => window.Emu.frameNum()); }
  videoDimensions() { return this.page.evaluate(() => window.Emu.videoDimensions()); }
  // Anything that runs or replaces the machine drops the cached state.
  waitFrames(n) { this._state = null; return this.page.evaluate((n) => window.Emu.waitFrames(n), n); }
  waitUntilFrame(abs) { this._state = null; return this.page.evaluate((a) => window.Emu.waitUntilFrame(a), abs); }
  setButton(name, pressed) { return this.page.evaluate(([n, p]) => window.Emu.setButton(n, p), [name, pressed]); }
  /** Tilt an analog stick ('left' | 'right') to x, y in -128..127 (0 = centre),
   *  on port 0 (1st controller) or 1. Needs a DualShock or analog pad (the default
   *  DualShock reports digital until the game switches it to analog). */
  setAnalog(stick, x, y, port = 0) { return this.page.evaluate(([s, a, b, p]) => window.Emu.setAnalog(s, a, b, p), [stick, x, y, port]); }
  /** Current stick positions: { 'P1:left': [x, y], … }. */
  analog() { return this.page.evaluate(() => window.Emu.analog()); }
  /** Frames per second of the emulated video mode (60 NTSC, 50 PAL). */
  get fps() { return this.options?.region === 'pal' ? 50 : 60; }
  /** Hold/release several buttons at once (e.g. ['L1', 'R1']). */
  setButtons(names, pressed) { return this.page.evaluate(([n, p]) => window.Emu.setButtons(n, p), [names, pressed]); }
  heldButtons() { return this.page.evaluate(() => window.Emu.heldButtons()); }
  /** Press, hold `hold` frames, release, settle `release` frames. `name` may be an array (combo). */
  tap(name, hold = 4, release = 4) { this._state = null; return this.page.evaluate(([n, h, r]) => window.Emu.tap(n, h, r), [name, hold, release]); }
  /** The deterministic wait clock's current target (waitFrames(n) moves it by n). */
  waitTarget() { return this.page.evaluate(() => window.Emu._target); }
  /** Fast-forward counters: { ffWaits, recoveries, restoreRetries }. */
  stats() { return this.page.evaluate(() => window.Emu.stats); }

  /** Reset the game, like the console's reset button: memory cards and cheats
   *  are kept and the clock restarts at BOOT_FRAME, as after launch (analog pads
   *  are switched to analog again). A side-loaded EXE restarts from where it was
   *  loaded. Deterministic: the same script gives the same result. */
  async restart() {
    this._state = null;
    await this.page.evaluate(() => window.Emu.reset());
    if (!this.options.exe) await this._settle();
  }

  /** PNG of the current frame → Buffer (and written to `outPath` if given).
   *  `this.lastScreenshotStale` is true when the picture for this exact state is
   *  unknown (right after loading a save state this session didn't create) — the
   *  image is then the last frame rendered; advance a frame for the true picture. */
  async screenshot(outPath) {
    const { png, stale } = await this.page.evaluate(() => window.Emu.screenshot());
    this.lastScreenshotStale = stale;
    const buf = Buffer.from(png, 'base64');
    if (outPath) {
      const abs = path.resolve(process.cwd(), outPath);
      await mkdir(path.dirname(abs), { recursive: true }); // out/ is gitignored; ensure it exists
      await writeFile(abs, buf);
    }
    return buf;
  }

  async saveState() {
    const b64 = await this.page.evaluate(() => window.Emu.saveState());
    return Buffer.from(b64, 'base64');
  }
  /** Raw state of the current frame, cached until the machine runs or changes, so
   *  many reads on one frame cost one transfer. Treat as read-only. */
  async _rawState() {
    if (!this._state) this._state = Buffer.from(await this.page.evaluate(() => window.Emu.rawState()), 'base64');
    return this._state;
  }
  /** Restore a state. The frame number keeps counting on, unless `frame` gives
   *  the number to continue from (e.g. the one the state was saved at). */
  async loadState(buf, { frame = undefined } = {}) {
    this._state = null;
    const b64 = Buffer.from(buf).toString('base64');
    await this.page.evaluate(([b, f]) => window.Emu.loadState(b, f), [b64, frame]);
  }

  /** Whether the loaded core exposes live RAM exports (the stock core does not;
   *  memory reads instead go through save-state parsing, which always works). */
  hasMemoryAccess() { return this.page.evaluate(() => window.Emu.hasMemoryAccess()); }
  async readSystemRam() {
    const r = await this.page.evaluate(() => window.Emu.readSystemRam());
    return r ? Buffer.from(r.base64, 'base64') : null;
  }

  get _mem() { return psxMem; }

  /** Parse the current state into typed memory regions (views; don't modify):
   *  { ram, scratchpad, io, bios, vram, spuRam, spuRegs, gpuStatus, gpuControl, hle }. */
  async readRegions() { return this._mem.parseState(await this._rawState()); }

  /** Read `length` bytes at a PS1 address: RAM (0x80000000-0x801FFFFF, or its
   *  0x00…/0xA0… mirrors), the scratchpad (0x1F800000-0x1F8003FF), I/O ports
   *  (0x1F801000-0x1F802FFF) or the BIOS (0xBFC00000). Reflects the current frame. */
  async readMemory(addr, length = 1) {
    addr = this.addr(addr);
    if (this.live) return Buffer.from(await this.page.evaluate((r) => window.Emu.liveReadRuns(r), psxMem.liveRuns(addr, length)), 'base64');
    return this._mem.readMemory(await this._rawState(), addr, length);
  }
  async readU8(addr) { return (await this.readMemory(addr, 1)).readUInt8(0); }
  async readU16(addr) { return (await this.readMemory(addr, 2)).readUInt16LE(0); }
  async readU32(addr) { return (await this.readMemory(addr, 4)).readUInt32LE(0); }

  /** Write bytes at a bus address on the current frame (patches a save state of
   *  the paused machine and reloads it; what's on screen is unchanged). Returns
   *  whether the bytes read back as written — false if the address isn't RAM-backed
   *  in the state. The game may still overwrite the value on the next frame. */
  async writeMemory(addr, data) {
    addr = this.addr(addr);
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (this.live) {
      const runs = psxMem.liveRuns(addr, bytes.length);
      if (runs.some((r) => r[0] === psxMem.LIVE.bios)) throw new Error('the BIOS is read-only');
      this._state = null;
      await this.page.evaluate(([r, b]) => window.Emu.liveWriteRuns(r, b), [runs, bytes.toString('base64')]);
      return (await this.readMemory(addr, bytes.length)).equals(bytes);
    }
    const state = Buffer.from(await this._rawState());
    this._mem.writeMemory(state, addr, bytes);
    await this._poke(state);
    return (await this.readMemory(addr, bytes.length)).equals(bytes);
  }
  /** Patch the current state in one go: fn(stateCopy, memModule) edits it, then it
   *  is loaded on the same frame (the picture is kept). */
  async patchState(fn) {
    const state = Buffer.from(await this._rawState());
    await fn(state, this._mem);
    await this._poke(state);
  }
  async _poke(state) {
    this._state = null;
    await this.page.evaluate((b) => window.Emu.pokeState(b), state.toString('base64'));
  }
  async writeU8(addr, v) { await this.writeMemory(addr, Buffer.from([v & 0xff])); }
  async writeU16(addr, v) { const b = Buffer.alloc(2); b.writeUInt16LE(v & 0xffff); await this.writeMemory(addr, b); }
  async writeU32(addr, v) { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); await this.writeMemory(addr, b); }

  /** R3000A registers on the current frame: { pc, zero…ra, hi, lo, cop0: { sr,
   *  cause, epc, badVaddr, exception }, interruptsEnabled, gte: { data[32],
   *  control[32] }, cycle }. */
  async readCpu() { return this._mem.cpu(await this._rawState()); }

  /** A light per-frame view for checks (instrumented core): { cpu, regions }
   *  where regions has vram (live), gpuStatus and gpuControl only. */
  async readLight() {
    if (!this.live) return { cpu: await this.readCpu(), regions: await this.readRegions() };
    const b = await this.page.evaluate(() => ({ ...window.Emu.stateBlocks(), vram: window.Emu.liveRead(2, 0, 0x100000) }));
    const gpu = Buffer.from(b.gpu, 'base64');
    return {
      cpu: psxMem.cpuFromRegs(Buffer.from(b.regs, 'base64')),
      regions: { vram: Buffer.from(b.vram, 'base64'), gpuStatus: gpu.readUInt32LE(4), gpuControl: gpu.subarray(8) },
    };
  }

  // ---- GPU command capture (instrumented core) ----
  /** Run `frames` frames (default 1) with the core logging every GPU command and
   *  CPU exception, and decode it: { prims, env, exceptions, gp1, chains, stats,
   *  overflow, frame } (see gpu.mjs decodeLog). Advances time like waitFrames.
   *  `startEx`: the E0-E7 registers at the start (default: read from a state),
   *  e.g. the previous capture's `ex` when capturing frame after frame. */
  async captureFrame(frames = 1, { startEx = null } = {}) {
    if (!this.live) throw new Error('GPU capture needs the bundled ps1-test core (this core has no command log)');
    if (!startEx) {
      const r = await this.readRegions();
      startEx = Array.from({ length: 8 }, (_, i) => r.gpuControl.readUInt32LE((0xe0 + i) * 4));
    }
    await this.page.evaluate(() => window.Emu.logCtl(true));
    try { await this.waitFrames(frames); } finally {
      var log = await this.page.evaluate(() => { const l = window.Emu.logRead(); window.Emu.logCtl(false); return l; });
    }
    const cap = decodeLog(Buffer.from(log.words, 'base64'), startEx);
    return { ...cap, overflow: log.overflow, frame: await this.frameNum() };
  }

  // ---- Memory cards ----
  /** The memory card in `slot` (1 or 2) as a 128 KB raw image (.mcr/.mcd), or
   *  null if the slot is empty. */
  async readMemoryCard(slot = 1) {
    const p = await this._cardPath(slot);
    const b64 = await this.page.evaluate((f) => window.Emu.readFile(f), p);
    return b64 ? Buffer.from(b64, 'base64') : null;
  }
  /** Put a memory card image (raw 128 KB, DexDrive .gme or .vgs) in `slot`. The
   *  game is then reset so it sees the new card, unless reset:false. */
  async writeMemoryCard(data, { slot = 1, reset = true } = {}) {
    const buf = rawCard(Buffer.from(data));
    const p = await this._cardPath(slot);
    this._state = null;
    await this.page.evaluate(([f, b]) => { window.Emu.writeFile(f, b); window.Emu.loadSaveFiles(); }, [p, buf.toString('base64')]);
    if (reset) await this.restart();
  }
  async _cardPath(slot) {
    if (slot !== 1 && slot !== 2) throw new Error('memory card slot must be 1 or 2');
    if (slot === 1) return this.page.evaluate(() => window.Emu.saveFilePath());
    const files = await this.page.evaluate(() => window.Emu.saveFiles());
    return Object.keys(files).find((f) => /card2|_2\.mcd$/i.test(f)) ?? '/data/saves/card2.mcd';
  }

  // ---- Recording ----
  /** Start capturing frames: every `every`-th frame while the game runs (waits
   *  run at 1x meanwhile), keeping the last `maxFrames` captures. */
  async startRecording({ every = 1, maxFrames = 600 } = {}) {
    await this.page.evaluate(([e, m]) => window.Emu.recStart(e, m), [every, maxFrames]);
  }
  /** Stop capturing → [{ frame, png: Buffer }] in frame order. The array also
   *  carries `.audio` = { rate, channels, pcm: Buffer (s16le interleaved) } or null. */
  async stopRecording() {
    const { frames, audio } = await this.page.evaluate(() => window.Emu.recStop());
    const out = frames.map((f) => ({ frame: f.frame, png: Buffer.from(f.png, 'base64') }));
    /** @type {any} */ (out).audio = audio ? { rate: audio.rate, channels: audio.channels, pcm: Buffer.from(audio.pcm, 'base64') } : null;
    return out;
  }
  get recording() { return this.page.evaluate(() => !!window.Emu._rec); }
  /** PNG Buffers → JPEG Buffers upscaled by `scale` with no smoothing (encoded by
   *  the browser; used to feed Playwright's JPEG-only ffmpeg). */
  async toJpeg(pngs, scale = 1) {
    const out = await this.page.evaluate(async ([list, k]) => {
      const res = [];
      for (const b64 of list) {
        const bmp = await createImageBitmap(new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type: 'image/png' }));
        const c = new OffscreenCanvas(bmp.width * k, bmp.height * k);
        const ctx = c.getContext('2d');
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(bmp, 0, 0, c.width, c.height);
        const blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.95 });
        const u8 = new Uint8Array(await blob.arrayBuffer());
        let s = '';
        for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
        res.push(btoa(s));
      }
      return res;
    }, [pngs.map((p) => p.toString('base64')), scale]);
    return out.map((b) => Buffer.from(b, 'base64'));
  }
  /** Advance `frames` frames, capturing every `every`-th (frame-exact). */
  async record(frames, { every = 1 } = {}) {
    await this.startRecording({ every, maxFrames: Math.ceil(frames / every) + 2 });
    try { await this.waitFrames(frames); } finally { return this.stopRecording(); }
  }

  // ---- Cheats ----
  /** Set the active cheat codes (replaces the list): GameShark / Action Replay
   *  lines such as "8009C6E4 0064" (several lines in one code are fine). Cheats
   *  apply every frame and survive restart(). */
  async setCheats(codes) {
    this.cheats = [...codes];
    await this.page.evaluate((c) => window.Emu.setCheats(c), this.cheats);
  }

  // ---- Waiting on conditions ----
  /** Run until a condition holds (or `maxFrames` pass) and stop on the first frame
   *  where it does. Conditions:
   *   { address, as='u8', op: eq|ne|gt|lt|gte|lte|changed, value }
   *   { screen: 'changed' }            video memory differs from now
   *   { screen: 'stable', frames: 30 } video memory unchanged for N frames
   *  (Screen conditions watch the displayed part of VRAM and the display
   *  registers, which is what the picture is made from.) → { met, frame } */
  async waitFor(cond, { maxFrames = 600, precise = false } = {}) {
    const state = this.live ? null : await this._rawState();
    let spec;
    if (cond.screen) {
      if (!['changed', 'stable'].includes(cond.screen)) throw new Error('screen must be "changed" or "stable"');
      spec = { kind: 'video', mode: cond.screen, frames: cond.frames ?? 30, ...(this.live ? { live: true } : { ranges: this._mem.videoRanges(state) }) };
    } else {
      const as = cond.as ?? 'u8';
      const width = { u8: 1, s8: 1, u16: 2, s16: 2, u32: 4, s32: 4 }[as];
      if (!width) throw new Error(`bad "as" ${as}`);
      const op = cond.op ?? 'eq';
      if (!['eq', 'ne', 'gt', 'lt', 'gte', 'lte', 'changed'].includes(op)) throw new Error(`bad op ${op}`);
      if (op !== 'changed' && typeof cond.value !== 'number') throw new Error(`op ${op} needs a numeric value`);
      const a = this.addr(cond.address);
      spec = { kind: 'value', signed: as.startsWith('s'), op, value: cond.value,
        ...(this.live ? { live: psxMem.liveRuns(a, width).flatMap(([w, o, n]) => Array.from({ length: n }, (_, i) => [w, o + i])) } : { offsets: this._mem.stateOffsets(state, a, width) }) };
    }
    this._state = null;
    return this.page.evaluate(([sp, m, p]) => window.Emu.waitFor(sp, m, p), [spec, maxFrames, precise]);
  }

  async close() {
    await this.context?.close().catch(() => {});
    this.host?.roms.delete(this._romToken);
    if (!this._shared) await this.host?.close();
  }
}

/** A raw 128 KB memory card image from the common formats: raw .mcr/.mcd/.srm,
 *  DexDrive .gme (3904-byte header) or .vgs/.mem (64-byte header). */
export function rawCard(buf) {
  const SIZE = 128 * 1024;
  if (buf.length === SIZE) return buf;
  if (buf.length === SIZE + 3904 && buf.toString('latin1', 0, 11) === '123-456-STD') return buf.subarray(3904);
  if (buf.length === SIZE + 64 && buf.toString('latin1', 0, 4) === 'VgsM') return buf.subarray(64);
  throw new Error(`not a memory card image: ${buf.length} bytes (a raw card is 131072)`);
}

// ---- CLI ----
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const [cmd, rom, framesArg, outArg] = process.argv.slice(2);
  if (cmd !== 'shot' || !rom) {
    console.error('Usage: node driver.mjs shot <disc-or-exe> [frames=300] [out.png=out/shot.png]');
    process.exit(1);
  }
  const frames = Number(framesArg || 300);
  const out = outArg || 'out/shot.png';
  const emu = await EmuHarness.launch(rom);
  await emu.waitFrames(frames);
  await emu.screenshot(out);
  console.log(`Ran ${frames} frames of ${rom}; screenshot -> ${out} (frame ${await emu.frameNum()})`);
  await emu.close();
}
