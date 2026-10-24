# PS1 starter (PSn00bSDK, C)

A small working PlayStation game to start from: text on screen, a 16x16 player
you move with the D-pad (or the left stick of an analog pad), a cube spun by the
GTE, and a test that checks it.

| | |
|---|---|
| Build | `cmake --preset default && cmake --build build` → `build/game.cue` + `game.bin` (bootable disc), `build/game.exe` and `build/game.elf` (symbols) |
| Needs | [PSn00bSDK](https://github.com/Lameguy64/PSn00bSDK) with `PSN00BSDK_LIBS` set, a MIPS GCC (`mipsel-none-elf`, or Debian/Ubuntu's `gcc-mipsel-linux-gnu`), CMake and Ninja — or open the folder in the dev container — and Node.js for the tests |
| Test | `tests/ps1/smoke.json`, run by the `ps1-tests` GitHub workflow or by an AI agent with the ps1-test MCP server |

- `src/main.c`: double-buffered display, ordering table, font, the player sprite
  (a TIM loaded into VRAM), pad input, `frame_count` and `cpu_usage`.
- `src/cube.c`: the cube: GTE rotate/translate/perspective, back-face culling,
  depth sorting into the ordering table.
- `assets/player.png` → `assets/player.tim` (4-bit, pixels at VRAM 768,0, CLUT at
  768,256), linked in with `psn00bsdk_target_incbin`. Regenerate it with the MCP
  `texture` tool: `convert` with `png: "assets/player.png", out: "assets/player.tim",
  depth: 4, x: 768, y: 0, clutX: 768, clutY: 256`.
- `iso.xml` + `system.cnf`: the disc layout for `mkpsxiso`.

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
