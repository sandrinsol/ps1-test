// Input-script runner: drive a game through a list of steps and dump a screenshot
// timeline the AI can read back. Steps are plain JSON so an AI can author them.
//
//   node runner.mjs <script.json> [outDir]
//
// Script shape:
//   {
//     "rom": "build/game.cue",          (or a PS-EXE)
//     "bios": "openbios",                (optional: openbios | hle | path to a dump)
//     "region": "ntsc",                  (optional: ntsc | pal | auto)
//     "pad1": "dualshock",               (optional: dualshock | digital | analog | none)
//     "steps": [
//       { "wait": 240 },
//       { "shot": "title" },
//       { "tap": "START" },
//       { "hold": "RIGHT", "frames": 90 },
//       { "analog": "left", "x": 127, "y": 0 },
//       { "record": { "frames": 300, "every": 30, "prefix": "walk" } },
//       { "assert": "goldens/title.png", "threshold": 0.02, "name": "title" },
//       { "saveState": "checkpoint" },
//       { "loadState": "checkpoint" },
//       { "read": "player_hp", "as": "u16" },
//       { "assertRam": "0x80010000", "as": "u16", "equals": 3 }
//     ]
//   }
//
// `rom` (and `bios`) are relative to the working directory, `assert` goldens to
// the script file. Full step list: steps.mjs.
//
// Output: <outDir>/NN-*.png screenshots + <outDir>/timeline.json manifest.
// Exit code is nonzero if any `assert`/`assertRam` step fails.

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { EmuHarness } from './driver.mjs';
import { runSteps } from './steps.mjs';

const scriptPath = process.argv[2];
if (!scriptPath) {
  console.error('Usage: node runner.mjs <script.json> [outDir]');
  process.exit(1);
}
const absScript = path.resolve(process.cwd(), scriptPath);
const script = JSON.parse(await readFile(absScript, 'utf8'));
const outDir = path.resolve(
  process.cwd(),
  process.argv[3] || path.join('out', path.basename(scriptPath).replace(/\.json$/i, ''))
);

// The disc/EXE path is relative to the working directory; golden paths are
// relative to the script file.
const emu = await EmuHarness.launch(script.rom, { bios: script.bios, region: script.region, pad1: script.pad1, pad2: script.pad2 });
let result;
try {
  // Optional "video": { "path": "fail.mp4", "onlyOnFail": true, "seconds": 10 } records the run.
  result = await runSteps(emu, script.steps, { outDir, baseDir: path.dirname(absScript), log: console.log, video: script.video });
} finally {
  await emu.close();
}
const { timeline, failures } = result;
const rel = (p) => path.relative(process.cwd(), p);
for (const e of timeline) if (e.assert?.golden) { e.assert.golden = rel(e.assert.golden); if (e.assert.diff) e.assert.diff = rel(e.assert.diff); }
const shotCount = timeline.reduce((n, e) => n + (e.file ? 1 : 0) + (e.files?.length ?? 0), 0);

await writeFile(
  path.join(outDir, 'timeline.json'),
  JSON.stringify({ rom: script.rom, outDir: rel(outDir), pass: failures === 0, steps: timeline }, null, 2)
);

if (result.video) console.log(`Video -> ${rel(result.video)}`);
console.log(`\nTimeline -> ${rel(path.join(outDir, 'timeline.json'))}  (${shotCount} screenshots, ${failures} failed assert${failures === 1 ? '' : 's'})`);
process.exit(failures ? 1 : 0);
