// The CLI runner on a committed script with committed goldens: a regression
// test of the whole pipeline as CI would use it.
//
//   node tests/script.mjs

import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ok, done, HARNESS } from './lib.mjs';

const r = spawnSync(process.execPath, ['runner.mjs', 'tests/scripts/hello.json', 'out/script-test'], { cwd: HARNESS, encoding: 'utf8' });
ok('runner exits 0 on a passing script', r.status === 0, (r.stdout + r.stderr).trim().split('\n').slice(-2).join(' | '));
const t = JSON.parse(await readFile(path.join(HARNESS, 'out', 'script-test', 'timeline.json'), 'utf8'));
ok('timeline reports pass', t.pass === true);
ok('goldens compared, not created', t.steps.filter((s) => s.assert?.golden).every((s) => !s.assert.created && s.assert.pass));
done();
