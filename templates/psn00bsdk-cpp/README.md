# PS1 starter (PSn00bSDK, C++)

A small working PlayStation game in C++ to start from: text on screen, a 16x16
player you move with the D-pad (or the left stick of an analog pad), a cube spun
by the GTE, a sound effect on Cross, and a test that checks it. It is the C
template (`psn00bsdk`) organised in classes, and draws exactly the same frames.

C++ on the PS1 is the embedded subset: PSn00bSDK compiles with `-fno-exceptions
-fno-rtti` and there is no standard library, but classes, templates, `constexpr`,
references, namespaces and virtual functions work. Keep global objects
constant-initialised (default member initialisers, no constructors doing work):
set things up in an `init()` called from `main`.

| | |
|---|---|
| Build | `cmake --preset default && cmake --build build` → `build/game.cue` + `game.bin` (bootable disc), `build/game.exe` and `build/game.elf` (symbols) |
| Needs | [PSn00bSDK](https://github.com/Lameguy64/PSn00bSDK) with `PSN00BSDK_LIBS` set, a MIPS GCC (`mipsel-none-elf`, or Debian/Ubuntu's `gcc-mipsel-linux-gnu` + `g++-mipsel-linux-gnu`), CMake and Ninja — or open the folder in the dev container — and Node.js for the tests |
| Test | `tests/ps1/smoke.json`, run by the `ps1-tests` GitHub workflow or by an AI agent with the ps1-test MCP server |

- `src/main.cpp`: start-up and the main loop; `frame_count` and `cpu_usage`.
- `src/display.cpp`: `Display`, the double-buffered display with an ordering table
  and a primitive allocator (`alloc<POLY_F4>()`).
- `src/player.cpp`: `Player`, the sprite (a TIM loaded into VRAM) and pad input
  (`player_x`, `player_y`).
- `src/cube.cpp`: `Cube`, GTE rotate/translate/perspective, back-face culling,
  depth sorting into the ordering table.
- `src/sound.cpp`: `Sound`, a VAG sample in SPU RAM played on a voice
  (`sounds_played`).
- `assets/player.png` → `assets/player.tim` (4-bit, pixels at VRAM 768,0, CLUT at
  768,256), linked in with `psn00bsdk_target_incbin`. Regenerate it with the MCP
  `texture` tool: `convert` with `png: "assets/player.png", out: "assets/player.tim",
  depth: 4, x: 768, y: 0, clutX: 768, clutY: 256`.
- `assets/blip.wav` → `assets/blip.vag` (SPU ADPCM, 22050 Hz), uploaded to SPU RAM
  at start and played on voice 0. Regenerate it with the MCP `data` tool:
  `kind: "sound", wav: "assets/blip.wav", out: "assets/blip.vag"`.
- `iso.xml` + `system.cnf`: the disc layout for `mkpsxiso`.

With `mipsel-linux-gnu`, the template links `libmips1rt.a`. That toolchain's
libgcc is built for MIPS32r2 with hard-float helpers: its extra instructions crash
the PS1's MIPS I CPU (a "reserved instruction" exception the moment the game
byte-swaps or does 64-bit math), and its `float`/`double` helpers use an FPU the
PS1 doesn't have (a "coprocessor unusable" exception). `libmips1rt.a` is LLVM
compiler-rt's portable C runtime (64-bit integer maths, bit counts, soft-float)
built for MIPS I by `.devcontainer/build-mips1-rt.sh`, which the install script
runs; with it, `float` and `double` work (slowly — prefer fixed point in hot
code). Without it the template compiles `src/libgcc_mips1.c` instead, which covers
the integer helpers only.

`.devcontainer/install-psn00bsdk.sh` builds PSn00bSDK for Ubuntu's
`mipsel-linux-gnu` toolchain, with a small fix to its `elf2x` tool
(`elf2x-ptload.patch`: only convert `PT_LOAD` segments — that toolchain also emits
a stack header at address 0).

`ps1test.json` tells the test harness how to build and load the game, which
variables to report after each step (`watch`), and which variable counts frames
(`frameCounter`, for lag checks) and which holds the CPU load (`cpuUsage`).

The goldens in `tests/ps1/goldens/` are created on the first run; delete them
when you change what the screen should look like. The smoke test masks the
frame counter line of the text (it changes every frame).
