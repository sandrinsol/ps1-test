// The SPU as text: which voices play what (start address, pitch as a sample
// rate, envelope, volumes) and, when nothing is heard, the usual reasons.

const hex = (n) => '0x' + (n >>> 0).toString(16);
/** Raw SPU pitch (4096 = 44.1 kHz) → sample rate in Hz. */
export const pitchToRate = (p) => Math.round((p * 44100) / 4096);

/**
 * @param {{ ctrl: number, audible: number, keyedOn: number, irqAddr: number | null,
 *   voices: { voice: number, current: number, loop: number, envelope: number, adsr: string,
 *   noise: boolean, reverb: boolean, fmod: boolean, pitch: number, volL: number, volR: number }[] }} st
 *   the driver's spuState()
 * @param {Buffer} regs the 0x400 bytes of SPU registers (0x1F801C00…)
 * @param {{ all?: boolean }} [opts] all: list idle voices too
 * @returns {{ lines: string[], playing: number, problems: string[] }}
 */
export function describeSpu(st, regs, { all = false } = {}) {
  const r16 = (o) => regs.readUInt16LE(o), s16 = (o) => regs.readInt16LE(o);
  const ctrl = r16(0x1aa), mainL = s16(0x180), mainR = s16(0x182);
  const on = !!(ctrl & 0x8000), unmuted = !!(ctrl & 0x4000);
  const lines = [`SPU ${on ? 'on' : 'OFF'}, ${unmuted ? 'unmuted' : 'MUTED'}, main volume ${mainL}/${mainR}, reverb ${ctrl & 0x80 ? 'on' : 'off'}${st.irqAddr !== null && ctrl & 0x40 ? `, IRQ at ${hex(st.irqAddr)}` : ''}.`];
  const problems = [];
  if (!on) problems.push('the SPU is off (SPUCNT 0x1F801DAA bit 15)');
  if (on && !unmuted) problems.push('the SPU is muted (SPUCNT bit 14 clear)');
  if (on && mainL === 0 && mainR === 0) problems.push('main volume is 0 (0x1F801D80/82)');
  let playing = 0;
  for (const v of st.voices) {
    const b = v.voice * 16;
    const start = r16(b + 6) * 8, adsr1 = r16(b + 8), adsr2 = r16(b + 10);
    const active = v.envelope > 0 || (st.audible >>> v.voice) & 1;
    if (active) playing++;
    if (!active && !all) continue;
    const flags = [v.noise && 'noise', v.reverb && 'reverb', v.fmod && 'fmod'].filter(Boolean).join(',');
    lines.push(`voice ${v.voice}: ${active ? v.adsr : 'idle'} env ${Math.round((Math.max(0, v.envelope) * 100) / 0x7fffffff)}% vol ${v.volL}/${v.volR} pitch ${hex(v.pitch)} (${pitchToRate(v.pitch)} Hz) start ${hex(start)} now ${hex(v.current)} loop ${hex(v.loop)} adsr ${hex(adsr1)}/${hex(adsr2)}${flags ? ` ${flags}` : ''}`);
    if (active && v.volL === 0 && v.volR === 0) problems.push(`voice ${v.voice} plays at volume 0`);
    if (active && v.pitch === 0) problems.push(`voice ${v.voice} has pitch 0 (it never advances)`);
    if (active && start < 0x1000) problems.push(`voice ${v.voice} plays from ${hex(start)}, inside the SPU's reserved area (samples belong at 0x1000 or above)`);
  }
  if (!playing) lines.push('No voice is playing.');
  return { lines, playing, problems };
}

/** The ADPCM sample starting at `offset` in SPU RAM, up to its end flag
 *  (with the repeat flag: one pass of the loop) → { adpcm, loopAt (bytes into
 *  it, or null), looped }. */
export function sampleAt(ram, offset) {
  let loopAt = null, o = offset;
  for (; o + 16 <= ram.length; o += 16) {
    const flags = ram[o + 1];
    if (flags & 4 && loopAt === null) loopAt = o - offset;
    if (flags & 1) { o += 16; break; }
  }
  const end = ram[o - 15] ?? 0;
  return { adpcm: ram.subarray(offset, o), loopAt, looped: !!(end & 2) };
}
