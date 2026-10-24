// End-to-end tests of the driver on the bundled pcsx_rearmed core: booting an
// EXE and a disc with each BIOS, the frame clock, buttons and analog sticks,
// determinism, fast-forward, save states, waits, RAM / scratchpad / CPU reads
// and writes, memory cards, cheats, RAM search, and audio capture.
//
//   node tests/core.mjs

import { readFile, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { ok, done, EXE, CUE, HARNESS } from './lib.mjs';
import { EmuHarness, BOOT_FRAME } from '../driver.mjs';
import { compare } from '../assert.mjs';
import { decodePng } from '../png.mjs';
import { RamSearch } from '../ramsearch.mjs';
import { saveVideo } from '../recording.mjs';

const OUT = path.join(HARNESS, 'out', 'core-test');
await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

// Background colour (BGR555 0x402010 → RGB of the box test).
const pixel = (png, x, y) => { const img = decodePng(png); const o = (y * img.width + x) * img.channels; return [img.data[o], img.data[o + 1], img.data[o + 2]]; };
const isRed = (p) => p[0] > 200 && p[1] < 40 && p[2] < 40;

try {
  // ---- Boot: EXE with OpenBIOS (default) ----
  const emu = await EmuHarness.launch(EXE, { reuse: true });
  ok('boots with OpenBIOS by default', emu.options.bios === 'openbios' && (await emu.readRegions()).hle === false);
  ok('symbols found beside the EXE', emu.symbols?.get('frame_count') !== undefined);
  ok('launch leaves the machine on BOOT_FRAME', (await emu.frameNum()) === BOOT_FRAME, `${await emu.frameNum()}`);
  ok('instrumented core: live memory', emu.live === true);
  await emu.waitFrames(60);
  ok('frame clock matches the game\'s VSync counter', (await emu.readU32('frame_count')) === 70, `${await emu.readU32('frame_count')}`);
  const shot = await emu.screenshot(path.join(OUT, 'boot.png'));
  const img = decodePng(shot);
  ok('screenshot is the native 320x240 frame', img.width === 320 && img.height === 240, `${img.width}x${img.height}`);
  ok('box drawn at 144,104', isRed(pixel(shot, 150, 110)) && !isRed(pixel(shot, 10, 10)));
  const cpu = await emu.readCpu();
  ok('pc in main', /^main/.test(emu.symbols.nameOf(cpu.pc) ?? ''), emu.symbols.nameOf(cpu.pc));
  ok('stack pointer in RAM', cpu.sp >= 0x801f0000 && cpu.sp < 0x80200000, cpu.sp.toString(16));

  // ---- Live memory and save-state parsing agree ----
  emu.live = false;
  const viaState = [await emu.readU32('frame_count'), (await emu.readMemory(0x1f801070, 8)).toString('hex'), (await emu.readMemory(0xbfc00100, 16)).toString('hex')];
  emu.live = true;
  const viaLive = [await emu.readU32('frame_count'), (await emu.readMemory(0x1f801070, 8)).toString('hex'), (await emu.readMemory(0xbfc00100, 16)).toString('hex')];
  ok('live reads match save-state reads (RAM, I/O, BIOS)', JSON.stringify(viaState) === JSON.stringify(viaLive), `${JSON.stringify(viaState)} vs ${JSON.stringify(viaLive)}`);
  emu.live = false;
  ok('state-path write sticks', await emu.writeMemory('box_y', Buffer.from([104, 0])));
  emu.live = true;

  // ---- Memory: mirrors, scratchpad, I/O, writes ----
  const fc = await emu.readU32('frame_count');
  const addr = emu.addr('frame_count');
  ok('KUSEG and KSEG1 mirrors read the same RAM', (await emu.readU32(addr & 0x1fffffff)) === fc && (await emu.readU32(((addr & 0x1fffffff) | 0xa0000000) >>> 0)) === fc);
  ok('I/O: GPUSTAT readable at 0x1F801814', typeof (await emu.readU32(0x1f801814)) === 'number');
  ok('BIOS readable at 0xBFC00000', (await emu.readMemory(0xbfc00000, 4)).length === 4);
  ok('write to RAM sticks', await emu.writeMemory('box_x', Buffer.from([10, 0])));
  await emu.waitFrames(1);
  ok('game sees the write (box moved to x=10)', isRed(pixel(await emu.screenshot(), 15, 110)));
  ok('scratchpad write', (await emu.writeMemory(0x1f800010, Buffer.from([1, 2, 3, 4]))) && (await emu.readU32(0x1f800010)) === 0x04030201);
  let threw = '';
  try { await emu.writeMemory(0xbfc00000, Buffer.from([0])); } catch (e) { threw = e.message; }
  ok('BIOS writes refused', /read-only/.test(threw));

  // ---- Buttons ----
  await emu.writeU16('box_x', 100);
  await emu.setButton('RIGHT', true);
  await emu.waitFrames(30);
  await emu.setButton('RIGHT', false);
  await emu.waitFrames(1);
  ok('holding RIGHT 30 frames moves the box 30 px', (await emu.readU16('box_x')) === 130, `${await emu.readU16('box_x')}`);
  await emu.setButton('CROSS', true);
  await emu.waitFrames(2);
  ok('CROSS reads as bit 14 of the pad', ((await emu.readU16('pad_buttons')) & (1 << 14)) !== 0);
  ok('heldButtons lists CROSS', (await emu.heldButtons()).includes('CROSS'));
  await emu.setButton('CROSS', false);
  await emu.waitFrames(2);
  for (const [b, bit] of /** @type {Array<[string, number]>} */ ([['TRIANGLE', 12], ['CIRCLE', 13], ['SQUARE', 15], ['L1', 10], ['R1', 11], ['L2', 8], ['R2', 9], ['START', 3], ['SELECT', 0]])) {
    await emu.setButton(b, true); await emu.waitFrames(2);
    const v = await emu.readU16('pad_buttons');
    await emu.setButton(b, false); await emu.waitFrames(2);
    ok(`${b} → pad bit ${bit}`, v === (1 << bit), v.toString(16));
  }
  ok('DualShock reports digital mode (0x41) until the game asks for analog', (await emu.readU8('pad_id')) === 0x41);

  // ---- Save states, waits, determinism of reloads ----
  const st = await emu.saveState();
  const f0 = await emu.frameNum();
  await emu.waitFrames(30);
  const after = await emu.readU32('frame_count');
  await emu.loadState(st, { frame: f0 });
  ok('loadState rewinds RAM and the clock', (await emu.frameNum()) === f0 && (await emu.readU32('frame_count')) === after - 30);
  await emu.waitFrames(30);
  ok('replay after load is identical', (await emu.readU32('frame_count')) === after);
  const w = await emu.waitFor({ address: 'frame_count', as: 'u32', op: 'gte', value: after + 200 }, { maxFrames: 400 });
  ok('waitFor stops on the first frame the condition holds (fast-forwarded)', w.met && (await emu.readU32('frame_count')) === after + 200, JSON.stringify(w));
  const precise = await emu.waitFor({ address: 'frame_count', as: 'u32', op: 'eq', value: after + 205 }, { maxFrames: 20, precise: true });
  ok('precise waitFor', precise.met && (await emu.readU32('frame_count')) === after + 205);
  const stable = await emu.waitFor({ screen: 'stable', frames: 10 }, { maxFrames: 60 });
  ok('screen stable (nothing moving)', stable.met);
  await emu.setButton('DOWN', true);
  const changed = await emu.waitFor({ screen: 'changed' }, { maxFrames: 60 });
  await emu.setButton('DOWN', false);
  ok('screen changed once the box moves', changed.met);

  // ---- Reset ----
  await emu.restart();
  ok('reset of an EXE restarts it: box back at x=144, clock at BOOT_FRAME', (await emu.readU16('box_x')) === 144 && (await emu.frameNum()) === BOOT_FRAME);
  await emu.waitFrames(200);
  ok('reset: the frame clock still matches the game\'s counter', (await emu.readU32('frame_count')) === (await emu.frameNum()), `${await emu.readU32('frame_count')} vs ${await emu.frameNum()}`);

  // ---- Cheats ----
  // GameShark 30 = 8-bit write, 80 = 16-bit write, applied every frame.
  const bx = emu.addr('box_x');
  await emu.setCheats([`80${(bx & 0xffffff).toString(16).padStart(6, '0')} 0020`]);
  await emu.waitFrames(5);
  ok('GameShark 16-bit write holds box_x at 32', (await emu.readU16('box_x')) === 32, `${await emu.readU16('box_x')}`);
  await emu.setCheats([]);

  // ---- RAM search: find box_y by moving the box ----
  await emu.writeU16('box_y', 100);
  await emu.waitFrames(1);
  const rs = new RamSearch('psx', await emu.readRegions(), { type: 'u16' });
  rs.filter(await emu.readRegions(), 'eq', 100);
  await emu.setButton('DOWN', true); await emu.waitFrames(5); await emu.setButton('DOWN', false); await emu.waitFrames(1);
  rs.filter(await emu.readRegions(), 'increased');
  rs.filter(await emu.readRegions(), 'eq', 105);
  ok('ram search narrows to box_y', rs.results(5).some((r) => r.address === emu.addr('box_y')), `${rs.count} left`);

  // ---- Memory cards ----
  const card = Buffer.alloc(128 * 1024);
  card.write('MC', 0, 'latin1');
  card.write('test card', 0x2000, 'latin1');
  await emu.writeMemoryCard(card, { slot: 1 });
  ok('memory card import then export round-trips (slot 1)', (await emu.readMemoryCard(1))?.equals(card));
  await emu.writeMemoryCard(card, { slot: 2, reset: false });
  ok('memory card slot 2 round-trips', (await emu.readMemoryCard(2))?.equals(card));

  // ---- Audio: hold CROSS to sound the tone ----
  await emu.setButton('CROSS', true);
  const recFrom = await emu.frameNum();
  const caps = await emu.record(60, { every: 2 });
  await emu.setButton('CROSS', false);
  const a = caps.audio;
  let peak = 0;
  if (a) for (let i = 0; i < a.pcm.length; i += 2) peak = Math.max(peak, Math.abs(a.pcm.readInt16LE(i)));
  ok('recording captures the start frame and every 2nd frame to the end', caps.length === 31 && caps.every((c, i) => c.frame === recFrom + i * 2), caps.map((c) => c.frame).join(','));
  ok('recording captures the SPU tone', !!a && peak > 1000, a ? `peak ${peak} at ${a.rate} Hz` : 'no audio');
  const gif = await saveVideo(caps, path.join(OUT, 'tone.gif'), { audio: 'off' });
  ok('gif written', (await readFile(gif.file)).toString('latin1', 0, 6) === 'GIF89a');
  await emu.close();

  // ---- GPU command capture and exceptions (instrumented core) ----
  {
    const g = await EmuHarness.launch(EXE, { reuse: true });
    await g.waitFrames(20);
    const cap = await g.captureFrame();
    const kinds = cap.prims.map((p) => p.kind).join(' ');
    ok('captureFrame decodes the frame: 2 fills, triangle, sprite, line', kinds === 'fill fill poly3 sprite line', kinds);
    ok('capture advances one frame', cap.frame === BOOT_FRAME + 21);
    const tri = cap.prims[2], spr = cap.prims[3];
    ok('gouraud triangle from the DMA chain, with its RAM address', tri.gouraud && tri.src === 'chain' && g.symbols.nameOf(tri.addr) === 'ot_packets+4', g.symbols.nameOf(tri.addr));
    ok('sprite: 4-bit texture page 640,0 and CLUT 640,480', spr.texpage.x === 640 && spr.texpage.depth === '4bit' && spr.clut.x === 640 && spr.clut.y === 480);
    ok('chain start logged', cap.chains.length === 1 && cap.chains[0] === g.addr('ot_packets'));
    ok('draw environment', cap.env.drawArea.x1 === 319 && cap.env.drawArea.y1 === 239);
    ok('no exceptions in a normal frame', cap.exceptions.length === 0);
    await g.setButtons(['L2', 'R2', 'SELECT'], true);
    const crash = await g.captureFrame(3);
    const e = crash.exceptions[0];
    ok('an unaligned load raises an address error (AdEL) at the faulting instruction', e && e.code === 4 && /^main/.test(g.symbols.nameOf(e.epc) ?? '') && e.badVaddr === 0x80010002, e && `${e.code} ${g.symbols.nameOf(e.epc)} ${e.badVaddr.toString(16)}`);
    await g.close();
  }

  // ---- Determinism + fast-forward: same script twice, once at 1x ----
  const run = async (fast) => {
    const h = await EmuHarness.launch(EXE, { reuse: true, fast });
    await h.waitFrames(300);
    await h.tap('RIGHT', 20, 10);
    await h.waitFrames(250);
    const r = { png: await h.screenshot(), ram: Buffer.from((await h.readRegions()).ram), frame: await h.frameNum() };
    await h.close();
    return r;
  };
  const A = await run(true), B = await run(true), C = await run(false);
  ok('deterministic: identical frames', compare(A.png, B.png).fraction === 0);
  ok('deterministic: identical RAM', A.ram.equals(B.ram));
  ok('fast-forward gives the same result as 1x', A.ram.equals(C.ram) && compare(A.png, C.png).fraction === 0);

  // ---- Disc boot through OpenBIOS, and HLE ----
  for (const bios of ['openbios', 'hle']) {
    const d = await EmuHarness.launch(CUE, { reuse: true, bios });
    const r = await d.waitFor({ address: 'frame_count', as: 'u32', op: 'gte', value: 10 }, { maxFrames: 900 });
    ok(`disc boots with ${bios}`, r.met, `game running by frame ${r.frame}`);
    ok(`disc with ${bios}: BIOS flag`, (await d.readRegions()).hle === (bios === 'hle'));
    await d.close();
  }

  // ---- Analog pad: the left stick moves the box ----
  const an = await EmuHarness.launch(EXE, { reuse: true, pad1: 'analog' });
  ok('analog boot also ends on BOOT_FRAME', (await an.frameNum()) === BOOT_FRAME);
  await an.waitFrames(30);
  ok('analog pad id 0x73', (await an.readU8('pad_id')) === 0x73, (await an.readU8('pad_id')).toString(16));
  const x0 = await an.readU16('box_x');
  await an.setAnalog('left', 127, 0);
  await an.waitFrames(10);
  ok('stick right reads ~0xFF', (await an.readU8('stick_lx')) >= 0xf0, `${await an.readU8('stick_lx')}`);
  ok('stick right moves the box', (await an.readU16('box_x')) - x0 >= 20, `${x0} → ${await an.readU16('box_x')}`);
  await an.setAnalog('left', 0, -128);
  await an.waitFrames(2);
  ok('stick up reads ~0x00, x back to centre', (await an.readU8('stick_ly')) <= 0x10 && Math.abs((await an.readU8('stick_lx')) - 0x80) <= 2, `${await an.readU8('stick_lx')},${await an.readU8('stick_ly')}`);
  await an.close();

  // ---- Disc reset re-boots the disc ----
  const dr = await EmuHarness.launch(CUE, { reuse: true, bios: 'hle' });
  await dr.waitFrames(60);
  await dr.restart();
  ok('disc reset ends on BOOT_FRAME', (await dr.frameNum()) === BOOT_FRAME);
  const back = await dr.waitFor({ address: 'frame_count', as: 'u32', op: 'gte', value: 5 }, { maxFrames: 600 });
  ok('disc reset re-boots the game', back.met && (await dr.frameNum()) < 300, `running again by frame ${back.frame}`);
  await dr.close();

  // ---- PAL ----
  const p = await EmuHarness.launch(EXE, { reuse: true, region: 'pal' });
  ok('PAL runs at 50 fps', p.fps === 50);
  await p.close();

  // ---- Errors ----
  try { await EmuHarness.launch(path.join(HARNESS, 'package.json'), { reuse: true }); threw = ''; } catch (e) { threw = e.message; }
  ok('a non-PS1 file is refused with a reason', /not a PS1/.test(threw), threw.slice(0, 80));
  try { await EmuHarness.launch(EXE, { reuse: true, bios: path.join(HARNESS, 'package.json') }); threw = ''; } catch (e) { threw = e.message; }
  ok('a wrong-size BIOS is refused', /512 KB/.test(threw));
} finally {
  await EmuHarness.shutdown();
}
done();
