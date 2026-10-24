// The CD-ROM command log of the instrumented core, decoded: what the game asked
// the drive (commands with their parameters), what the drive answered
// (interrupts with result bytes) and which sectors it read — mapped to the
// files of the disc's ISO9660 file system when the disc image is at hand.

const CMDS = ['Sync', 'Getstat', 'Setloc', 'Play', 'Forward', 'Backward', 'ReadN', 'Standby', 'Stop', 'Pause',
  'Init', 'Mute', 'Demute', 'Setfilter', 'Setmode', 'Getparam', 'GetlocL', 'GetlocP', 'SetSession', 'GetTN',
  'GetTD', 'SeekL', 'SeekP', 'SetClock', 'GetClock', 'Test', 'GetID', 'ReadS', 'Reset', 'GetQ', 'ReadTOC'];
export const IRQS = { 1: 'INT1 data ready', 2: 'INT2 complete', 3: 'INT3 acknowledge', 4: 'INT4 data end', 5: 'INT5 error' };
const bcd = (b) => (b >> 4) * 10 + (b & 15);
const pad = (n) => String(n).padStart(2, '0');
/** MSF (binary minute, second, frame) → sector number (LBA; 00:02:00 is sector 0). */
export const msfToLba = (m, s, f) => (m * 60 + s) * 75 + f - 150;

/** Decode log words (LE u32 buffer) → [{ type, cycle, ... }]; non-CD entries are skipped. */
export function decodeCdLog(buf) {
  const w = new Uint32Array(buf.buffer, buf.byteOffset, buf.length >> 2);
  const out = [];
  const bytes = (from, n) => Array.from({ length: n }, (_, i) => (w[from + (i >> 2)] >>> ((i & 3) * 8)) & 0xff);
  for (let i = 0; i + 1 < w.length;) {
    const type = w[i] >>> 28, n = w[i] & 0xffffff, cycle = w[i + 1], d = i + 2;
    if (type === 5) {
      const cmd = w[d] & 0xff, pc = w[d] >>> 8 & 0xff;
      out.push({ type: 'command', cycle, cmd, name: CMDS[cmd] ?? `0x${cmd.toString(16)}`, params: bytes(d + 1, pc), pc: w[d + 5] });
    } else if (type === 6) {
      const irq = w[d] & 0xff, cmd = (w[d] >>> 8) & 0xffff, rn = w[d] >>> 24;
      out.push({ type: 'irq', cycle, irq, name: IRQS[irq] ?? `INT${irq}`, cmd, result: bytes(d + 1, Math.min(rn, 16)) });
    } else if (type === 7) {
      const m = w[d] & 0xff, s = (w[d] >>> 8) & 0xff, f = (w[d] >>> 16) & 0xff;
      out.push({ type: 'read', cycle, msf: [m, s, f], lba: msfToLba(m, s, f) });
    }
    i = d + n;
  }
  return out;
}

const hex2 = (b) => b.toString(16).padStart(2, '0');
const STATUS = (s) => [s & 1 ? 'error' : '', s & 2 ? 'motor' : '', s & 4 ? 'seek-error' : '', s & 0x10 ? 'lid-open' : '',
  s & 0x20 ? 'reading' : '', s & 0x40 ? 'seeking' : '', s & 0x80 ? 'playing' : ''].filter(Boolean).join(',') || 'idle';

/** Which file holds sector `lba` (files from disc.mjs isoList). */
export function fileAt(files, lba) {
  for (const f of files) if (!f.dir && lba >= f.lba && lba < f.lba + Math.max(1, Math.ceil(f.size / 2048))) return f;
  return null;
}

/**
 * Readable summary: one line per command (with its answers), sector reads folded
 * into runs with the file they belong to, and totals.
 * @param {ReturnType<typeof decodeCdLog>} entries
 * @param {{ files?: { path: string, lba: number, size: number, dir: boolean }[],
 *   name?: (addr: number) => string | null, cyclesPerFrame?: number, limit?: number }} [opts]
 */
export function summarizeCd(entries, { files = [], name = () => null, cyclesPerFrame = 564480, limit = 80 } = {}) {
  const lines = [], t0 = entries[0]?.cycle ?? 0;
  const when = (c) => `+${(((c - t0) >>> 0) / cyclesPerFrame).toFixed(1)}f`;
  let run = null, sectors = 0, errors = 0, commands = 0, seeks = 0;
  const flush = () => {
    if (!run) return;
    const f = fileAt(files, run.from);
    const where = f ? ` ${f.path}${run.from > f.lba ? ` from sector ${run.from - f.lba}` : ''}` : '';
    lines.push(`${run.when} read ${run.n} sector(s) ${run.from}-${run.to} (${run.msf})${where}`);
    run = null;
  };
  for (const e of entries) {
    if (e.type === 'read') {
      sectors++;
      if (run && e.lba === run.to + 1) { run.to = e.lba; run.n++; continue; }
      flush();
      run = { from: e.lba, to: e.lba, n: 1, when: when(e.cycle), msf: e.msf.map(pad).join(':') };
      continue;
    }
    flush();
    if (e.type === 'command') {
      commands++;
      if (e.name === 'Setloc' || e.name === 'SeekL' || e.name === 'SeekP') seeks++;
      let p = e.params.map(hex2).join(' ');
      if (e.name === 'Setloc' && e.params.length === 3) {
        const lba = msfToLba(bcd(e.params[0]), bcd(e.params[1]), bcd(e.params[2]));
        const f = fileAt(files, lba);
        p = `${e.params.map(hex2).join(':')} = sector ${lba}${f ? ` (${f.path}${lba > f.lba ? ` +${lba - f.lba}` : ''})` : ''}`;
      }
      const fn = name(e.pc);
      lines.push(`${when(e.cycle)} ${e.name}${p ? ' ' + p : ''}${fn ? `  [from ${fn}]` : ''}`);
    } else if (e.type === 'irq') {
      if (e.irq === 5) errors++;
      if (e.irq === 1) continue;   // one per sector: the reads say it
      const st = e.result.length ? ` stat ${hex2(e.result[0])} (${STATUS(e.result[0])})${e.result.length > 1 ? ' ' + e.result.slice(1).map(hex2).join(' ') : ''}` : '';
      lines.push(`${when(e.cycle)}   → ${e.name}${st}`);
    }
  }
  flush();
  const shown = lines.length > limit ? [...lines.slice(0, limit), `… ${lines.length - limit} more line(s)`] : lines;
  return { text: shown.join('\n'), commands, sectors, seeks, errors };
}
