---
name: ps1-real-hardware
description: What changes when a PlayStation (PS1) game moves from emulators to a real console — booting homebrew (modchips, FreePSXBoot, Unirom, ODEs like XStation), uninitialised memory, timing, BIOS versions and regions, CD drive behaviour, caches, and how to test on hardware (Unirom + nops serial loading, PCSX-Redux, DuckStation, no$psx). Use when a PS1 game works in an emulator but not on a console, before a release, or when the user asks about testing on a real PS1.
---

# Real PS1 hardware

The bundled emulator (PCSX-ReARMed with OpenBIOS) is good but forgiving, and it
starts from a clean state. Before calling a game done:

## Checklist

1. **Boot path**: a disc needs `SYSTEM.CNF` and a valid EXE (`check` verifies both).
   An unmodified console only boots pressed discs (it checks the SCEx region code
   that CD-Rs can't carry), and the BIOS wants the licence text in sector 4 to show
   its logo — homebrew boots through a modchip, an ODE (XStation, PSIO), FreePSXBoot
   (memory card exploit) or Unirom/tonyhax; `check` reports whether licence data
   is present.
2. **Run with a real BIOS too**: load with your own BIOS dump (`bios` path, e.g.
   SCPH-1001 for NTSC-U, SCPH-7502 for PAL) as well as OpenBIOS and HLE; kernel
   behaviour differs (memory card and CD functions most).
3. **Region**: NTSC is 60 Hz/240 lines, PAL 50 Hz/256 lines. Test with `region:
   "pal"`; set `SetVideoMode(MODE_PAL)` for PAL, scale game speed by frame
   time, and mark the EXE's region string.
4. **Initialise everything**: RAM, VRAM and SPU RAM hold leftovers or garbage at
   boot (emulators often zero them). Clear the BSS (the SDK's start code does),
   clear VRAM areas you sample, upload every CLUT, silence every SPU voice.
5. **Alignment and bus errors**: unaligned accesses and reads from unmapped
   addresses raise exceptions on hardware. `check` catches most with exception
   emulation on — don't ignore its warnings.
6. **Caches**: code loaded from CD or decompressed at run time needs
   `FlushCache()` before it's called; the emulator may run stale code fine.
7. **GTE and load delays** in hand-written assembly: the console enforces them, some
   emulators don't (wrong values, not crashes).
8. **Timing**: don't count on fixed cycle counts; wait on GPU status/`DrawSync`,
   DMA busy bits and CD interrupts instead of delay loops. The real CD drive is
   slower and seeks take tens of milliseconds — show a loading screen, don't spin.
9. **Pads**: real DualShocks start in digital mode; analog needs the ANALOG button or
   the config command. Multitaps and third-party pads report other IDs. Handle a
   missing pad (`stat != 0`).
10. **Memory cards**: real cards are slow (milliseconds per 128-byte frame) and can be
    pulled; check every BIOS call's result and never write every frame.
11. **Video**: test on a CRT or a scaler — 320×240 is what most expect; interlaced
    480-line modes flicker unless both fields are drawn.

## Testing on hardware

| Tool | Use |
|---|---|
| **Unirom** + `nops` (or `NOTPSXSerial`) over a serial cable (or Unirom's network adapter) | Upload and run `game.exe` in seconds, `debug` mode for breakpoints and memory dumps |
| **XStation / PSIO** ODE | Boot `game.cue`/`.bin` from SD like a disc |
| **FreePSXBoot / tonyhax** | Boot homebrew on an unmodified console from a memory card |
| **CD-R** (modded console) | Final test of real disc timing — burn at low speed, Mode 2 raw |
| **PCSX-Redux** | Accurate emulator with debugger, memory/VRAM viewers, GDB server, OpenBIOS |
| **DuckStation** | Accurate emulator; use for a second opinion on timing and rendering |
| **no$psx** | Debugger with good hardware-accuracy warnings (Windows) |

Keep the ps1-test regression scripts green on every change; reproduce a
hardware-only bug in PCSX-Redux or DuckStation if possible, then turn it into a
`check` warning or a test here.
