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

/** Which file (or directory, or file-system structure) holds sector `lba`
 *  (entries from disc.mjs isoList). */
export function fileAt(files, lba) {
  for (const f of files) if (lba >= f.lba && lba < f.lba + Math.max(1, Math.ceil(f.size / 2048))) return f.dir && !f.path.endsWith(')') ? { ...f, path: f.path + '/ (directory)' } : f;
  return null;
}

/**
 * Readable summary: one line per command with the drive's answers appended
 * ("→ ack", "→ done", "→ ERROR …"), sector reads folded into runs with the file
 * they belong to, and totals (including which files were read).
 * @param {ReturnType<typeof decodeCdLog>} entries
 * @param {{ files?: { path: string, lba: number, size: number, dir: boolean }[],
 *   name?: (addr: number) => string | null, cyclesPerFrame?: number, limit?: number }} [opts]
 */
export function summarizeCd(entries, { files = [], name = () => null, cyclesPerFrame = 564480, limit = 80 } = {}) {
  const lines = [], t0 = entries[0]?.cycle ?? 0;
  const when = (c) => `+${(((c - t0) >>> 0) / cyclesPerFrame).toFixed(1)}f`;
  const lineOf = new Map();    // command id -> index of its line
  const read = new Map();      // file path -> sectors read
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
      const f = fileAt(files, e.lba);
      const key = f ? f.path : 'other sectors';
      read.set(key, (read.get(key) ?? 0) + 1);
      if (run && e.lba === run.to + 1) { run.to = e.lba; run.n++; continue; }
      flush();
      run = { from: e.lba, to: e.lba, n: 1, when: when(e.cycle), msf: e.msf.map(pad).join(':') };
      continue;
    }
    if (e.type === 'command') {
      flush();
      commands++;
      if (e.name === 'Setloc' || e.name === 'SeekL' || e.name === 'SeekP') seeks++;
      let p = e.params.map(hex2).join(' ');
      if (e.name === 'Setloc' && e.params.length === 3) {
        const lba = msfToLba(bcd(e.params[0]), bcd(e.params[1]), bcd(e.params[2]));
        const f = fileAt(files, lba);
        const at = f ? `${f.path}${lba > f.lba ? ` +${lba - f.lba}` : ''}` : '';
        p = `${e.params.map(hex2).join(':')} = sector ${lba}${at ? (at.startsWith('(') ? ` ${at}` : ` (${at})`) : ''}`;
      }
      const fn = name(e.pc);
      lineOf.set(e.cmd, lines.length);
      lines.push(`${when(e.cycle)} ${e.name}${p ? ' ' + p : ''}${fn ? `  [${fn}]` : ''}`);
    } else if (e.type === 'irq') {
      if (e.irq === 1) continue;   // one per sector: the reads say it
      const stat = e.result[0] ?? 0;
      let note;
      if (e.irq === 5) { errors++; note = `ERROR stat ${hex2(stat)} (${STATUS(stat)})${e.result.length > 1 ? ' code ' + hex2(e.result[1]) : ''}`; }
      else if (e.irq === 3) note = 'ack';
      else if (e.irq === 2) note = 'done';
      else note = e.name;
      if (stat & 0x15 && e.irq !== 5) note += ` (${STATUS(stat)})`;
      const i = lineOf.get(e.cmd & 0xff);
      if (i !== undefined && e.irq !== 5) lines[i] += ` → ${note}`;
      else { flush(); lines.push(`${when(e.cycle)}   → ${note}`); }
    }
  }
  flush();
  const shown = lines.length > limit ? [...lines.slice(0, limit), `… ${lines.length - limit} more line(s)`] : lines;
  const filesRead = [...read].map(([f, n]) => `${f} (${n})`).join(', ');
  return { text: shown.join('\n'), commands, sectors, seeks, errors, filesRead };
}
