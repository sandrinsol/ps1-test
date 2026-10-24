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
import { ok, done, HARNESS } from './lib.mjs';
import { startServer } from '../driver.mjs';
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
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--enable-webgl', '--mute-audio'],
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
  ok('every request succeeded', failures.length === 0, failures.join(', '));
  ok('no page errors', errors.length === 0, errors.join('; '));
} finally {
  await browser.close();
  server?.close();
}
done();
