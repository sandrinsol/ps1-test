// Tiny test helpers shared by the suites: ok() prints PASS/FAIL lines and
// done() exits non-zero if anything failed.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HARNESS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FIX = path.join(HARNESS, 'tests', 'fixtures');
export const EXE = path.join(FIX, 'hello.exe');
export const CUE = path.join(FIX, 'hello.cue');

let failed = 0;
export const ok = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${name}${detail !== undefined && detail !== '' ? ` — ${detail}` : ''}`);
  if (!cond) failed++;
};
export const done = () => process.exit(failed ? 1 : 0);
