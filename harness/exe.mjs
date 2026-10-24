// ELF → PS-EXE, for toolchains that leave you with only an .elf (a plain
// mipsel-gcc build): the loadable segments become one image at their lowest
// address, behind the 2 KB "PS-X EXE" header the BIOS loader expects.

const MARKERS = {
  'NTSC-U': 'Sony Computer Entertainment Inc. for North America area',
  'NTSC-J': 'Sony Computer Entertainment Inc. for Japan area',
  PAL: 'Sony Computer Entertainment Inc. for Europe area',
};

/** @param {Buffer} elf  32-bit little-endian MIPS ELF
 *  @param {{ region?: 'NTSC-U' | 'NTSC-J' | 'PAL', stack?: number }} [opts] */
export function elfToExe(elf, { region = 'NTSC-U', stack = 0x801ffff0 } = {}) {
  if (elf.readUInt32BE(0) !== 0x7f454c46 || elf[4] !== 1 || elf[5] !== 1) throw new Error('not a 32-bit little-endian ELF');
  if (elf.readUInt16LE(0x12) !== 8) throw new Error('not a MIPS ELF');
  const entry = elf.readUInt32LE(0x18);
  const phoff = elf.readUInt32LE(0x1c), phentsize = elf.readUInt16LE(0x2a), phnum = elf.readUInt16LE(0x2c);
  const segs = [];
  for (let i = 0; i < phnum; i++) {
    const o = phoff + i * phentsize;
    if (elf.readUInt32LE(o) !== 1) continue; // PT_LOAD
    const offset = elf.readUInt32LE(o + 4), vaddr = elf.readUInt32LE(o + 8), filesz = elf.readUInt32LE(o + 16);
    if (filesz) segs.push({ vaddr, data: elf.subarray(offset, offset + filesz) });
  }
  if (!segs.length) throw new Error('the ELF has no loadable segments');
  const load = Math.min(...segs.map((s) => s.vaddr));
  const end = Math.max(...segs.map((s) => s.vaddr + s.data.length));
  if (end - load > 0x200000) throw new Error(`the program is ${end - load} bytes; it must fit in the PS1's 2 MB of RAM`);
  const body = Buffer.alloc(Math.ceil((end - load) / 2048) * 2048);
  for (const s of segs) s.data.copy(body, s.vaddr - load);
  const hdr = Buffer.alloc(2048);
  hdr.write('PS-X EXE', 0, 'latin1');
  hdr.writeUInt32LE(entry, 0x10);
  hdr.writeUInt32LE(gpOf(elf), 0x14);
  hdr.writeUInt32LE(load >>> 0, 0x18);
  hdr.writeUInt32LE(body.length, 0x1c);
  hdr.writeUInt32LE(stack >>> 0, 0x30);
  hdr.write(MARKERS[region] ?? MARKERS['NTSC-U'], 0x4c, 'latin1');
  return Buffer.concat([hdr, body]);
}

/** The `_gp` symbol's value (0 if the program doesn't use $gp-relative data). */
function gpOf(elf) {
  const shoff = elf.readUInt32LE(0x20), shentsize = elf.readUInt16LE(0x2e), shnum = elf.readUInt16LE(0x30);
  for (let i = 0; i < shnum; i++) {
    const o = shoff + i * shentsize;
    if (elf.readUInt32LE(o + 4) !== 2) continue; // SHT_SYMTAB
    const off = elf.readUInt32LE(o + 16), size = elf.readUInt32LE(o + 20), link = elf.readUInt32LE(o + 24);
    const str = elf.readUInt32LE(shoff + link * shentsize + 16);
    for (let p = off; p + 16 <= off + size; p += 16) {
      const n = elf.readUInt32LE(p);
      if (n && elf.toString('latin1', str + n, str + n + 4) === '_gp\0') return elf.readUInt32LE(p + 4);
    }
  }
  return 0;
}
