# PS1 emulator + AI test harness

[![test](https://github.com/sandrinsol/ps1-test/actions/workflows/test.yml/badge.svg)](https://github.com/sandrinsol/ps1-test/actions/workflows/test.yml)
[![release](https://img.shields.io/github/v/release/sandrinsol/ps1-test)](https://github.com/sandrinsol/ps1-test/releases/latest)

Play PlayStation (PS1) games and homebrew in the browser, or let an AI agent test
them through an MCP server. Everything runs offline from the bundled `data/` folder
(EmulatorJS with the PCSX-ReARMed core, plus the free OpenBIOS, so no Sony BIOS is
needed).

- **Play:** see below.
- **Make or test games with an AI agent:** see [harness/README.md](harness/README.md).
  In Claude Code: `/plugin marketplace add sandrinsol/ps1-test`, then
  `/plugin install ps1-test@ps1-test`.
  The agent can build your game, read its variables by name, see every GPU
  command a frame sends, check it against hardware rules, and start new games
  from the [PSn00bSDK template](templates/psn00bsdk).

## Play

Browsers won't load the emulator from `file://`, so serve the folder:

```bash
python3 -m http.server 8000    # or double-click start.command on macOS
```

Open <http://localhost:8000> and click **Try the demo** (a small game built from
the template, in [`demo/`](demo)), or **Load disc or EXE** and pick a disc image (a
`.cue` together with its `.bin` files, or a single `.bin`/`.iso`), a homebrew `.exe`
or a `.zip`. Choose the bundled OpenBIOS, the built-in HLE BIOS, or your own BIOS
dump (best compatibility; it never leaves your computer).

| Action | Key |
|--------|-----|
| D-pad | W A S D |
| Triangle / Square / Cross / Circle | I / J / K / L |
| L1 / L2 | Q / E |
| R1 / R2 | U / O |
| Start / Select | Enter / V |
| Left stick | T F G H |
| Right stick | Arrow keys |

The bar at the bottom has pause, save states, fullscreen, volume and settings
(including gamepads and the controller type). On a phone or tablet an on-screen
PlayStation pad appears (D-pad, △ ○ ✕ □, L1/L2/R1/R2, Start/Select).

- **Drag and drop** a disc image, EXE or zip onto the page to play it (a `.cue`
  together with its `.bin` files).
- **Memory card** (above the game): see the saves on the card (title, game ID,
  blocks, icon), export it as `.mcr`, import a card (`.mcr`/`.mcd`/`.gme`/`.vgs`,
  or drop it on the running game) or format it. Cards are kept in the browser's
  storage between visits.
- **Install it** from the browser's menu ("Install app" / "Add to Home Screen"):
  after the first visit the page, the emulator and the demo work offline.

To host it, deploy the folder as a static site (no build step). It's set up for
Vercel: import the repository at vercel.com/new (or run `npx vercel` in the
folder) and keep the defaults — `vercel.json` skips the install and build, serves
the folder as is and sets cache headers for the core files, and `.vercelignore`
leaves the test harness and templates out of the deployment. Each deployment
(including PR previews) is then smoke-tested by the `deployment` workflow: it
opens the deployed page, starts the demo and checks it draws. If previews sit
behind Vercel Authentication, add the project's "Protection Bypass for
Automation" secret to the repository as `VERCEL_AUTOMATION_BYPASS_SECRET`.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fsandrinsol%2Fps1-test)

## License

GPL-3.0-or-later, as it bundles EmulatorJS (GPL-3.0) and PCSX-ReARMed (GPL-2.0+).
See `LICENSE` and `NOTICE.md`. No BIOS dumps or commercial games are included;
don't commit them.
