// Run every suite in order; exit non-zero if any failed.
//   node tests/run-all.mjs [suite …]
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SUITES = ['unit', 'core', 'script', 'mcp', 'template'];
const want = process.argv.slice(2);
let failed = [];
for (const s of want.length ? want : SUITES) {
  console.log(`\n=== ${s} ===`);
  const r = spawnSync(process.execPath, [path.join(here, `${s}.mjs`)], { stdio: 'inherit', cwd: path.dirname(here) });
  if (r.status !== 0) failed.push(s);
}
console.log(failed.length ? `\nFAILED: ${failed.join(', ')}` : '\nAll suites passed.');
process.exit(failed.length ? 1 : 0);
