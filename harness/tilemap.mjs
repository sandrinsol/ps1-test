// Backgrounds for PS1 2D games: a big image or a Tiled map (.tmx / .tmj) cut
// into tiles, identical tiles merged, the unique ones packed into a tileset
// texture (a TIM) and the map written as an array of tile numbers. The GPU has
// no tile hardware: a game draws the map as a sprite (or SPRT_16 / SPRT_8) per
// visible cell, sampling the tileset. It can't mirror textures either, so
// mirrored tiles are kept as separate tiles.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { inflateSync, gunzipSync } from 'node:zlib';
import path from 'node:path';
import { decodePng, encodePng } from './png.mjs';
import { convertTim } from './tim.mjs';

/**
 * Cut an image into tile×tile cells, merge duplicates, pack the unique tiles
 * into a tileset `columns` tiles wide and convert it to a TIM.
 * @param {Buffer} png
 * @param {{ tile?: 8 | 16 | 32, depth?: 4 | 8 | 16, x?: number, y?: number, clutX?: number, clutY?: number,
 *   dedupe?: boolean, transparent?: string, quantize?: boolean }} [opts]
 */
export function convertTilemap(png, { tile = 16, depth = 4, x = 640, y = 256, clutX = 640, clutY = 496, dedupe = true, transparent = 'alpha', quantize = true } = {}) {
  const img = decodePng(png);
  const ch = img.channels;
  if (img.width % tile || img.height % tile) throw new Error(`the image (${img.width}x${img.height}) isn't a whole number of ${tile}-pixel tiles`);
  const cols = img.width / tile, rows = img.height / tile;
  const tiles = [], index = new Map(), map = new Uint16Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const t = new Uint8Array(tile * tile * 4);
      for (let j = 0; j < tile; j++) for (let i = 0; i < tile; i++) {
        const s = ((r * tile + j) * img.width + c * tile + i) * ch, d = (j * tile + i) * 4;
        t[d] = img.data[s]; t[d + 1] = img.data[s + (ch >= 3 ? 1 : 0)]; t[d + 2] = img.data[s + (ch >= 3 ? 2 : 0)];
        t[d + 3] = ch === 4 ? img.data[s + 3] : ch === 2 ? img.data[s + 1] : 255;
      }
      const key = dedupe ? Buffer.from(t).toString('base64') : `${r},${c}`;
      if (!index.has(key)) { index.set(key, tiles.length); tiles.push(t); }
      map[r * cols + c] = index.get(key);
    }
  }
  // A texture page is 256 texels wide at 4-bit (64 VRAM words): fit the tileset in one.
  const pageW = depth === 4 ? 256 : depth === 8 ? 128 : 64;
  const perRow = Math.max(1, Math.floor(pageW / tile));
  const sheetRows = Math.ceil(tiles.length / perRow);
  const W = perRow * tile, H = sheetRows * tile;
  const warnings = [];
  if (H > 256) warnings.push(`${tiles.length} tiles need ${H} rows of texels: more than one texture page (256) — use 8-bit/16-bit tiles, smaller art, or split the tileset`);
  const sheet = new Uint8Array(W * H * 4);
  tiles.forEach((t, k) => {
    const ox = (k % perRow) * tile, oy = Math.floor(k / perRow) * tile;
    for (let j = 0; j < tile; j++) sheet.set(t.subarray(j * tile * 4, (j + 1) * tile * 4), ((oy + j) * W + ox) * 4);
  });
  const conv = convertTim(encodePng({ width: W, height: H, channels: 4, data: sheet }), { depth, x, y, clutX, clutY, transparent, quantize });
  return { ...conv, tile, cols, rows, map, tileCount: tiles.length, cells: cols * rows, perRow, warnings: [...warnings, ...conv.warnings], preview: renderTilemap(sheet, W, tile, perRow, map, cols, rows) };
}

/** Rebuild the full picture from the tileset and the map (a check of the output). */
function renderTilemap(sheet, W, tile, perRow, map, cols, rows) {
  const out = new Uint8Array(cols * tile * rows * tile * 4);
  const OW = cols * tile;
  for (let k = 0; k < map.length; k++) {
    const t = map[k], sx = (t % perRow) * tile, sy = Math.floor(t / perRow) * tile;
    const dx = (k % cols) * tile, dy = Math.floor(k / cols) * tile;
    for (let j = 0; j < tile; j++) out.set(sheet.subarray(((sy + j) * W + sx) * 4, ((sy + j) * W + sx + tile) * 4), ((dy + j) * OW + dx) * 4);
  }
  return encodePng({ width: OW, height: rows * tile, channels: 4, data: out });
}

/** Write a converted map: <out>.tim (the tileset) and <out>.c + .h (the map
 *  and constants), or .h alone. */
export async function writeTilemap(conv, file, name) {
  const id = name.replace(/\W/g, '_'), ID = id.toUpperCase(), ext = path.extname(file).toLowerCase();
  await mkdir(path.dirname(path.resolve(file)), { recursive: true });
  const tim = file.replace(/\.[^.]+$/, '.tim');
  await writeFile(tim, conv.tim);
  const rows = [];
  for (let r = 0; r < conv.rows; r++) rows.push('\t' + Array.from(conv.map.subarray(r * conv.cols, (r + 1) * conv.cols)).join(', ') + ',');
  const info = `${conv.cols}x${conv.rows} map of ${conv.tile}x${conv.tile} tiles, ${conv.tileCount} unique, tileset ${path.basename(tim)} (${conv.depth}-bit at VRAM ${conv.vram.x},${conv.vram.y}${conv.clut ? `, CLUT ${conv.clut.x},${conv.clut.y}` : ''})`;
  const defs = [`#define ${ID}_COLS ${conv.cols}`, `#define ${ID}_ROWS ${conv.rows}`, `#define ${ID}_TILE ${conv.tile}`, `#define ${ID}_TILES_PER_ROW ${conv.perRow} /* in the tileset: tile t is at u = (t % ${conv.perRow}) * ${conv.tile}, v = (t / ${conv.perRow}) * ${conv.tile} */`];
  const decl = `const uint16_t ${id}_map[${conv.cols * conv.rows}]`;
  if (ext === '.h') {
    await writeFile(file, [`/* ${info} */`, `#ifndef ${ID}_MAP_H`, `#define ${ID}_MAP_H`, '#include <stdint.h>', ...defs, `static ${decl} = {\n${rows.join('\n')}\n};`, '#endif', ''].join('\n'));
    return [file, tim];
  }
  if (ext === '.c') {
    const h = file.replace(/\.c$/i, '.h');
    await writeFile(h, [`/* ${info} */`, `#ifndef ${ID}_MAP_H`, `#define ${ID}_MAP_H`, '#include <stdint.h>', ...defs, `extern ${decl};`, '#endif', ''].join('\n'));
    await writeFile(file, [`/* ${info} */`, `#include "${path.basename(h)}"`, '', `${decl} = {\n${rows.join('\n')}\n};`, ''].join('\n'));
    return [file, h, tim];
  }
  throw new Error(`unknown map output "${ext}" (use .c or .h; the tileset goes next to it as .tim)`);
}

// ---- Tiled maps ----

const attr = (tag, name) => { const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag); return m ? m[1] : undefined; };

/** Layer data → gids (CSV, base64 with optional zlib/gzip, or a JSON array). */
function decodeData(data, encoding, compression) {
  if (Array.isArray(data)) return data;
  if (encoding === 'csv') return data.trim().split(/[\s,]+/).filter(Boolean).map(Number);
  if (encoding === 'base64') {
    let b = Buffer.from(data.trim(), 'base64');
    if (compression === 'zlib') b = inflateSync(b);
    else if (compression === 'gzip') b = gunzipSync(b);
    else if (compression) throw new Error(`unsupported Tiled compression "${compression}" (use CSV, base64, zlib or gzip)`);
    return Array.from({ length: b.length / 4 }, (_, i) => b.readUInt32LE(i * 4));
  }
  throw new Error(`unsupported Tiled layer encoding "${encoding}" (use CSV or base64)`);
}

/** A tileset as { firstgid, tw, th, columns, margin, spacing, img }. */
async function loadTileset(ts, dir) {
  let t = ts, base = dir;
  if (ts.source) {
    const f = path.resolve(dir, ts.source);
    base = path.dirname(f);
    const text = await readFile(f, 'utf8');
    if (/\.(tsj|json)$/i.test(f)) t = JSON.parse(text);
    else {
      const head = /<tileset[^>]*>/.exec(text)?.[0] ?? '', im = /<image[^>]*>/.exec(text)?.[0] ?? '';
      t = { tilewidth: +attr(head, 'tilewidth'), tileheight: +attr(head, 'tileheight'), columns: +(attr(head, 'columns') ?? 0), margin: +(attr(head, 'margin') ?? 0), spacing: +(attr(head, 'spacing') ?? 0), image: attr(im, 'source') };
    }
  }
  if (!t.image) throw new Error('tilesets must use one image (image-collection tilesets are not supported)');
  const img = decodePng(await readFile(path.resolve(base, t.image)));
  const tw = t.tilewidth, th = t.tileheight, margin = t.margin ?? 0, spacing = t.spacing ?? 0;
  const columns = t.columns || Math.floor((img.width - 2 * margin + spacing) / (tw + spacing));
  return { firstgid: ts.firstgid, tw, th, columns, margin, spacing, img };
}

/** Render a Tiled map's visible tile layers to an RGBA PNG. */
export async function renderTiledMap(file) {
  const text = await readFile(file, 'utf8');
  const dir = path.dirname(file);
  let map;
  if (/^\s*\{/.test(text)) {
    const j = JSON.parse(text);
    map = { width: j.width, height: j.height, tw: j.tilewidth, th: j.tileheight, tilesets: j.tilesets,
      layers: (j.layers ?? []).filter((l) => l.type === 'tilelayer' && l.visible !== false).map((l) => decodeData(l.data, l.encoding ?? 'csv', l.compression)) };
  } else {
    const head = /<map[^>]*>/.exec(text)?.[0];
    if (!head) throw new Error(`${file} is not a Tiled map`);
    const tilesets = [...text.matchAll(/<tileset([^>]*?)(\/>|>([\s\S]*?)<\/tileset>)/g)].map((m) => {
      const tag = m[1];
      if (attr(tag, 'source')) return { firstgid: +attr(tag, 'firstgid'), source: attr(tag, 'source') };
      const im = /<image[^>]*>/.exec(m[3] ?? '')?.[0] ?? '';
      return { firstgid: +attr(tag, 'firstgid'), tilewidth: +attr(tag, 'tilewidth'), tileheight: +attr(tag, 'tileheight'), columns: +(attr(tag, 'columns') ?? 0), margin: +(attr(tag, 'margin') ?? 0), spacing: +(attr(tag, 'spacing') ?? 0), image: attr(im, 'source') };
    });
    const layers = [...text.matchAll(/<layer([^>]*)>\s*<data([^>]*)>([\s\S]*?)<\/data>/g)]
      .filter((m) => attr(m[1], 'visible') !== '0')
      .map((m) => {
        if (/<tile\b/.test(m[3])) return [...m[3].matchAll(/<tile(?:\s+gid="(\d+)")?\s*\/>/g)].map((t) => +(t[1] ?? 0));
        return decodeData(m[3], attr(m[2], 'encoding') ?? 'xml', attr(m[2], 'compression'));
      });
    map = { width: +attr(head, 'width'), height: +attr(head, 'height'), tw: +attr(head, 'tilewidth'), th: +attr(head, 'tileheight'), tilesets, layers };
  }
  if (attr((/<map[^>]*>/.exec(text)?.[0] ?? ''), 'infinite') === '1') throw new Error('infinite Tiled maps are not supported; set a fixed map size');
  const sets = (await Promise.all(map.tilesets.map((t) => loadTileset(t, dir)))).sort((a, b) => b.firstgid - a.firstgid);
  const W = map.width * map.tw, H = map.height * map.th;
  const out = new Uint8Array(W * H * 4);
  for (const gids of map.layers) {
    gids.forEach((raw, i) => {
      const gid = raw & 0x1fffffff;
      if (!gid) return;
      const fh = !!(raw & 0x80000000), fv = !!(raw & 0x40000000), fd = !!(raw & 0x20000000);
      const ts = sets.find((s) => s.firstgid <= gid);
      if (!ts) return;
      const id = gid - ts.firstgid;
      const sx = ts.margin + (id % ts.columns) * (ts.tw + ts.spacing), sy = ts.margin + Math.floor(id / ts.columns) * (ts.th + ts.spacing);
      const dx = (i % map.width) * map.tw, dy = Math.floor(i / map.width) * map.th;
      for (let y = 0; y < map.th; y++) for (let x = 0; x < map.tw; x++) {
        let u = x, v = y;
        if (fd) [u, v] = [v, u];
        if (fh) u = map.tw - 1 - u;
        if (fv) v = map.th - 1 - v;
        const so = ((sy + v) * ts.img.width + sx + u) * ts.img.channels;
        const a = ts.img.channels === 4 ? ts.img.data[so + 3] : 255;
        if (a < 128) continue;
        const o = ((dy + y) * W + dx + x) * 4;
        out[o] = ts.img.data[so]; out[o + 1] = ts.img.data[so + 1]; out[o + 2] = ts.img.data[so + 2]; out[o + 3] = 255;
      }
    });
  }
  return encodePng({ width: W, height: H, data: out, channels: 4 });
}
