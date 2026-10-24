# PS1 test harness and MCP server

Lets an AI agent (or a script) play and test PlayStation games and homebrew. It
runs the bundled EmulatorJS PCSX-ReARMed core in headless Chromium, with the free
OpenBIOS, so no other emulator and no Sony BIOS is needed, and nothing is
downloaded at runtime.

- `mcp-server.mjs` — MCP server for agents (Claude Code, Cursor, VS Code, …).
- `driver.mjs` — the same features as a Node library, for scripts and CI.
- `runner.mjs` — runs a JSON step script from the command line (for CI).
- A PSn00bSDK starter game that builds, runs and passes a test from the start
  ([`templates/psn00bsdk`](../templates/psn00bsdk)), and the same game as a ready
  disc in [`demo/`](../demo).
- A Claude Code plugin bundling the server with skills (testing, playtesting, CI,
  homebrew development, PSn00bSDK, hardware reference, performance, real hardware)
  and two agents, `ps1-tester` and `ps1-reviewer`
  ([`skills/`](../skills/), [`agents/`](../agents/)).

## Setup

Node 20+.

**Claude Code:** install the plugin (server + skills + agents; dependencies install
on first start):

```
/plugin marketplace add sandrinsol/ps1-test
/plugin install ps1-test@ps1-test
```

**Other MCP hosts**, or to work on the harness:

```bash
cd harness
npm install        # dependencies + headless Chromium
```

Add the server to your MCP host:

```json
{
  "mcpServers": {
    "ps1-test": {
      "command": "node",
      "args": ["/absolute/path/to/ps1-test/harness/mcp-server.mjs"],
      "env": { "PS1TEST_ROOT": "/path/to/your/project" }
    }
  }
}
```

VS Code uses the key `"servers"` instead of `"mcpServers"`
([`.vscode/mcp.json.example`](../.vscode/mcp.json.example)).

| Variable | Effect |
|----------|--------|
| `PS1TEST_ROOT` | Base for relative paths and `ps1test.json`. Default: the host's workspace root, else the working directory. |
| `PS1TEST_BIOS` | Default BIOS: `openbios` (bundled, default), `hle` (the core's built-in), or a path to your own 512 KB BIOS dump. |
| `PS1TEST_TOOLS` | Expose only some tools: `core`, or a comma list such as `core,ram_search`. |
| `PS1TEST_CHROMIUM` | Use this Chrome/Chromium binary instead of Playwright's. |
| `PS1TEST_FFMPEG` | ffmpeg for `.webm`/`.mp4` video (default: one on PATH, else Playwright's). |
| `PS1TEST_ALLOW_ANY_PATH=1` | Allow writing files outside the workspace (refused by default). |
| `UPDATE_GOLDENS=1` | Re-create golden images instead of comparing. |

## Tools

| Tool | Does |
|------|------|
| `load_disc` | Boot a disc image (`.cue`/`.bin`/`.iso`) or a PS-EXE (`.exe`), with its symbol file if there is one. Options: `bios` (`openbios`, `hle`, or a dump), `region` (`ntsc`, `pal`, `auto`), `pad1`/`pad2` (`dualshock`, `digital`, `analog`, `none`). |
| `wait_frames` | Advance N frames (60 = 1 s; 50 on PAL). |
| `press` | Tap a button or a combo (`buttons: ["L1","R1"]`), on port 1 or 2. |
| `set_button` | Hold or release buttons. |
| `set_analog` | Tilt a stick to x,y (-128…127). |
| `wait_until` | Run until a memory condition or a screen change holds; stops on the first such frame. |
| `reset` | Reset button. Keeps memory cards and cheats; a side-loaded EXE restarts from where it was loaded. |
| `screenshot` | Current frame as an image (2× by default). |
| `read_memory` | Read RAM, the scratchpad, I/O ports or the BIOS; addresses as numbers, hex strings (`"0x80010000"`) or symbols. |
| `read_cpu` | R3000A registers, COP0 status/cause, GTE registers; names the function the PC is in. |
| `debug` | A debugger. `set` breakpoints (stop before an address or function) and watchpoints (reads/writes of a RAM range, optionally only changes or values matching a condition), `run` until the first hit — the CPU stops mid-frame, on the exact instruction — or log every hit with `halt: false`, `step` instructions, `where` (disassembly around the pc, registers, a probable call stack), `hits`, `clear`. Frame numbers stay those of a run without the debugger. |
| `profile` | Run frames sampling the pc every N CPU cycles: the share of time per function (from the symbols), and how much is spent waiting for VSync or in the BIOS. |
| `spu` | The sound chip: which of the 24 voices play, their ADSR phase, envelope, pitch in Hz, volume and SPU RAM addresses, and SPUCNT; `export` decodes the ADPCM sample a voice plays (or at an address) to a WAV. |
| `cdrom` | Run frames logging the CD-ROM drive: each command (with its parameters and the function that sent it) and the drive's answers, sector reads folded into runs and mapped to the disc's files, errors, and which files were read. |
| `gpu_capture` | Run a frame logging every GPU command: the primitives drawn (polygons, sprites, lines, fills, VRAM transfers) with their box, colour, texture page and CLUT, and for DMA-chain packets the RAM address and symbol; plus the drawn buffer with each one outlined. |
| `view_vram` | The whole 1024×512 VRAM with the display and draw areas (and, with `gpu: true`, the texture pages and CLUTs in use) outlined, or one texture decoded through its CLUT. |
| `describe` | The machine as text, far cheaper than a screenshot: where the CPU is, watched variables, display mode, how much of the screen changed; `gpu: true` adds what the next frame draws. `watch` sets the variables every step reports. |
| `status` | Disc/EXE, BIOS, region, frame, held buttons, saved states, cheats. |
| `write_memory` | Write memory on the current frame. |
| `state` | Save or load named snapshots, optionally to/from a file. |
| `cheats` | GameShark / Action Replay codes (`"80010394 0064"`). |
| `memory_card` | List the saves on a card (game ID, title, blocks, icon), export or import a card (`.mcr`/`.mcd`, `.gme`, `.vgs`), or insert a blank formatted one, in slot 1 or 2. |
| `run_sequence` | Run a list of steps in one call (see [Steps](#steps)). |
| `assert_golden` | Compare the frame to a golden PNG; on failure returns current, golden and diff images. |
| `record_video` | Play N frames into `.gif`, animated `.png`, `.webm`, `.mp4` (with sound) or `.wav`. |
| `export_script` | Everything done since `load_disc` as replayable steps. |
| `ab_compare` | Run the same steps on two discs/EXEs and report differences. |
| `ram_search` | Find where a value (HP, score…) is stored: `start`, then `filter` until one address is left. |
| `build` | Run the project's build (CMake, make, or `ps1test.json`), report compiler errors as `file:line: error: …`, load the new disc/EXE with its symbols. |
| `texture` | `convert` a PNG to a TIM (4/8/16-bit, pixels and CLUT placed in VRAM; opaque black kept as 0x8000 so it isn't transparent) as `.tim` or a C array; `inject` a PNG or TIM into the running game's VRAM; `export` a VRAM rectangle, through a CLUT, to a PNG. |
| `background` | A PNG or Tiled map (`.tmx`/`.tmj`) → identical tiles merged, the unique ones packed into a tileset TIM, plus the map of tile numbers as C; returns a preview rebuilt from the output. |
| `data` | `sound`: WAV → SPU ADPCM (`.vag`, raw, C, or a `.wav` of the result to listen to), looping or one-shot, with the voice pitch value. `table`: fixed-point sin/cos/reciprocal lookup tables (4096 steps per turn). `mesh`: Wavefront `.obj` → `SVECTOR` vertices and normals plus triangle and quad lists (in the GPU's vertex order) for the GTE. |
| `new_project` | Copy a starter template (`psn00bsdk`): text, a player sprite, a GTE cube, a smoke test with goldens, `ps1test.json`, a CI workflow and a dev container. |
| `check` | Hardware rules: the PS-EXE header and `SYSTEM.CNF` (region marker, load address, entry, size), then a short run watching for CPU exceptions (unaligned or bad addresses, bus errors, …, with the faulting function), hangs, lag frames (`frameCounter`), CPU load (`cpu_usage`), a blank or frozen screen, polygons the GPU drops (> 1023×511), primitives outside the drawing area, textures and CLUTs inside the framebuffer, all-zero CLUTs, DMA from outside RAM, unaligned DMA chains, the stack reaching the program's data, and CD-ROM drive errors. |

Prompts: `smoke_test_rom`, `regression_check`, `find_ram_address`,
`record_regression_test`. Resources: `emu://screen`, `emu://status`.

**Token use.** Tool definitions are sent with every request: ~3,700 tokens for all
tools, ~1,800 with `PS1TEST_TOOLS=core` (`load_disc wait_frames press set_button
set_analog wait_until screenshot read_memory write_memory run_sequence assert_golden
status build describe`). A 2× screenshot is ~410 tokens; `describe` is usually under
100. Prefer one `run_sequence`
over many single calls, and `wait_until` over wait-and-check loops.

Start a game from the template with `new_project`, or from the clone:
`node harness/mcp-server.mjs new psn00bsdk <dir>`.

## Buttons

`CROSS CIRCLE SQUARE TRIANGLE L1 R1 L2 R2 L3 R3 START SELECT UP DOWN LEFT RIGHT`
(`X`, `O`, `L`, `R` also work). In steps, a second controller's buttons are
written `"P2:CROSS"`; tools take `port: 2`.

The default controller is a **DualShock**: like the real one it reports a digital
pad (ID 0x41) until the game switches it to analog. `pad1: "analog"` boots it
already in analog mode (ID 0x73); `"digital"` is the original digital pad.

## Projects: symbols and ps1test.json

A symbol file next to the disc/EXE with the same name is loaded with it: an `.elf`
(PSn00bSDK, PSYQo, any `mipsel-none-elf` build), a GNU ld `.map`, `nm` output or a
`.sym` (`80010000 main`). Every address argument and step then also takes a
name, `"player_x"` or `"player_x+2"`, and `read_cpu` names the function the CPU is in.

`ps1test.json` in the workspace sets project defaults:

```json
{
  "build": "cmake --build build",
  "rom": "build/game.cue",
  "symbols": "build/game.elf",
  "bios": "openbios",
  "region": "ntsc",
  "pad1": "dualshock",
  "watch": ["player_x:s16", "lives"],
  "frameCounter": "frame_count",
  "cpuUsage": "cpu_usage"
}
```

`frameCounter` is a variable the game's main loop increments once per frame;
`check` counts the frames where it didn't (lag). `cpuUsage` is a variable holding
the percentage of the last frame the game spent working; `check` reports its range.
Both are found by name (`frame_count`, `cpu_usage`) when there's a symbol file.

## Steps

`run_sequence`, `ab_compare`, `export_script` and `runner.mjs` share one step format.
Each step has one action key:

| Step | Example |
|------|---------|
| wait | `{"wait": 60}` |
| tap (press + release) | `{"tap": "CROSS"}`, `{"tap": ["L1","R1"], "hold": 4, "release": 4}` |
| hold / release | `{"press": "RIGHT"}`, `{"release": "RIGHT"}`, `{"hold": "RIGHT", "frames": 30}` |
| analog stick | `{"analog": "left", "x": 127, "y": 0}` (stays until changed; `"port": 2`) |
| wait for a condition | `{"waitUntil": {"address": "frame_count", "as": "u32", "op": "gte", "value": 300}, "maxFrames": 600}`, `{"waitUntil": {"screen": "stable", "frames": 30}}` |
| screenshot | `{"shot": "title"}`, `{"record": {"frames": 120, "every": 20, "prefix": "walk"}}` |
| state | `{"saveState": "cp"}`, `{"loadState": "cp"}`, `{"loadStateFile": "boss.state"}` |
| memory | `{"read": "0x80010000", "as": "u16"}`, `{"write": "player_hp", "value": 1}`, `{"assertRam": "lives", "equals": 3}` (or `min`/`max`) |
| golden image | `{"assert": "goldens/title.png", "threshold": 0.02, "ignore": [{"x": 200, "y": 0, "w": 40, "h": 16}]}` |
| video | `{"video": {"frames": 120, "path": "clips/walk.gif"}}` |
| other | `{"reset": true}`, `{"cheats": ["..."]}`, `{"importCard": "cards/100pct.mcr", "slot": 1}`, `{"formatCard": 2}` |

From the command line:

```bash
node runner.mjs tests/scripts/hello.json   # screenshots + timeline.json in out/hello/
```

A script may also set `bios`, `region`, `pad1` and `pad2`. In a script file, `rom`
is relative to the working directory and other paths to the script. A top-level
`"video": {"path": "failures/x.gif", "onlyOnFail": true, "seconds": 10}` records the
run and keeps the clip when a check fails. The exit code is non-zero if an assert fails.

## Library

```js
import { EmuHarness } from './driver.mjs';

const emu = await EmuHarness.launch('game.cue', { bios: 'openbios', pad1: 'analog' });
await emu.waitFrames(300);
await emu.tap('START');
await emu.setAnalog('left', 127, 0);
const hp = await emu.readU16('player_hp');
await emu.screenshot('out/title.png');
await emu.close();
```

| Method | Description |
|--------|-------------|
| `EmuHarness.launch(path, {bios, region, pad1, pad2, fast=true, reuse=false, timeout=60000, symbols=true})` | Boot a disc or EXE. `reuse` shares one browser between harnesses; call `EmuHarness.shutdown()` at the end. |
| `waitFrames(n)`, `waitUntilFrame(f)`, `frameNum()`, `fps` | Advance and read the frame clock. |
| `waitFor(cond, {maxFrames, precise})` | Run until `{address, as, op, value}` or `{screen: 'changed'\|'stable', frames}` holds → `{met, frame}`. |
| `setButton(b, down)`, `setButtons(bs, down)`, `tap(b \| bs, hold, release)` | Input; `"P2:CROSS"` for port 2. |
| `setAnalog(stick, x, y, port)`, `analog()` | Analog sticks. |
| `screenshot(path?)` | PNG `Buffer`. |
| `readMemory(addr, len)`, `readU8/U16/U32(addr)`, `readRegions()` | Memory; `addr` can be a symbol. `readRegions()` → `{ ram, scratchpad, io, bios, vram, spuRam, spuRegs, gpuStatus, … }`. |
| `writeMemory(addr, buf)`, `writeU8/U16/U32(addr, v)` | Write memory; returns whether it stuck. |
| `saveState()`, `loadState(buf, {frame})` | Full machine snapshots. |
| `readCpu()`, `setCheats(codes)`, `restart()` | CPU + GTE registers, cheats, reset. |
| `readMemoryCard(slot)`, `writeMemoryCard(buf, {slot, reset})` | Memory cards. |
| `record(n, {every})`, `startRecording()`, `stopRecording()` | Frame-exact captures `[{frame, png}]` with `.audio` (PCM); save with `saveVideo()` from `recording.mjs`. |
| `captureFrame(n)` | Run n frames logging the GPU and CPU exceptions → `{ prims, env, exceptions, chains, stats }` (`gpu.mjs`). |
| `symbols`, `useSymbols(file)`, `addr(nameOrAddress)`, `options`, `close()` | |

GPU decoding and VRAM images (`gpu.mjs`), memory cards (`mcard.mjs`), the
hardware rules (`checks.mjs`), disc reading (`disc.mjs`: `isoFile`, `systemCnf`),
TIM conversion (`tim.mjs`), VAG sound, tables and meshes (`gamedata.mjs`) and
tilemaps (`tilemap.mjs`) can also be used on their own. `disc.mjs` also builds bootable discs: `makeDisc({ exe, out, files })` wraps a
PS-EXE (and data files) into an ISO 9660 Mode 2 `.bin`/`.cue` with `SYSTEM.CNF`,
and `exe.mjs` turns an `.elf` into a PS-EXE.

## Behaviour

- **Deterministic.** The same steps give bit-identical frames and RAM on every run.
  Advance time only with waits; the machine is paused between calls, so real time
  between them doesn't matter and every read lands on the exact frame. Every load
  and reset leaves the machine on frame 10 (`BOOT_FRAME`), so input sent right
  after a load always lands on the same frame.
- **Fast-forward.** Waits longer than 120 frames run at 8× and finish at 1×, with
  identical results. Turn it off with `fast: false`.
- **BIOS.** OpenBIOS (bundled, MIT) is the default; discs boot through it in about
  150 frames. `hle` boots faster and needs no file; a real BIOS dump is the most
  compatible. A PS-EXE is side-loaded once the BIOS is up.
- **Reset** is the console's reset button: memory cards and cheats survive. A disc
  boots again; a side-loaded EXE restarts from the moment it was loaded (a real
  reset would leave the BIOS in its shell, with no disc to boot).
- **Exceptions are emulated**, as on the console: an unaligned or bad-address
  load or store raises an address/bus error instead of quietly working, so code
  that would crash on hardware crashes here too.
- **The debugger** sees what the CPU does: watchpoints catch CPU loads and stores
  (not DMA, e.g. CD sectors arriving in RAM), and the call stack is a heuristic
  (MIPS code keeps no frame pointers). Waits run at 1× while breakpoints,
  watchpoints or the profiler are on. After a stop mid-frame, the next wait first
  finishes that frame.
- **Writes to memory** apply on the current frame. A value the game recomputes every
  frame is overwritten on the next one; `write_memory` says when that happens.
- **Save states** don't store the picture. Loading a state file from another session
  gives a stale screenshot (flagged) until you advance one frame.
- **Video** is captured frame by frame (identical to screenshots of those frames).
  **Audio** stays in step with the frames but is not bit-exact across runs.
- **Files** are only written inside the workspace or `harness/out/`.

## How it works

`page.html` loads EmulatorJS in a headless page and exposes a small control bridge.
`driver.mjs` serves the repo over localhost (a `.cue` and its tracks as one zip,
which EmulatorJS unpacks), starts Chromium with software WebGL, and calls the
bridge.

The bundled core is EmulatorJS's PCSX-ReARMed build with a small patch
([`core/pcsx_rearmed-ps1test.patch`](../core/pcsx_rearmed-ps1test.patch), rebuilt
by `core/build-core.sh` and the `core` workflow): it exports pointers to the
emulated RAM, scratchpad, I/O, VRAM and BIOS, so memory is read and written in
place, and it logs every GPU command (with the RAM address of each DMA-chain
packet), CPU exception and CD-ROM command, answer and sector read while the
harness asks it to: `gpu.mjs` and `cdrom.mjs` decode that log. The interpreter
also checks breakpoints, watchpoints and a profiler's sampling clock before each
instruction and load/store when they are set (a block of words the page shares
with the core: `debugger.mjs`, `mips.mjs` for the disassembly), and the SPU's
voices and sound RAM are exported for `spu`. Registers, VRAM for images, and anything the stock core can't
give come from the core's save states: `psx-memory.mjs` parses pcsx_rearmed's format
(and the harness falls back to it entirely with a stock core).

## Development

```bash
npm test               # all suites (unit, core, script, mcp, template — skipped without PSn00bSDK)
npm run typecheck      # JSDoc types
npm run fixtures       # rebuild tests/fixtures from src/ (needs a mipsel GCC)
PSN00BSDK_LIBS=… node tests/template.mjs   # the template end to end (needs PSn00bSDK)
npm run package-test   # pack, install into an empty project, drive an EXE
npm run site-test      # the play page in a browser (or: node tests/site.mjs <deployed URL>)
```

Releases: bump `version` in the repo-root `package.json`, this folder's
`package.json` and `.claude-plugin/plugin.json` (`package-test` checks they match),
optionally add `.github/release-notes/v<version>.md`, and merge to `main`: the
`release` workflow tags it and publishes a GitHub release. The repo-root
`package.json` describes the npm package (`ps1-test-mcp` bin); the workflow also
publishes it to npm when the repository has an `NPM_TOKEN` secret (an npm
"automation" token), after which `npx ps1-test-mcp` runs the server and
`npx ps1-test-mcp new psn00bsdk mygame` starts a project.
