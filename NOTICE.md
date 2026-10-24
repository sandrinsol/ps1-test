# Third-party components & attribution

This project is licensed **GPL-3.0-or-later** (see `LICENSE`), because it bundles
and builds on the following software:

- **EmulatorJS** — the emulator frontend in `data/` (loader, UI, compression helpers).
  GPL-3.0. https://github.com/EmulatorJS/EmulatorJS
- **PCSX-ReARMed** (libretro core, WebAssembly, `data/cores/pcsx_rearmed-*.data`) —
  runs the PlayStation. GPL-2.0-or-later (`data/cores/PCSX_REARMED-COPYING`).
  Built from EmulatorJS's fork (commit `f29871d`, linked with EmulatorJS's RetroArch
  fork `6dd43539`, as EmulatorJS 4.2.3's own core) with this repo's patch
  `core/pcsx_rearmed-ps1test.patch` (a GPU command / CPU exception log and memory
  pointers for the test harness), by `core/build-core.sh`; build details and
  checksums in `data/cores/reports/pcsx_rearmed-ps1test.json`.
  https://github.com/libretro/pcsx_rearmed, https://github.com/EmulatorJS/pcsx_rearmed
- **OpenBIOS** (`data/bios/openbios.bin`) — a free replacement for the PlayStation
  BIOS from the PCSX-Redux project, built from source with `core/build-openbios.sh`
  (the commit is in `data/bios/openbios.json`). MIT (`data/bios/OPENBIOS-LICENSE`).
  https://github.com/pcsx-redux/nugget/tree/main/openbios

## BIOS and game legality

No Sony BIOS is included. The bundled OpenBIOS, or the core's built-in HLE BIOS,
boots games without one; for the best compatibility use a dump of **your own**
console's BIOS (`PS1TEST_BIOS=/path/to/SCPH1001.BIN`). **Do not commit or
distribute BIOS dumps or commercial games** — supply your own copies of games you
legally own. Homebrew you build yourself is of course fine.

## What in this repo is original

Everything in `harness/` (the test harness and MCP server, including the test
fixtures in `harness/tests/fixtures/src/`), `templates/`, `skills/`, `agents/`,
`index.html`, `core/` and `start.command` is original work, released under the same
GPL-3.0-or-later.
