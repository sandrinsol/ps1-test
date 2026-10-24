// The PSn00bSDK template end to end through the MCP server: new_project, build
// (CMake → disc image, loaded with its symbols), its own smoke test, and check.
// Needs PSn00bSDK (PSN00BSDK_LIBS) and a MIPS GCC; skipped without them.
//
//   PSN00BSDK_LIBS=… node tests/template.mjs

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from '../mcp-server.mjs';
import { ok, done, HARNESS } from './lib.mjs';

if (!process.env.PSN00BSDK_LIBS) {
  console.log('SKIP: PSN00BSDK_LIBS is not set (install PSn00bSDK: templates/psn00bsdk/.devcontainer/install-psn00bsdk.sh)');
  process.exit(0);
}

const DIR = path.join(HARNESS, 'out', 'template-test');
await rm(DIR, { recursive: true, force: true });
const textOf = (r) => r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');

// Create the project with a server rooted at harness/out, then work in it with
// a second server rooted at the project (as an agent would).
{
  const { server, close } = createServer({ root: path.join(HARNESS, 'out') });
  const client = new Client({ name: 't', version: '0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  const r = await client.callTool({ name: 'new_project', arguments: { template: 'psn00bsdk', path: 'template-test' } });
  ok('new_project copies the template', !r.isError && /ps1test\.json/.test(textOf(r)) && /CMakeLists\.txt/.test(textOf(r)), textOf(r).slice(0, 120));
  await close();
}

const { server, close } = createServer({ root: DIR });
const client = new Client({ name: 't', version: '0' });
const [a, b] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(b), client.connect(a)]);
/** @returns {Promise<any>} */
const call = (name, args = {}) => client.callTool({ name, arguments: args });
try {
  let r = await call('build');
  ok('build (ps1test.json command) succeeds and loads the disc with symbols', !r.isError && /Loaded build\/game\.cue \(OpenBIOS, \d+ symbols from game\.elf\)/.test(textOf(r)), textOf(r));
  ok('the build reports the watched variables', /watch: player_x=\d+ player_y=\d+/.test(textOf(r)), textOf(r));
  const script = JSON.parse(await readFile(path.join(DIR, 'tests/ps1/smoke.json'), 'utf8'));
  r = await call('run_sequence', { steps: script.steps.map((s) => (s.assert ? { ...s, assert: path.join('tests/ps1', s.assert) } : s)) });
  ok('the template\'s smoke test passes against its goldens', !r.isError && r.structuredContent.pass, textOf(r).split('\n')[0]);
  r = await call('check', { frames: 60 });
  ok('check: no errors or warnings', !r.isError && r.structuredContent.errors === 0 && r.structuredContent.warnings === 0, textOf(r));
  ok('check notes the missing license sectors', /no license data in sector 4/.test(textOf(r)));
  ok('check finds frame_count and cpu_usage by name', /frame counter 0x[0-9a-f]+ \(frame_count\)/.test(textOf(r)) && /CPU load \d+-\d+%/.test(textOf(r)), textOf(r));
  r = await call('gpu_capture', { image: false, list: 100 });
  ok('gpu_capture: cube faces, the player sprite and font sprites', /poly4/.test(textOf(r)) && /sprite \d+,\d+ 16x16 tex 768,0 4bit clut 768,256/.test(textOf(r)) && /sprite \d+,\d+ 8x8 tex 960,0/.test(textOf(r)), textOf(r).split('\n')[0]);
  ok('gpu_capture: font primitives are labelled heap', /@[0-9a-f]+ \(heap\+\d+\)/.test(textOf(r)));
  // Break the build: errors come back as file:line.
  const main = path.join(DIR, 'src/main.c');
  const src = await readFile(main, 'utf8');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(main, src.replace('player_x -= 2;', 'player_x -= 2'));
  r = await call('build');
  ok('a compile error is reported as file:line', r.isError && /src\/main\.c:\d+:\d+: error: expected ';'/.test(textOf(r)), textOf(r));
  await writeFile(main, src);
} finally {
  await close();
}
done();
