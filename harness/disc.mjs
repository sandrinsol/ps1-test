// Disc images and PS-EXE files.
//
// - discFiles(): what the harness must serve for a disc (a .cue names its track
//   files) or an EXE.
// - exeInfo(): the PS-EXE header (entry point, load address, size, region).
// - makeDisc(): wrap a PS-EXE (plus extra files) into a bootable single-track
//   Mode 2 .bin/.cue with SYSTEM.CNF, so a homebrew build can be tested as the
//   console really loads it (from CD, through the BIOS) and not only side-loaded.

import { readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';

const EXE_EXT = new Set(['.exe', '.psx', '.ps-exe', '.psexe']);
export const DISC_EXT = ['.cue', '.bin', '.iso', '.img', '.exe', '.psx'];

/** What to serve for a disc or EXE: { serve: { urlName: absPath | Buffer }, url,
 *  exe }. EmulatorJS downloads one file, so a .cue and its track files go in an
 *  (uncompressed) zip it unpacks; every FILE the .cue names must exist. */
export async function discFiles(absRom) {
  const ext = path.extname(absRom).toLowerCase();
  const name = path.basename(absRom);
  /** @type {Record<string, string | Buffer>} */
  const serve = { [name]: absRom };
  if (EXE_EXT.has(ext)) {
    exeInfo(await readFile(absRom)); // throws with the reason if it isn't a PS-EXE
    return { serve, url: name, exe: true };
  }
  if (!['.cue', '.bin', '.iso', '.img', '.zip', '.7z', '.pbp', '.chd', '.m3u'].includes(ext)) {
    throw new Error(`${name}: not a PS1 disc image or EXE (use .cue/.bin/.iso/.img, .exe/.psx, or a .zip of them)`);
  }
  if (ext === '.bin' || ext === '.iso' || ext === '.img') await checkImage(absRom);
  if (ext === '.cue') {
    const cue = await readFile(absRom, 'utf8');
    const missing = [];
    for (const m of cue.matchAll(/^\s*FILE\s+(?:"([^"]+)"|(\S+))/gim)) {
      const f = m[1] ?? m[2];
      const abs = path.resolve(path.dirname(absRom), f);
      if (!(await stat(abs).catch(() => null))) missing.push(f);
      serve[f] = abs;
      serve[path.basename(f)] = abs;
    }
    if (missing.length) throw new Error(`${name} names missing track file(s): ${missing.join(', ')}`);
    const entries = [[name, await readFile(absRom)]];
    for (const m of cue.matchAll(/^\s*FILE\s+(?:"([^"]+)"|(\S+))/gim)) {
      const f = m[1] ?? m[2];
      entries.push([f.replace(/\\/g, '/'), await readFile(path.resolve(path.dirname(absRom), f))]);
    }
    const zipName = name.replace(/\.cue$/i, '') + '.zip';
    return { serve: { [zipName]: zipStore(entries) }, url: zipName, exe: false };
  }
  return { serve, url: name, exe: false };
}

const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
function crc32(b) { let c = -1; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; }

/** A zip archive holding `entries` ([name, Buffer]) without compression. */
export function zipStore(entries) {
  const parts = [], central = [];
  let off = 0;
  for (const [name, data] of entries) {
    const n = Buffer.from(name, 'utf8'), crc = crc32(data);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x800, 6);
    h.writeUInt32LE(crc, 14); h.writeUInt32LE(data.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(n.length, 26);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x800, 8);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(off, 42);
    parts.push(h, n, data); central.push(c, n);
    off += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, end]);
}

/** Throw if a raw image isn't a CD-ROM data track: whole 2048- or 2352-byte
 *  sectors with an ISO 9660 volume descriptor ("CD001") at sector 16. */
async function checkImage(file) {
  const { open } = await import('node:fs/promises');
  const fh = await open(file, 'r');
  try {
    const { size } = await fh.stat();
    const at = async (o) => { const b = Buffer.alloc(5); await fh.read(b, 0, 5, o); return b.toString('latin1'); };
    const ok = (size % 2352 === 0 && (await at(16 * 2352 + 25) === 'CD001' || await at(16 * 2352 + 17) === 'CD001'))
      || (size % 2048 === 0 && await at(16 * 2048 + 1) === 'CD001');
    if (!ok) throw new Error(`${path.basename(file)} is not a PS1 disc image (no ISO 9660 data track: expected 2048- or 2352-byte sectors with "CD001" at sector 16)`);
  } finally { await fh.close(); }
}

const REGIONS = { 'North America': 'NTSC-U', Europe: 'PAL', Japan: 'NTSC-J' };

/** Parse a PS-EXE header. → { entry, gp, load, size, stack, region, marker }
 *  Throws if the file isn't a PS-EXE (or is truncated). */
export function exeInfo(buf) {
  if (buf.length < 0x800 || buf.toString('latin1', 0, 8) !== 'PS-X EXE') {
    throw new Error('not a PS-EXE (no "PS-X EXE" header); give a disc image (.cue/.bin/.iso) or an executable built for the PS1');
  }
  const u = (o) => buf.readUInt32LE(o);
  const size = u(0x1c);
  if (0x800 + size > buf.length) throw new Error(`PS-EXE is truncated: header says ${size} bytes of code, file has ${buf.length - 0x800}`);
  const marker = buf.toString('latin1', 0x4c, 0x800).replace(/\0.*$/s, '');
  const region = Object.entries(REGIONS).find(([k]) => marker.includes(k))?.[1] ?? null;
  return { entry: u(0x10), gp: u(0x14), load: u(0x18), size, stack: u(0x30) + u(0x34), region, marker };
}

// ---- Disc builder ----

const SECTOR = 2352;

// CD-ROM EDC (CRC32, reversed poly 0xD8018001) and ECC (Reed-Solomon P/Q over GF(2^8)).
const EDC = new Uint32Array(256);
const ECC_F = new Uint8Array(256), ECC_B = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  let e = i;
  for (let k = 0; k < 8; k++) e = (e >>> 1) ^ (e & 1 ? 0xd8018001 : 0);
  EDC[i] = e >>> 0;
  const j = (i << 1) ^ (i & 0x80 ? 0x11d : 0);
  ECC_F[i] = j & 0xff;
  ECC_B[i ^ j] = i;
}
function edc(buf, start, len) {
  let e = 0;
  for (let i = start; i < start + len; i++) e = (e >>> 8) ^ EDC[(e ^ buf[i]) & 0xff];
  return e >>> 0;
}
function eccPart(sec, majorCount, minorCount, majorMult, minorInc, dest) {
  const size = majorCount * minorCount;
  for (let major = 0; major < majorCount; major++) {
    let index = (major >> 1) * majorMult + (major & 1);
    let a = 0, b = 0;
    for (let minor = 0; minor < minorCount; minor++) {
      const t = sec[0xc + index];
      index += minorInc;
      if (index >= size) index -= size;
      a ^= t; b ^= t; a = ECC_F[a];
    }
    a = ECC_B[ECC_F[a] ^ b];
    sec[dest + major] = a;
    sec[dest + major + majorCount] = a ^ b;
  }
}
/** Fill a Mode 2 Form 1 sector: sync, header (MSF), subheader, data, EDC, ECC. */
function form1Sector(lba, data, { eof = false, eor = false } = {}) {
  const s = Buffer.alloc(SECTOR);
  s.fill(0xff, 1, 11);
  const msf = lba + 150, bcd = (v) => ((v / 10) | 0) * 16 + (v % 10);
  s[12] = bcd((msf / 4500) | 0); s[13] = bcd(((msf / 75) | 0) % 60); s[14] = bcd(msf % 75); s[15] = 2;
  const sub = (eof ? 0x80 : 0) | (eor || eof ? 0x01 : 0) | 0x08; // data
  s[16] = s[20] = 0; s[17] = s[21] = 0; s[18] = s[22] = sub; s[19] = s[23] = 0;
  data.copy(s, 24, 0, Math.min(2048, data.length));
  s.writeUInt32LE(edc(s, 16, 2048 + 8), 2072);
  // ECC is computed with the header zeroed (Mode 2).
  const hdr = s.subarray(12, 16).toString('latin1');
  s.fill(0, 12, 16);
  eccPart(s, 86, 24, 2, 86, 2076);
  eccPart(s, 52, 43, 86, 88, 2076 + 172);
  s.write(hdr, 12, 'latin1');
  return s;
}

const both16 = (b, o, v) => { b.writeUInt16LE(v, o); b.writeUInt16BE(v, o + 2); };
const both32 = (b, o, v) => { b.writeUInt32LE(v, o); b.writeUInt32BE(v, o + 4); };
function dirRecord(name, lba, size, isDir) {
  const id = Buffer.from(name, 'latin1');
  const len = 33 + id.length + (id.length % 2 ? 0 : 1);
  const r = Buffer.alloc(len);
  r[0] = len;
  both32(r, 2, lba); both32(r, 10, size);
  r.set([125, 1, 1, 0, 0, 0, 0], 18); // 2025-01-01, a fixed date: identical images every build
  r[25] = isDir ? 2 : 0;
  both16(r, 28, 1);
  r[32] = id.length;
  id.copy(r, 33);
  return r;
}

/** Build a bootable disc from a PS-EXE: SYSTEM.CNF + the EXE + `files`
 *  ({ "DATA.BIN": Buffer }), in an ISO 9660 filesystem on one Mode 2 track.
 *  Writes `<out>.bin` and `<out>.cue`; returns their paths.
 *  @param {{ exe: Buffer, out: string, label?: string, exeName?: string, files?: Record<string, Buffer> }} o */
export async function makeDisc({ exe, out, label = 'PS1TEST', exeName = 'MAIN.EXE', files = {} }) {
  const info = exeInfo(exe);
  exeName = exeName.toUpperCase();
  const cnf = Buffer.from(`BOOT = cdrom:\\${exeName};1\r\nTCB = 4\r\nEVENT = 16\r\nSTACK = ${'801FFFF0'}\r\n`, 'latin1');
  /** @type {Array<[string, Buffer]>} */
  const entries = [['SYSTEM.CNF', cnf], [exeName, exe], ...Object.entries(files).map(([k, v]) => /** @type {[string, Buffer]} */ ([k.toUpperCase(), v]))];
  for (const [n] of entries) if (!/^[A-Z0-9_]{1,8}(\.[A-Z0-9_]{0,3})?$/.test(n)) throw new Error(`disc file name "${n}" must be 8.3 upper case`);
  // Layout: 0-15 system area (license sectors left blank), 16 PVD, 17 terminator,
  // 18-19 path tables (L, M), 20 root directory, then files.
  const ROOT_LBA = 22;
  let lba = ROOT_LBA + 1;
  const placed = entries.map(([n, d]) => { const e = { name: n + ';1', data: d, lba }; lba += Math.max(1, Math.ceil(d.length / 2048)); return e; });
  const total = lba + 150; // + a postgap so the last file isn't at the very end
  const root = Buffer.alloc(2048);
  let o = 0;
  for (const rec of [dirRecord('\0', ROOT_LBA, 2048, true), dirRecord('\x01', ROOT_LBA, 2048, true), ...placed.map((e) => dirRecord(e.name, e.lba, e.data.length, false))]) {
    rec.copy(root, o); o += rec.length;
  }
  const pt = (be) => {
    const t = Buffer.alloc(2048);
    t[0] = 1;
    if (be) t.writeUInt32BE(ROOT_LBA, 2); else t.writeUInt32LE(ROOT_LBA, 2);
    if (be) t.writeUInt16BE(1, 6); else t.writeUInt16LE(1, 6);
    return t;
  };
  const pvd = Buffer.alloc(2048, 0);
  pvd[0] = 1; pvd.write('CD001', 1, 'latin1'); pvd[6] = 1;
  pvd.write('PLAYSTATION'.padEnd(32), 8, 'latin1');
  pvd.write(label.toUpperCase().slice(0, 32).padEnd(32), 40, 'latin1');
  both32(pvd, 80, total);
  both16(pvd, 120, 1); both16(pvd, 124, 1); both16(pvd, 128, 2048);
  both32(pvd, 132, 10);
  pvd.writeUInt32LE(18, 140); pvd.writeUInt32BE(19, 148);
  dirRecord('\0', ROOT_LBA, 2048, true).copy(pvd, 156);
  for (const off of [190, 318, 446, 574]) pvd.write(''.padEnd(128), off, 'latin1');
  pvd.write('SCEA'.padEnd(128), 318, 'latin1');
  for (const off of [702, 739, 776]) pvd.write(''.padEnd(37), off, 'latin1');
  for (const off of [813, 830, 847, 864]) pvd.write('0000000000000000', off, 'latin1');
  pvd[881] = 1;
  pvd.write('CD-XA001', 1024, 'latin1');
  const term = Buffer.alloc(2048); term[0] = 255; term.write('CD001', 1, 'latin1'); term[6] = 1;

  const sectors = [];
  for (let i = 0; i < 16; i++) sectors.push(form1Sector(i, Buffer.alloc(0)));
  sectors.push(form1Sector(16, pvd, { eor: true }), form1Sector(17, term, { eof: true }));
  sectors.push(form1Sector(18, pt(false)), form1Sector(19, pt(true)));
  sectors.push(form1Sector(20, Buffer.alloc(0)), form1Sector(21, Buffer.alloc(0)));
  sectors.push(form1Sector(ROOT_LBA, root, { eof: true }));
  for (const e of placed) {
    const n = Math.max(1, Math.ceil(e.data.length / 2048));
    for (let i = 0; i < n; i++) sectors.push(form1Sector(e.lba + i, e.data.subarray(i * 2048, i * 2048 + 2048), { eof: i === n - 1 }));
  }
  while (sectors.length < total) sectors.push(form1Sector(sectors.length, Buffer.alloc(0)));
  const bin = out.replace(/\.(bin|cue)$/i, '') + '.bin', cue = bin.replace(/\.bin$/, '.cue');
  await writeFile(bin, Buffer.concat(sectors));
  await writeFile(cue, `FILE "${path.basename(bin)}" BINARY\r\n  TRACK 01 MODE2/2352\r\n    INDEX 01 00:00:00\r\n`);
  return { bin, cue, exe: info };
}

// ---- Reading discs ----

/** The data of a 2048-byte sector of an image (Mode 1/2 2352-byte or 2048-byte). */
function sectorReader(img) {
  const raw = img.length % 2352 === 0 && img.length >= 17 * 2352;
  const mode2 = raw && img[16 * 2352 + 15] === 2;
  return (lba) => raw ? img.subarray(lba * 2352 + (mode2 ? 24 : 16), lba * 2352 + (mode2 ? 24 : 16) + 2048) : img.subarray(lba * 2048, lba * 2048 + 2048);
}

/** The data track of a disc (a .cue's first BINARY file, or the image itself). */
export async function dataTrack(absRom) {
  if (/\.cue$/i.test(absRom)) {
    const cue = await readFile(absRom, 'utf8');
    const m = /^\s*FILE\s+(?:"([^"]+)"|(\S+))/im.exec(cue);
    if (!m) throw new Error(`${path.basename(absRom)} names no FILE`);
    return readFile(path.resolve(path.dirname(absRom), m[1] ?? m[2]));
  }
  return readFile(absRom);
}

/** A file from an ISO 9660 image's root (or a path like "DIR/FILE.EXE"), or null. */
export function isoFile(img, name) {
  const sec = sectorReader(img);
  const pvd = sec(16);
  if (pvd.toString('latin1', 1, 6) !== 'CD001') return null;
  let lba = pvd.readUInt32LE(156 + 2), size = pvd.readUInt32LE(156 + 10);
  const parts = name.toUpperCase().replace(/^[\\/]+/, '').split(/[\\/]/);
  for (let pi = 0; pi < parts.length; pi++) {
    const want = parts[pi].replace(/;1$/, '');
    let found = null;
    for (let s = 0; s < Math.ceil(size / 2048) && !found; s++) {
      const d = sec(lba + s);
      for (let o = 0; o < 2048 && d[o];) {
        const len = d[o], nl = d[o + 32];
        const n = d.toString('latin1', o + 33, o + 33 + nl).replace(/;1$/, '');
        if (n.toUpperCase() === want) found = { lba: d.readUInt32LE(o + 2), size: d.readUInt32LE(o + 10), dir: !!(d[o + 25] & 2) };
        o += len;
      }
    }
    if (!found) return null;
    ({ lba, size } = found);
    if (pi === parts.length - 1) {
      if (found.dir) return null;
      const out = Buffer.alloc(size);
      for (let s = 0; s * 2048 < size; s++) sec(lba + s).copy(out, s * 2048, 0, Math.min(2048, size - s * 2048));
      return out;
    }
  }
  return null;
}

/** Every file and directory of a disc's ISO9660 file system:
 *  [{ path, lba, size, dir }] (sectors from the start of the data track), plus
 *  the volume descriptor, path tables and root directory (system: true). */
export function isoList(img) {
  const sec = sectorReader(img);
  const pvd = sec(16);
  if (pvd.toString('latin1', 1, 6) !== 'CD001') return [];
  const out = [], seen = new Set();
  const walk = (lba, size, prefix) => {
    if (seen.has(lba) || seen.size > 4096) return;
    seen.add(lba);
    for (let s = 0; s < Math.ceil(size / 2048); s++) {
      const d = sec(lba + s);
      for (let o = 0; o < 2048 && d[o];) {
        const len = d[o], nl = d[o + 32];
        const name = d.toString('latin1', o + 33, o + 33 + nl).replace(/;1$/, '');
        const e = { lba: d.readUInt32LE(o + 2), size: d.readUInt32LE(o + 10), dir: !!(d[o + 25] & 2) };
        if (nl !== 1 || (d[o + 33] !== 0 && d[o + 33] !== 1)) {   // skip "." and ".."
          const path = prefix + name;
          out.push({ path, ...e });
          if (e.dir) walk(e.lba, e.size, path + '/');
        }
        o += len;
      }
    }
  };
  const root = pvd.readUInt32LE(156 + 2);
  walk(root, pvd.readUInt32LE(156 + 10), '/');
  // The file system's own sectors, so reads of them can be named too.
  const ptSize = pvd.readUInt32LE(132);
  out.push({ path: '(volume descriptor)', lba: 16, size: 2048, dir: false, system: true },
    { path: '(path table)', lba: pvd.readUInt32LE(140), size: ptSize, dir: false, system: true },
    { path: '(path table, big-endian)', lba: pvd.readUInt32BE(148), size: ptSize, dir: false, system: true },
    { path: '/ (root directory)', lba: root, size: pvd.readUInt32LE(156 + 10), dir: true, system: true });
  return out;
}

/** SYSTEM.CNF of a disc → { boot, tcb, event, stack, raw } (null if missing). */
export function systemCnf(img) {
  const f = isoFile(img, 'SYSTEM.CNF');
  if (!f) return null;
  const raw = f.toString('latin1');
  const get = (k) => new RegExp(`^\\s*${k}\\s*=\\s*(\\S+)`, 'im').exec(raw)?.[1] ?? null;
  return { boot: get('BOOT'), tcb: get('TCB'), event: get('EVENT'), stack: get('STACK'), raw };
}
