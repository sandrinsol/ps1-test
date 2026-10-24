import { EmuHarness } from '/home/user/ps1-test/harness/driver.mjs';
import { summarizeCd } from '/home/user/ps1-test/harness/cdrom.mjs';
import { isoList, dataTrack } from '/home/user/ps1-test/harness/disc.mjs';
const emu = await EmuHarness.launch('/home/user/ps1-test/demo/demo.cue', { reuse: true });
// CD log during boot
const cd = await emu.cdLog(240);
const img = await dataTrack('/home/user/ps1-test/demo/demo.cue');
const files = isoList(img);
console.log('files', files.map((f) => `${f.path}@${f.lba}+${f.size}`).join(' '));
const sum = summarizeCd(cd.entries, { files, name: (a) => emu.symbols?.nameOf?.(a) ?? null });
console.log(sum.text.split('\n').slice(0, 25).join('\n'), '\n', { commands: sum.commands, sectors: sum.sectors, errors: sum.errors });
console.log('frame', await emu.frameNum());
// watch frame_count writes (log mode)
await emu.debugSet({ watch: [{ address: 'frame_count', on: 'write' }] });
await emu.waitFrames(5);
let st = await emu.debugState();
console.log('log hits', st.total, st.hits.slice(0, 2).map((h) => `${h.kind} pc=${h.pc.toString(16)} ${h.old}->${h.value}`));
// halt on write
const f0 = await emu.frameNum();
await emu.debugSet({ watch: [{ address: 'frame_count', on: 'write' }], halt: true });
await emu.waitFrames(10);
st = await emu.debugState();
console.log('halted', st.halted, st.partial, 'frame', await emu.frameNum(), 'from', f0, 'pc', st.regs.pc.toString(16), st.hits.map((h) => h.pc.toString(16)));
const ran = await emu.debugStep(3);
st = await emu.debugState();
console.log('stepped', ran, 'pc', st.regs.pc.toString(16));
await emu.waitFrames(1);
st = await emu.debugState();
console.log('after wait halted', st.halted, st.partial, 'frame', await emu.frameNum());
await emu.debugOff();
const fa = await emu.frameNum();
await emu.waitFrames(5);
console.log('clock ok', (await emu.frameNum()) - fa);
// profile
const p = await emu.profile(30);
const counts = new Map();
for (const pc of p.samples) { const n = emu.symbols?.nameOf?.(pc) ?? pc.toString(16); counts.set(n, (counts.get(n) || 0) + 1); }
console.log('samples', p.samples.length, [...counts].sort((a, b) => b[1] - a[1]).slice(0, 8));
// spu
await emu.tap('CROSS', 2, 2);
const spu = await emu.spuState();
console.log('spu ctrl', spu.ctrl.toString(16), 'audible', spu.audible.toString(2), spu.voices[0]);
await emu.close();
