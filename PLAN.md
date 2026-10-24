# ps1-test — plan

PlayStation counterpart of [gb-gbc-gba-test-mcp](https://github.com/sandrinsol/gb-gbc-gba-test-mcp):
play PS1 games in the browser, or let an AI agent test them through an MCP server.

## Decisions

| Area | Choice |
|------|--------|
| Name | `ps1-test` (plugin + MCP server), env `PS1TEST_*`, config `ps1test.json` |
| Core | pcsx_rearmed, rebuilt to WASM in CI with a small hook (GPU command capture, direct RAM/VRAM/SPU access); patch + build script in `core/`, built `.data` committed |
| BIOS | Bundled OpenBIOS (PCSX-Redux, MIT) by default → core HLE fallback → user `SCPH1001.bin` via `PS1TEST_BIOS` / `ps1test.json` |
| Formats | PS-EXE (`.exe`/`.psx`, side-loaded), `.cue`/`.bin`, `.iso` |
| Region | NTSC 60 Hz by default; PAL selectable per load |
| Input | Digital pad + DualShock analog sticks (−128..127), ports 1 and 2 |
| Memory cards | Import/export `.mcr`/`.mcd` for both slots + block list (game ID, title, icon PNG) |
| Cheats | GameShark / Action Replay |
| Sample game | Original demo (sprite, text, GTE cube, sound) — also the test fixture |
| Play page | `index.html` + Vercel (`vercel.json`) |
| Scope | Full parity with the GB repo |
| Licence | GPL-3.0-or-later |
| Reuse | Port platform-neutral modules from the GB repo (png, bmp, assert, recording/video, ramsearch, steps, runner, build parsing) |
| CI | Ubuntu Node 20/22/24 + macOS Node 22, typecheck, full suite, release-on-version-bump, core-build workflow |
| Delivery | Feature branch, milestones pushed as they land, one PR |

## Tools (PS1 versions of the GB set)

`load_disc` (EXE/disc), `wait_frames`, `press`, `set_button`, `set_analog`, `wait_until`,
`reset`, `screenshot`, `read_memory` / `write_memory` (2 MB RAM, scratchpad, symbol names
from `.elf`/`.map`), `read_cpu` (R3000A + COP0 + GTE regs), `status`, `state`,
`memory_card`, `cheats`, `run_sequence`, `assert_golden`, `record_video`,
`export_script`, `ab_compare`, `ram_search`, `describe`, `build`, `new_project`, plus:

- `view_vram` — 1024×512 VRAM image with display area, texpages and CLUTs outlined.
- `gpu_capture` — one frame's GP0 primitives (type, coords, texpage, CLUT) and an outlined screenshot.
- `check` — boot/crash (PS-EXE header, region, CPU exceptions, stack overflow, blank/frozen screen),
  frame budget (lag, VSync misses, `cpuUsage`), GPU rules (off-area prims, textures over the
  framebuffer, missing CLUTs, broken OT chain, oversized polys), memory/DMA rules
  (KSEG0/KSEG1 mixups, unaligned DMA, scratchpad misuse, RAM nearly full).
- `texture` — PNG → TIM (4/8/16-bit, CLUT, VRAM placement), inject/overlay/export.
- `background` — Tiled `.tmx`/`.tmj` → tile data + TIM.
- `data` — WAV → VAG (SPU ADPCM, loop points), OBJ → fixed-point mesh, GTE sin/cos LUTs.

## Templates

- `psn00bsdk` — C + CMake, builds PS-EXE + ELF + CD image (mkpsxiso); devcontainer, CI workflow,
  smoke test with goldens, passing from the start.

## Plugin

- Skills: `ps1-game-testing`, `ps1-playtest`, `ps1-ci-tests`, `ps1-homebrew-dev`, `psn00bsdk`,
  `ps1-hardware` (+ references), `ps1-performance`, `ps1-real-hardware`.
- Agents: `ps1-tester`, `ps1-reviewer`.

## Milestones

1. Core build: pcsx_rearmed WASM + hook, OpenBIOS, EmulatorJS bundle, play page.
2. Harness + MCP core: driver, input/analog, frames, screenshots, states, RAM, symbols, steps, runner, goldens, video.
3. PS1 inspection: VRAM viewer, GPU capture, memory cards, cheats, `describe`, `check`.
4. Sample demo + PSn00bSDK template + `build` / `new_project`.
5. Converters: TIM, VAG, Tiled, OBJ, LUTs.
6. Skills, agents, plugin manifests, CI, release workflow, docs.
