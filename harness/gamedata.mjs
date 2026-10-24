// Game data generators for PS1 projects:
// - sound: WAV → VAG (the SPU's 4-bit ADPCM, with loop points), and back.
// - tables: fixed-point sine/cosine/reciprocal lookup tables (4096 = 1.0, as
//   PSn00bSDK's ONE and the GTE use).
// - mesh: Wavefront OBJ → fixed-point vertex / normal / face arrays for the GTE.

import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

// ---- WAV ----

/** Parse a WAV file (PCM 8/16/24/32-bit, float, extensible) → { rate, channels, samples: Float32Array mono -1..1 }. */
export function decodeWav(buf) {
  if (buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') throw new Error('not a WAV file (RIFF/WAVE header missing)');
  let fmt = null, data = null;
  for (let p = 12; p + 8 <= buf.length;) {
    const id = buf.toString('latin1', p, p + 4), size = buf.readUInt32LE(p + 4);
    if (id === 'fmt ') fmt = buf.subarray(p + 8, p + 8 + size);
    else if (id === 'data') data = buf.subarray(p + 8, Math.min(buf.length, p + 8 + size));
    p += 8 + size + (size & 1);
  }
  if (!fmt || !data) throw new Error('WAV has no fmt or data chunk');
  let format = fmt.readUInt16LE(0);
  const channels = fmt.readUInt16LE(2), rate = fmt.readUInt32LE(4), bits = fmt.readUInt16LE(14);
  if (format === 0xfffe) format = fmt.readUInt16LE(24); // extensible: sub-format GUID starts with the format tag
  const bytes = bits / 8, frames = Math.floor(data.length / (bytes * channels));
  const read = format === 3
    ? (o) => (bits === 64 ? data.readDoubleLE(o) : data.readFloatLE(o))
    : bits === 8 ? (o) => (data[o] - 128) / 128
      : bits === 16 ? (o) => data.readInt16LE(o) / 32768
        : bits === 24 ? (o) => data.readIntLE(o, 3) / 8388608
          : bits === 32 ? (o) => data.readInt32LE(o) / 2147483648 : null;
  if ((format !== 1 && format !== 3) || !read) throw new Error(`unsupported WAV encoding (format ${format}, ${bits}-bit); use PCM or float`);
  const samples = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let v = 0;
    for (let c = 0; c < channels; c++) v += read((i * channels + c) * bytes);
    samples[i] = v / channels;
  }
  return { rate, channels, samples };
}

/** Linear resampling. */
export function resample(samples, from, to) {
  if (from === to) return samples;
  const n = Math.max(1, Math.round(samples.length * to / from)), out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = i * from / to, j = Math.floor(x), f = x - j;
    out[i] = (samples[j] ?? 0) * (1 - f) + (samples[j + 1] ?? samples[j] ?? 0) * f;
  }
  return out;
}

/** 16-bit mono WAV of `pcm` (Int16Array). */
export function encodeWav16(pcm, rate) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'latin1'); h.writeUInt32LE(36 + pcm.length * 2, 4); h.write('WAVE', 8, 'latin1');
  h.write('fmt ', 12, 'latin1'); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36, 'latin1'); h.writeUInt32LE(pcm.length * 2, 40);
  return Buffer.concat([h, Buffer.from(pcm.buffer, pcm.byteOffset, pcm.length * 2)]);
}

// ---- SPU ADPCM (VAG) ----

const F0 = [0, 60, 115, 98, 122], F1 = [0, 0, -52, -55, -60];
const clamp16 = (v) => (v > 32767 ? 32767 : v < -32768 ? -32768 : v);

/** Encode one 28-sample block (Int16 values) with the best filter/shift, given
 *  the decoder's history [s1, s2]. → { bytes: Buffer(16), s1, s2 } */
function encodeBlock(x, s1, s2, flags) {
  let best = null;
  for (let f = 0; f < 5; f++) {
    for (let shift = 0; shift <= 12; shift++) {
      const step = 2 ** (12 - shift);
      let a = s1, b = s2, err = 0;
      const nib = new Int8Array(28);
      for (let i = 0; i < 28; i++) {
        const pred = (a * F0[f] + b * F1[f] + 32) >> 6;
        let n = Math.round((x[i] - pred) / step);
        n = n > 7 ? 7 : n < -8 ? -8 : n;
        const out = clamp16(n * step + pred);
        err += (x[i] - out) ** 2;
        if (best && err >= best.err) break;
        nib[i] = n; b = a; a = out;
      }
      if (!best || err < best.err) best = { err, f, shift, nib, s1: a, s2: b };
    }
  }
  const bytes = Buffer.alloc(16);
  bytes[0] = (best.f << 4) | best.shift;
  bytes[1] = flags;
  for (let i = 0; i < 14; i++) bytes[2 + i] = (best.nib[i * 2] & 15) | ((best.nib[i * 2 + 1] & 15) << 4);
  return { bytes, s1: best.s1, s2: best.s2 };
}

/**
 * WAV → SPU ADPCM. Options: rate (default 22050, or the WAV's), loop (loop the
 * whole sound, or from `loopStart` seconds), normalize.
 * @returns {{ adpcm: Buffer, rate: number, samples: number, seconds: number, blocks: number,
 *   loop: boolean, pitch: number, peak: number, clipped: number, sourceRate: number, channels: number }}
 *   `pitch` is the SPU voice pitch register value for `rate` (0x1000 = 44100 Hz).
 */
export function encodeVag(wav, { rate = 22050, loop = false, loopStart = 0, normalize = false } = {}) {
  const src = decodeWav(wav);
  let s = resample(src.samples, src.rate, rate);
  let peak = 0;
  for (const v of s) peak = Math.max(peak, Math.abs(v));
  if (normalize && peak > 0) { s = s.map((v) => v / peak * 0.98); peak = 0.98; }
  let clipped = 0;
  const pcm = Int16Array.from(s, (v) => { const q = Math.round(v * 32767); if (q > 32767 || q < -32768) clipped++; return clamp16(q); });
  const blocks = Math.max(1, Math.ceil(pcm.length / 28));
  const loopBlock = loop ? Math.min(blocks - 1, Math.floor(loopStart * rate / 28)) : -1;
  const out = [Buffer.alloc(16)]; // a leading silent block, as VAG files have
  let s1 = 0, s2 = 0;
  for (let b = 0; b < blocks; b++) {
    const x = new Int16Array(28);
    x.set(pcm.subarray(b * 28, b * 28 + 28));
    // Flags: bit 0 loop end (jump to the loop address), bit 1 repeat (keep
    // playing; without it the voice is released), bit 2 loop start.
    let flags = 0;
    if (b === loopBlock) flags |= 4;
    if (b === blocks - 1) flags |= loop ? 3 : 1;
    const e = encodeBlock(x, s1, s2, flags);
    out.push(e.bytes); s1 = e.s1; s2 = e.s2;
  }
  const adpcm = Buffer.concat(out);
  return { adpcm, rate, samples: pcm.length, seconds: pcm.length / rate, blocks, loop, pitch: Math.round(rate * 4096 / 44100), peak, clipped, sourceRate: src.rate, channels: src.channels };
}

/** SPU ADPCM → Int16Array (one pass, stops at the first end flag). */
export function decodeAdpcm(adpcm) {
  const out = [];
  let s1 = 0, s2 = 0;
  for (let o = 0; o + 16 <= adpcm.length; o += 16) {
    const f = (adpcm[o] >> 4) & 7, shift = adpcm[o] & 15, flags = adpcm[o + 1];
    for (let i = 0; i < 28; i++) {
      const byte = adpcm[o + 2 + (i >> 1)];
      const n = ((i & 1 ? byte >> 4 : byte & 15) << 28) >> 28;
      const v = clamp16(((n << 12) >> shift) + ((s1 * (F0[f] ?? 0) + s2 * (F1[f] ?? 0) + 32) >> 6));
      out.push(v); s2 = s1; s1 = v;
    }
    if (flags & 1) break;
  }
  return Int16Array.from(out);
}

/** A .vag file: 48-byte header (big-endian) + the ADPCM data. */
export function vagFile(conv, name = 'sound') {
  const h = Buffer.alloc(48);
  h.write('VAGp', 0, 'latin1');
  h.writeUInt32BE(0x20, 4);
  h.writeUInt32BE(conv.adpcm.length, 12);
  h.writeUInt32BE(conv.rate, 16);
  h.write(name.slice(0, 16), 32, 'latin1');
  return Buffer.concat([h, conv.adpcm]);
}

/** Read a .vag → { rate, name, adpcm }. */
export function readVag(buf) {
  if (buf.toString('latin1', 0, 4) !== 'VAGp') throw new Error('not a VAG file');
  const size = buf.readUInt32BE(12);
  return { rate: buf.readUInt32BE(16), name: buf.toString('latin1', 32, 48).replace(/\0.*$/s, ''), adpcm: buf.subarray(48, 48 + size) };
}

const list = (vals, perLine, fmt) => {
  const out = [];
  for (let i = 0; i < vals.length; i += perLine) out.push('\t' + vals.slice(i, i + perLine).map(fmt).join(', '));
  return out.join(',\n');
};
const cid = (name) => name.replace(/\W/g, '_');

/** Write a converted sound: .vag (with header), .bin (raw ADPCM), .wav (the
 *  decoded result, to listen to), or .c (+ .h) / .h arrays. */
export async function writeSound(conv, file, name) {
  const id = cid(name), ID = id.toUpperCase(), ext = path.extname(file).toLowerCase();
  await mkdir(path.dirname(path.resolve(file)), { recursive: true });
  if (ext === '.vag') { await writeFile(file, vagFile(conv, name)); return [file]; }
  if (ext === '.bin') { await writeFile(file, conv.adpcm); return [file]; }
  if (ext === '.wav') { await writeFile(file, encodeWav16(decodeAdpcm(conv.adpcm), conv.rate)); return [file]; }
  const info = `${conv.samples} samples, ${conv.seconds.toFixed(2)} s at ${conv.rate} Hz, SPU ADPCM${conv.loop ? ', looping' : ''}`;
  const defs = [`#define ${ID}_SIZE ${conv.adpcm.length} /* bytes, a multiple of 16 */`, `#define ${ID}_RATE ${conv.rate}`, `#define ${ID}_PITCH 0x${conv.pitch.toString(16)} /* SPU voice pitch for ${conv.rate} Hz */`];
  const body = list([...conv.adpcm], 16, (v) => '0x' + v.toString(16).padStart(2, '0'));
  const decl = `const unsigned char ${id}[${conv.adpcm.length}] __attribute__((aligned(4)))`;
  if (ext === '.h') {
    await writeFile(file, [`/* ${info} */`, `#ifndef ${ID}_VAG_H`, `#define ${ID}_VAG_H`, ...defs, `static ${decl} = {\n${body}\n};`, '#endif', ''].join('\n'));
    return [file];
  }
  if (ext === '.c') {
    const h = file.replace(/\.c$/i, '.h');
    await writeFile(h, [`/* ${info} */`, `#ifndef ${ID}_VAG_H`, `#define ${ID}_VAG_H`, ...defs, `extern ${decl.replace(' __attribute__((aligned(4)))', '')};`, '#endif', ''].join('\n'));
    await writeFile(file, [`/* ${info} */`, `#include "${path.basename(h)}"`, '', `${decl} = {\n${body}\n};`, ''].join('\n'));
    return [file, h];
  }
  throw new Error(`unknown sound output "${ext}" (use .vag, .bin, .wav, .c or .h)`);
}

// ---- Lookup tables ----

/** Fixed-point lookup table. kind sin/cos: `size` steps per turn (4096 = a full
 *  turn, as PSn00bSDK's angles), value × 2^bits; reciprocal: entry i = 2^bits / i. */
export function makeTable(kind, { size = 4096, bits = 12 } = {}) {
  const one = 2 ** bits;
  let values;
  if (kind === 'sin' || kind === 'cos') values = Array.from({ length: size }, (_, i) => Math.round((kind === 'sin' ? Math.sin : Math.cos)((2 * Math.PI * i) / size) * one));
  else if (kind === 'reciprocal') values = Array.from({ length: size }, (_, i) => (i ? Math.round(one / i) : 0));
  else throw new Error('table must be sin, cos or reciprocal');
  const min = Math.min(...values), max = Math.max(...values);
  const type = min >= 0 ? (max < 65536 ? 'uint16_t' : 'uint32_t') : (min >= -32768 && max < 32768 ? 'int16_t' : 'int32_t');
  return { kind, size, bits, values, type };
}

/** Write a lookup table as .c (+ .h) or .h. */
export async function writeTable(t, file, name) {
  const id = cid(name), ID = id.toUpperCase(), ext = path.extname(file).toLowerCase();
  await mkdir(path.dirname(path.resolve(file)), { recursive: true });
  const info = t.kind === 'reciprocal' ? `${id}[i] = 2^${t.bits} / i (i = 1..${t.size - 1})` : `${id}[i] = ${t.kind}(i * 2pi / ${t.size}) * 2^${t.bits}`;
  const defs = [`#define ${ID}_SIZE ${t.size}`, `#define ${ID}_SHIFT ${t.bits} /* fractional bits */`];
  const body = list(t.values, 12, String);
  const decl = `const ${t.type} ${id}[${t.size}]`;
  if (ext === '.h') {
    await writeFile(file, [`/* ${info} */`, `#ifndef ${ID}_LUT_H`, `#define ${ID}_LUT_H`, '#include <stdint.h>', ...defs, `static ${decl} = {\n${body}\n};`, '#endif', ''].join('\n'));
    return [file];
  }
  if (ext === '.c') {
    const h = file.replace(/\.c$/i, '.h');
    await writeFile(h, [`/* ${info} */`, `#ifndef ${ID}_LUT_H`, `#define ${ID}_LUT_H`, '#include <stdint.h>', ...defs, `extern ${decl};`, '#endif', ''].join('\n'));
    await writeFile(file, [`/* ${info} */`, `#include "${path.basename(h)}"`, '', `${decl} = {\n${body}\n};`, ''].join('\n'));
    return [file, h];
  }
  throw new Error(`unknown table output "${ext}" (use .c or .h)`);
}

// ---- Meshes ----

/**
 * Wavefront OBJ → fixed-point mesh for the GTE: vertices scaled so the model
 * spans ±`size` units (default 256) — or by `scale` — normals in 4096 units,
 * faces as triangles/quads (polygons with more sides are fanned into triangles).
 * Quads keep the GPU's vertex order (0, 1, 3, 2 → a Z shape: the OBJ's 4th vertex
 * becomes the 3rd).
 * @returns {{ verts: number[][], norms: number[][], uvs: number[][], faces: Array<{ v: number[], n: number[] | null, t: number[] | null }>,
 *   tris: number, quads: number, scale: number, bounds: number[][], warnings: string[] }}
 */
export function convertMesh(text, { size = 256, scale = null, flipY = true } = {}) {
  const v = [], vn = [], vt = [], faces = [], warnings = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const parts = line.split(/\s+/);
    if (parts[0] === 'v') v.push(parts.slice(1, 4).map(Number));
    else if (parts[0] === 'vn') vn.push(parts.slice(1, 4).map(Number));
    else if (parts[0] === 'vt') vt.push(parts.slice(1, 3).map(Number));
    else if (parts[0] === 'f') {
      const refs = parts.slice(1).map((p) => p.split('/').map((x) => (x === '' ? null : Number(x))));
      const idx = (x, n) => (x === null || x === undefined ? null : x < 0 ? n + x : x - 1);
      const vi = refs.map((r) => idx(r[0], v.length)), ti = refs.map((r) => idx(r[1], vt.length)), ni = refs.map((r) => idx(r[2], vn.length));
      const push = (ks) => faces.push({ v: ks.map((k) => vi[k]), t: ti.every((x) => x !== null) ? ks.map((k) => ti[k]) : null, n: ni.every((x) => x !== null) ? ks.map((k) => ni[k]) : null });
      if (refs.length === 3) push([0, 1, 2]);
      else if (refs.length === 4) push([0, 1, 3, 2]);
      else { for (let k = 1; k + 1 < refs.length; k++) push([0, k, k + 1]); warnings.push(`a ${refs.length}-sided face was split into triangles`); }
    }
  }
  if (!v.length) throw new Error('no vertices in the OBJ');
  const lo = [0, 1, 2].map((a) => Math.min(...v.map((p) => p[a]))), hi = [0, 1, 2].map((a) => Math.max(...v.map((p) => p[a])));
  const centre = lo.map((l, a) => (l + hi[a]) / 2);
  const extent = Math.max(...hi.map((h, a) => (h - lo[a]) / 2)) || 1;
  const k = scale ?? size / extent;
  const verts = v.map((p) => p.map((c, a) => Math.round((c - centre[a]) * k * (a === 1 && flipY ? -1 : 1))));
  if (verts.some((p) => p.some((c) => c > 32767 || c < -32768))) throw new Error('scaled vertices overflow 16 bits; use a smaller size/scale');
  const norms = vn.map((n) => { const l = Math.hypot(...n) || 1; return n.map((c, a) => Math.round(c / l * 4096 * (a === 1 && flipY ? -1 : 1))); });
  const uvs = vt.map(([u, w]) => [Math.round(u * 255), Math.round((1 - w) * 255)]);
  if (faces.length > 4096) warnings.push(`${faces.length} faces: heavy for the PS1 (a few hundred per model is typical)`);
  return { verts, norms, uvs, faces, tris: faces.filter((f) => f.v.length === 3).length, quads: faces.filter((f) => f.v.length === 4).length, scale: k, bounds: [lo, hi], warnings };
}

/** Write a mesh as .c (+ .h) or .h (PSn00bSDK SVECTOR arrays + face lists). */
export async function writeMesh(m, file, name) {
  const id = cid(name), ID = id.toUpperCase(), ext = path.extname(file).toLowerCase();
  await mkdir(path.dirname(path.resolve(file)), { recursive: true });
  const sv = (a) => a.map((p) => `\t{ ${p[0]}, ${p[1]}, ${p[2]}, 0 }`).join(',\n');
  const tris = m.faces.filter((f) => f.v.length === 3), quads = m.faces.filter((f) => f.v.length === 4);
  const face = (f) => `\t{ ${f.v.join(', ')}${f.n ? `, ${f.n[0]}` : ', 0'} }`;
  const defs = [`#define ${ID}_VERTS ${m.verts.length}`, `#define ${ID}_NORMS ${m.norms.length}`, `#define ${ID}_TRIS ${tris.length}`, `#define ${ID}_QUADS ${quads.length}`];
  const types = [`typedef struct { uint16_t v0, v1, v2, n; } ${id}_tri;`, `typedef struct { uint16_t v0, v1, v2, v3, n; } ${id}_quad; /* GPU order: v0 v1 v2 v3 form a Z */`];
  const arrays = [
    [`const SVECTOR ${id}_verts[${Math.max(1, m.verts.length)}]`, sv(m.verts.length ? m.verts : [[0, 0, 0]])],
    [`const SVECTOR ${id}_norms[${Math.max(1, m.norms.length)}]`, sv(m.norms.length ? m.norms : [[0, 0, 4096]])],
    [`const ${id}_tri ${id}_tris[${Math.max(1, tris.length)}]`, tris.length ? tris.map(face).join(',\n') : '\t{ 0 }'],
    [`const ${id}_quad ${id}_quads[${Math.max(1, quads.length)}]`, quads.length ? quads.map(face).join(',\n') : '\t{ 0 }'],
  ];
  const info = `${m.verts.length} vertices, ${tris.length} triangles, ${quads.length} quads (scale ${m.scale.toFixed(3)} units per OBJ unit)`;
  const head = [`/* ${info} */`, `#ifndef ${ID}_MESH_H`, `#define ${ID}_MESH_H`, '#include <stdint.h>', '#include <psxgte.h>', ...defs, ...types];
  if (ext === '.h') {
    await writeFile(file, [...head, ...arrays.map(([d, b]) => `static ${d} = {\n${b}\n};`), '#endif', ''].join('\n'));
    return [file];
  }
  if (ext === '.c') {
    const h = file.replace(/\.c$/i, '.h');
    await writeFile(h, [...head, ...arrays.map(([d]) => `extern ${d};`), '#endif', ''].join('\n'));
    await writeFile(file, [`/* ${info} */`, `#include "${path.basename(h)}"`, '', ...arrays.map(([d, b]) => `${d} = {\n${b}\n};\n`)].join('\n'));
    return [file, h];
  }
  throw new Error(`unknown mesh output "${ext}" (use .c or .h)`);
}
