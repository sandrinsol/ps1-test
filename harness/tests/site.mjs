// The play page (index.html) end to end, as a visitor sees it: load the page,
// click "Try the demo", and check that every request succeeded and the game
// draws. Runs against the repo served locally, or against a deployment:
//
//   node tests/site.mjs                       # serves the repo itself
//   node tests/site.mjs https://….vercel.app  # a deployed copy
//
// VERCEL_AUTOMATION_BYPASS_SECRET is sent as Vercel's protection-bypass header,
// for preview deployments behind Vercel Authentication.

import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { ok, done, HARNESS } from './lib.mjs';
import { startServer, BROWSER_ARGS } from '../driver.mjs';
import { decodePng } from '../png.mjs';

const { chromium } = await import('playwright');
let base = process.argv[2]?.replace(/\/$/, '');
let server = null;
if (!base) {
  const s = await startServer(path.resolve(HARNESS, '..'));
  server = s.server;
  base = `http://127.0.0.1:${s.port}`;
}
const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
const browser = await chromium.launch({
  executablePath: process.env.PS1TEST_CHROMIUM || undefined,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--enable-webgl', '--mute-audio', ...BROWSER_ARGS],
});
try {
  const context = await browser.newContext({
    viewport: { width: 1000, height: 800 },
    extraHTTPHeaders: bypass ? { 'x-vercel-protection-bypass': bypass, 'x-vercel-set-bypass-cookie': 'true' } : {},
  });
  const page = await context.newPage();
  const failures = [], errors = [];
  page.on('response', (r) => { if (r.status() >= 400) failures.push(`${r.status()} ${r.url()}`); });
  // EmulatorJS asks for a screen wake lock, which headless Chrome refuses: harmless.
  page.on('pageerror', (e) => { if (!/Wake Lock/i.test(e.message)) errors.push(e.message); });

  const res = await page.goto(`${base}/index.html`);
  if (res?.status() === 401 && !bypass) {
    console.log(`SKIP: ${base} needs authentication (Vercel Deployment Protection): set VERCEL_AUTOMATION_BYPASS_SECRET`);
    process.exit(0);
  }
  ok('page loads', res?.ok(), `${res?.status()} ${base}`);
  ok('page has the demo button', await page.locator('#demo').isVisible());

  await page.click('#demo');
  // Wait until the game draws something that isn't one flat colour.
  let colours = 0;
  for (let i = 0; i < 60 && colours < 4; i++) {
    await page.waitForTimeout(1000);
    if (!(await page.locator('#game canvas').count())) continue;
    const img = decodePng(await page.locator('#game').screenshot());
    const seen = new Set();
    for (let p = 0; p < img.width * img.height; p += 97) { const o = p * img.channels; seen.add((img.data[o] << 16) | (img.data[o + 1] << 8) | img.data[o + 2]); }
    colours = seen.size;
  }
  ok('the demo draws', colours >= 4, `${colours} colours sampled`);

  // Memory card panel: format a card, export it, import it back, drop one on the game.
  page.on('dialog', (d) => d.accept());   // "Erase every save…?"
  ok('the toolbar shows while playing', await page.locator('#cardBtn').isVisible());
  // Keyboard: WASD D-pad, I J K L for △ □ ✕ ○, Q/E L1/L2, U/O R1/R2 (key codes).
  const keys = await page.evaluate(() => { const c = window.EJS_emulator.controls[0]; return [4, 5, 6, 7, 9, 1, 0, 8, 10, 12, 11, 13].map((i) => c[i].value).join(','); });
  ok('keyboard: WASD, I J K L, Q E U O', keys === [87, 83, 65, 68, 73, 74, 75, 76, 81, 69, 85, 79].join(','), keys);
  ok('the key legend shows below the game', await page.locator('#keys').isVisible() && /W A S D/.test(await page.locator('#keys').innerText()));
  await page.click('#cardBtn');
  ok('memory card panel opens', await page.locator('#cardDlg').isVisible(), await page.locator('#cardInfo').textContent());
  await page.click('#cardFormat');
  await page.waitForTimeout(1500);
  ok('format: a blank card with 15 free blocks', /0 save\(s\), 15 of 15 blocks free/.test(await page.locator('#cardInfo').textContent()), await page.locator('#cardInfo').textContent());
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#cardExport')]);
  const exported = await readFile(await dl.path());
  ok('export downloads the 128 KB card', exported.length === 131072 && exported.toString('latin1', 0, 2) === 'MC', `${exported.length} bytes`);
  await page.setInputFiles('#cardFile', { name: 'blank.mcr', mimeType: 'application/octet-stream', buffer: exported });
  await page.waitForTimeout(500);
  ok('import inserts a card and says so', /blank\.mcr inserted/.test(await page.locator('#toast').textContent()));
  await page.click('#cardClose').catch(() => {});
  await page.evaluate((b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'dropped.mcd'));
    document.body.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, exported.toString('base64'));
  await page.waitForTimeout(500);
  ok('a memory card dropped on the game is inserted', /dropped\.mcd inserted/.test(await page.locator('#toast').textContent()), await page.locator('#toast').textContent());

  // A card with a save: the panel lists its title, game ID, region, size and icon.
  const card = Buffer.from(exported);
  const dir = card.subarray(128, 256);
  dir.writeUInt32LE(0x51, 0); dir.writeUInt32LE(8192, 4); dir.writeUInt16LE(0xffff, 8);
  dir.write('BASLUS-00067GAME0', 0x0a, 'latin1');
  dir[0x7f] = dir.subarray(0, 0x7f).reduce((a, v) => a ^ v, 0);
  const blk = card.subarray(8192, 16384);
  blk.write('SC', 0, 'latin1'); blk[2] = 0x11; blk[3] = 1;
  Buffer.from([0x82, 0x60, 0x82, 0x61, 0x81, 0x40, 0x82, 0x50]).copy(blk, 4);   // "AB 1" in full-width Shift-JIS
  blk.writeUInt16LE(0x7fff, 0x62); blk.fill(0x11, 128, 256);                     // a white icon
  await page.click('#cardBtn');
  await page.setInputFiles('#cardFile', { name: 'with-save.mcr', mimeType: 'application/octet-stream', buffer: card });
  await page.waitForTimeout(1000);
  const listed = await page.locator('#saves li').allTextContents();
  ok('the panel lists a save: title, game ID, region, blocks, icon', listed.length === 1 && /AB 1/.test(listed[0]) && /SLUS-00067 NTSC-U · 1 block/.test(listed[0])
    && await page.locator('#saves canvas').count() === 1 && /1 save\(s\), 14 of 15 blocks free/.test(await page.locator('#cardInfo').textContent()), listed.join(' | '));
  await page.click('#cardClose');
  ok('every request succeeded', failures.length === 0, failures.join(', '));
  ok('no page errors', errors.length === 0, errors.join('; '));

  // Installable and offline: a manifest, and a service worker that serves the
  // page again without a network.
  const manifest = await (await page.request.get(`${base}/manifest.webmanifest`)).json().catch(() => null);
  ok('web app manifest with icons', manifest?.display === 'standalone' && manifest.icons?.length >= 2);
  const sw = await page.evaluate(async () => { const r = await navigator.serviceWorker.ready; return !!r.active; });
  ok('service worker active', sw);
  if (sw) {
    await page.reload();
    await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 15000 }).catch(() => {});
    await context.setOffline(true);
    const off = await page.reload().catch(() => null);
    ok('offline: the page still loads from the cache', !!off && await page.locator('#demo').isVisible());
    await context.setOffline(false);
  }

  // Drag and drop on the picker: a .cue without its track is explained.
  await page.goto(`${base}/index.html`);
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['FILE "game.bin" BINARY\n  TRACK 01 MODE2/2352\n    INDEX 01 00:00:00\n'], 'game.cue'));
    document.body.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(300);
  ok('a dropped .cue without its .bin asks for it', /needs game\.bin too/.test(await page.locator('#error').textContent()));

  // Touch: on a phone the on-screen gamepad is shown.
  const phone = await browser.newContext({
    viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36',
    extraHTTPHeaders: bypass ? { 'x-vercel-protection-bypass': bypass, 'x-vercel-set-bypass-cookie': 'true' } : {},
  });
  const mob = await phone.newPage();
  await mob.goto(`${base}/index.html`);
  await mob.tap('#demo');
  const pad = await mob.waitForSelector('.ejs_virtualGamepad_button', { state: 'visible', timeout: 60000 }).then(() => true).catch(() => false);
  const labels = pad ? await mob.locator('.ejs_virtualGamepad_button').allTextContents() : [];
  ok('touch: an on-screen PlayStation pad shows on a phone', pad && ['△', '○', '✕', '□', 'L1', 'R2', 'Start'].every((l) => labels.includes(l)), labels.join(' '));
  await phone.close();
} finally {
  await browser.close();
  server?.close();
}
done();
