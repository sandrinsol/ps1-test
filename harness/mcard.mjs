// PlayStation memory cards: 128 KB = 16 blocks of 8 KB (64 frames of 128 bytes).
// Block 0 is the directory (frame 0 "MC", frames 1-15 one entry per block);
// a save's first block starts with its title frame ("SC", icon flags, a Shift-JIS
// title, a 16-colour palette) followed by one to three 16x16 4-bit icon frames.

import { encodePng, scalePng } from './png.mjs';

const BLOCK = 8192, FRAME = 128;

/** A blank, formatted card (what a console's "format" writes). */
export function formatCard() {
  const c = Buffer.alloc(128 * 1024);
  c.write('MC', 0, 'latin1');
  c[0x7f] = xor(c.subarray(0, 0x7f));
  for (let i = 1; i < 16; i++) {
    const f = c.subarray(i * FRAME, (i + 1) * FRAME);
    f.writeUInt32LE(0xa0, 0);        // free
    f.writeUInt16LE(0xffff, 8);      // no next block
    f[0x7f] = xor(f.subarray(0, 0x7f));
  }
  // Frames 16-35: the broken-sector list (unused): "no sector".
  for (let i = 16; i < 36; i++) {
    const f = c.subarray(i * FRAME, (i + 1) * FRAME);
    f.writeUInt32LE(0xffffffff, 0);
    f.writeUInt16LE(0xffff, 8);
    f[0x7f] = xor(f.subarray(0, 0x7f));
  }
  c.write('MC', 63 * FRAME, 'latin1');
  c[63 * FRAME + 0x7f] = xor(c.subarray(63 * FRAME, 63 * FRAME + 0x7f));
  return c;
}
const xor = (b) => b.reduce((a, v) => a ^ v, 0);

// Shift-JIS as used in save titles: mostly full-width ASCII.
function sjis(buf) {
  let s = '';
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b === 0) break;
    if (b < 0x80) { s += String.fromCharCode(b); continue; }
    const w = (b << 8) | buf[++i];
    if (w === 0x8140) s += ' ';
    else if (w >= 0x824f && w <= 0x8258) s += String.fromCharCode(48 + w - 0x824f);
    else if (w >= 0x8260 && w <= 0x8279) s += String.fromCharCode(65 + w - 0x8260);
    else if (w >= 0x8281 && w <= 0x829a) s += String.fromCharCode(97 + w - 0x8281);
    else s += { 0x8143: ',', 0x8144: '.', 0x8146: ':', 0x8147: ';', 0x8148: '?', 0x8149: '!', 0x815b: '-', 0x815e: '/', 0x8169: '(', 0x816a: ')', 0x817b: '+', 0x817c: '-', 0x8181: '=', 0x8193: '%', 0x8195: '&', 0x8196: '*', 0x8197: '@', 0x8194: '#', 0x8190: '$', 0x8175: '"', 0x8176: '"', 0x8166: "'" }[w] ?? '?';
  }
  return s.trim();
}

const STATES = { 0x51: 'first', 0x52: 'middle', 0x53: 'last', 0xa0: 'free', 0xa1: 'deleted-first', 0xa2: 'deleted-middle', 0xa3: 'deleted-last' };

/** The saves on a card: [{ block, file, gameId, region, title, blocks, size,
 *  iconFrames, icon (PNG of the first icon frame) }], plus card-level problems. */
export function listSaves(card) {
  if (card.length !== 128 * 1024) throw new Error(`a memory card is 131072 bytes, not ${card.length}`);
  const problems = [];
  if (card.toString('latin1', 0, 2) !== 'MC') problems.push('not formatted (no "MC" header)');
  const dir = (i) => card.subarray(i * FRAME, (i + 1) * FRAME);
  const saves = [];
  for (let i = 1; i < 16; i++) {
    const f = dir(i);
    const state = f.readUInt32LE(0) & 0xff;
    if (xor(f.subarray(0, 0x7f)) !== f[0x7f] && card.toString('latin1', 0, 2) === 'MC') problems.push(`directory frame ${i}: bad checksum`);
    if (STATES[state] !== 'first') continue;
    // Follow the chain of blocks.
    let blocks = 1, next = f.readUInt16LE(8);
    const seen = new Set([i]);
    while (next !== 0xffff && next < 15 && !seen.has(next + 1)) { seen.add(next + 1); blocks++; next = dir(next + 1).readUInt16LE(8); }
    const file = f.toString('latin1', 0x0a, 0x1f).replace(/\0.*$/s, '');
    const head = card.subarray(i * BLOCK, i * BLOCK + FRAME);
    const ok = head.toString('latin1', 0, 2) === 'SC';
    const iconFrames = ok ? ({ 0x11: 1, 0x12: 2, 0x13: 3 }[head[2]] ?? 0) : 0;
    const save = {
      block: i, file, gameId: file.slice(2, 12), region: { BA: 'NTSC-U', BE: 'PAL', BI: 'NTSC-J' }[file.slice(0, 2)] ?? file.slice(0, 2),
      title: ok ? sjis(head.subarray(4, 4 + 64)) : '(no title frame)', blocks, size: f.readUInt32LE(4), iconFrames,
      icon: iconFrames ? iconPng(card, i, 0) : null,
    };
    if (save.size !== blocks * BLOCK) problems.push(`${file}: directory says ${save.size} bytes, chain has ${blocks} block(s)`);
    saves.push(save);
  }
  const used = saves.reduce((n, s) => n + s.blocks, 0);
  return { saves, freeBlocks: 15 - used, problems };
}

/** Icon frame `n` of the save starting at `block`, as a 16x16 PNG (scaled). */
export function iconPng(card, block, n = 0, scale = 2) {
  const base = block * BLOCK;
  const pal = Array.from({ length: 16 }, (_, k) => card.readUInt16LE(base + 0x60 + k * 2));
  const data = new Uint8Array(16 * 16 * 4);
  for (let p = 0; p < 256; p++) {
    const byte = card[base + FRAME * (1 + n) + (p >> 1)];
    const c = pal[(byte >>> ((p & 1) * 4)) & 15];
    data.set([(c & 31) * 255 / 31 | 0, ((c >>> 5) & 31) * 255 / 31 | 0, ((c >>> 10) & 31) * 255 / 31 | 0, c === 0 ? 0 : 255], p * 4);
  }
  return scalePng(encodePng({ width: 16, height: 16, channels: 4, data }), scale);
}
