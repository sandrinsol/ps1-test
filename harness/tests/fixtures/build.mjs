#!/usr/bin/env node
// Rebuild the test fixtures from src/ (needs a mipsel GCC: mipsel-none-elf-gcc
// or mipsel-linux-gnu-gcc). The outputs are committed, so the test suite itself
// needs no compiler.
//
//   hello.exe / hello.elf    bare-metal PS-EXE: a box the D-pad moves, pad and
//                            frame counters in RAM (see src/hello.c)
//   hello.bin / hello.cue    the same EXE on a bootable disc (makeDisc)

import { spawnSync } from 'node:child_process';
import { readFile, writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeDisc } from '../../disc.mjs';
import { elfToExe } from '../../exe.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, 'src');
const prefix = ['mipsel-none-elf', 'mipsel-linux-gnu'].find((p) => spawnSync(`${p}-gcc`, ['--version']).status === 0);
if (!prefix) { console.error('no mipsel GCC found (install mipsel-none-elf-gcc or gcc-mipsel-linux-gnu)'); process.exit(1); }

const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { cwd: src, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
};
run(`${prefix}-gcc`, ['-march=r3000', '-mabi=32', '-msoft-float', '-mno-abicalls', '-fno-pic', '-G0', '-O2',
  '-ffreestanding', '-nostdlib', '-static', '-T', 'ps1.ld', 'crt0.s', 'hello.c', '-o', '../hello.elf', '-Wl,--build-id=none']);
const exe = elfToExe(await readFile(path.join(here, 'hello.elf')));
await writeFile(path.join(here, 'hello.exe'), exe);
const { bin, cue } = await makeDisc({ exe, out: path.join(here, 'hello'), label: 'HELLO' });
console.log(`built hello.exe (${exe.length} bytes), ${path.basename(bin)}, ${path.basename(cue)} with ${prefix}-gcc`);
