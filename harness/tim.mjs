// PNG ↔ TIM, the PS1's texture file format (what PSn00bSDK's GetTimInfo /
// LoadImage and the Sony libraries load).
//
// A TIM is: u32 0x10, u32 flags (bits 0-1 depth: 0 = 4-bit, 1 = 8-bit, 2 = 16-bit;
// bit 3 = has a CLUT), then [CLUT block] and the pixel block, each
// u32 length, u16 x, y, w, h (VRAM position and size in 16-bit units) + data.
//
// Colours are 15-bit BGR with a "semi-transparency" bit 15. A pixel of value 0 is
// transparent on the GPU, so opaque black must be stored as 0x8000 (black with the
// STP bit) or it disappears; convertTim does that unless told otherwise.

import { decodePng, encodePng, scalePng } from './png.mjs';
import { medianCut } from './recording.mjs';

const DEPTH_BITS = { 4: 0, 8: 1, 16: 2 };

/** RGBA → 15-bit PS1 colour (0 for transparent). */
function to15(r, g, b, a, { blackStp = true } = {}) {
  if (a < 128) return 0;
  const c = (r >> 3) | ((g >> 3) << 5) | ((b >> 3) << 10);
  return c === 0 && blackStp ? 0x8000 : c;
}
const from15 = (c) => [(c & 31) * 255 / 31 | 0, ((c >>> 5) & 31) * 255 / 31 | 0, ((c >>> 10) & 31) * 255 / 31 | 0, c === 0 ? 0 : 255];

/** Read a PNG as RGBA. */
export function pngRgba(buf) {
  const img = decodePng(buf);
  const n = img.width * img.height, out = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const c = img.channels;
    out[i * 4] = img.data[i * c];
    out[i * 4 + 1] = img.data[i * c + (c >= 3 ? 1 : 0)];
    out[i * 4 + 2] = img.data[i * c + (c >= 3 ? 2 : 0)];
    out[i * 4 + 3] = c === 4 ? img.data[i * c + 3] : c === 2 ? img.data[i * c + 1] : 255;
  }
  return { width: img.width, height: img.height, rgba: out };
}

/**
 * Convert a PNG to a TIM.
 * @param {Buffer} png
 * @param {{ depth?: 4 | 8 | 16, x?: number, y?: number, clutX?: number, clutY?: number,
 *   transparent?: string, blackStp?: boolean, quantize?: boolean }} [opts]
 *   x, y: VRAM position of the pixels (x in VRAM 16-bit units); clutX/clutY: of
 *   the CLUT (clutX a multiple of 16). transparent: "alpha" (default) or "#rrggbb".
 * @returns {{ tim: Buffer, width: number, height: number, colors: number, depth: number,
 *   vram: { x: number, y: number, w: number, h: number }, clut: { x: number, y: number } | null,
 *   preview: Buffer, warnings: string[] }}
 */
export function convertTim(png, { depth = 4, x = 640, y = 0, clutX = 640, clutY = 480, transparent = 'alpha', blackStp = true, quantize = false } = {}) {
  if (!(depth in DEPTH_BITS)) throw new Error('depth must be 4, 8 or 16');
  const { width, height, rgba } = pngRgba(png);
  const warnings = [];
  const key = /^#?([0-9a-f]{6})$/i.exec(transparent)?.[1];
  if (key) {
    const k = parseInt(key, 16);
    for (let i = 0; i < width * height; i++) if (((rgba[i * 4] << 16) | (rgba[i * 4 + 1] << 8) | rgba[i * 4 + 2]) === k) rgba[i * 4 + 3] = 0;
  }
  const px = Array.from({ length: width * height }, (_, i) => to15(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2], rgba[i * 4 + 3], { blackStp }));
  const perWord = depth === 4 ? 4 : depth === 8 ? 2 : 1;
  if (width % perWord) throw new Error(`a ${depth}-bit TIM's width must be a multiple of ${perWord} pixels (this PNG is ${width})`);
  if (x % 1 || x < 0 || x > 1023 || y < 0 || y > 511) throw new Error('x/y must be inside VRAM (0-1023, 0-511)');
  const vram = { x, y, w: width / perWord, h: height };
  if (x + vram.w > 1024 || y + height > 512) throw new Error(`the image (${vram.w}x${vram.h} VRAM words) doesn't fit at ${x},${y}`);
  if (Math.floor(x / 64) !== Math.floor((x + vram.w - 1) / 64)) warnings.push(`the image crosses a 64-word texture page boundary at x=${(Math.floor(x / 64) + 1) * 64}: a single primitive can't sample all of it`);
  if (y < 256 && y + height > 256) warnings.push('the image crosses the y=256 texture page boundary');

  let indices = null, palette = null;
  if (depth !== 16) {
    const max = depth === 4 ? 16 : 256;
    const opaque = [...new Set(px.filter((c) => c !== 0))];
    const needTransparent = px.some((c) => c === 0);
    let colours = opaque;
    if (opaque.length + (needTransparent ? 1 : 0) > max) {
      if (!quantize) throw new Error(`${opaque.length} colours don't fit a ${depth}-bit CLUT (${max}${needTransparent ? ', one of them transparent' : ''}); pass quantize: true, or use depth 16`);
      const rgb = new Uint8Array(opaque.length * 3);
      opaque.forEach((c, i) => { const [r, g, b] = from15(c); rgb.set([r, g, b], i * 3); });
      colours = [...new Set(medianCut(rgb, max - (needTransparent ? 1 : 0)).map((v) => to15(v >>> 16, (v >>> 8) & 255, v & 255, 255, { blackStp })))];
      warnings.push(`quantized ${opaque.length} colours to ${colours.length}`);
    }
    palette = [...(needTransparent ? [0] : []), ...colours];
    const near = (c) => {
      if (c === 0) return 0;
      let best = needTransparent ? 1 : 0, bd = Infinity;
      const [r, g, b] = from15(c);
      for (let i = needTransparent ? 1 : 0; i < palette.length; i++) {
        const [r2, g2, b2] = from15(palette[i]);
        const d = (r - r2) ** 2 + (g - g2) ** 2 + (b - b2) ** 2;
        if (d < bd) { bd = d; best = i; }
      }
      return best;
    };
    const lut = new Map();
    indices = px.map((c) => { if (!lut.has(c)) lut.set(c, palette.indexOf(c) >= 0 ? palette.indexOf(c) : near(c)); return lut.get(c); });
    while (palette.length < max) palette.push(0);
    if (clutX % 16) throw new Error('clutX must be a multiple of 16');
    if (clutX + max > 1024 || clutY > 511) throw new Error(`the CLUT (${max} entries) doesn't fit at ${clutX},${clutY}`);
  }

  const parts = [];
  const head = Buffer.alloc(8);
  head.writeUInt32LE(0x10, 0);
  head.writeUInt32LE(DEPTH_BITS[depth] | (palette ? 8 : 0), 4);
  parts.push(head);
  if (palette) {
    const b = Buffer.alloc(12 + palette.length * 2);
    b.writeUInt32LE(b.length, 0);
    b.writeUInt16LE(clutX, 4); b.writeUInt16LE(clutY, 6); b.writeUInt16LE(palette.length, 8); b.writeUInt16LE(1, 10);
    palette.forEach((c, i) => b.writeUInt16LE(c, 12 + i * 2));
    parts.push(b);
  }
  const data = Buffer.alloc(vram.w * vram.h * 2);
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const p = j * width + i;
      if (depth === 16) data.writeUInt16LE(px[p], p * 2);
      else if (depth === 8) data[p] = indices[p];
      else data[p >> 1] |= indices[p] << ((p & 1) * 4);
    }
  }
  const img = Buffer.alloc(12);
  img.writeUInt32LE(12 + data.length, 0);
  img.writeUInt16LE(vram.x, 4); img.writeUInt16LE(vram.y, 6); img.writeUInt16LE(vram.w, 8); img.writeUInt16LE(vram.h, 10);
  parts.push(img, data);
  const tim = Buffer.concat(parts);
  return {
    tim, width, height, depth, vram, clut: palette ? { x: clutX, y: clutY } : null,
    colors: palette ? palette.filter((c, i) => c !== 0 || i === 0).length : new Set(px).size,
    preview: timToPng(tim), warnings,
  };
}

/** Parse a TIM → { depth, clut: { x, y, w, h, colors } | null, image: { x, y, w, h, data }, width, height }. */
export function readTim(buf) {
  if (buf.readUInt32LE(0) !== 0x10) throw new Error('not a TIM (no 0x10 magic)');
  const flags = buf.readUInt32LE(4);
  const depth = [4, 8, 16, 24][flags & 3];
  let o = 8, clut = null;
  if (flags & 8) {
    const len = buf.readUInt32LE(o);
    const w = buf.readUInt16LE(o + 8), h = buf.readUInt16LE(o + 10);
    clut = { x: buf.readUInt16LE(o + 4), y: buf.readUInt16LE(o + 6), w, h, colors: Array.from({ length: w * h }, (_, i) => buf.readUInt16LE(o + 12 + i * 2)) };
    o += len;
  }
  const image = { x: buf.readUInt16LE(o + 4), y: buf.readUInt16LE(o + 6), w: buf.readUInt16LE(o + 8), h: buf.readUInt16LE(o + 10), data: buf.subarray(o + 12, o + buf.readUInt32LE(o)) };
  const width = depth === 4 ? image.w * 4 : depth === 8 ? image.w * 2 : depth === 16 ? image.w : image.w * 2 / 3;
  return { depth, clut, image, width, height: image.h };
}

/** A TIM rendered as a PNG (first CLUT row for 4/8-bit). */
export function timToPng(buf, scale = 1) {
  const t = readTim(buf);
  const out = new Uint8Array(t.width * t.height * 4);
  for (let p = 0; p < t.width * t.height; p++) {
    let c;
    if (t.depth === 16) c = t.image.data.readUInt16LE(p * 2);
    else if (t.depth === 8) c = t.clut.colors[t.image.data[p]];
    else if (t.depth === 4) c = t.clut.colors[(t.image.data[p >> 1] >>> ((p & 1) * 4)) & 15];
    else { out.set([t.image.data[p * 3], t.image.data[p * 3 + 1], t.image.data[p * 3 + 2], 255], p * 4); continue; }
    out.set(from15(c), p * 4);
  }
  return scalePng(encodePng({ width: t.width, height: t.height, channels: 4, data: out }), scale);
}

/** C source declaring a TIM as an array (for projects without a CD file system). */
export function timToC(buf, name) {
  const words = [];
  const padded = Buffer.concat([buf, Buffer.alloc((4 - (buf.length % 4)) % 4)]);
  for (let i = 0; i < padded.length; i += 4) words.push('0x' + padded.readUInt32LE(i).toString(16).padStart(8, '0'));
  const lines = [];
  for (let i = 0; i < words.length; i += 8) lines.push('\t' + words.slice(i, i + 8).join(', ') + ',');
  return `/* ${name}: generated by ps1-test (TIM, ${buf.length} bytes) */\n#include <stdint.h>\n\nconst uint32_t ${name}[] = {\n${lines.join('\n')}\n};\n`;
}
