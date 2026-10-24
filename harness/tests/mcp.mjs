// End-to-end test of the MCP layer: drives the real server through the MCP SDK
// client over an in-memory transport and checks tool schemas and responses.
//
//   node tests/mcp.mjs

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createServer, CORE_TOOLS } from '../mcp-server.mjs';
import { decodePng, encodePng } from '../png.mjs';
import { ok, done, HARNESS } from './lib.mjs';

const OUT = path.join(HARNESS, 'out', 'mcp-test');
const rel = (f) => path.relative(path.resolve(HARNESS, '..'), path.join(OUT, f));
await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

// Relative paths resolve against `root` (here: the repo root).
const { server, close } = createServer({ root: path.resolve(HARNESS, '..') });
const client = new Client({ name: 'test', version: '0' });
const [ct, st] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(st), client.connect(ct)]);

/** @returns {Promise<any>} */
const call = (name, args = {}) => client.callTool({ name, arguments: args });
const textOf = (r) => r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
const images = (r) => r.content.filter((c) => c.type === 'image').map((c) => decodePng(Buffer.from(c.data, 'base64')));
const scriptOf = (r) => JSON.parse(textOf(r).slice(textOf(r).indexOf('{')));
const EXE = 'harness/tests/fixtures/hello.exe', CUE = 'harness/tests/fixtures/hello.cue';

try {
  // --- Listing ---
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  const ALL = ['load_disc', 'wait_frames', 'press', 'set_button', 'set_analog', 'wait_until', 'reset', 'screenshot',
    'read_memory', 'read_cpu', 'status', 'write_memory', 'state', 'cheats', 'memory_card', 'run_sequence',
    'record_video', 'assert_golden', 'export_script', 'ab_compare', 'ram_search', 'build'];
  for (const n of ALL) ok(`tool listed: ${n}`, names.includes(n));
  ok('exactly the documented tools', names.length === ALL.length, `${names.length}: ${names.filter((n) => !ALL.includes(n)).join(', ')}`);
  ok('screenshot is annotated read-only', tools.find((t) => t.name === 'screenshot').annotations?.readOnlyHint === true);
  const listJson = JSON.stringify(tools);
  ok('tool list is slim (no output schemas, $schema or ±2^53 bounds)',
    !tools.some((t) => t.outputSchema) && !listJson.includes('$schema') && !listJson.includes('9007199254740991'));
  ok('tool list stays small', listJson.length / 4 < 3600, `~${Math.round(listJson.length / 4)} tokens`);
  ok('core set names real tools', CORE_TOOLS.filter((t) => t !== 'describe').every((t) => names.includes(t)));
  const { prompts } = await client.listPrompts();
  ok('prompts listed', ['smoke_test_rom', 'regression_check', 'find_ram_address', 'record_regression_test'].every((p) => prompts.some((x) => x.name === p)));
  const { resources } = await client.listResources();
  ok('resources listed', ['emu://screen', 'emu://status'].every((u) => resources.some((r) => r.uri === u)));

  // --- Nothing loaded yet ---
  const none = await call('screenshot');
  ok('tools error cleanly before load_disc', none.isError && /load_disc/.test(textOf(none)));

  // --- Load an EXE (relative path via root), wait, screenshot ---
  let r = await call('load_disc', { path: EXE });
  ok('load_disc EXE (relative to root)', !r.isError && r.structuredContent.bios === 'openbios' && /OpenBIOS, NTSC/.test(textOf(r)), textOf(r));
  ok('load_disc reports symbols', /symbols from hello\.elf/.test(textOf(r)));
  r = await call('wait_frames', { frames: 60 });
  ok('wait_frames lands exactly', r.structuredContent.frame === 60, `frame ${r.structuredContent.frame}`);
  r = await call('screenshot');
  let [img] = images(r);
  ok('screenshot defaults to 2x (640x480)', img && img.width === 640 && img.height === 480, img && `${img.width}x${img.height}`);
  r = await call('screenshot', { scale: 1, save: rel('native.png') });
  [img] = images(r);
  ok('screenshot scale=1 is native 320x240', img.width === 320 && img.height === 240);
  ok('screenshot save writes a file', existsSync(path.join(OUT, 'native.png')));

  // --- Concurrency: parallel calls are serialized ---
  const [w, f] = await Promise.all([call('wait_frames', { frames: 30 }), call('status')]);
  ok('parallel calls run in order', w.structuredContent.frame === 90 && f.structuredContent.frame === 90, `${w.structuredContent.frame} / ${f.structuredContent.frame}`);

  // --- Memory and CPU ---
  r = await call('read_memory', { address: 'frame_count', as: 'u32' });
  ok('read_memory by symbol', !r.isError && r.structuredContent.values[0] === 90, textOf(r));
  r = await call('read_memory', { address: '0x1F800000', length: 8 });
  ok('read_memory scratchpad (hex dump)', !r.isError && /0x1f800000: ([0-9a-f]{2} ){7}[0-9a-f]{2}/.test(textOf(r)), textOf(r));
  r = await call('read_memory', { address: 'nonsense' });
  ok('bad address is a clean error', r.isError && /not an address or a symbol/.test(textOf(r)), textOf(r));
  r = await call('write_memory', { address: 'box_x', value: 20, as: 'u16' });
  ok('write_memory sticks', !r.isError && r.structuredContent.stuck === true, textOf(r));
  r = await call('read_cpu', { gte: true });
  ok('read_cpu names the function and shows the GTE', !r.isError && /in main/.test(textOf(r)) && /gte data:/.test(textOf(r)), textOf(r).split('\n')[0]);

  // --- Input ---
  r = await call('press', { button: 'RIGHT', hold: 10, release: 1 });
  ok('press advances hold+release frames', r.structuredContent.frame === 101, `${r.structuredContent.frame}`);
  r = await call('read_memory', { address: 'box_x', as: 'u16' });
  ok('press moved the box', r.structuredContent.values[0] === 30, textOf(r));
  r = await call('set_button', { button: 'CROSS', pressed: true });
  ok('set_button holds', /Held: CROSS/.test(textOf(r)));
  await call('set_button', { button: 'CROSS', pressed: false });
  r = await call('set_button', { button: 'START', pressed: true, port: 2 });
  ok('port 2 buttons are labelled', /P2:START/.test(textOf(r)));
  await call('set_button', { button: 'START', pressed: false, port: 2 });

  // --- States ---
  r = await call('state', { action: 'save', id: 'cp', path: rel('cp.state') });
  ok('state save to file', !r.isError && existsSync(path.join(OUT, 'cp.state')), textOf(r));
  const shotAtCp = (await call('screenshot', { scale: 1 })).content[1].data;
  await call('press', { button: 'DOWN', hold: 20, release: 5 });
  r = await call('state', { action: 'load', path: rel('cp.state') });
  ok('state load from file', !r.isError, textOf(r));
  r = await call('state', { action: 'load', id: 'cp' });
  ok('state restore is pixel-exact', !r.isError && (await call('screenshot', { scale: 1 })).content[1].data === shotAtCp);

  // --- Waits ---
  r = await call('wait_until', { address: 'frame_count', as: 'u32', op: 'gte', value: 400, maxFrames: 600 });
  ok('wait_until on a symbol', !r.isError && r.structuredContent.met && /Met at frame/.test(textOf(r)), textOf(r));
  r = await call('wait_until', { screen: 'stable', frames: 10, maxFrames: 100 });
  ok('wait_until screen stable', !r.isError && r.structuredContent.met);

  // --- Golden asserts ---
  r = await call('assert_golden', { golden: rel('golden.png') });
  ok('assert_golden creates a baseline', !r.isError && r.structuredContent.created === true);
  r = await call('assert_golden', { golden: rel('golden.png') });
  ok('assert_golden passes on the same frame', !r.isError && r.structuredContent.pass === true, textOf(r));
  await writeFile(path.join(OUT, 'black.png'), encodePng({ width: 320, height: 240, data: new Uint8Array(320 * 240 * 3) }));
  r = await call('assert_golden', { golden: rel('black.png'), threshold: 0 });
  ok('assert_golden fails on mismatch with 3 images', r.isError && images(r).length === 3);
  r = await call('assert_golden', { golden: rel('black.png'), threshold: 0, ignore: [{ x: 0, y: 0, w: 320, h: 240 }] });
  ok('assert_golden ignore mask', !r.isError && r.structuredContent.pass === true, textOf(r));

  // --- run_sequence ---
  r = await call('run_sequence', {
    steps: [
      { wait: 10 }, { shot: 'a' }, { tap: 'LEFT', hold: 5, release: 1 },
      { record: { frames: 40, every: 10, prefix: 'rec' } },
      { read: 'box_x', as: 'u16' },
      { write: 'box_y', value: 50, as: 'u16' },
      { assertRam: 'box_y', as: 'u16', equals: 50 },
      { saveState: 'seq' },
    ],
    outDir: rel('seq'),
  });
  ok('run_sequence passes', !r.isError && r.structuredContent.pass === true, textOf(r).split('\n')[0]);
  ok('run_sequence returns shot + contact sheet', images(r).length === 2, `${images(r).length} images`);
  ok('run_sequence reports read values', /read box_x = \d+/.test(textOf(r)), textOf(r));
  ok('run_sequence writes timeline.json', existsSync(path.join(OUT, 'seq', 'timeline.json')));
  r = await call('run_sequence', { steps: [{ assertRam: 'box_y', as: 'u16', equals: 1 }] });
  ok('failed assertRam → isError', r.isError && r.structuredContent.failures === 1);
  r = await call('run_sequence', { steps: [{ bogus: 1 }] });
  ok('unknown steps rejected', r.isError && /unknown step/.test(textOf(r)));

  // --- Cheats, memory cards ---
  r = await call('cheats', { codes: ['80010000 0000'] });
  ok('cheats set', !r.isError && /1 cheat/.test(textOf(r)));
  await call('cheats', { codes: [] });
  r = await call('memory_card', { action: 'export', path: rel('empty.mcr') });
  ok('exporting an unwritten card says so', r.isError ? /no memory card data/.test(textOf(r)) : existsSync(path.join(OUT, 'empty.mcr')), textOf(r));
  const card = Buffer.alloc(128 * 1024); card.write('MC', 0, 'latin1');
  await writeFile(path.join(OUT, 'in.mcr'), card);
  r = await call('memory_card', { action: 'import', path: rel('in.mcr'), slot: 1 });
  ok('memory_card import', !r.isError, textOf(r));
  r = await call('memory_card', { action: 'export', path: rel('out.mcr'), slot: 1 });
  ok('memory_card export round-trips', !r.isError && (await readFile(path.join(OUT, 'out.mcr'))).equals(card), textOf(r));

  // --- RAM search ---
  await call('write_memory', { address: 'box_y', value: 77, as: 'u16' });
  r = await call('ram_search', { action: 'start', type: 'u16', value: 77 });
  ok('ram_search start with a value', !r.isError && r.structuredContent.count > 0, textOf(r).split('\n')[0]);
  await call('write_memory', { address: 'box_y', value: 78, as: 'u16' });
  r = await call('ram_search', { action: 'filter', op: 'eq', value: 78 });
  ok('ram_search finds box_y', /box_y/.test(textOf(r)), textOf(r));

  // --- Video ---
  r = await call('record_video', { frames: 20, path: rel('clip.gif') });
  ok('record_video writes a GIF', !r.isError && existsSync(path.join(OUT, 'clip.gif')), textOf(r));
  r = await call('record_video', { frames: 20, path: rel('clip.wav') });
  ok('record_video writes a WAV', !r.isError && (await readFile(path.join(OUT, 'clip.wav'))).toString('latin1', 0, 4) === 'RIFF', textOf(r));

  // --- export_script and replay ---
  await call('load_disc', { path: EXE });
  await call('press', { button: 'RIGHT', hold: 15, release: 5 });
  await call('wait_frames', { frames: 30 });
  await call('set_analog', { stick: 'left', x: 0, y: 0 });
  const xBefore = (await call('read_memory', { address: 'box_x', as: 'u16' })).structuredContent.values[0];
  r = await call('export_script', { path: rel('script.json') });
  const script = scriptOf(r);
  ok('export_script records the session', script.steps.some((s) => s.tap === 'RIGHT') && script.steps.some((s) => s.analog === 'left'), JSON.stringify(script.steps));
  await call('load_disc', { path: EXE });
  r = await call('run_sequence', { steps: [...script.steps, { assertRam: 'box_x', as: 'u16', equals: xBefore }] });
  ok('exported script replays', !r.isError, textOf(r));

  // --- Analog via MCP ---
  r = await call('load_disc', { path: EXE, pad1: 'analog' });
  ok('load_disc with an analog pad', !r.isError && /pad analog/.test(textOf(r)), textOf(r));
  r = await call('set_analog', { stick: 'left', x: 127, y: 0 });
  ok('set_analog reports the stick', /P1:left 127,0/.test(textOf(r)), textOf(r));
  await call('wait_frames', { frames: 10 });
  r = await call('read_memory', { address: 'stick_lx' , as: 'u8' });
  ok('the game reads the stick', r.structuredContent.values[0] >= 0xf0, textOf(r));
  await call('set_analog', { stick: 'left' });

  // --- Disc + PAL + HLE options, reset ---
  r = await call('load_disc', { path: CUE, bios: 'hle', region: 'pal' });
  ok('load_disc a .cue with hle + pal', !r.isError && /HLE BIOS, PAL, pad dualshock/.test(textOf(r)), textOf(r));
  r = await call('status');
  ok('status shows bios and region', r.structuredContent.bios === 'hle' && r.structuredContent.region === 'pal');
  r = await call('reset');
  ok('reset', !r.isError, textOf(r));
  r = await call('load_disc', { path: 'harness/package.json' });
  ok('load_disc refuses a non-PS1 file', r.isError && /not a PS1/.test(textOf(r)), textOf(r));

  // --- A/B ---
  r = await call('ab_compare', { romA: EXE, romB: CUE, steps: [{ wait: 400 }, { read: 'frame_count', as: 'u32' }] });
  ok('ab_compare runs both', !r.isError && /DIFFERENT|IDENTICAL/.test(textOf(r)), textOf(r).split('\n')[0]);

  // --- Resources ---
  const res = /** @type {any} */ (await client.readResource({ uri: 'emu://status' }));
  ok('emu://status resource', JSON.parse(res.contents[0].text).loaded === true);

  // --- Path safety ---
  r = await call('screenshot', { save: '/tmp/ps1test-outside.png' });
  ok('writes outside the workspace are refused', r.isError && /refusing to write/.test(textOf(r)));

  // --- Build (a shell command) ---
  r = await call('build', { command: 'echo "src/main.c:3:1: error: expected \';\'" && exit 1' });
  ok('build failure reports file:line errors', r.isError && /src\/main\.c:3:1: error: expected/.test(textOf(r)), textOf(r));
  r = await call('build', { command: 'true', rom: EXE });
  ok('build success reloads with the last options', !r.isError && /Loaded harness\/tests\/fixtures\/hello\.exe \(HLE BIOS/.test(textOf(r)), textOf(r));
} finally {
  await close();
}
done();
