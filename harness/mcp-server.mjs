#!/usr/bin/env node
// PlayStation (PS1) test harness as an MCP server.
//
// Exposes the emulator to any MCP host (Claude Code, Claude Desktop, Cursor, ...)
// as tools an AI agent can call to test the PS1 games and homebrew it builds — no
// third-party emulator program. Tools, in groups:
//   play     load_disc, wait_frames, press, set_button, set_analog, wait_until, reset
//   look     screenshot, read_memory, read_cpu, gpu_capture, view_vram, describe, status
//   change   write_memory, state (save/load), memory_card, cheats
//   test     run_sequence, assert_golden, export_script, ab_compare, record_video
//   find     ram_search
//   make     texture (PNG ↔ TIM, into VRAM), background (maps → tileset + map), data (VAG sound, tables, meshes)
//   develop  build (compile + reload), check (hardware rules), new_project
//   debug    debug (breakpoints, watchpoints, step, disassembly, call stack), profile, spu, cd_log
// Addresses can be symbol names when there is a symbol file (.elf/.map/.sym).
// A ps1test.json in the workspace sets project defaults (build, rom, bios, watch).
// The machine is paused between calls, so every read lands on an exact frame.
//
// Token budget: every tool definition is resent with each request, so they are
// kept terse and PS1TEST_TOOLS can expose a subset (see toolFilter). Results put
// their data in one place, and images default to 2x.
//
// Run: node mcp-server.mjs   (stdio transport)
// Library/tests: import { createServer } from './mcp-server.mjs'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { RootsListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import path from 'node:path';
import { readFileSync, realpathSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { EmuHarness } from './driver.mjs';
import { findSymbols } from './symbols.mjs';
import { assertGolden, compare } from './assert.mjs';
import { scalePng, contactSheet } from './png.mjs';
import { saveVideo } from './recording.mjs';
import { RamSearch, SEARCH_OPS, SEARCH_TYPES } from './ramsearch.mjs';
import { runSteps, decodeValues, encodeValue, VALUE_TYPES } from './steps.mjs';
import { runCommand, parseDiagnostics, formatDiagnostic, detectBuild, findRom, readProjectConfig } from './build.mjs';
import { discFiles, dataTrack, isoList, makeDisc, exeInfo } from './disc.mjs';
import { elfToExe } from './exe.mjs';
import { primLine, captureImage, vramPng, texturePng, stateDrawEnv } from './gpu.mjs';
import { display } from './psx-memory.mjs';
import { listSaves, formatCard } from './mcard.mjs';
import { exeIssues, discIssues, RunChecker } from './checks.mjs';
import { TEMPLATES, createProject } from './templates.mjs';
import { convertTim, readTim, timToPng, timToC } from './tim.mjs';
import { convertTilemap, writeTilemap, renderTiledMap } from './tilemap.mjs';
import { encodeVag, writeSound, makeTable, writeTable, convertMesh, writeMesh, decodeAdpcm, encodeWav16 } from './gamedata.mjs';
import { vramImage, outline } from './gpu.mjs';
import { encodePng } from './png.mjs';
import { REG_NAMES } from './mips.mjs';
import { listing, callStack, profileByFunction } from './debugger.mjs';
import { describeSpu, sampleAt, pitchToRate } from './spu.mjs';
import { summarizeCd } from './cdrom.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'out');
const VERSION = JSON.parse(readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version;

const BUTTONS = ['CROSS', 'CIRCLE', 'SQUARE', 'TRIANGLE', 'L1', 'R1', 'L2', 'R2', 'L3', 'R3', 'START', 'SELECT', 'UP', 'DOWN', 'LEFT', 'RIGHT'];
const Button = z.enum(BUTTONS);
const Port = z.number().int().min(1).max(2).default(1);
const Address = z.union([z.number().int().nonnegative(), z.string()]).describe('number, "0x..." or symbol');
const Scale = z.number().int().min(1).max(4).default(2);

/** Tools in the "core" set: enough to play, look, check and script a game. */
export const CORE_TOOLS = ['load_disc', 'wait_frames', 'press', 'set_button', 'set_analog', 'wait_until', 'screenshot',
  'read_memory', 'write_memory', 'run_sequence', 'assert_golden', 'status', 'build', 'describe'];

/** Drop JSON-schema detail that costs tokens on every request but rarely helps
 *  a model: the $schema URL, numeric bounds, "type" next to an enum, a record's
 *  default key/value schemas; and write anyOf of plain types as a type list.
 *  Inputs are still fully validated by the zod schemas on the server, whose
 *  error messages state the limits. */
function slimSchema(node) {
  if (Array.isArray(node)) return node.map(slimSchema);
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === '$schema' || k === 'minimum' || k === 'maximum' || k === 'exclusiveMinimum' || k === 'exclusiveMaximum') continue;
    if (k === 'type' && node.enum) continue;
    if (k === 'propertyNames' && v?.type === 'string' && Object.keys(v).length === 1) continue;
    if (k === 'additionalProperties' && v && typeof v === 'object' && !Object.keys(v).length) continue;
    if (k === 'anyOf') {
      const kids = v.map(slimSchema);
      if (kids.every((x) => Object.keys(x).length === 1 && typeof x.type === 'string')) { out.type = kids.map((x) => x.type); continue; }
    }
    out[k] = slimSchema(v);
  }
  return out;
}

/** Which tools to register, from PS1TEST_TOOLS (or the `tools` option): unset or
 *  "all" = every tool; otherwise a comma list of tool names and/or "core". */
export function toolFilter(spec) {
  if (!spec || spec.trim() === 'all') return () => true;
  const want = new Set(spec.split(',').map((x) => x.trim()).filter(Boolean).flatMap((x) => (x === 'core' ? CORE_TOOLS : [x])));
  return (name) => want.has(name);
}

const hex = (n) => '0x' + (n >>> 0).toString(16);
const hexBytes = (buf) => buf.toString('hex').replace(/(..)/g, '$1 ').trim();
const png = (buf) => ({ type: 'image', data: buf.toString('base64'), mimeType: 'image/png' });

/** Build an MCP server with its own emulator session. Options:
 *  - root: base dir for relative paths (else $PS1TEST_ROOT, the client's first
 *    file:// root, or the process cwd)
 *  - fast: default fast-forward setting for load_disc
 *  - tools: which tools to expose (else $PS1TEST_TOOLS; see toolFilter)
 *  @param {{ root?: string, fast?: boolean, tools?: string }} [opts] */
export function createServer({ root = undefined, fast = true, tools = undefined } = {}) {
  // ---- Session (one game at a time) ----
  let emu = null;
  let romName = null, romPath = null;
  const states = new Map(); // id -> Buffer (save states)
  let search = null;        // active RamSearch
  let rec = [];             // steps done since load_disc (export_script)
  const record = (step) => { rec.push(step); };
  let cfg = {};             // ps1test.json of the workspace
  let lastOpts = { fast };  // load_disc's options (fast, bios, region, pads), reused by build
  let watches = null;       // [{ label, expr, as }] (null = from ps1test.json)
  let charmap = null;       // describe's charmap (null = from ps1test.json)
  let lastDescribe = null;  // screenshot at the last describe

  const server = new McpServer({ name: 'ps1-test-mcp', version: VERSION });

  // Tool calls touch one shared emulator, and hosts may issue calls in parallel;
  // run them strictly one at a time.
  let queue = Promise.resolve();
  const serial = (fn) => (...args) => {
    const run = queue.then(() => fn(...args));
    queue = run.catch(() => {});
    return run;
  };

  // ---- Path resolution ----
  let rootsDir; // undefined = not fetched yet, null = none
  server.server.setNotificationHandler(RootsListChangedNotificationSchema, async () => { rootsDir = undefined; });
  async function baseDir() {
    if (root) return path.resolve(root);
    if (process.env.PS1TEST_ROOT) return path.resolve(process.env.PS1TEST_ROOT);
    if (rootsDir === undefined) {
      rootsDir = null;
      try {
        if (server.server.getClientCapabilities()?.roots) {
          const { roots } = await server.server.listRoots();
          const r = roots.find((x) => x.uri.startsWith('file://'));
          if (r) rootsDir = fileURLToPath(r.uri);
        }
      } catch { /* client didn't answer; fall back to cwd */ }
    }
    return rootsDir || process.cwd();
  }
  const resolvePath = async (p) => (path.isAbsolute(p) ? p : path.resolve(await baseDir(), p));

  // Files are only written inside the workspace root (or harness/out), so a
  // confused or prompt-injected agent can't overwrite arbitrary files.
  // PS1TEST_ALLOW_ANY_PATH=1 lifts this.
  const inside = (abs, dir) => { const rel = path.relative(dir, abs); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };
  async function writeGuard() {
    const roots = [await baseDir(), OUT_DIR];
    return (abs) => {
      if (process.env.PS1TEST_ALLOW_ANY_PATH === '1' || roots.some((d) => inside(abs, d))) return;
      throw new Error(`refusing to write outside the workspace (${roots.join(', ')}): ${abs}. Set PS1TEST_ALLOW_ANY_PATH=1 to allow.`);
    };
  }
  const writePath = async (p) => { const abs = await resolvePath(p); (await writeGuard())(abs); return abs; };

  // ---- Helpers ----
  function requireRom() {
    if (!emu) throw new Error('Nothing loaded. Call load_disc first.');
  }
  /** "0x80010394" or "0x80010394 (frame_count)". */
  const label = (addr) => { const n = emu?.symbols?.nameOf(addr, { maxOffset: 32 }); return n ? `${hex(addr)} (${n})` : hex(addr); };

  /** Boot `abs`. Options not given come from ps1test.json, then the defaults;
   *  with `again` (a rebuild), from the last load first.
   *  @param {string} abs @param {{ fast?: boolean, symbols?: string, bios?: string, region?: string, pad1?: string, pad2?: string }} [opts] */
  async function loadRom(abs, opts = {}, { again = false } = {}) {
    await discFiles(abs); // a bad path or file fails here, before the running game is closed
    if (emu) { await emu.close().catch(() => {}); emu = null; }
    states.clear(); search = null; rec = []; lastDescribe = null;
    const bd = await baseDir();
    cfg = await readProjectConfig(bd);
    const pick = (k) => opts[k] ?? (again ? lastOpts[k] : undefined) ?? cfg[k];
    const bios = pick('bios');
    const o = { fast: pick('fast') ?? fast, bios: bios && !['hle', 'openbios'].includes(bios) ? path.resolve(bd, bios) : bios,
      region: pick('region'), pad1: pick('pad1'), pad2: pick('pad2') };
    const sym = opts.symbols ?? (cfg.symbols ? path.resolve(bd, cfg.symbols) : true);
    emu = await EmuHarness.launch(abs, { reuse: true, symbols: sym, ...Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) });
    lastOpts = { fast: o.fast, bios: emu.options.bios, region: emu.options.region, pad1: emu.options.pad1, pad2: emu.options.pad2 };
    romName = path.basename(abs); romPath = abs;
    return emu;
  }
  /** "OpenBIOS" / "HLE BIOS" / "BIOS SCPH1001.BIN". */
  const biosName = () => (emu.options.bios === 'openbios' ? 'OpenBIOS' : emu.options.bios === 'hle' ? 'HLE BIOS' : `BIOS ${path.basename(emu.options.bios)}`);
  const symbolInfo = () => (emu.symbols ? `, ${emu.symbols.count} symbols from ${path.basename(emu.symbols.file)}` : emu.symbolsError ? `; symbols not loaded: ${emu.symbolsError}` : '');

  /** Watched variables: "name", "name:u16", "0x80010000:s8". */
  const parseWatch = (w) => { const m = /^(.*?)(?::(u8|u16|u32|s8|s16|s32))?$/.exec(String(w).trim()); return { label: m[1], expr: m[1], as: m[2] ?? 'u8' }; };
  const activeWatches = () => watches ?? (Array.isArray(cfg.watch) ? cfg.watch.map(parseWatch) : []);
  async function watchValues() {
    const out = [];
    for (const w of activeWatches()) {
      try { out.push(`${w.label}=${decodeValues(await emu.readMemory(emu.addr(w.expr), VALUE_TYPES[w.as][0]), w.as)[0]}`); } catch { out.push(`${w.label}=?`); }
    }
    return out;
  }
  /** A "watch: a=1 b=2" line to append to results that advance time ('' if none). */
  const watchLine = async () => { const v = emu ? await watchValues() : []; return v.length ? `\nwatch: ${v.join(' ')}` : ''; };
  // Results carry their data ONCE: lists and dumps go in the text (what the model
  // reads); structuredContent holds only small scalar fields for programmatic use.
  const result = (text, structured, extra = []) => ({
    content: [{ type: 'text', text }, ...extra],
    ...(structured ? { structuredContent: structured } : {}),
  });
  const errText = (s) => ({ content: [{ type: 'text', text: s }], isError: true });

  // Which tools to expose (each one's definition is resent with every request).
  const enabled = toolFilter(tools ?? process.env.PS1TEST_TOOLS);

  /** Register a tool whose handler runs serialized and turns throws into tool errors. */
  function tool(name, config, handler, { needsRom = true } = {}) {
    if (!enabled(name)) return;
    server.registerTool(name, config, serial(async (args, extra) => {
      try {
        if (needsRom) requireRom();
        return await handler(args ?? {}, extra);
      } catch (e) {
        return errText(`${name} failed: ${e.message}`);
      }
    }));
  }

  const RO = { readOnlyHint: true };
  const buttonsOf = ({ button, buttons, port = 1 }) => {
    const list = [...(buttons ?? []), ...(button ? [button] : [])];
    if (!list.length) throw new Error('give `button` or `buttons`');
    return [...new Set(list)].map((b) => (port === 2 ? `P2:${b}` : b));
  };
  const Rect = z.object({ x: z.number().int(), y: z.number().int(), w: z.number().int(), h: z.number().int() });

  // ---- Play ----
  tool('load_disc', {
    description: 'Boot a disc (.cue/.bin/.iso) or PS-EXE, fresh; a .elf/.map/.sym beside it gives symbols. Paused between calls: reads are frame-exact.',
    inputSchema: {
      path: z.string().optional().describe('default: ps1test.json rom'),
      bios: z.string().optional().describe('openbios (default) | hle | path to a BIOS dump'),
      region: z.enum(['ntsc', 'pal', 'auto']).optional().describe('default ntsc (60 Hz)'),
      pad1: z.enum(['dualshock', 'digital', 'analog', 'none']).optional(),
      pad2: z.enum(['dualshock', 'digital', 'analog', 'none']).optional(),
      fast: z.boolean().default(fast).describe('fast-forward long waits (same results)'),
      symbols: z.string().optional().describe('symbol file if not beside it'),
    },
  }, async ({ path: rom, bios, region, pad1, pad2, fast: ff, symbols }) => {
    const bd = await baseDir();
    const want = rom ?? (await readProjectConfig(bd)).rom;
    if (!want) return errText('give `path` (or set "rom" in ps1test.json)');
    const abs = await resolvePath(want);
    await loadRom(abs, { fast: ff, bios, region, pad1, pad2, symbols: symbols ? await resolvePath(symbols) : undefined });
    const frame = await emu.frameNum();
    const o = emu.options;
    const exe = o.exe ? `, PS-EXE ${o.exe.region ?? 'no region'} entry ${hex(o.exe.entry)}` : '';
    return result(`Loaded ${abs} (${biosName()}, ${o.region.toUpperCase()}, pad ${o.pad1}${o.pad2 !== 'none' ? `+${o.pad2}` : ''}${exe}), frame ${frame}${symbolInfo()}.`,
      { frame, bios: o.bios, region: o.region });
  }, { needsRom: false });

  tool('wait_frames', {
    description: 'Advance N frames (60 = 1 s; 50 on PAL). Held buttons and sticks stay held.',
    inputSchema: { frames: z.number().int().positive() },
  }, async ({ frames }) => {
    await emu.waitFrames(frames);
    record({ wait: frames });
    const frame = await emu.frameNum();
    return result(`Frame ${frame}.${await watchLine()}`, { frame });
  });

  tool('press', {
    description: 'Tap one button or a combo: hold `hold` frames, release, wait `release` frames.',
    inputSchema: {
      button: Button.optional(),
      buttons: z.array(Button).optional(),
      port: Port,
      hold: z.number().int().positive().default(4),
      release: z.number().int().nonnegative().default(4),
    },
  }, async (args) => {
    const list = buttonsOf(args);
    await emu.tap(list, args.hold, args.release);
    record({ tap: list.length === 1 ? list[0] : list, hold: args.hold, release: args.release });
    const frame = await emu.frameNum();
    return result(`Pressed ${list.join('+')}. Frame ${frame}.${await watchLine()}`, { frame });
  });

  tool('set_button', {
    description: 'Hold or release button(s) without advancing time.',
    inputSchema: { button: Button.optional(), buttons: z.array(Button).optional(), pressed: z.boolean(), port: Port },
  }, async (args) => {
    const list = buttonsOf(args);
    await emu.setButtons(list, args.pressed);
    record(args.pressed ? { press: list } : { release: list });
    const held = await emu.heldButtons();
    return result(`Held: ${held.join(', ') || 'none'}.`);
  });

  tool('set_analog', {
    description: 'Tilt a stick to x,y (-128..127, +y down); stays until changed. Needs analog mode (pad1:"analog", or the game enables it).',
    inputSchema: { stick: z.enum(['left', 'right']), x: z.number().int().min(-128).max(127).default(0), y: z.number().int().min(-128).max(127).default(0), port: Port },
  }, async ({ stick, x, y, port }) => {
    await emu.setAnalog(stick, x, y, port - 1);
    record({ analog: stick, x, y, ...(port === 2 ? { port } : {}) });
    const pos = await emu.analog();
    return result(`Sticks: ${Object.entries(pos).filter(([, v]) => v[0] || v[1]).map(([k, v]) => `${k} ${v[0]},${v[1]}`).join(', ') || 'centred'}.`);
  });

  tool('wait_until', {
    description: 'Run until address op value, or screen changed / stable for `frames`, holds; stops on that first frame. Use instead of wait/read loops.',
    inputSchema: {
      address: Address.optional(),
      as: z.enum(Object.keys(VALUE_TYPES)).default('u8'),
      op: z.enum(['eq', 'ne', 'gt', 'lt', 'gte', 'lte', 'changed']).default('eq'),
      value: z.number().int().optional(),
      screen: z.enum(['changed', 'stable']).optional(),
      frames: z.number().int().positive().default(30),
      maxFrames: z.number().int().positive().max(216000).default(600),
      precise: z.boolean().default(false),
      screenshot: z.boolean().default(false),
      scale: Scale,
    },
  }, async ({ address, as, op, value, screen, frames, maxFrames, precise, screenshot, scale }) => {
    let cond;
    if (screen) cond = { screen, frames };
    else if (address !== undefined) cond = { address: emu.addr(address), as, op, value };
    else return errText('give `address` (+ op/value) or `screen`');
    const before = await emu.waitTarget(), f0 = await emu.frameNum();
    const r = await emu.waitFor(cond, { maxFrames, precise });
    record({ wait: r.frame - before });
    const text = (r.met ? `Met at frame ${r.frame} (+${r.frame - f0}).` : `Not met within ${maxFrames} frames; frame ${r.frame}.`) + await watchLine();
    const extra = screenshot ? [png(scalePng(await emu.screenshot(), scale))] : [];
    return result(text, { met: r.met, frame: r.frame, waited: r.frame - f0 }, extra);
  });

  tool('reset', {
    description: 'Reset button: memory cards and cheats kept, frame restarts at 1.',
    inputSchema: {},
  }, async () => {
    await emu.restart();
    record({ reset: true });
    return result(`Reset. Frame ${await emu.frameNum()}.${await watchLine()}`);
  });

  // ---- Look ----
  tool('screenshot', {
    description: 'Current frame as an image. `save` also writes the native PNG.',
    inputSchema: { scale: Scale, save: z.string().optional() },
    annotations: RO,
  }, async ({ scale, save }) => {
    const buf = await emu.screenshot();
    const stale = emu.lastScreenshotStale;
    const frame = await emu.frameNum();
    let saved;
    if (save) {
      saved = await writePath(save);
      await mkdir(path.dirname(saved), { recursive: true });
      await writeFile(saved, buf);
    }
    record({ shot: `f${frame}` });
    const warn = stale ? ' STALE: state from another session; wait_frames 1 for the real picture.' : '';
    return result(`Frame ${frame}${saved ? `, saved ${saved}` : ''}.${warn}`, { frame, stale }, [png(scalePng(buf, scale))]);
  });

  tool('read_memory', {
    description: 'Read memory: RAM 0x80000000-0x801FFFFF (0x00…/0xA0… mirrors), scratchpad 0x1F800000-0x1F8003FF, I/O 0x1F801000-0x1F802FFF, BIOS 0xBFC00000.',
    inputSchema: {
      address: Address,
      length: z.number().int().positive().max(4096).optional().describe('bytes (default 4, or 1 value with as)'),
      as: z.enum(['hex', ...Object.keys(VALUE_TYPES)]).default('hex'),
    },
    annotations: RO,
  }, async ({ address, length, as }) => {
    const addr = emu.addr(address);
    if (as === 'hex') return result(`${label(addr)}: ${hexBytes(await emu.readMemory(addr, length ?? 4))}`);
    const w = VALUE_TYPES[as][0];
    length ??= w;
    const values = decodeValues(await emu.readMemory(addr, Math.max(length - (length % w), w)), as);
    return result(`${label(addr)} ${as}: ${values.length === 1 ? `${values[0]} (${hex(values[0])})` : values.join(', ')}`, { values });
  });

  tool('read_cpu', {
    description: 'R3000A registers (pc named from symbols), COP0 status/cause; gte:true adds GTE registers. A pc stuck across waits (with no progress) is a hang.',
    inputSchema: { gte: z.boolean().default(false) },
    annotations: RO,
  }, async ({ gte }) => {
    const c = await emu.readCpu();
    const h = (n) => (n >>> 0).toString(16).padStart(8, '0');
    const regs = ['at', 'v0', 'v1', 'a0', 'a1', 'a2', 'a3', 't0', 't1', 't2', 't3', 't4', 't5', 't6', 't7', 's0', 's1', 's2', 's3', 's4', 's5', 's6', 's7', 't8', 't9', 'k0', 'k1', 'gp', 'sp', 'fp', 'ra'];
    const lines = [`pc=${h(c.pc)} sr=${h(c.cop0.sr)} cause=${h(c.cop0.cause)} (${c.cop0.exception}) epc=${h(c.cop0.epc)} hi=${h(c.hi)} lo=${h(c.lo)}${c.interruptsEnabled ? '' : ' irq-off'}`];
    for (let i = 0; i < regs.length; i += 8) lines.push(regs.slice(i, i + 8).map((r) => `${r}=${h(c[r])}`).join(' '));
    if (gte) {
      lines.push('gte data: ' + c.gte.data.map(h).join(' '));
      lines.push('gte ctrl: ' + c.gte.control.map(h).join(' '));
    }
    const at = emu.symbols?.nameOf(c.pc), ra = emu.symbols?.nameOf(c.ra);
    return result(`Frame ${await emu.frameNum()}: ${lines.join('\n')}${at ? `\nin ${at}` : ''}${ra ? `, returns to ${ra}` : ''}`, { pc: c.pc });
  });

  tool('gpu_capture', {
    description: 'Run frame(s) logging GPU commands: primitives drawn (box, colour, texpage/CLUT, RAM address+symbol of chain packets), CPU exceptions, and the drawn buffer outlined.',
    inputSchema: {
      frames: z.number().int().min(1).max(60).default(1),
      list: z.number().int().min(0).max(500).default(40).describe('primitives to list'),
      kinds: z.array(z.enum(['poly3', 'poly4', 'line', 'polyline', 'rect', 'sprite', 'dot', 'fill', 'copy', 'upload', 'download'])).optional(),
      only: z.array(z.number().int().min(0)).optional().describe('outline only these primitive numbers'),
      image: z.boolean().default(true),
      scale: Scale,
    },
  }, async ({ frames, list, kinds, only, image, scale }) => {
    const cap = await emu.captureFrame(frames);
    record({ wait: frames });
    const name = (a) => {
      const n = emu.symbols?.nameOf(a, { maxOffset: 0x10000 }) ?? null;
      // Past the end of the program's data: malloc'd memory, not that symbol.
      return n && /^_*(end|bss_end|heap_start)_*(\+|$)/.test(n) ? `heap${n.includes('+') ? n.slice(n.indexOf('+')) : ''}` : n;
    };
    const shown = cap.prims.filter((p) => !kinds || kinds.includes(p.kind));
    const stats = Object.entries(cap.stats).map(([k, v]) => `${v} ${k}`).join(', ') || 'nothing';
    const env = cap.env;
    const lines = [
      `Frame ${cap.frame}: ${stats}${frames > 1 ? ` over ${frames} frames` : ''}; ${cap.chains.length} DMA chain(s)${cap.overflow ? '; LOG OVERFLOWED (partial)' : ''}.`,
      `draw area ${env.drawArea.x0},${env.drawArea.y0}-${env.drawArea.x1},${env.drawArea.y1} offset ${env.offset.join(',')}; coordinates below are VRAM (offset applied).`,
      ...cap.exceptions.map((e) => `EXCEPTION code ${e.code} at ${hex(e.epc)}${name(e.epc) ? ` (${name(e.epc)})` : ''} address ${hex(e.badVaddr)}`),
      ...shown.slice(0, list).map((p) => primLine(p, name)),
      ...(shown.length > list ? [`…${shown.length - list} more`] : []),
    ];
    const extra = image ? [png(captureImage(await emu.readRegions(), cap, { scale, only: only ?? null }))] : [];
    return result(lines.join('\n') + await watchLine(), { frame: cap.frame, prims: cap.prims.length, exceptions: cap.exceptions.length }, extra);
  });

  tool('view_vram', {
    description: 'VRAM 1024x512 with display (white) and draw (red) areas outlined; gpu:true runs a frame and outlines texpages/CLUTs used. what:"texture" decodes one through a CLUT.',
    inputSchema: {
      what: z.enum(['vram', 'texture']).default('vram'),
      gpu: z.boolean().default(false),
      x: z.number().int().min(0).max(1023).optional(), y: z.number().int().min(0).max(511).optional(),
      depth: z.enum(['4bit', '8bit', '15bit']).default('4bit'),
      clutX: z.number().int().min(0).max(1023).optional(), clutY: z.number().int().min(0).max(511).optional(),
      w: z.number().int().min(1).max(256).default(256), h: z.number().int().min(1).max(256).default(256),
      scale: z.number().int().min(1).max(4).default(1),
    },
    annotations: RO,
  }, async (a) => {
    let cap = null;
    if (a.gpu) { cap = await emu.captureFrame(1); record({ wait: 1 }); }
    const r = await emu.readRegions();
    const d = display(r), env = cap?.env ?? stateDrawEnv(r);
    const info = `display ${d.x},${d.y} ${d.w}x${d.h}${d.depth24 ? ' 24-bit' : ''}${d.interlaced ? ' interlaced' : ''}${d.enabled ? '' : ' (off)'}; draw area ${env.drawArea.x0},${env.drawArea.y0}-${env.drawArea.x1},${env.drawArea.y1}`;
    if (a.what === 'texture') {
      if (a.x === undefined || a.y === undefined) return errText('texture needs `x` and `y` (the page or texture origin in VRAM)');
      const clut = a.depth === '15bit' || a.clutX === undefined ? null : { x: a.clutX, y: a.clutY ?? 0 };
      return result(`Texture ${a.x},${a.y} ${a.depth}${clut ? ` CLUT ${clut.x},${clut.y}` : a.depth !== '15bit' ? ' (no CLUT: grey levels)' : ''} ${a.w}x${a.h}, frame ${await emu.frameNum()}. ${info}.`, undefined,
        [png(texturePng(r, { x: a.x, y: a.y, depth: a.depth, clut, w: a.w, h: a.h, scale: Math.max(a.scale, 2) }))]);
    }
    const used = cap ? ` Texture pages: ${[...new Set(cap.prims.filter((p) => p.texpage).map((p) => `${p.texpage.x},${p.texpage.y} ${p.texpage.depth}`))].join('; ') || 'none'}. CLUTs: ${[...new Set(cap.prims.filter((p) => p.clut).map((p) => `${p.clut.x},${p.clut.y}`))].join('; ') || 'none'}.` : '';
    return result(`VRAM, frame ${await emu.frameNum()}: ${info}.${used}`, undefined, [png(vramPng(r, { cap, scale: a.scale }))]);
  });

  // ---- Change ----
  tool('write_memory', {
    description: 'Write RAM on the current frame (value+as, or hex bytes). Says if it did not stick.',
    inputSchema: {
      address: Address,
      value: z.number().int().optional(),
      as: z.enum(['u8', 'u16', 'u32']).default('u8'),
      hex: z.string().optional().describe('raw bytes, e.g. "deadbeef"'),
    },
  }, async ({ address, value, as, hex: hx }) => {
    const addr = emu.addr(address);
    let bytes;
    if (hx != null) {
      const clean = hx.replace(/[^0-9a-fA-F]/g, '');
      if (clean.length === 0 || clean.length % 2) return errText('hex must be an even number of hex digits');
      bytes = Buffer.from(clean, 'hex');
    } else if (value != null) {
      bytes = encodeValue(value, as);
    } else {
      return errText('provide `value` (with `as`) or `hex`');
    }
    const stuck = await emu.writeMemory(addr, bytes);
    record({ write: hex(addr), hex: bytes.toString('hex') });
    if (stuck) return result(`Wrote ${bytes.length}B at ${label(addr)}.`, { stuck });
    return result(`Wrote ${bytes.length}B at ${label(addr)} but it did not stick (not RAM, or overwritten); now: ${hexBytes(await emu.readMemory(addr, bytes.length))}.`, { stuck });
  });

  tool('state', {
    description: 'Save state `id` (and to `path`), or load it (or a state file).',
    inputSchema: { action: z.enum(['save', 'load']), id: z.string().default('default'), path: z.string().optional() },
  }, async ({ action, id, path: p }) => {
    if (action === 'save') {
      const st = await emu.saveState();
      states.set(id, st);
      record({ saveState: id });
      let file;
      if (p) {
        file = await writePath(p);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, st);
      }
      return result(`Saved "${id}" at frame ${await emu.frameNum()}${file ? ` to ${file}` : ''}.`);
    }
    let st;
    if (p) {
      st = await readFile(await resolvePath(p));
    } else {
      st = states.get(id);
      if (!st) return errText(`No state "${id}". Saved: ${[...states.keys()].join(', ') || 'none'}.`);
    }
    await emu.loadState(st);
    record(p ? { loadStateFile: await resolvePath(p) } : { loadState: id });
    const frame = await emu.frameNum();
    return result(`Restored. Frame ${frame}.${await watchLine()}`, { frame });
  });

  tool('cheats', {
    description: 'Replace the active GameShark/Action Replay codes ([] clears), e.g. "80010394 0064". Applied every frame; survive reset.',
    inputSchema: { codes: z.array(z.string()) },
  }, async ({ codes }) => {
    await emu.setCheats(codes);
    record({ cheats: codes });
    return result(codes.length ? `${codes.length} cheat(s) active.` : 'Cheats cleared.');
  });

  tool('memory_card', {
    description: 'Card in slot 1/2: list saves (ID, title, icon), export/import an image (.mcr/.mcd/.gme/.vgs; import resets unless reset:false), or format.',
    inputSchema: {
      action: z.enum(['list', 'export', 'import', 'format']),
      path: z.string().optional(), slot: z.number().int().min(1).max(2).default(1), reset: z.boolean().default(true),
      icons: z.boolean().default(true),
    },
  }, async ({ action, path: p, slot, reset, icons }) => {
    if (action === 'list') {
      const data = await emu.readMemoryCard(slot);
      if (!data) return result(`Slot ${slot}: no card data yet (nothing written or inserted).`, { saves: 0 });
      const l = listSaves(data);
      const lines = l.saves.map((s) => `block ${s.block}: ${s.file} "${s.title}" ${s.blocks} block(s)${s.region ? ` ${s.region}` : ''}`);
      const imgs = icons ? l.saves.filter((s) => s.icon).flatMap((s) => [{ type: 'text', text: `${s.file}:` }, png(s.icon)]) : [];
      return result(`Slot ${slot}: ${l.saves.length} save(s), ${l.freeBlocks} free block(s).${l.problems.length ? `\nPROBLEMS: ${l.problems.join('; ')}` : ''}${lines.length ? `\n${lines.join('\n')}` : ''}`, { saves: l.saves.length, free: l.freeBlocks }, imgs);
    }
    if (action === 'format') {
      await emu.writeMemoryCard(formatCard(), { slot, reset });
      record({ formatCard: slot, reset });
      return result(`Slot ${slot}: blank formatted card inserted${reset ? '; reset' : ''}. Frame ${await emu.frameNum()}.`);
    }
    if (!p) return errText(`${action} needs \`path\``);
    if (action === 'export') {
      const data = await emu.readMemoryCard(slot);
      if (!data) return errText(`Slot ${slot} has no memory card data yet (the game hasn't written one).`);
      const file = await writePath(p);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, data);
      return result(`Exported slot ${slot} (${data.length}B) to ${file}.`, { bytes: data.length });
    }
    const file = await resolvePath(p);
    const data = await readFile(file);
    await emu.writeMemoryCard(data, { slot, reset });
    record({ importCard: file, slot, reset });
    const frame = await emu.frameNum();
    return result(`Inserted ${path.basename(file)} in slot ${slot}${reset ? '; reset' : ''}. Frame ${frame}.`, { frame });
  });

  // ---- Test ----
  tool('run_sequence', {
    description: 'Run many steps in one call. Steps (one key each): wait:N | tap:btn|[btns] (hold,release; "P2:X" = port 2) | press/release:btn | hold:btn,frames | analog:left|right,x,y | waitUntil:{address,op,value}|{screen} (maxFrames) | shot:name | record:{frames,every} | saveState/loadState:id | loadStateFile | read:addr (as) | write:addr,value|hex | assertRam:addr,equals|min|max | assert:png (threshold,ignore) | video:{frames,path} | reset | cheats | importCard | formatCard',
    inputSchema: {
      steps: z.array(z.record(z.string(), z.any())).min(1),
      scale: Scale,
      outDir: z.string().optional().describe('save shots + timeline.json'),
      maxImages: z.number().int().min(0).max(20).default(8),
      video: z.object({ path: z.string(), onlyOnFail: z.boolean().default(true), seconds: z.number().positive().default(10) }).optional()
        .describe('record the run; kept on failure'),
    },
  }, async ({ steps, scale, outDir, maxImages, video }) => {
    const out = outDir ? await writePath(outDir) : undefined;
    const bd = await baseDir();
    // Record each step as it completes (with absolute paths, so an exported script
    // replays from anywhere) — if a later step throws, what already ran is kept.
    const onStep = (st) => {
      const c = { ...st };
      for (const k of ['assert', 'loadStateFile', 'importCard']) if (typeof c[k] === 'string') c[k] = path.resolve(bd, c[k]);
      record(c);
    };
    const res = await runSteps(emu, steps, { outDir: out, baseDir: bd, states, checkWrite: await writeGuard(), onStep, video });
    const frame = await emu.frameNum();
    if (out) await writeFile(path.join(out, 'timeline.json'), JSON.stringify({ rom: romPath, pass: res.failures === 0, steps: res.timeline }, null, 2));

    const images = [];
    const pushImg = (label, buf) => {
      if (images.length / 2 >= maxImages) return false;
      images.push({ type: 'text', text: label }, png(buf));
      return true;
    };
    let dropped = 0;
    for (const s of res.shots) if (!pushImg(`${s.name} f${s.frame}:`, scalePng(s.png, scale))) dropped++;
    for (const r of res.records) {
      // Keep sheets <= ~1600px wide (larger images get downscaled by vision models).
      const cols = Math.min(r.pngs.length, 4), fw = 320;
      const sheetScale = Math.max(1, Math.min(scale, Math.floor(1600 / (cols * fw))));
      if (!pushImg(`${r.prefix}: frames ${r.frames.join(',')} (left-right, top-bottom):`, contactSheet(r.pngs, { cols, scale: sheetScale }))) dropped++;
    }
    // Only steps with something to say get a line (waits/taps are in the frame count).
    const lines = res.timeline.filter((e) => 'value' in e || 'met' in e || e.assert || ('stuck' in e && !e.stuck)).map((e) => {
      let l = `#${e.i} f${e.frame} ${e.action}`;
      if ('value' in e) l += ` = ${JSON.stringify(e.value)}`;
      if ('met' in e) l += e.met ? ` met f${e.metFrame}` : ' NOT met';
      if ('stuck' in e && !e.stuck) l += ' (did not stick)';
      if (e.assert) l += e.assert.pass ? ' ok' : ` FAIL ${JSON.stringify(e.assert)}`;
      return l;
    });
    const summary = `${res.failures ? `FAIL (${res.failures})` : 'OK'}: ${steps.length} steps, frame ${frame}.` +
      (dropped ? ` ${dropped} image(s) not shown${out ? `; saved in ${out}` : ''}.` : '') +
      (res.video ? ` Video: ${res.video}.` : '') +
      (lines.length ? `\n${lines.join('\n')}` : '') + await watchLine();
    const r = result(summary, { pass: res.failures === 0, failures: res.failures, frame }, images);
    return res.failures ? { ...r, isError: true } : r;
  });

  tool('record_video', {
    description: 'Play `frames` frames into a video: .gif .png(animated) .webm .mp4 (with sound if ffmpeg allows) .wav.',
    inputSchema: {
      frames: z.number().int().positive().max(36000),
      path: z.string(),
      every: z.number().int().positive().default(1).describe('keep every Nth frame'),
      scale: z.number().int().min(1).max(4).default(2),
      audio: z.enum(['auto', 'on', 'off']).default('auto'),
    },
  }, async ({ frames, path: p, every, scale, audio }) => {
    const file = await writePath(p);
    const caps = await emu.record(frames, { every });
    const r = await saveVideo(caps, file, { scale, every, audio, fps: emu.fps, toJpeg: (pngs, k) => emu.toJpeg(pngs, k) });
    record({ video: { frames, path: file, every, scale, audio } });
    const frame = await emu.frameNum();
    return result(`Saved ${caps.length} frames to ${file}${r.audio === 'muxed' ? ' with sound' : r.audio ? `; sound in ${r.audio}` : ''}. Frame ${frame}.`, { frame });
  });

  tool('assert_golden', {
    description: 'Compare the frame to a golden PNG (created if missing). `ignore` masks rects (clocks). On failure returns current/golden/diff images.',
    inputSchema: {
      golden: z.string(),
      threshold: z.number().min(0).max(1).default(0.02).describe('max fraction of differing pixels'),
      tolerance: z.number().int().min(0).max(255).default(16),
      ignore: z.array(Rect).default([]),
      scale: Scale,
    },
  }, async ({ golden, threshold, tolerance, ignore, scale }) => {
    const shot = await emu.screenshot();
    const goldenPath = await writePath(golden);
    const res = await assertGolden(shot, goldenPath, { threshold, tolerance, ignore });
    record({ assert: goldenPath, threshold, tolerance, ...(ignore.length ? { ignore } : {}) });
    const out = { pass: res.pass, created: !!res.created, fraction: res.fraction ?? 0 };
    if (res.created) return result(`Golden created: ${res.goldenPath}. Check it:`, out, [png(scalePng(shot, scale))]);
    const pct = (res.fraction * 100).toFixed(2);
    if (res.pass) return result(`PASS (${pct}% differ).`, out);
    const why = res.mismatchDimensions ? 'frame size differs from the golden' : `${pct}% differ`;
    const images = [{ type: 'text', text: 'current:' }, png(scalePng(shot, scale)),
      { type: 'text', text: 'golden:' }, png(scalePng(await readFile(res.goldenPath), scale))];
    if (res.diffPng) images.push({ type: 'text', text: 'diff (red):' }, png(scalePng(res.diffPng, scale)));
    return { ...result(`FAIL: ${why}.${res.diffPath ? ` Diff: ${res.diffPath}` : ''}`, out, images), isError: true };
  });

  tool('export_script', {
    description: 'Everything done since load_disc as replayable run_sequence steps; add asserts for a regression test.',
    inputSchema: {
      path: z.string().optional(),
      includeShots: z.boolean().default(false).describe('keep a step per screenshot'),
    },
    annotations: RO,
  }, async ({ path: p, includeShots }) => {
    const steps = rec.filter((s) => includeShots || !s.shot).map((s) => ({ ...s }));
    // Merge consecutive waits.
    const merged = [];
    for (const s of steps) {
      const last = merged[merged.length - 1];
      if (last && 'wait' in s && 'wait' in last && Object.keys(s).length === 1 && Object.keys(last).length === 1) last.wait += s.wait;
      else merged.push(s);
    }
    const o = emu.options;
    const script = { rom: romPath, ...(o.bios !== 'openbios' ? { bios: o.bios } : {}), ...(o.region !== 'ntsc' ? { region: o.region } : {}),
      ...(o.pad1 !== 'dualshock' ? { pad1: o.pad1 } : {}), ...(o.pad2 !== 'none' ? { pad2: o.pad2 } : {}),
      steps: merged.filter((s) => !('wait' in s) || s.wait > 0) };
    let file;
    if (p) {
      file = await writePath(p);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify(script, null, 2) + '\n');
    }
    return result(`${file ? `Wrote ${file}. ` : ''}${JSON.stringify(script)}`, { steps: script.steps.length });
  });

  tool('ab_compare', {
    description: 'Run the same steps on two discs/EXEs (same BIOS/region/pads as loaded); shows which shot/read steps differ, with A|B|diff images.',
    inputSchema: {
      romA: z.string(), romB: z.string(),
      steps: z.array(z.record(z.string(), z.any())).min(1),
      tolerance: z.number().int().min(0).max(255).default(16),
      scale: z.number().int().min(1).max(3).default(2),
      maxImages: z.number().int().min(0).max(10).default(4),
    },
    annotations: RO,
  }, async ({ romA, romB, steps, tolerance, scale, maxImages }) => {
    const [pa, pb] = [await resolvePath(romA), await resolvePath(romB)];
    const base = await baseDir();
    const runOne = async (rom) => {
      const o = emu?.options ?? {};
      const h = await EmuHarness.launch(rom, { reuse: true, bios: o.bios, region: o.region, pad1: o.pad1, pad2: o.pad2 });
      try { return { system: h.system, ...(await runSteps(h, steps, { baseDir: base, checkWrite: await writeGuard() })) }; } finally { await h.close(); }
    };
    const [A, B] = await Promise.all([runOne(pa), runOne(pb)]);
    const lines = [], images = [];
    let identical = true;
    A.shots.forEach((sa, i) => {
      const sb = B.shots[i];
      if (!sb) return;
      const c = compare(sa.png, sb.png, { tolerance });
      if (c.fraction === 0) { lines.push(`${sa.name} f${sa.frame}: same`); return; }
      identical = false;
      lines.push(`${sa.name} f${sa.frame}: ${(c.fraction * 100).toFixed(2)}% differ`);
      if (images.length / 2 < maxImages) {
        const tiles = [sa.png, sb.png, ...(c.diffPng ? [c.diffPng] : [])];
        images.push({ type: 'text', text: `${sa.name} A|B|diff:` }, png(contactSheet(tiles, { cols: tiles.length, scale })));
      }
    });
    A.timeline.forEach((ea, i) => {
      if (!('value' in ea)) return;
      const vb = B.timeline[i]?.value;
      const same = JSON.stringify(ea.value) === JSON.stringify(vb);
      if (!same) identical = false;
      lines.push(`#${i} read: A=${JSON.stringify(ea.value)} B=${JSON.stringify(vb)}${same ? '' : ' DIFFERS'}`);
    });
    const fails = A.failures + B.failures ? ` (failed asserts: A ${A.failures}, B ${B.failures})` : '';
    return result(`${identical ? 'IDENTICAL' : 'DIFFERENT'}${fails}\n${lines.join('\n') || '(no shot/read steps)'}`, { identical }, images);
  }, { needsRom: false });

  // ---- Find ----
  tool('ram_search', {
    description: 'Find where a value (HP, score) lives: start (optional known value), change it in game, filter (op vs value, or changed/unchanged/increased/decreased/delta vs last) until one is left; list shows candidates.',
    inputSchema: {
      action: z.enum(['start', 'filter', 'list']),
      type: z.enum(SEARCH_TYPES).default('u8'),
      region: z.enum(['ram', 'scratchpad']).optional(),
      op: z.enum(SEARCH_OPS).optional(),
      value: z.number().int().optional(),
      limit: z.number().int().min(0).max(200).default(10).describe('candidates to list'),
    },
    annotations: RO,
  }, async ({ action, type, region, op, value, limit }) => {
    let head;
    if (action === 'start') {
      search = new RamSearch(emu.system, await emu.readRegions(), { type, region });
      if (value !== undefined) search.filter(await emu.readRegions(), 'eq', value);
      head = 'Started';
    } else {
      if (!search) return errText('No RAM search; use action "start" first.');
      if (action === 'filter') {
        if (!op) return errText('filter needs `op`');
        const before = search.count;
        search.filter(await emu.readRegions(), op, value);
        head = `${op}${value !== undefined ? ` ${value}` : ''}: ${before} ->`;
      } else head = 'Candidates:';
    }
    const rows = search.results(limit);
    const lines = rows.map((r) => `${label(r.address)} ${r.region} =${r.value}${r.previous !== undefined ? ` (was ${r.previous})` : ''}`);
    const more = search.count > rows.length ? `\n…${search.count - rows.length} more` : '';
    return result(`${head} ${search.count} (${search.type}).${lines.length ? `\n${lines.join('\n')}${more}` : ''}`, { count: search.count });
  });

  // ---- Make ----
  tool('texture', {
    description: 'PNG → TIM (convert: depth, VRAM x,y in words, clutX/Y; out .tim/.c/.h), inject a PNG/.tim into VRAM, or export a VRAM rect (through a CLUT) to PNG.',
    inputSchema: {
      action: z.enum(['convert', 'inject', 'export']),
      png: z.string().optional(), tim: z.string().optional(),
      depth: z.union([z.literal(4), z.literal(8), z.literal(16)]).default(4),
      x: z.number().int().min(0).max(1023).optional(), y: z.number().int().min(0).max(511).optional(),
      clutX: z.number().int().min(0).max(1023).optional(), clutY: z.number().int().min(0).max(511).optional(),
      w: z.number().int().min(1).max(1024).optional(), h: z.number().int().min(1).max(512).optional(),
      transparent: z.string().default('alpha'), quantize: z.boolean().default(false),
      out: z.string().optional(), name: z.string().optional(),
      scale: Scale,
    },
  }, async (a) => {
    if (a.action === 'export') {
      requireRom();
      if (a.x === undefined || a.y === undefined || !a.w || !a.h) return errText('export needs x, y, w, h (VRAM words for 15-bit; texels with depth 4/8 and a CLUT)');
      const r = await emu.readRegions();
      const pngBuf = a.depth === 16 || a.clutX === undefined
        ? encodePng(vramImage(r, { x: a.x, y: a.y, w: a.w, h: a.h }))
        : (await import('./gpu.mjs')).texturePng(r, { x: a.x, y: a.y, depth: a.depth === 4 ? '4bit' : '8bit', clut: { x: a.clutX, y: a.clutY ?? 0 }, w: a.w, h: a.h, scale: 1 });
      let file;
      if (a.out) { file = await writePath(a.out); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, pngBuf); }
      return result(`VRAM ${a.x},${a.y} ${a.w}x${a.h}${file ? ` saved to ${file}` : ''}.`, undefined, [png(scalePng(pngBuf, a.scale))]);
    }
    let tim, info = '', files = [], warn = [];
    if (a.tim) {
      tim = await readFile(await resolvePath(a.tim));
      const t = readTim(tim);
      info = `${a.tim}: ${t.width}x${t.height} ${t.depth}-bit at VRAM ${t.image.x},${t.image.y}${t.clut ? `, CLUT ${t.clut.x},${t.clut.y}` : ''}`;
    } else if (a.png) {
      const conv = convertTim(await readFile(await resolvePath(a.png)), { depth: a.depth, x: a.x ?? 640, y: a.y ?? 0, clutX: a.clutX ?? 640, clutY: a.clutY ?? 480, transparent: a.transparent, quantize: a.quantize });
      tim = conv.tim; warn = conv.warnings;
      info = `${conv.width}x${conv.height} ${conv.depth}-bit, ${conv.colors} colour(s), pixels at VRAM ${conv.vram.x},${conv.vram.y} (${conv.vram.w}x${conv.vram.h} words)${conv.clut ? `, CLUT ${conv.clut.x},${conv.clut.y}` : ''}; texture page ${Math.floor(conv.vram.x / 64) * 64},${conv.vram.y < 256 ? 0 : 256}, u0 = ${(conv.vram.x % 64) * (16 / conv.depth)}, v0 = ${conv.vram.y % 256}`;
      if (a.action === 'convert' && a.out) {
        const out = await writePath(a.out);
        await mkdir(path.dirname(out), { recursive: true });
        if (/\.tim$/i.test(out)) await writeFile(out, tim);
        else if (/\.[ch]$/i.test(out)) await writeFile(out, timToC(tim, a.name ?? path.basename(out).replace(/\.[^.]+$/, '').replace(/\W/g, '_')));
        else return errText('out must be .tim, .c or .h');
        files.push(out);
      }
    } else return errText('give `png` (or `tim` for inject)');
    const preview = timToPng(tim, Math.max(1, Math.min(a.scale * 2, 8)));
    if (a.action === 'convert') return result(`${info}.${warn.length ? ` WARN: ${warn.join('; ')}.` : ''}${files.length ? ` Wrote ${files.join(', ')}.` : ''}`, undefined, [png(preview)]);
    requireRom();
    const t = readTim(tim);
    await emu.writeVram(t.image.x, t.image.y, t.image.w, t.image.h, t.image.data);
    if (t.clut) {
      const c = Buffer.alloc(t.clut.colors.length * 2);
      t.clut.colors.forEach((v, i) => c.writeUInt16LE(v, i * 2));
      await emu.writeVram(t.clut.x, t.clut.y, t.clut.w, t.clut.h, c);
    }
    const r = await emu.readRegions();
    const img = vramImage(r);
    outline(img, [{ verts: [[t.image.x, t.image.y], [t.image.x + t.image.w - 1, t.image.y], [t.image.x + t.image.w - 1, t.image.y + t.image.h - 1], [t.image.x, t.image.y + t.image.h - 1]], color: [0, 255, 255] }]);
    return result(`Injected into VRAM: ${info}. The game draws with it from the next frame if its primitives sample there.${warn.length ? ` WARN: ${warn.join('; ')}.` : ''}`, undefined, [png(encodePng(img))]);
  }, { needsRom: false });

  tool('background', {
    description: 'PNG or Tiled .tmx/.tmj → deduped tileset TIM + tile map (out .c/.h, .tim beside it), with a preview. No mirrored-tile merging (the GPU can\'t flip).',
    inputSchema: {
      png: z.string().optional(), tiled: z.string().optional(),
      tile: z.union([z.literal(8), z.literal(16), z.literal(32)]).default(16),
      depth: z.union([z.literal(4), z.literal(8), z.literal(16)]).default(4),
      x: z.number().int().min(0).max(1023).default(640), y: z.number().int().min(0).max(511).default(256),
      clutX: z.number().int().min(0).max(1023).default(640), clutY: z.number().int().min(0).max(511).default(496),
      dedupe: z.boolean().default(true), out: z.string().optional(), scale: Scale,
    },
  }, async (a) => {
    if (!a.png === !a.tiled) return errText('give `png` or `tiled`');
    const src = await resolvePath(a.png ?? a.tiled);
    const img = a.tiled ? await renderTiledMap(src) : await readFile(src);
    const conv = convertTilemap(img, { tile: a.tile, depth: a.depth, x: a.x, y: a.y, clutX: a.clutX, clutY: a.clutY, dedupe: a.dedupe });
    const files = a.out ? await writeTilemap(conv, await writePath(a.out), path.basename(a.out).replace(/\.[^.]+$/, '')) : [];
    const sc = Math.max(1, Math.min(a.scale, Math.floor(1600 / (conv.cols * conv.tile))));
    return result(`${conv.cols}x${conv.rows} map, ${conv.tileCount} unique ${a.tile}px tiles of ${conv.cells}, tileset ${conv.width}x${conv.height} ${conv.depth}-bit at VRAM ${conv.vram.x},${conv.vram.y}${conv.clut ? ` (CLUT ${conv.clut.x},${conv.clut.y})` : ''}.` +
      (conv.warnings.length ? ` WARN: ${conv.warnings.join('; ')}.` : '') + (files.length ? ` Wrote ${files.join(', ')}.` : ''), { tiles: conv.tileCount }, [png(scalePng(conv.preview, sc))]);
  }, { needsRom: false });

  tool('data', {
    description: 'sound: WAV → SPU ADPCM (.vag/.bin/.c/.h, or .wav to hear it; loop) + pitch. table: fixed-point sin/cos/reciprocal (.c/.h). mesh: .obj → SVECTOR verts/normals + faces (.c/.h).',
    inputSchema: {
      kind: z.enum(['sound', 'table', 'mesh']),
      out: z.string(), name: z.string().optional(),
      wav: z.string().optional(), rate: z.number().int().min(4000).max(48000).default(22050), loop: z.boolean().default(false), normalize: z.boolean().default(false),
      table: z.enum(['sin', 'cos', 'reciprocal']).optional(), size: z.number().int().min(2).max(65536).optional(), bits: z.number().int().min(0).max(24).default(12),
      obj: z.string().optional(),
    },
  }, async (a) => {
    const file = await writePath(a.out);
    const name = a.name ?? path.basename(a.out).replace(/\.[^.]+$/, '');
    if (a.kind === 'sound') {
      if (!a.wav) return errText('sound needs `wav`');
      const c = encodeVag(await readFile(await resolvePath(a.wav)), { rate: a.rate, loop: a.loop, normalize: a.normalize });
      const files = await writeSound(c, file, name);
      return result(`${c.samples} samples, ${c.seconds.toFixed(2)} s at ${c.rate} Hz from ${c.sourceRate} Hz ${c.channels === 1 ? 'mono' : `${c.channels}-ch`}: ${c.adpcm.length} bytes of ADPCM (${c.blocks} blocks)${c.loop ? ', looping' : ''}; SPU pitch 0x${c.pitch.toString(16)}; peak ${(c.peak * 100).toFixed(0)}%${c.clipped ? `, ${c.clipped} samples clipped` : ''}. Wrote ${files.join(', ')}.`, { bytes: c.adpcm.length });
    }
    if (a.kind === 'mesh') {
      if (!a.obj) return errText('mesh needs `obj`');
      const m = convertMesh(await readFile(await resolvePath(a.obj), 'utf8'), { size: a.size ?? 256 });
      const files = await writeMesh(m, file, name);
      return result(`${m.verts.length} vertices, ${m.norms.length} normals, ${m.tris} triangles, ${m.quads} quads, scaled ×${m.scale.toFixed(3)}.${m.warnings.length ? ` WARN: ${m.warnings.join('; ')}.` : ''} Wrote ${files.join(', ')}.`, { faces: m.faces.length });
    }
    if (!a.table) return errText('table needs `table` (sin, cos or reciprocal)');
    const t = makeTable(a.table, { size: a.size ?? 4096, bits: a.bits });
    const files = await writeTable(t, file, name);
    return result(`${a.table} table: ${t.size} ${t.type} entries, ${t.bits} fractional bits. Wrote ${files.join(', ')}.`, { size: t.size });
  }, { needsRom: false });

  // ---- Develop ----
  tool('build', {
    description: 'Build (ps1test.json build, else CMake/make): errors as file:line, then load the disc/EXE + symbols and check its header. replay: redo the steps since the last load.',
    inputSchema: {
      command: z.string().optional(),
      rom: z.string().optional().describe('default: ps1test.json rom, else the newest .cue/.exe'),
      load: z.boolean().default(true),
      replay: z.boolean().default(false),
    },
  }, async ({ command, rom, load, replay }) => {
    const bd = await baseDir();
    cfg = await readProjectConfig(bd);
    const cmd = command ?? cfg.build ?? await detectBuild(bd);
    if (!cmd) return errText(`no build command: pass \`command\` or add {"build": "..."} to ${path.join(bd, 'ps1test.json')}`);
    const r = await runCommand(cmd, bd);
    const diags = parseDiagnostics(r.output);
    const errors = diags.filter((d) => d.level === 'error'), warns = diags.filter((d) => d.level === 'warning');
    const secs = (r.ms / 1000).toFixed(1);
    const count = `${errors.length} error(s), ${warns.length} warning(s)`;
    if (r.code !== 0 || r.timedOut) {
      const shown = (errors.length ? errors : diags).slice(0, 25).map(formatDiagnostic);
      const tail = shown.length ? '' : `\n${r.output.trim().split(/\r?\n/).slice(-25).join('\n')}`;
      return errText(`Build FAILED (${r.timedOut ? 'timed out' : `exit ${r.code}`}, ${secs}s): ${count}.\n${shown.join('\n')}${tail}`);
    }
    let text = `Built with \`${cmd}\` in ${secs}s${warns.length ? `, ${warns.length} warning(s):\n${warns.slice(0, 10).map(formatDiagnostic).join('\n')}` : '.'}`;
    if (!load) return result(text, { built: true });
    const want = rom ?? cfg.rom;
    const abs = want ? await resolvePath(want) : await findRom(bd);
    if (!abs) return result(`${text}\nNo disc image or EXE found to load; pass \`rom\`.`, { built: true });
    const steps = replay ? rec.filter((st) => !('shot' in st) && !('assert' in st) && !('video' in st) && !('record' in st)) : null;
    await loadRom(abs, {}, { again: true });
    text += `\nLoaded ${path.relative(bd, abs) || abs} (${biosName()}${symbolInfo()}).`;
    if (emu.options.exe) {
      const x = emu.options.exe;
      if (!x.region) text += `\nPS-EXE: no region marker ("Sony Computer Entertainment Inc. for … area") — a real BIOS loading it from disc may refuse it.`;
    }
    if (steps?.length) {
      const res = await runSteps(emu, steps, { baseDir: bd, states, checkWrite: await writeGuard(), onStep: record });
      text += `\nReplayed ${steps.length} steps${res.failures ? ` (${res.failures} check(s) failed)` : ''}.`;
    }
    return result(`${text}\nFrame ${await emu.frameNum()}.${await watchLine()}`, { built: true, frame: await emu.frameNum() });
  }, { needsRom: false });

  tool('disc', {
    description: 'Make a bootable disc (.cue/.bin: SYSTEM.CNF, the EXE, extra files) from a PS-EXE or ELF; lists its files, checks it, loads it unless load:false.',
    inputSchema: {
      exe: z.string().describe('.exe, or .elf (converted)'),
      out: z.string().describe('.cue path (the .bin goes beside it)'),
      files: z.record(z.string(), z.string()).optional().describe('{"DATA.BIN": "path"} (8.3 names, root directory)'),
      label: z.string().max(32).default('PS1GAME'),
      load: z.boolean().default(true),
    },
  }, async ({ exe, out, files = {}, label, load }) => {
    const src = await resolvePath(exe);
    let exeBuf = await readFile(src);
    if (exeBuf.readUInt32BE(0) === 0x7f454c46) exeBuf = elfToExe(exeBuf);
    const info = exeInfo(exeBuf);
    /** @type {Record<string, Buffer>} */
    const extra = {};
    for (const [name, p] of Object.entries(files)) extra[name] = await readFile(await resolvePath(p));
    const dest = await writePath(out);
    await mkdir(path.dirname(dest), { recursive: true });
    const made = await makeDisc({ exe: exeBuf, out: dest, label, exeName: 'MAIN.EXE', files: extra });
    const img = await readFile(made.bin);
    const list = isoList(img).filter((f) => !f.system).map((f) => `${f.path} (${f.size} B, sector ${f.lba})`);
    const issues = discIssues(img, {}).filter((f) => f.level !== 'ok').map((f) => `${f.level}: ${f.msg}`);
    let text = `Wrote ${made.cue} + ${path.basename(made.bin)} (${img.length / 2352} sectors): ${list.join(', ')}. EXE entry ${hex(info.entry)}, ${info.size} B at ${hex(info.load)}.${issues.length ? '\n' + issues.join('\n') : ''}`;
    if (load) {
      // The symbols of the program it was made from (an .elf given, or one beside the EXE).
      const sym = /\.elf$/i.test(src) ? src : await findSymbols(src);
      await loadRom(made.cue, sym ? { symbols: sym } : {}, { again: true });
      text += `\nLoaded (${biosName()}${symbolInfo()}); it boots through the BIOS in ~200 frames. Frame ${await emu.frameNum()}.`;
    }
    return result(text, { cue: made.cue, files: list.length });
  }, { needsRom: false });

  tool('send_to_console', {
    description: 'Upload a PS-EXE to a real PS1 running Unirom over a serial cable with nops (NOTPSXSerial) and run it. PS1TEST_UPLOADER overrides the command ({exe}, {port}).',
    inputSchema: {
      exe: z.string().optional().describe('default: the loaded EXE, else ps1test.json\'s build output'),
      port: z.string().optional().describe('COM3, /dev/ttyUSB0… (default $PS1TEST_SERIAL)'),
      fast: z.boolean().default(false).describe('Unirom in fast (518400 baud) mode'),
      dry_run: z.boolean().default(false),
    },
  }, async ({ exe, port, fast, dry_run: dryRun }) => {
    const bd = await baseDir();
    let file = exe ? await resolvePath(exe) : (emu?.options.exe ? romPath : null);
    if (!file) {
      const c = await readProjectConfig(bd);
      const guess = c.rom ? (await resolvePath(c.rom)).replace(/\.(cue|bin)$/i, '.exe') : null;
      if (guess && (await readFile(guess).then(() => true, () => false))) file = guess;
    }
    if (!file) throw new Error('give `exe` (a PS-EXE; for a disc, its EXE)');
    exeInfo(await readFile(file));    // a PS-EXE, or this throws with the reason
    port ??= process.env.PS1TEST_SERIAL;
    if (!port) throw new Error('give `port` (COM3, /dev/ttyUSB0…) or set PS1TEST_SERIAL');
    const q = (v) => `"${v}"`;
    const template = process.env.PS1TEST_UPLOADER ?? `nops ${fast ? '/fast ' : ''}/exe {exe} {port}`;
    const cmd = template.replaceAll('{exe}', q(file)).replaceAll('{port}', port);
    if (dryRun) return result(`Would run: ${cmd}`, { command: cmd });
    const r = await runCommand(cmd, bd, { timeout: 180000 });
    const out = r.output.trim().split(/\r?\n/).slice(-15).join('\n');
    if (r.code !== 0 || r.timedOut) {
      const missing = /not (found|recognized)|ENOENT/i.test(r.output) && !process.env.PS1TEST_UPLOADER;
      return errText(`Upload FAILED (${r.timedOut ? 'timed out' : `exit ${r.code}`}): ${cmd}\n${out}${missing ? '\nnops (NOTPSXSerial) isn\'t on PATH: install it, or set PS1TEST_UPLOADER to your uploader\'s command with {exe} and {port}. The console must be in Unirom\'s shell (or have it in its caetla/ROM cartridge).' : ''}`);
    }
    return result(`Sent ${path.basename(file)} to ${port} (${(r.ms / 1000).toFixed(1)}s) with: ${cmd}${out ? '\n' + out : ''}`, { sent: true });
  }, { needsRom: false });

  tool('new_project', {
    description: 'New game from a working template: text, player sprite, GTE cube, sound, a passing test, ps1test.json, CI, dev container.',
    inputSchema: { template: z.enum(Object.keys(TEMPLATES)).default('psn00bsdk'), path: z.string() },
  }, async ({ template, path: p }) => {
    const dest = await writePath(p);
    const files = await createProject(template, dest);
    return result(`Created ${dest} (${files.length} files): ${files.join(', ')}. Set the workspace to it (or PS1TEST_ROOT), then build. See its README for the SDK it needs.`);
  }, { needsRom: false });

  tool('describe', {
    description: 'Machine as text, cheaper than a screenshot: pc, watched values, display mode, screen change %; gpu:true adds the next frame\'s drawing. watch sets values reported after each step ("name:s16", [] clears).',
    inputSchema: {
      watch: z.array(z.string()).optional(),
      gpu: z.boolean().default(false),
      image: z.boolean().default(false),
      scale: Scale,
    },
    annotations: RO,
  }, async (a) => {
    if (a.watch) watches = a.watch.map(parseWatch);
    const lines = [];
    let cap = null;
    if (a.gpu) { cap = await emu.captureFrame(1); record({ wait: 1 }); }
    const r = await emu.readRegions();
    const cpu = await emu.readCpu();
    const at = emu.symbols?.nameOf(cpu.pc);
    lines.push(`Frame ${await emu.frameNum()}, pc ${hex(cpu.pc)}${at ? ` (${at})` : cpu.pc >>> 0 >= 0xbfc00000 ? ' (BIOS)' : ''}${cpu.cop0.exception !== 'Int' && cpu.cop0.exception !== 'Syscall' && (cpu.cop0.cause & 0x7c) ? `, last exception ${cpu.cop0.exception}` : ''}.`);
    const wv = await watchValues();
    if (wv.length) lines.push(`watch: ${wv.join(' ')}`);
    const d = display(r), env = stateDrawEnv(r);
    lines.push(`display: ${d.enabled ? `${d.w}x${d.h}${d.interlaced ? 'i' : ''} ${d.depth24 ? '24' : '15'}-bit ${d.pal ? 'PAL' : 'NTSC'} from VRAM ${d.x},${d.y}` : 'OFF'}; drawing into ${env.drawArea.x0},${env.drawArea.y0}-${env.drawArea.x1},${env.drawArea.y1}`);
    if (cap) {
      const stats = Object.entries(cap.stats).map(([k, v]) => `${v} ${k}`).join(', ') || 'nothing';
      lines.push(`gpu (next frame): ${stats}; ${cap.chains.length} DMA chain(s)${cap.exceptions.length ? `; ${cap.exceptions.length} CPU exception(s)` : ''}`);
    }
    const shot = await emu.screenshot();
    if (lastDescribe) {
      const c = compare(lastDescribe, shot, { tolerance: 0 });
      lines.push(`screen: ${c.fraction === 0 ? 'unchanged' : `${(c.fraction * 100).toFixed(1)}% changed`} since the last describe`);
    }
    lastDescribe = shot;
    return result(lines.join('\n'), undefined, a.image ? [png(scalePng(shot, a.scale))] : []);
  });

  tool('check', {
    description: 'Hardware rules: EXE header/SYSTEM.CNF, then `frames` frames watching exceptions, hangs, lag, CPU load, blank screen, dropped/off-screen prims, framebuffer textures, empty CLUTs, DMA, stack. State restored.',
    inputSchema: {
      frames: z.number().int().min(1).max(3600).default(120),
      frameCounter: Address.optional().describe('per-frame counter (default ps1test.json or *frame_count*)'),
    },
  }, async ({ frames, frameCounter }) => {
    const found = [];
    const region = emu.options.region === 'auto' ? null : emu.options.region;
    if (emu.options.exe) found.push(...exeIssues(await readFile(romPath), { region }));
    else if (/\.(cue|bin|iso|img)$/i.test(romPath)) found.push(...discIssues(await dataTrack(romPath), { region }));
    const findSym = (re) => [...(emu.symbols?.byName.values() ?? [])].find((x) => re.test(x.name))?.name;
    let counter = frameCounter ?? cfg.frameCounter ?? findSym(/^_?(g_|s_)?frame_?(count|counter|cnt|num)s?$/i) ?? null;
    let counterAddr = null, width = 4, counterNote = '';
    if (counter !== null) {
      try {
        counterAddr = emu.addr(counter);
        const sym = typeof counter === 'string' ? emu.symbols?.get(counter) : null;
        if (sym?.size) width = Math.min(sym.size, 4) === 3 ? 2 : Math.min(sym.size, 4);
      } catch (e) { counterNote = ` (frame counter: ${e.message})`; }
    }
    const cpuName = cfg.cpuUsage ?? findSym(/^_?(cpu_usage|cpu_load|cpuUsage)$/);
    let cpuAddr = null, cpuWidth = 1;
    if (cpuName) { try { cpuAddr = emu.addr(cpuName); cpuWidth = Math.min(emu.symbols?.get(cpuName)?.size ?? 1, 4); } catch { cpuAddr = null; } }
    const endName = ['_end', 'end', '__heap_start', '_heap_start', '__bss_end', '__bss_end__', '_bss_end'].find((n) => emu.symbols?.get(n));
    const checker = new RunChecker({ frameCounter: counterAddr, cpuUsage: cpuAddr, symbols: emu.symbols, dataEnd: endName ? emu.symbols.get(endName).addr : null });
    const saved = await emu.saveState(), f0 = await emu.frameNum();
    const rd = async (a, w) => { const b = await emu.readMemory(a, w); return w === 1 ? b.readInt8(0) : w === 2 ? b.readUInt16LE(0) : b.readUInt32LE(0); };
    try {
      let ex = null;
      for (let i = 0; i < frames; i++) {
        const cap = emu.live ? await emu.captureFrame(1, { startEx: ex, cd: true }) : (await emu.waitFrames(1), null);
        ex = cap?.ex ?? null;
        const { cpu, regions } = await emu.readLight();
        checker.observe({ regions, cpu, cap,
          counter: counterAddr !== null ? await rd(counterAddr, width) : null,
          cpuPct: cpuAddr !== null ? await rd(cpuAddr, cpuWidth) : null });
      }
    } finally { await emu.loadState(saved, { frame: f0 }); }
    found.push(...checker.findings());
    if (!emu.live) found.push({ level: 'info', msg: 'GPU and exception checks need the bundled ps1-test core (this core has no command log)' });
    const errs = found.filter((f) => f.level === 'error').length, warns = found.filter((f) => f.level === 'warn').length;
    const head = `${errs ? `${errs} error(s)` : 'No errors'}, ${warns} warning(s) over ${frames} frames${counterAddr === null ? counterNote || ' (no frame counter: lag not checked)' : ` (frame counter ${label(counterAddr)})`}; state restored.`;
    return result([head, ...found.map((f) => `${f.level === 'ok' || f.level === 'info' ? f.level : f.level.toUpperCase()}: ${f.msg}`)].join('\n'), { errors: errs, warnings: warns });
  });

  // ---- Debug (instrumented core) ----
  const nameFn = (a, o) => emu.symbols?.nameOf(a, o) ?? null;
  const at = (a) => { const n = nameFn(a, { maxOffset: 0x10000 }); return n ? `${hex(a)} (${n})` : hex(a); };
  const word = (b, o) => b.readUInt32LE(o);
  /** Registers as 4 lines of 8, pc/sr/cause/epc first. */
  const regLines = (r) => {
    const h = (n) => (n >>> 0).toString(16).padStart(8, '0');
    const lines = [`pc=${h(r.pc)} hi=${h(r.hi)} lo=${h(r.lo)} sr=${h(r.sr)} cause=${h(r.cause)} epc=${h(r.epc)}`];
    for (let i = 0; i < 32; i += 8) lines.push(REG_NAMES.slice(i, i + 8).map((n, k) => `${n}=${h(r.r[i + k])}`).join(' '));
    return lines;
  };
  async function disasmAt(addr, count, mark) {
    return listing(await emu.readMemory(addr >>> 0, count * 4), addr >>> 0, { mark, name: nameFn });
  }
  async function stackOf(regs) {
    const sp = regs.r[29] >>> 0, ram = ((sp & 0x1fffffff) >>> 0) < 0x200000;
    const stack = ram ? await emu.readMemory(sp, Math.max(0, Math.min(0x800, 0x200000 - ((sp & 0x1fffffff) >>> 0)))) : Buffer.alloc(0);
    const words = new Map();
    for (const f of [regs.r[31], ...Array.from({ length: stack.length >> 2 }, (_, i) => stack.readUInt32LE(i * 4))]) {
      const a = (f - 8) >>> 0;
      if (((a & 0x1fffffff) >>> 0) < 0x200000 && !(a & 3) && !words.has(a)) words.set(a, word(await emu.readMemory(a, 4), 0));
    }
    return callStack({ pc: regs.pc, ra: regs.r[31], sp, stack, word: (a) => words.get(a >>> 0) ?? null, name: nameFn });
  }
  const stackLine = (frames) => 'stack: ' + frames.map((f) => f.at ?? hex(f.addr)).join(' ← ');
  /** "write to frame_count by main+908: 0x45 → 0x46". */
  const hitText = (hit) => hit.kind === 'exec' ? `breakpoint ${at(hit.pc)}`
    : `${hit.kind} ${hit.kind === 'write' ? 'to' : 'of'} ${at(hit.addr)} by ${nameFn(hit.pc, { maxOffset: 0x10000 }) ?? hex(hit.pc)}: ${hit.size} byte(s) ${hit.kind === 'write' ? `${hex(hit.old)} → ${hex(hit.value)}` : hex(hit.value)}`;
  async function haltReport(st, head) {
    const pc = st.regs.pc >>> 0;
    const frames = await stackOf(st.regs);
    return [head, ...(await disasmAt(pc - 16, 9, pc)), stackLine(frames), ...regLines(st.regs)].join('\n');
  }

  tool('debug', {
    description: 'Breakpoints and watchpoints (CPU loads/stores). run: arm, run `frames`; halt stops mid-frame at the first hit (disassembly, call stack, registers), else hits are listed. Then step/continue/state/disasm; off clears.',
    inputSchema: {
      action: z.enum(['run', 'continue', 'step', 'state', 'disasm', 'off']).default('run'),
      break: z.array(Address).max(16).optional(),
      watch: z.array(z.object({
        address: Address, length: z.number().int().min(1).max(0x200000).default(4),
        on: z.enum(['write', 'read', 'access']).default('write'), changed: z.boolean().optional().describe('writes that change it'),
        op: z.enum(['eq', 'ne', 'lt', 'gt', 'lte', 'gte']).optional(), value: z.number().int().optional(),
      })).max(16).optional(),
      halt: z.boolean().default(true),
      frames: z.number().int().min(1).max(3600).default(60),
      count: z.number().int().min(1).max(10000).optional().describe('step: instructions (1); disasm: lines (16)'),
      address: Address.optional().describe('disasm start (default around pc)'),
    },
  }, async ({ action, break: exec = [], watch = [], halt, frames, count, address }) => {
    if (!emu.live) return errText('debug needs the bundled ps1-test core');
    if (action === 'off') {
      await emu.debugOff();
      return result(`Debugger off. Frame ${await emu.frameNum()}.`);
    }
    if (action === 'disasm') {
      const st = await emu.debugState();
      const pc = st.regs.pc >>> 0, n = count ?? 16;
      const from = address !== undefined ? emu.addr(address) : pc - 4 * Math.min(4, n >> 2);
      return result((await disasmAt(from & ~3, n, pc)).join('\n'));
    }
    if (action === 'state') {
      const st = await emu.debugState();
      const where = st.partial ? `Halted mid-frame ${await emu.frameNum()}` : `Frame ${await emu.frameNum()} (between frames)`;
      return result(await haltReport(st, `${where}, pc ${at(st.regs.pc)}.`), { halted: st.partial, pc: st.regs.pc });
    }
    if (action === 'step') {
      const before = await emu.debugState();
      if (!before.partial) return errText('step needs a halt: debug run with a breakpoint or watchpoint first');
      const ran = await emu.debugStep(count ?? 1);
      const st = await emu.debugState({ clear: true });
      const changed = REG_NAMES.map((n, i) => (st.regs.r[i] !== before.regs.r[i] ? `${n}=${hex(st.regs.r[i])}` : null)).filter(Boolean);
      const hit = st.hits.length ? `; stopped on ${hitText(st.hits[st.hits.length - 1])}` : '';
      return result(`Ran ${ran} instruction(s)${hit}; pc ${at(st.regs.pc)}. Changed: ${changed.join(' ') || 'none'}.\n${(await disasmAt((st.regs.pc >>> 0) - 8, 6, st.regs.pc)).join('\n')}`, { ran, pc: st.regs.pc });
    }
    const f0 = await emu.frameNum();
    if (action === 'run') {
      if (!exec.length && !watch.length) return errText('give `break` and/or `watch`');
      await emu.debugSet({ exec, watch, halt, maxHits: 256 });
    } else await emu.debugState({ clear: true });
    await emu.waitFrames(frames);
    const st = await emu.debugState({ clear: true });
    const f1 = await emu.frameNum();
    record({ wait: f1 - f0 });
    if (st.partial) {
      const hit = st.hits[st.hits.length - 1];
      const text = await haltReport(st, `Halted mid-frame ${f1} on ${hit ? hitText(hit) : 'a hit'}.\nNext: step, continue (keeps the points armed) or off; until off, other tools that run frames also stop at hits.`);
      return result(text, { halted: true, frame: f1, pc: st.regs.pc });
    }
    if (halt || action === 'continue') return result(`No hit in ${frames} frames; frame ${f1}.${action === 'run' ? ' Still armed: continue runs on, off clears.' : ''}`, { halted: false, frame: f1 });
    if (!halt) await emu.debugOff();
    // Logged hits, grouped by what and where.
    const groups = new Map();
    for (const h of st.hits) {
      const k = `${h.kind} ${h.addr} ${h.pc}`;
      const g = groups.get(k);
      if (g) { g.n++; g.last = h; } else groups.set(k, { n: 1, first: h, last: h });
    }
    const lines = [...groups.values()].map((g) => `${g.n}× ${hitText(g.last)}${g.last.kind === 'exec' ? ` (ra ${at(g.last.ra)}, a0=${hex(g.last.args[1])})` : ''}`);
    const more = st.total > st.hits.length ? ` (first ${st.hits.length} recorded)` : '';
    return result(`${st.total} hit(s) in frames ${f0}-${f1}${more}:\n${lines.join('\n') || 'none'}${await watchLine()}`, { hits: st.total, frame: f1 });
  });

  tool('profile', {
    description: 'Sample the CPU pc over `frames` frames → time per function (with hot spots), from symbols. Needs the bundled core.',
    inputSchema: {
      frames: z.number().int().min(1).max(3600).default(60),
      interval: z.number().int().min(16).max(1 << 20).optional().describe('cycles between samples (default: ~500k samples)'),
      top: z.number().int().min(1).max(100).default(15),
    },
  }, async ({ frames, interval, top }) => {
    if (!emu.live) return errText('profile needs the bundled ps1-test core');
    const cyclesPerFrame = emu.options.region === 'pal' ? 677376 : 564480;
    interval ??= Math.max(64, Math.ceil((frames * cyclesPerFrame) / 500000));
    const f0 = await emu.frameNum();
    const p = await emu.profile(frames, { interval });
    record({ wait: (await emu.frameNum()) - f0 });
    const r = profileByFunction(p.samples, nameFn);
    const lines = r.funcs.slice(0, top).map((f) => `${f.pct.toFixed(1).padStart(5)}%  ${f.name}  (hot: ${f.hot.map((x) => `${nameFn(x.addr) ?? hex(x.addr)} ${((x.count * 100) / r.total).toFixed(1)}%`).join(', ')})`);
    const more = r.funcs.length > top ? `\n… ${r.funcs.length - top} more function(s)` : '';
    const sym = emu.symbols ? '' : '\n(no symbols: grouped by address; give load_disc a .elf/.map for names)';
    return result(`${r.total} samples every ${interval} cycles over ${frames} frames${p.full ? ' (buffer full: later frames not sampled)' : ''}:\n${lines.join('\n')}${more}${sym}`,
      { samples: r.total, top: r.funcs[0]?.name ?? null });
  });

  // ---- Sound and CD-ROM (instrumented core) ----
  tool('spu', {
    description: 'Sound chip: what each voice plays (start address, rate, envelope, volume) and why nothing is heard. sample: a voice\'s (or address\'s) ADPCM from SPU RAM → .wav.',
    inputSchema: {
      action: z.enum(['state', 'sample']).default('state'),
      all: z.boolean().default(false).describe('list idle voices too'),
      voice: z.number().int().min(0).max(23).optional(),
      address: z.number().int().min(0).max(0x7fff0).optional().describe('SPU RAM byte offset (instead of voice)'),
      save: z.string().optional().describe('.wav path for sample'),
    },
    annotations: RO,
  }, async ({ action, all, voice, address, save }) => {
    if (!emu.live) return errText('spu needs the bundled ps1-test core');
    const st = await emu.spuState();
    const regs = await emu.spuRead(0, 0x400, 'regs');
    if (action === 'state') {
      const d = describeSpu(st, regs, { all });
      const lines = [`Frame ${await emu.frameNum()}: ${d.lines[0]}`, ...d.lines.slice(1), ...d.problems.map((p) => `PROBLEM: ${p}`)];
      return result(lines.join('\n'), { playing: d.playing, problems: d.problems.length });
    }
    if (voice === undefined && address === undefined) return errText('sample needs `voice` or `address`');
    const offset = address ?? regs.readUInt16LE(voice * 16 + 6) * 8;
    const s = sampleAt(await emu.spuRead(0, 0x80000), offset & ~15);
    const rate = voice !== undefined && st.voices[voice].pitch ? pitchToRate(st.voices[voice].pitch) : 22050;
    const pcm = decodeAdpcm(s.adpcm);
    let saved = '';
    if (save) {
      const abs = await writePath(save);
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, encodeWav16(pcm, rate));
      saved = `, saved ${abs}`;
    }
    let peak = 0;
    for (const v of pcm) peak = Math.max(peak, Math.abs(v));
    return result(`Sample at SPU RAM ${hex(offset & ~15)}: ${s.adpcm.length / 16} block(s), ${pcm.length} samples (${(pcm.length / rate).toFixed(3)} s at ${rate} Hz), peak ${peak}, ${s.looped ? `loops${s.loopAt !== null ? ` from byte ${s.loopAt}` : ''}` : 'one-shot'}${saved}.`,
      { blocks: s.adpcm.length / 16, samples: pcm.length, looped: s.looped, peak });
  });

  tool('cd_log', {
    description: 'Run `frames` frames logging the CD-ROM drive: commands (with the calling function), answers, errors, and sector reads mapped to the disc\'s files.',
    inputSchema: {
      frames: z.number().int().min(1).max(3600).default(60),
      list: z.number().int().min(1).max(1000).default(80).describe('lines to show'),
    },
  }, async ({ frames, list }) => {
    if (!emu.live) return errText('cd_log needs the bundled ps1-test core');
    let files = [];
    if (!emu.options.exe) { try { files = isoList(await dataTrack(romPath)); } catch { files = []; } }
    const log = await emu.cdLog(frames);
    record({ wait: log.to - log.from });
    const cyclesPerFrame = emu.options.region === 'pal' ? 677376 : 564480;
    const s = summarizeCd(log.entries, { files, name: (a) => nameFn(a, { maxOffset: 0x10000 }), cyclesPerFrame, limit: list });
    const head = `Frames ${log.from}-${log.to}: ${s.commands} command(s), ${s.sectors} sector(s) read, ${s.seeks} seek(s), ${s.errors} error(s)${log.overflow ? '; LOG FULL (later entries lost)' : ''}.${emu.options.exe ? ' (A side-loaded EXE: no disc in the drive.)' : ''}`;
    return result(`${head}${s.text ? '\n' + s.text : ''}`, { commands: s.commands, sectors: s.sectors, errors: s.errors });
  });

  // ---- Status ----
  const statusData = async () => (emu
    ? { loaded: true, rom: romPath, bios: emu.options.bios, region: emu.options.region, pads: [emu.options.pad1, emu.options.pad2], frame: await emu.frameNum(), held: await emu.heldButtons(), states: [...states.keys()], cheats: emu.cheats.length, ramSearch: search ? search.count : null, recordedSteps: rec.length, symbols: emu.symbols ? `${emu.symbols.file} (${emu.symbols.count})` : null, watch: activeWatches().map((w) => w.label) }
    : { loaded: false });

  tool('status', {
    description: 'Loaded disc/EXE, BIOS, region, frame, held buttons, saved states, cheats, RAM search.',
    inputSchema: {},
    annotations: RO,
  }, async () => {
    const s = await statusData();
    return result(JSON.stringify(s), s);
  }, { needsRom: false });

  // Serve a slimmed tool list (definitions are resent with every request). The SDK
  // keeps its handlers in a private map; if that ever changes, the full list is served.
  const handlers = /** @type {any} */ (server.server)._requestHandlers;
  const listTools = handlers?.get?.('tools/list');
  if (listTools) {
    handlers.set('tools/list', async (...args) => {
      const res = await listTools(...args);
      return { ...res, tools: res.tools.map(({ execution, ...t }) => ({ ...t, inputSchema: slimSchema(t.inputSchema) })) };
    });
  }

  // ---- Resources ----
  server.registerResource('screen', 'emu://screen', {
    title: 'Current screen', description: 'The current frame as a native-resolution PNG.', mimeType: 'image/png',
  }, serial(async (uri) => {
    requireRom();
    return { contents: [{ uri: uri.href, mimeType: 'image/png', blob: (await emu.screenshot()).toString('base64') }] };
  }));
  server.registerResource('status', 'emu://status', {
    title: 'Emulator status', description: 'Loaded disc/EXE, frame, held buttons and saved states as JSON.', mimeType: 'application/json',
  }, serial(async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(await statusData()) }] })));

  // ---- Prompts: reusable workflows that orchestrate the tools above ----
  /** @param {string} t */
  const userMsg = (t) => ({ messages: [{ role: /** @type {const} */ ('user'), content: { type: /** @type {const} */ ('text'), text: t } }] });

  server.registerPrompt('smoke_test_rom', {
    title: 'Smoke-test a disc or EXE',
    description: 'Boot a disc image or PS-EXE and check it actually runs (renders, does not crash or hang).',
    argsSchema: { rom: z.string().describe('Path to the .cue/.bin/.iso or .exe'), frames: z.string().optional().describe('Frames to run before judging (default 600: discs take ~3 s to boot)') },
  }, ({ rom, frames }) => userMsg(
`Smoke-test the PlayStation game at "${rom}" and tell me if it runs.

1. Call load_disc with path="${rom}". If it errors, report the error and stop.
2. Call run_sequence with steps [{"wait": ${frames || 600}}, {"shot": "boot"}, {"wait": 60}, {"shot": "later"}].
3. Look at both images. Does it show real game content, or is it black/blank/garbled?
   Do the two frames differ (animation/attract mode), or is it frozen? A static title
   screen can be fine — press START (press tool) and screenshot to check it responds.

Report PASS (it boots, renders and responds) or FAIL (with what you saw).`));

  server.registerPrompt('regression_check', {
    title: 'Visual regression check',
    description: 'Play a scripted sequence and compare frames to saved golden images.',
    argsSchema: { rom: z.string().describe('Path to the disc image or EXE'), steps: z.string().describe('Plain-language sequence of inputs and where to check, e.g. "press START, wait 120, then check the title screen"') },
  }, ({ rom, steps }) => userMsg(
`Run a visual regression check on "${rom}".

Sequence to perform: ${steps}

1. load_disc with path="${rom}".
2. Translate the sequence into ONE run_sequence call: wait/tap/hold steps, plus an
   {"assert": "goldens/<checkpoint>.png", "name": "<checkpoint>"} step at each
   checkpoint. Advance time only with wait steps (never real-time sleeps) so the run
   is deterministic. The FIRST run creates the baselines; later runs compare.
3. Report each checkpoint PASS/FAIL with the percent differing. On FAIL, call
   assert_golden at that point (replay with state load/run_sequence if needed) to see
   the current/golden/diff images, and describe what changed.

If this is the first run, say that you created the baselines and ask me to confirm they look correct.`));

  server.registerPrompt('find_ram_address', {
    title: 'Find a RAM address',
    description: 'Discover the RAM address of an in-game value (HP, score, coins…) by value search, then verify it.',
    argsSchema: { rom: z.string().describe('Path to the disc image or EXE'), variable: z.string().describe('What to find, e.g. "player HP" or "coin count"'), region: z.string().optional().describe('Optional: "ram" (default) or "scratchpad"') },
  }, ({ rom, variable, region }) => userMsg(
`Find the RAM address of "${variable}" in "${rom}" using the RAM search tools.

1. load_disc, then play (press / run_sequence) to a point where "${variable}" is in play.
   state action="save" id="start" so you can retry.
2. ram_search action="start"${region ? ` region="${region}"` : ''}. If you can read the value on screen, pass it as
   \`value\` (try type "u16" first — PS1 games often keep counters in 16 or 32 bits; "u8" for small values).
3. Change the value in game (take damage, collect a coin…), then ram_search
   action="filter": op "eq" + the new value if you can see it, otherwise
   "decreased"/"increased", or "delta" with the exact change. Also filter
   "unchanged" after doing something that does NOT affect the value.
4. Repeat step 3 until 1–3 candidates remain (usually 2–4 rounds).
5. VERIFY: write_memory a distinctive value to the candidate, wait_frames a few, and
   screenshot — the game should reflect it. If not, try the next candidate.

Report the confirmed address, type, and how you verified it.`));

  server.registerPrompt('record_regression_test', {
    title: 'Record a regression test',
    description: 'Play to a point of interest, then turn the session into a replayable test script with checks.',
    argsSchema: { rom: z.string().describe('Path to the disc image or EXE'), goal: z.string().describe('What to reach and check, e.g. "beat the first enemy and check the score goes up"'), path: z.string().optional().describe('Where to save the script (default tests/<name>.json)') },
  }, ({ rom, goal, path: p }) => userMsg(
`Record a regression test for "${rom}": ${goal}

1. load_disc with path="${rom}" (this starts a fresh recording).
2. Play towards the goal with run_sequence / press / set_button. Prefer wait_until
   over guessing wait lengths (e.g. wait_until screen "stable" after a transition,
   or a RAM condition). Use screenshot to see where you are.
3. At each point that matters, add a check: assert_golden for the picture (mask
   clocks/timers with \`ignore\`), or note a RAM address/value for an assertRam step
   (use ram_search to find addresses if needed).
4. export_script${p ? ` with path="${p}"` : ''} — then add {"assertRam": ...} steps to the
   exported steps where you noted values.
5. Prove it replays: load_disc again and run_sequence with the exported steps; it
   must pass.

Report the script path, what it checks, and the replay result.`));

  return {
    server,
    /** Close the emulator (and the shared browser). */
    async close() {
      try { await emu?.close(); } catch {}
      emu = null;
      await EmuHarness.shutdown();
    },
  };
}

// ---- Entry point (stdio) ----
/** Serve over stdio until stdin closes. */
export async function main() {
  const { server, close } = createServer();
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { await close(); process.exit(0); });
  process.stdin.on('close', async () => { await close(); process.exit(0); });
  await server.connect(new StdioServerTransport());
  console.error(`ps1-test-mcp ${VERSION} ready (stdio).`);
}
const isMain = process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (isMain && process.argv[2] === 'new') {
  // node mcp-server.mjs new <template> <dir>
  const [, , , template, dir] = process.argv;
  if (!template || !dir) {
    console.error(`usage: node mcp-server.mjs new <template> <dir>\ntemplates: ${Object.entries(TEMPLATES).map(([k, v]) => `\n  ${k.padEnd(10)} ${v}`).join('')}`);
    process.exit(1);
  }
  const files = await createProject(template, path.resolve(dir));
  console.log(`Created ${dir} (${files.length} files). cd ${dir} && cmake --preset default && cmake --build build`);
} else if (isMain) await main();
