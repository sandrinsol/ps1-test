// Unit tests that need no emulator: PS-EXE parsing, ELF → EXE, the disc
// builder (ISO 9660 + Mode 2 sectors with EDC), the zip writer, symbols,
// build-output parsing, and memory-card formats.
//
//   node tests/unit.mjs

import { readFile } from 'node:fs/promises';
import { ok, done, FIX } from './lib.mjs';
import { exeInfo, makeDisc, zipStore, discFiles } from '../disc.mjs';
import { elfToExe } from '../exe.mjs';
import { parseSymbols, loadSymbols, parseAddress } from '../symbols.mjs';
import { parseDiagnostics } from '../build.mjs';
import { rawCard } from '../driver.mjs';
import { formatCard, listSaves } from '../mcard.mjs';
import { exeIssues, discIssues } from '../checks.mjs';
import { decodeLog } from '../gpu.mjs';
import { convertTim, readTim, timToPng, timToC } from '../tim.mjs';
import { encodeVag, decodeAdpcm, encodeWav16, vagFile, readVag, makeTable, convertMesh, writeMesh, decodeWav } from '../gamedata.mjs';
import { convertTilemap, writeTilemap } from '../tilemap.mjs';
import { encodePng, decodePng } from '../png.mjs';
import { RunChecker } from '../checks.mjs';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp } from 'node:fs/promises';

const exe = await readFile(path.join(FIX, 'hello.exe'));
const elf = await readFile(path.join(FIX, 'hello.elf'));

// ---- PS-EXE ----
const info = exeInfo(exe);
ok('exeInfo: entry/load in KSEG0 RAM', info.entry === 0x80010000 && info.load === 0x80010000, `entry ${info.entry.toString(16)}`);
ok('exeInfo: region from the marker', info.region === 'NTSC-U');
let threw = '';
try { exeInfo(Buffer.alloc(4096)); } catch (e) { threw = e.message; }
ok('exeInfo rejects a non-EXE', /not a PS-EXE/.test(threw));
try { exeInfo(exe.subarray(0, 2100)); threw = ''; } catch (e) { threw = e.message; }
ok('exeInfo rejects a truncated EXE', /truncated/.test(threw));
ok('elfToExe reproduces the fixture EXE', elfToExe(elf).equals(exe));
const pal = exeInfo(elfToExe(elf, { region: 'PAL' }));
ok('elfToExe PAL marker', pal.region === 'PAL');

// ---- Disc ----
const tmp = await mkdtemp(path.join(os.tmpdir(), 'ps1test-'));
const { bin, cue } = await makeDisc({ exe, out: path.join(tmp, 'd'), label: 'unit', files: { 'DATA.BIN': Buffer.from('hello data') } });
const img = await readFile(bin);
ok('disc is whole 2352-byte sectors', img.length % 2352 === 0, `${img.length / 2352} sectors`);
const sector = (lba) => img.subarray(lba * 2352, lba * 2352 + 2352);
const data = (lba) => sector(lba).subarray(24, 24 + 2048);
ok('sector sync pattern', sector(16).subarray(0, 12).equals(Buffer.from([0, ...Array(10).fill(0xff), 0])));
ok('sector header MSF of LBA 16 is 00:02:16, mode 2', sector(16).subarray(12, 16).equals(Buffer.from([0x00, 0x02, 0x16, 0x02])));
ok('primary volume descriptor at LBA 16', data(16).toString('latin1', 1, 6) === 'CD001' && data(16)[0] === 1);
ok('volume label', data(16).toString('latin1', 40, 44) === 'UNIT');
// EDC check of sector 16 (CRC over subheader + data, poly 0xD8018001 reflected)
const t = new Uint32Array(256).map((_, i) => { let e = i; for (let k = 0; k < 8; k++) e = (e >>> 1) ^ (e & 1 ? 0xd8018001 : 0); return e >>> 0; });
let e = 0; for (let i = 16; i < 16 + 2056; i++) e = (e >>> 8) ^ t[(e ^ sector(16)[i]) & 0xff];
ok('EDC matches', (e >>> 0) === sector(16).readUInt32LE(2072));
// Walk the root directory for SYSTEM.CNF, the EXE and DATA.BIN.
const rootLba = data(16).readUInt32LE(156 + 2), root = data(rootLba);
const files = {};
for (let o = 0; root[o];) { const len = root[o]; const name = root.toString('latin1', o + 33, o + 33 + root[o + 32]); files[name] = { lba: root.readUInt32LE(o + 2), size: root.readUInt32LE(o + 10) }; o += len; }
ok('root lists SYSTEM.CNF, MAIN.EXE, DATA.BIN', ['SYSTEM.CNF;1', 'MAIN.EXE;1', 'DATA.BIN;1'].every((n) => files[n]), Object.keys(files).filter((n) => n.length > 1).join(' '));
ok('SYSTEM.CNF boots MAIN.EXE', /BOOT = cdrom:\\MAIN\.EXE;1/.test(data(files['SYSTEM.CNF;1'].lba).toString('latin1', 0, files['SYSTEM.CNF;1'].size)));
ok('EXE stored intact', Buffer.concat(Array.from({ length: Math.ceil(exe.length / 2048) }, (_, i) => data(files['MAIN.EXE;1'].lba + i))).subarray(0, exe.length).equals(exe));
ok('cue sheet names the bin', (await readFile(cue, 'utf8')).includes(`FILE "d.bin" BINARY`) && (await readFile(cue, 'utf8')).includes('MODE2/2352'));
try { await makeDisc({ exe, out: path.join(tmp, 'x'), files: { 'lowercase-long-name.bin': Buffer.alloc(1) } }); threw = ''; } catch (err) { threw = err.message; }
ok('disc file names must be 8.3', /8\.3/.test(threw));

// ---- Zip (a .cue and its tracks go to EmulatorJS as one file) ----
const z = zipStore([['a.cue', Buffer.from('FILE "a.bin" BINARY')], ['a.bin', Buffer.from([1, 2, 3])]]);
ok('zip local header', z.readUInt32LE(0) === 0x04034b50);
ok('zip end record lists 2 entries', z.readUInt16LE(z.length - 22 + 10) === 2);
const served = await discFiles(cue);
ok('discFiles serves a .cue as one zip', Object.keys(served.serve).length === 1 && served.url === 'd.zip' && Buffer.isBuffer(served.serve['d.zip']));
ok('discFiles serves an EXE as is', (await discFiles(path.join(FIX, 'hello.exe'))).exe === true);

// ---- Symbols ----
const syms = await loadSymbols(path.join(FIX, 'hello.elf'));
ok('ELF symbols: frame_count', syms.get('frame_count')?.addr >= 0x80010000);
ok('nameOf inside main', syms.nameOf(syms.get('main').addr + 8) === 'main+8');
ok('nameOf through the KSEG1 mirror', syms.nameOf((syms.get('main').addr | 0x20000000) >>> 0) === 'main');
const txt = parseSymbols(Buffer.from('80010000 main\n800103a4 frame_count\n'));
ok('.sym text format', txt.get('frame_count').addr === 0x800103a4);
const map = parseSymbols(Buffer.from('                0x80010394                frame_count\n'));
ok('GNU ld map format', map.get('frame_count').addr === 0x80010394);
ok('parseAddress hex/symbol/offset', parseAddress('0x1F800000') === 0x1f800000 && parseAddress('frame_count+2', txt) === 0x800103a6);

// ---- Build diagnostics ----
const diags = parseDiagnostics([
  'src/main.c:12:5: error: \'x\' undeclared (first use in this function)',
  'src/main.c:20:1: warning: unused variable \'y\' [-Wunused-variable]',
  'CMake Error at CMakeLists.txt:7 (psn00bsdk_add_executable):',
  '  Unknown CMake command "psn00bsdk_add_executable".',
  '/usr/bin/ld: main.o: in function `main\':',
  'main.c:(.text+0x10): undefined reference to `missing_fn\'',
].join('\n'));
ok('GCC error', diags.some((d) => d.level === 'error' && d.file === 'src/main.c' && d.line === 12));
ok('GCC warning', diags.some((d) => d.level === 'warning' && d.line === 20));
ok('CMake error with its message', diags.some((d) => d.file === 'CMakeLists.txt' && /Unknown CMake command/.test(d.msg)));
ok('undefined reference', diags.some((d) => /missing_fn/.test(d.msg)));
ok('typographic quotes become plain ones', parseDiagnostics('a.c:1:2: error: expected \u2018;\u2019 before \u2018if\u2019')[0]?.msg === "expected ';' before 'if'");

// ---- Memory card formats ----
const card = Buffer.alloc(128 * 1024, 7);
ok('raw card passes through', rawCard(card) === card);
const gme = Buffer.concat([Buffer.from('123-456-STD'.padEnd(3904, '\0'), 'latin1'), card]);
ok('DexDrive .gme header stripped', rawCard(gme).equals(card));
try { rawCard(Buffer.alloc(1000)); threw = ''; } catch (err) { threw = err.message; }
ok('wrong-size card rejected', /not a memory card/.test(threw));

// ---- Memory cards: format, a save with a title and icon, listing ----
const fc = formatCard();
ok('formatted card lists empty', listSaves(fc).saves.length === 0 && listSaves(fc).freeBlocks === 15 && !listSaves(fc).problems.length);
{
  const c = Buffer.from(fc);
  const d = c.subarray(128, 256);
  d.writeUInt32LE(0x51, 0); d.writeUInt32LE(8192, 4); d.writeUInt16LE(0xffff, 8);
  d.write('BASLUS-00067GAME0', 0x0a, 'latin1');
  d[0x7f] = d.subarray(0, 0x7f).reduce((a, v) => a ^ v, 0);
  const b = c.subarray(8192, 8192 * 2);
  b.write('SC', 0, 'latin1'); b[2] = 0x11; b[3] = 1;
  Buffer.from([0x82, 0x60, 0x82, 0x61, 0x81, 0x40, 0x82, 0x50]).copy(b, 4);   // "AB 1" in full-width SJIS
  b.writeUInt16LE(0x7fff, 0x62);                                               // palette entry 1 = white
  b.fill(0x11, 128, 256);                                                      // icon all colour 1
  const l = listSaves(c);
  const s0 = l.saves[0];
  ok('save listed with game ID, region and decoded title', s0 && s0.gameId === 'SLUS-00067' && s0.region === 'NTSC-U' && s0.title === 'AB 1' && s0.blocks === 1, JSON.stringify({ ...s0, icon: undefined }));
  ok('save icon decodes', s0?.icon && s0.icon.length > 50);
  ok('free blocks counted', l.freeBlocks === 14);
}

// ---- EXE / disc rules ----
const issues = (b, o) => exeIssues(b, o).filter((f) => f.level !== 'ok').map((f) => f.msg).join(' | ');
ok('fixture EXE has no issues', issues(exe) === '', issues(exe));
const noRegion = Buffer.from(exe); noRegion.fill(0, 0x4c, 0x800);
ok('missing region marker flagged', /no region marker/.test(issues(noRegion)));
ok('PAL run of an NTSC EXE flagged', /runs as PAL/.test(issues(exe, { region: 'pal' })));
const lowLoad = Buffer.from(exe); lowLoad.writeUInt32LE(0x80008000, 0x18); lowLoad.writeUInt32LE(0x80008000, 0x10);
ok('loading over the kernel flagged', /over the BIOS kernel/.test(issues(lowLoad)));
const badEntry = Buffer.from(exe); badEntry.writeUInt32LE(0x80100000, 0x10);
ok('entry outside the image flagged', /entry point .* outside/.test(issues(badEntry)));
const disc = await readFile(bin);
ok('disc rules: SYSTEM.CNF boots MAIN.EXE', discIssues(disc).some((f) => f.level === 'ok' && /boots MAIN\.EXE/.test(f.msg)));
ok('disc without SYSTEM.CNF or PSX.EXE is an error', discIssues(Buffer.alloc(2352 * 40)).some((f) => f.level === 'error'));

// ---- GPU log decoding ----
const words = (type, src, addr, ws) => { const b = Buffer.alloc(8 + ws.length * 4); b.writeUInt32LE((type << 28) | (src << 24) | ws.length, 0); b.writeUInt32LE(addr >>> 0, 4); ws.forEach((w, i) => b.writeUInt32LE(w >>> 0, 8 + i * 4)); return b; };
const log = Buffer.concat([
  words(3, 0, 0x80020000, []),
  words(1, 2, 0x80020000, [0xe5000000 | (100 & 0x7ff) | ((50 & 0x7ff) << 11), 0x28ff0000, 0, 10, 10 << 16, (10 << 16) | 10]),   // offset 100,50 + flat quad
  words(1, 0, 0, [0x02000000]), words(1, 0, 0, [0]), words(1, 0, 0, [(16 << 16) | 16]),                                          // fill, word by word
  words(4, 0, 0, [4 << 2, 0x80010010, 0x80010002]),
]);
const dec = decodeLog(log);
ok('decodeLog: quad with the draw offset applied', dec.prims[0]?.kind === 'poly4' && dec.prims[0].verts[0][0] === 100 && dec.prims[0].verts[3][1] === 60, JSON.stringify(dec.prims[0]?.verts));
ok('decodeLog: chain packet address', dec.prims[0].addr === 0x80020004 + 4 && dec.chains[0] === 0x80020000, dec.prims[0].addr.toString(16));
ok('decodeLog: CPU-written fill reassembled from single words', dec.prims[1]?.kind === 'fill' && dec.prims[1].size[0] === 16);
ok('decodeLog: exception', dec.exceptions[0]?.code === 4 && dec.exceptions[0].badVaddr === 0x80010002);

// ---- TIM ----
{
  const W = 8, H = 4, data = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) data.set(i % 3 === 0 ? [0, 0, 0, 0] : i % 3 === 1 ? [255, 0, 0, 255] : [0, 0, 0, 255], i * 4);
  const pngIn = encodePng({ width: W, height: H, channels: 4, data });
  const t4 = convertTim(pngIn, { depth: 4, x: 640, y: 0, clutX: 640, clutY: 480 });
  const r4 = readTim(t4.tim);
  ok('TIM 4-bit: header, CLUT and image blocks', r4.depth === 4 && r4.clut.x === 640 && r4.clut.y === 480 && r4.image.w === 2 && r4.image.h === 4 && r4.width === 8);
  ok('TIM: transparent pixels are colour 0, opaque black is 0x8000', r4.clut.colors[0] === 0 && r4.clut.colors.includes(0x8000) && r4.clut.colors.includes(0x001f));
  const back = decodePng(timToPng(t4.tim));
  ok('TIM round-trips through PNG', back.width === 8 && back.data[3] === 0 && back.data[7] === 255 && back.data[4] === 255);
  const t16 = readTim(convertTim(pngIn, { depth: 16, x: 0, y: 0 }).tim);
  ok('TIM 16-bit has no CLUT', t16.depth === 16 && !t16.clut && t16.image.w === 8);
  let thrown = '';
  try { convertTim(pngIn, { depth: 4, x: 1023 }); } catch (e) { thrown = e.message; }
  ok('TIM placement outside VRAM refused', /doesn't fit/.test(thrown), thrown);
  const many = new Uint8Array(32 * 32 * 4); for (let i = 0; i < 1024; i++) many.set([i & 255, (i >> 2) & 255, 128, 255], i * 4);
  try { convertTim(encodePng({ width: 32, height: 32, channels: 4, data: many }), { depth: 4 }); thrown = ''; } catch (e) { thrown = e.message; }
  ok('too many colours for 4-bit needs quantize', /quantize/.test(thrown));
  ok('quantize reduces to 16 colours', convertTim(encodePng({ width: 32, height: 32, channels: 4, data: many }), { depth: 4, quantize: true }).colors <= 16);
  ok('TIM as a C array', /const uint32_t player_tim\[\] = \{/.test(timToC(t4.tim, 'player_tim')));
}

// ---- VAG ----
{
  const rate = 22050, n = 11025;
  const pcm = Int16Array.from({ length: n }, (_, i) => Math.round(Math.sin(2 * Math.PI * 440 * i / rate) * 20000));
  const v = encodeVag(encodeWav16(pcm, rate), { rate });
  const d = decodeAdpcm(v.adpcm);
  let sig = 0, noise = 0;
  for (let i = 0; i < n; i++) { sig += pcm[i] ** 2; noise += (pcm[i] - d[i + 28]) ** 2; }
  ok('VAG: SPU ADPCM round trip above 40 dB SNR', 10 * Math.log10(sig / noise) > 40, `${(10 * Math.log10(sig / noise)).toFixed(1)} dB`);
  ok('VAG: 16-byte blocks, last one flagged end', v.adpcm.length % 16 === 0 && (v.adpcm[v.adpcm.length - 15] & 1) === 1);
  ok('VAG: pitch for 22050 Hz is 0x800', v.pitch === 0x800);
  const looped = encodeVag(encodeWav16(pcm, rate), { rate, loop: true });
  ok('VAG loop: start flag on the first data block, end+repeat on the last', (looped.adpcm[17] & 4) === 4 && (looped.adpcm[looped.adpcm.length - 15] & 3) === 3);
  const f = readVag(vagFile(v, 'tone'));
  ok('.vag header round-trips', f.rate === rate && f.name === 'tone' && f.adpcm.equals(v.adpcm));
  const st = encodeWav16(Int16Array.from([1000, -1000, 2000, -2000]), 8000);
  ok('WAV decoder', decodeWav(st).samples.length === 4 && decodeWav(st).rate === 8000);
}

// ---- Tables, meshes, tilemaps ----
{
  const sin = makeTable('sin');
  ok('sin table: 4096 steps, 12 bits', sin.size === 4096 && sin.values[1024] === 4096 && sin.values[0] === 0 && sin.type === 'int16_t');
  const obj = 'v -1 -1 0\nv 1 -1 0\nv 1 1 0\nv -1 1 0\nvn 0 0 1\nf 1//1 2//1 3//1 4//1\nf 1 2 3\n';
  const m = convertMesh(obj, { size: 100 });
  ok('mesh: scaled to ±size, Y flipped for screen space', m.verts[0][0] === -100 && m.verts[0][1] === 100 && m.verts[2][1] === -100);
  ok('mesh: quads in GPU order (0,1,3,2)', m.faces[0].v.join() === '0,1,3,2' && m.quads === 1 && m.tris === 1);
  ok('mesh: normals in 4096 units', m.norms[0][2] === 4096);
  const mf = path.join(tmp, 'm.c');
  await writeMesh(m, mf, 'quad');
  ok('mesh C source', /const SVECTOR quad_verts\[4\]/.test(await readFile(mf, 'utf8')) && /QUAD_QUADS 1/.test(await readFile(mf.replace(/c$/, 'h'), 'utf8')));
  const W = 64, H = 32, img = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) img.set(((x >> 4) + (y >> 4)) % 2 ? [200, 50, 50, 255] : [50, 50, 200, 255], (y * W + x) * 4);
  const tm = convertTilemap(encodePng({ width: W, height: H, channels: 4, data: img }), { tile: 16 });
  ok('tilemap: duplicates merged', tm.tileCount === 2 && tm.cols === 4 && tm.rows === 2 && Array.from(tm.map).join() === '0,1,0,1,1,0,1,0');
  ok('tilemap preview rebuilds the image', decodePng(tm.preview).width === 64);
  const files = await writeTilemap(tm, path.join(tmp, 'level.c'), 'level');
  ok('tilemap writes .c, .h and the tileset .tim', files.length === 3 && readTim(await readFile(path.join(tmp, 'level.tim'))).depth === 4);
}

// ---- check: a reserved instruction in a libgcc helper gets an explanation ----
{
  const c = new RunChecker({ symbols: { nameOf: () => '__bswapsi2' } });
  c.observe({ regions: { gpuStatus: 0, gpuControl: Buffer.alloc(1024), vram: Buffer.alloc(1024 * 1024) }, cpu: { pc: 0x80010000, sp: 0x801fff00 }, cap: { exceptions: [{ code: 10, epc: 0x80010980, badVaddr: 0 }], prims: [], chains: [], env: { drawArea: { x0: 0, y0: 0, x1: 319, y1: 239 } } } });
  ok('check explains an RI exception in a compiler helper', c.findings().some((f) => /reserved instruction.*__bswapsi2.*MIPS32r2/.test(f.msg)));
}

done();
