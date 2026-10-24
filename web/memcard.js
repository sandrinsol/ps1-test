// Memory cards in the browser (the play page): read a card image's directory
// (the saves, their titles and icons), accept the usual file formats, and make
// a blank formatted card. A browser twin of harness/mcard.mjs.

const CARD = 128 * 1024, BLOCK = 8192, FRAME = 128;
const xor = (b) => b.reduce((a, v) => a ^ v, 0);

/** A raw 128 KB card from .mcr/.mcd (raw), DexDrive .gme or .vgs/.mem files. */
export function rawCard(u8) {
  const ascii = (o, n) => String.fromCharCode(...u8.subarray(o, o + n));
  if (u8.length === CARD) return u8;
  if (u8.length === CARD + 3904 && ascii(0, 11) === '123-456-STD') return u8.subarray(3904);
  if (u8.length === CARD + 64 && ascii(0, 4) === 'VgsM') return u8.subarray(64);
  throw new Error(`not a memory card image (${u8.length} bytes; a raw card is 131072)`);
}

/** A blank, formatted card. */
export function formatCard() {
  const c = new Uint8Array(CARD);
  const frame = (i) => c.subarray(i * FRAME, (i + 1) * FRAME);
  const seal = (f) => { f[0x7f] = xor(f.subarray(0, 0x7f)); };
  c.set([0x4d, 0x43]); seal(frame(0));                     // "MC"
  for (let i = 1; i < 16; i++) { const f = frame(i); f[0] = 0xa0; f[8] = 0xff; f[9] = 0xff; seal(f); }
  for (let i = 16; i < 36; i++) { const f = frame(i); f.fill(0xff, 0, 4); f[8] = 0xff; f[9] = 0xff; seal(f); }
  c.set([0x4d, 0x43], 63 * FRAME); seal(frame(63));
  return c;
}

// Save titles are Shift-JIS, mostly full-width ASCII.
function sjis(b) {
  let s = '';
  for (let i = 0; i < b.length; i++) {
    const c = b[i];
    if (c === 0) break;
    if (c < 0x80) { s += String.fromCharCode(c); continue; }
    const w = (c << 8) | b[++i];
    if (w === 0x8140) s += ' ';
    else if (w >= 0x824f && w <= 0x8258) s += String.fromCharCode(48 + w - 0x824f);
    else if (w >= 0x8260 && w <= 0x8279) s += String.fromCharCode(65 + w - 0x8260);
    else if (w >= 0x8281 && w <= 0x829a) s += String.fromCharCode(97 + w - 0x8281);
    else s += { 0x8143: ',', 0x8144: '.', 0x8146: ':', 0x8147: ';', 0x8148: '?', 0x8149: '!', 0x815b: '-', 0x815e: '/', 0x8169: '(', 0x816a: ')', 0x817b: '+', 0x817c: '-', 0x8181: '=' }[w] ?? '?';
  }
  return s.trim();
}

/** The saves on a card: { saves: [{ block, file, gameId, region, title, blocks, icon (canvas | null) }], freeBlocks, formatted }. */
export function listSaves(card) {
  const saves = [];
  const u32 = (o) => card[o] | (card[o + 1] << 8) | (card[o + 2] << 16) | (card[o + 3] << 24);
  const u16 = (o) => card[o] | (card[o + 1] << 8);
  const formatted = card[0] === 0x4d && card[1] === 0x43;
  for (let i = 1; i < 16 && formatted; i++) {
    const d = i * FRAME;
    if ((u32(d) & 0xff) !== 0x51) continue;               // first block of a save
    let blocks = 1, next = u16(d + 8);
    const seen = new Set([i]);
    while (next !== 0xffff && next < 15 && !seen.has(next + 1)) { seen.add(next + 1); blocks++; next = u16((next + 1) * FRAME + 8); }
    let file = '';
    for (let k = 0x0a; k < 0x1f && card[d + k]; k++) file += String.fromCharCode(card[d + k]);
    const head = i * BLOCK, ok = card[head] === 0x53 && card[head + 1] === 0x43;  // "SC"
    saves.push({
      block: i, file, gameId: file.slice(2, 12), region: { BA: 'NTSC-U', BE: 'PAL', BI: 'NTSC-J' }[file.slice(0, 2)] ?? '',
      title: ok ? sjis(card.subarray(head + 4, head + 68)) : '(no title)', blocks,
      icon: ok && card[head + 2] >= 0x11 && card[head + 2] <= 0x13 ? iconCanvas(card, i) : null,
    });
  }
  return { saves, freeBlocks: 15 - saves.reduce((n, s) => n + s.blocks, 0), formatted };
}

/** The first icon frame of the save at `block` (16x16, 4-bit through its palette). */
function iconCanvas(card, block) {
  const base = block * BLOCK;
  const cv = document.createElement('canvas');
  cv.width = cv.height = 16;
  const ctx = cv.getContext('2d'), img = ctx.createImageData(16, 16);
  for (let p = 0; p < 256; p++) {
    const byte = card[base + FRAME + (p >> 1)];
    const k = (byte >> ((p & 1) * 4)) & 15;
    const c = card[base + 0x60 + k * 2] | (card[base + 0x61 + k * 2] << 8);
    img.data.set([(c & 31) * 255 / 31, ((c >> 5) & 31) * 255 / 31, ((c >> 10) & 31) * 255 / 31, c === 0 ? 0 : 255], p * 4);
  }
  ctx.putImageData(img, 0, 0);
  return cv;
}
