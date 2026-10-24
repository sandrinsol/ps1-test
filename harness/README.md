# PS1 test harness and MCP server

Lets an AI agent (or a script) play and test PlayStation games and homebrew. It
runs the bundled EmulatorJS PCSX-ReARMed core in headless Chromium, with the free
OpenBIOS, so no other emulator and no Sony BIOS is needed, and nothing is
downloaded at runtime.

- `mcp-server.mjs` — MCP server for agents (Claude Code, Cursor, VS Code, …).
- `driver.mjs` — the same features as a Node library, for scripts and CI.
- `runner.mjs` — runs a JSON step script from the command line (for CI).

## Setup

Node 20+.

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

VS Code uses the key `"servers"` instead of `"mcpServers"`.

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
| `status` | Disc/EXE, BIOS, region, frame, held buttons, saved states, cheats. |
| `write_memory` | Write memory on the current frame. |
| `state` | Save or load named snapshots, optionally to/from a file. |
| `cheats` | GameShark / Action Replay codes (`"80010394 0064"`). |
| `memory_card` | Export or import a memory card (`.mcr`/`.mcd`, `.gme`, `.vgs`) in slot 1 or 2. |
| `run_sequence` | Run a list of steps in one call (see [Steps](#steps)). |
| `assert_golden` | Compare the frame to a golden PNG; on failure returns current, golden and diff images. |
| `record_video` | Play N frames into `.gif`, animated `.png`, `.webm`, `.mp4` (with sound) or `.wav`. |
| `export_script` | Everything done since `load_disc` as replayable steps. |
| `ab_compare` | Run the same steps on two discs/EXEs and report differences. |
| `ram_search` | Find where a value (HP, score…) is stored: `start`, then `filter` until one address is left. |
| `build` | Run the project's build (CMake, make, or `ps1test.json`), report compiler errors as `file:line: error: …`, load the new disc/EXE with its symbols. |

Prompts: `smoke_test_rom`, `regression_check`, `find_ram_address`,
`record_regression_test`. Resources: `emu://screen`, `emu://status`.

**Token use.** Tool definitions are sent with every request; `PS1TEST_TOOLS=core`
exposes a smaller set. A 2× screenshot is ~410 tokens. Prefer one `run_sequence`
over many single calls, and `wait_until` over wait-and-check loops.

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
  "frameCounter": "frame_count"
}
```

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
| other | `{"reset": true}`, `{"cheats": ["..."]}`, `{"importCard": "cards/100pct.mcr", "slot": 1}` |

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
| `symbols`, `useSymbols(file)`, `addr(nameOrAddress)`, `options`, `close()` | |

`disc.mjs` also builds bootable discs: `makeDisc({ exe, out, files })` wraps a
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
packet) and CPU exception while the harness asks it to: `gpu.mjs` decodes that log
into primitives. Registers, VRAM for images, and anything the stock core can't
give come from the core's save states: `psx-memory.mjs` parses pcsx_rearmed's format
(and the harness falls back to it entirely with a stock core).

## Development

```bash
npm test               # all suites (unit, core, script, mcp)
npm run typecheck      # JSDoc types
npm run fixtures       # rebuild tests/fixtures from src/ (needs a mipsel GCC)
```
