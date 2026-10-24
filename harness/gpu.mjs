// The PS1 GPU from the harness's point of view: decode the instrumented core's
// command log into primitives, read the draw environment from a save state, and
// draw VRAM / frames with outlines for the gpu_capture and view_vram tools.
//
// GP0 reference: polygons 0x20-0x3F, lines 0x40-0x5F, rectangles 0x60-0x7F,
// fill 0x02, VRAM copies 0x80 / 0xA0 / 0xC0, environment 0xE1-0xE6.

import { VRAM_W, VRAM_H, display, vramRgba } from './psx-memory.mjs';
import { encodePng, scalePng } from './png.mjs';

const s11 = (v) => ((v & 0x7ff) ^ 0x400) - 0x400; // signed 11-bit coordinate
const xy = (w) => [s11(w), s11(w >>> 16)];
const rgb = (w) => [w & 0xff, (w >>> 8) & 0xff, (w >>> 16) & 0xff];
const DEPTHS = ['4bit', '8bit', '15bit', '15bit'];

/** E1 draw mode → texture page and flags. */
export function texpage(w) {
  return { x: (w & 0xf) * 64, y: ((w >>> 4) & 1) * 256, semi: (w >>> 5) & 3, depth: DEPTHS[(w >>> 7) & 3], dither: !!(w & 0x200), drawToDisplay: !!(w & 0x400) };
}
const clutOf = (w) => ({ x: ((w >>> 16) & 0x3f) * 16, y: (w >>> 22) & 0x1ff });

/** The draw environment from E1-E6 words (as gpulib keeps them). */
export function drawEnv(ex) {
  const e = (i) => ex[i] ?? 0;
  return {
    texpage: texpage(e(1)),
    drawArea: { x0: e(3) & 0x3ff, y0: (e(3) >>> 10) & 0x3ff, x1: e(4) & 0x3ff, y1: (e(4) >>> 10) & 0x3ff },
    offset: [s11(e(5)), s11(e(5) >>> 11)],
    texWindow: e(2) & 0xfffff,
    mask: e(6) & 3,
  };
}

/** The draw environment saved in a state (gpulib stores E0-E7 at control[0xE0]). */
export function stateDrawEnv(r) {
  return drawEnv(Array.from({ length: 8 }, (_, i) => r.gpuControl.readUInt32LE((0xe0 + i) * 4)));
}

/** Split the log (u32 words) into entries. */
export function logEntries(buf) {
  const out = [];
  for (let i = 0; i + 8 <= buf.length;) {
    const h = buf.readUInt32LE(i), n = h & 0xffffff;
    out.push({ type: h >>> 28, src: (h >>> 24) & 0xf, addr: buf.readUInt32LE(i + 4), words: Array.from({ length: n }, (_, k) => buf.readUInt32LE(i + 8 + k * 4)) });
    i += 8 + n * 4;
  }
  return out;
}

const SRC = ['cpu', 'dma', 'chain'];

/** Decode a frame's log into { prims, env, exceptions, gp1, chains, stats }.
 *  Each primitive: { n, cmd, kind, verts (VRAM coords, offset applied), color,
 *  gouraud, textured, semi, raw, texpage, clut, uv, addr (RAM address of its
 *  packet, or null), src, words }. `env` is the draw environment in force at the end. */
export function decodeLog(buf, startEx = []) {
  const ex = [...startEx];
  const prims = [], exceptions = [], gp1 = [], chains = [];
  // Flatten GP0 words with where they came from.
  const stream = [];
  for (const e of logEntries(buf)) {
    if (e.type === 1) e.words.forEach((w, k) => stream.push({ w, addr: e.src === 2 || e.addr ? (e.addr ? e.addr + (e.src === 2 ? 4 : 0) + k * 4 : null) : null, src: SRC[e.src] ?? 'cpu', head: k === 0 ? e.addr : null }));
    else if (e.type === 2) gp1.push(e.words[0]);
    else if (e.type === 3) chains.push(e.addr);
    else if (e.type === 4) exceptions.push({ cause: e.words[0], code: (e.words[0] >>> 2) & 0x1f, epc: e.words[1], badVaddr: e.words[2] });
  }
  let i = 0;
  const need = (n) => i + n <= stream.length;
  while (i < stream.length) {
    const first = stream[i], w0 = first.w, cmd = w0 >>> 24;
    const env = drawEnv(ex);
    const at = (k) => stream[i + k].w;
    const base = { n: prims.length, cmd, addr: first.addr, src: first.src };
    const off = (p) => [p[0] + env.offset[0], p[1] + env.offset[1]];
    if (cmd >= 0x20 && cmd < 0x40) {
      const quad = !!(cmd & 8), gouraud = !!(cmd & 0x10), textured = !!(cmd & 4);
      const nv = quad ? 4 : 3, per = 1 + (textured ? 1 : 0) + (gouraud ? 1 : 0);
      const len = 1 + nv * per - (gouraud ? 1 : 0);
      if (!need(len)) break;
      const verts = [], colors = [rgb(w0)], uv = [];
      let k = 1, tp = null, clut = null;
      for (let v = 0; v < nv; v++) {
        if (gouraud && v > 0) colors.push(rgb(at(k++)));
        verts.push(off(xy(at(k++))));
        if (textured) {
          const t = at(k++);
          uv.push([t & 0xff, (t >>> 8) & 0xff]);
          if (v === 0) clut = clutOf(t);
          if (v === 1) { tp = texpage(t >>> 16); ex[1] = (ex[1] & ~0x9ff) | ((t >>> 16) & 0x9ff); }
        }
      }
      prims.push({ ...base, kind: quad ? 'poly4' : 'poly3', verts, color: colors[0], ...(gouraud ? { colors } : {}), gouraud, textured, semi: !!(cmd & 2), raw: !!(cmd & 1), ...(textured ? { texpage: tp, clut: tp.depth === '15bit' ? null : clut, uv } : {}), words: len });
      i += len;
    } else if (cmd >= 0x40 && cmd < 0x60) {
      const poly = !!(cmd & 8), gouraud = !!(cmd & 0x10);
      const verts = [], colors = [rgb(w0)];
      let k = 1;
      if (!poly) {
        const len = gouraud ? 4 : 3;
        if (!need(len)) break;
        verts.push(off(xy(at(k++))));
        if (gouraud) colors.push(rgb(at(k++)));
        verts.push(off(xy(at(k++))));
        prims.push({ ...base, kind: 'line', verts, color: colors[0], gouraud, semi: !!(cmd & 2), words: len });
        i += len;
      } else {
        // Polyline: vertices (with colours if gouraud) until a 0x5xxx5xxx terminator.
        let ok = false;
        while (i + k < stream.length) {
          if (k > 1 && (at(k) & 0xf000f000) === 0x50005000) { ok = true; k++; break; }
          if (gouraud && verts.length) colors.push(rgb(at(k++)));
          if (i + k >= stream.length) break;
          verts.push(off(xy(at(k++))));
        }
        if (!ok) break;
        prims.push({ ...base, kind: 'polyline', verts, color: colors[0], gouraud, semi: !!(cmd & 2), words: k });
        i += k;
      }
    } else if (cmd >= 0x60 && cmd < 0x80) {
      const size = (cmd >>> 3) & 3, textured = !!(cmd & 4);
      const len = 2 + (textured ? 1 : 0) + (size === 0 ? 1 : 0);
      if (!need(len)) break;
      const p = off(xy(at(1)));
      let k = 2, uv = null, clut = null;
      if (textured) { const t = at(k++); uv = [[t & 0xff, (t >>> 8) & 0xff]]; clut = clutOf(t); }
      const [w, h] = size === 0 ? [at(k) & 0x3ff, (at(k) >>> 16) & 0x1ff] : [[0, 1, 8, 16][size], [0, 1, 8, 16][size]];
      const tp = textured ? env.texpage : null;
      prims.push({ ...base, kind: size === 1 ? 'dot' : textured ? 'sprite' : 'rect', verts: [p, [p[0] + w, p[1]], [p[0] + w, p[1] + h], [p[0], p[1] + h]], size: [w, h], color: rgb(w0), textured, semi: !!(cmd & 2), raw: !!(cmd & 1), ...(textured ? { texpage: tp, clut: tp.depth === '15bit' ? null : clut, uv } : {}), words: len });
      i += len;
    } else if (cmd === 0x02) {
      if (!need(3)) break;
      const x = at(1) & 0x3f0, y = (at(1) >>> 16) & 0x1ff, w = ((at(2) & 0x3ff) + 15) & ~15, h = (at(2) >>> 16) & 0x1ff;
      prims.push({ ...base, kind: 'fill', verts: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]], size: [w, h], color: rgb(w0), words: 3 });
      i += 3;
    } else if ((cmd & 0xe0) === 0x80) {
      if (!need(4)) break;
      prims.push({ ...base, kind: 'copy', from: [at(1) & 0x3ff, (at(1) >>> 16) & 0x1ff], to: [at(2) & 0x3ff, (at(2) >>> 16) & 0x1ff], size: [((at(3) - 1) & 0x3ff) + 1, (((at(3) >>> 16) - 1) & 0x1ff) + 1], words: 4 });
      i += 4;
    } else if ((cmd & 0xe0) === 0xa0) {
      if (!need(3)) break;
      const x = at(1) & 0x3ff, y = (at(1) >>> 16) & 0x1ff, w = ((at(2) - 1) & 0x3ff) + 1, h = (((at(2) >>> 16) - 1) & 0x1ff) + 1;
      const data = Math.ceil(w * h / 2);
      prims.push({ ...base, kind: 'upload', verts: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]], size: [w, h], words: 3 + data });
      i += Math.min(3 + data, stream.length - i);
    } else if ((cmd & 0xe0) === 0xc0) {
      if (!need(3)) break;
      prims.push({ ...base, kind: 'download', from: [at(1) & 0x3ff, (at(1) >>> 16) & 0x1ff], size: [((at(2) - 1) & 0x3ff) + 1, (((at(2) >>> 16) - 1) & 0x1ff) + 1], words: 3 });
      i += 3;
    } else if (cmd >= 0xe1 && cmd <= 0xe6) {
      ex[cmd & 7] = w0;
      i++;
    } else {
      i++; // NOP / cache clear / unknown
    }
  }
  const stats = {};
  for (const p of prims) stats[p.kind] = (stats[p.kind] ?? 0) + 1;
  return { prims, env: drawEnv(ex), ex, exceptions, gp1, chains, stats, leftover: stream.length - i };
}

/** Bounding box of a primitive's vertices. */
export function bounds(p) {
  if (!p.verts) return null;
  const xs = p.verts.map((v) => v[0]), ys = p.verts.map((v) => v[1]);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

/** One line per primitive for the agent. `name` turns a RAM address into a symbol.
 *  @param {any} p @param {(addr: number) => string | null} [name] */
export function primLine(p, name = () => null) {
  const b = bounds(p);
  const box = b ? ` ${b.x0},${b.y0} ${b.x1 - b.x0}x${b.y1 - b.y0}` : p.from ? ` ${p.from.join(',')}${p.to ? `→${p.to.join(',')}` : ''} ${p.size.join('x')}` : '';
  const col = p.color && !p.textured ? ` #${p.color.map((c) => c.toString(16).padStart(2, '0')).join('')}` : '';
  const tex = p.texpage ? ` tex ${p.texpage.x},${p.texpage.y} ${p.texpage.depth}${p.clut ? ` clut ${p.clut.x},${p.clut.y}` : ''}` : '';
  const flags = `${p.gouraud ? ' gouraud' : ''}${p.semi ? ' semi' : ''}`;
  const at = p.addr ? ` @${(p.addr >>> 0).toString(16)}${name(p.addr) ? ` (${name(p.addr)})` : ''}` : '';
  return `#${p.n} ${p.kind}${box}${col}${tex}${flags}${at}`;
}

// ---- Images ----

const COLORS = { poly3: [0, 255, 0], poly4: [0, 255, 0], line: [255, 255, 0], polyline: [255, 255, 0], rect: [0, 160, 255], sprite: [0, 160, 255], dot: [255, 255, 0], fill: [255, 0, 255], upload: [255, 128, 0] };

/** An RGBA image of a VRAM rectangle (15-bit view). */
export function vramImage(r, rect = { x: 0, y: 0, w: VRAM_W, h: VRAM_H }) {
  return { width: rect.w, height: rect.h, channels: 4, data: vramRgba(r, rect.x, rect.y, rect.w, rect.h) };
}

/** Outline rectangles / polygons on an RGBA image (coordinates relative to it). */
export function outline(img, shapes) {
  const put = (x, y, c) => {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
    const o = (y * img.width + x) * 4;
    img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; img.data[o + 3] = 255;
  };
  const line = (a, b, c) => {
    const n = Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]), 1);
    for (let t = 0; t <= n; t++) put(a[0] + (b[0] - a[0]) * t / n, a[1] + (b[1] - a[1]) * t / n, c);
  };
  for (const s of shapes) {
    const v = s.verts;
    if (v.length === 2) { line(v[0], v[1], s.color); continue; }
    // Quads are sent as 0,1,2,3 in a Z order (0-1-3-2 around the edge).
    const order = s.quad ? [0, 1, 3, 2] : v.map((_, k) => k);
    for (let k = 0; k < order.length; k++) line(v[order[k]], v[order[(k + 1) % order.length]], s.color);
  }
  return img;
}

/** The image of what a frame's primitives drew: the draw area from VRAM, with
 *  each primitive outlined (green polygons, blue rectangles/sprites, yellow
 *  lines, magenta fills), as a PNG. `only` restricts outlines to those indices. */
export function captureImage(r, cap, { scale = 2, only = null } = {}) {
  const a = cap.env.drawArea;
  const rect = { x: a.x0, y: a.y0, w: Math.max(1, a.x1 - a.x0 + 1), h: Math.max(1, a.y1 - a.y0 + 1) };
  const img = vramImage(r, rect);
  const shapes = cap.prims.filter((p) => p.verts && COLORS[p.kind] && (!only || only.includes(p.n)))
    .map((p) => ({ verts: p.verts.map(([x, y]) => [x - rect.x, y - rect.y]), color: COLORS[p.kind], quad: p.kind === 'poly4' }));
  outline(img, shapes);
  return scalePng(encodePng(img), scale);
}

/** VRAM as a PNG with the display area (white), draw area (red), texture pages
 *  and CLUTs used by `cap` (cyan / orange) outlined. */
export function vramPng(r, { cap = null, scale = 1 } = {}) {
  const img = vramImage(r);
  const box = (x, y, w, h, color) => ({ verts: [[x, y], [x + w - 1, y], [x + w - 1, y + h - 1], [x, y + h - 1]], color });
  const shapes = [];
  const d = display(r);
  shapes.push(box(d.x, d.y, d.w, d.h, [255, 255, 255]));
  const env = cap?.env ?? stateDrawEnv(r);
  shapes.push(box(env.drawArea.x0, env.drawArea.y0, env.drawArea.x1 - env.drawArea.x0 + 1, env.drawArea.y1 - env.drawArea.y0 + 1, [255, 0, 0]));
  if (cap) {
    const pages = new Map(), cluts = new Map();
    for (const p of cap.prims) {
      if (p.texpage) pages.set(`${p.texpage.x},${p.texpage.y},${p.texpage.depth}`, p.texpage);
      if (p.clut) cluts.set(`${p.clut.x},${p.clut.y},${p.texpage.depth}`, { ...p.clut, w: p.texpage.depth === '4bit' ? 16 : 256 });
    }
    for (const t of pages.values()) shapes.push(box(t.x, t.y, t.depth === '4bit' ? 64 : t.depth === '8bit' ? 128 : 256, 256, [0, 255, 255]));
    for (const c of cluts.values()) shapes.push(box(c.x, c.y, c.w, 1, [255, 140, 0]));
  }
  outline(img, shapes);
  return scalePng(encodePng(img), scale);
}

/** A texture page decoded with a CLUT (4/8-bit) or as 15-bit, as a PNG: what the
 *  GPU samples, not the raw VRAM words. */
export function texturePng(r, { x, y, depth = '4bit', clut = null, w = 256, h = 256, scale = 2 }) {
  const out = new Uint8Array(w * h * 4);
  const px = (vx, vy) => r.vram.readUInt16LE(((vy & 511) * VRAM_W + (vx & 1023)) * 2);
  const c15 = (p, o) => { out[o] = (p & 31) * 255 / 31 | 0; out[o + 1] = ((p >>> 5) & 31) * 255 / 31 | 0; out[o + 2] = ((p >>> 10) & 31) * 255 / 31 | 0; out[o + 3] = p === 0 ? 0 : 255; };
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const o = (j * w + i) * 4;
      if (depth === '15bit') { c15(px(x + i, y + j), o); continue; }
      const word = px(x + (depth === '4bit' ? i >> 2 : i >> 1), y + j);
      const idx = depth === '4bit' ? (word >>> ((i & 3) * 4)) & 15 : (word >>> ((i & 1) * 8)) & 255;
      if (!clut) { const g = depth === '4bit' ? idx * 17 : idx; out[o] = out[o + 1] = out[o + 2] = g; out[o + 3] = 255; } else c15(px(clut.x + idx, clut.y), o);
    }
  }
  return scalePng(encodePng({ width: w, height: h, channels: 4, data: out }), scale);
}
