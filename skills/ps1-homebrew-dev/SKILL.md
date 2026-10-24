---
name: ps1-homebrew-dev
description: Build and debug PlayStation (PS1) homebrew with the ps1-test MCP tools — start a project from the PSn00bSDK template, the edit → build → run → check loop, converting art, sound, maps, meshes and tables, reading build errors, and fixing PS1-specific bugs (black screen, missing sprites, hangs, CPU exceptions, slowdown). Use when writing or changing a PS1 game in C or assembly, or when a PS1 build fails or misbehaves.
---

# PS1 homebrew development

SDK details: the `psn00bsdk` skill. Addresses and limits: `ps1-hardware`.
Speed: `ps1-performance`. Console differences: `ps1-real-hardware`.

## Start

`new_project` (template `psn00bsdk`, a folder) gives a working game: double-buffered
display, font, a TIM sprite moved by the pad (or left stick), a GTE cube, a sound
effect, `frame_count`/`cpu_usage`, a passing smoke test, a CI workflow and a dev
container. From a shell: `node <ps1-test>/harness/mcp-server.mjs new psn00bsdk mygame`
(or `npx ps1-test-mcp new psn00bsdk mygame` when the package is installed from npm).

The project's `ps1test.json` says how to build (`build`), what to load (`rom`,
`symbols`), the `bios`, the variables to `watch`, and the `frameCounter` /
`cpuUsage` globals that `check` uses for lag and CPU load.

## The loop

1. Edit code.
2. `build` → errors come back as `file:line: message`; on success the disc/EXE
   and its symbols are loaded and the EXE header and `SYSTEM.CNF` checked.
   `replay: true` replays the steps you ran since the last load, so you land back
   where you were testing.
3. Look: `describe` (watched values, pc as a function name, screen change %), then
   `screenshot` only if you need the picture.
4. `check` with `frames: 120` or more: CPU exceptions (with the function), hangs,
   lag frames, CPU load, blank screen, dropped or off-screen primitives, textures
   read from the framebuffer, empty CLUTs, DMA from bad addresses, stack depth.
5. Keep what you verified as a test: `export_script` → `tests/ps1/<feature>.json`
   with `assert`/`assertRam` steps; the project's workflow runs them in CI.
6. Before handing the change over, run the `ps1-reviewer` agent on the diff and
   `ps1-tester` on the running game.

## Assets

| Source | Tool | Result |
|---|---|---|
| PNG sprite / texture | `texture` `convert` (depth 4/8/16, VRAM x,y in 16-bit words, clutX multiple of 16) | `.tim` (or `.c`/`.h`); opaque black is stored as 0x8000 so it doesn't turn transparent |
| PNG background, Tiled `.tmx`/`.tmj` | `background` | deduplicated tileset TIM + tile map `.c/.h` |
| WAV | `data` `kind: "sound"` | SPU ADPCM `.vag` (+ the pitch for its sample rate) |
| `.obj` model | `data` `kind: "mesh"` | `SVECTOR` vertices/normals + faces |
| sin/cos/reciprocal | `data` `kind: "table"` | fixed-point lookup tables |

Link small assets with `psn00bsdk_target_incbin`; put large ones on the disc
(`iso.xml`) and load them with the CD library. Check placement with `view_vram`
`gpu: true`: textures and CLUTs must stay out of the two framebuffers.

## Debugging

| Symptom | Look with | Usual cause |
|---|---|---|
| Black screen | `describe`, `check` | Display never enabled (`SetDispMask(1)`), DISPENV pointing at an empty buffer, crashed before the first frame (exception) |
| Stuck in the BIOS / boot screen | `check`, `read_cpu` | Disc not bootable (`SYSTEM.CNF`, EXE name) — `build`/`check` report it; EXE loads below 0x80010000 |
| Crash, freeze | `check` (exception + function), `read_cpu` | Unaligned access (packed struct, `char*` cast to `int*`), null pointer, reserved instruction (MIPS32 code from the wrong libgcc), stack overflow |
| Sprite missing | `gpu_capture`, `view_vram gpu:true` | Never added to the OT, off-screen or outside the drawing area, CLUT all zero (not uploaded), texture page not set (sprites use the last E1), wrong colour depth |
| Garbage texture | `view_vram`, `texture` export | Texture crosses a 64-word page boundary, uploaded over a framebuffer, UVs not relative to the page |
| Flicker / half-drawn frame | `gpu_capture` | Drawing into the displayed buffer (DrawSync/VSync/swap order), primitive buffer overflow |
| Giant/missing polygons | `check` | Polygon over 1023×511 (GTE values overflowed, vertex behind the camera not culled) |
| Slowdown | `check` with the frame counter, `describe` `cpu_usage` | See `ps1-performance` |
| No sound | `read_memory` 0x1F801DAA (SPUCNT), `check` | SPU not initialised, sample uploaded below 0x1010 or not 8-byte aligned, volume 0, KON not written |
| Input ignored | `describe`, pad buffer in `read_memory` | Reading before the BIOS fills the buffer (type 0), buttons are active-low, analog fields read on a digital pad |
| Save fails | `memory_card list` | Card not formatted, filename/region prefix wrong, title frame missing |

Memory cards: `memory_card` `format` before testing a save, `list` to see the
directory, `export` to keep the card for a test, `import` to start from one.
