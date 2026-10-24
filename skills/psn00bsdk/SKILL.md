---
name: psn00bsdk
description: Writing PlayStation games with PSn00bSDK (the open-source PS1 SDK) — installing it, the CMake project layout, display/draw environments and ordering tables, primitives and TIM textures, the GTE helpers, pads, SPU sound, CD file loading, memory cards, and the toolchain pitfalls (mipsel-none-elf vs mipsel-linux-gnu, libgcc, elf2x, floats). Use when a project uses PSn00bSDK (psn00bsdk_add_executable, psxgpu.h, psxgte.h, psxpad.h …).
---

# PSn00bSDK

Open-source replacement for Sony's PsyQ libraries, with a similar API (`psxgpu.h`,
`psxgte.h`, `psxpad.h`, `psxspu.h`, `psxcd.h`, `psxapi.h`, `psxetc.h`, `inline_c.h`).
The `psn00bsdk` template (`new_project`) uses v0.24.

## Install

- **Dev container** (template's `.devcontainer/`): Ubuntu + `gcc-mipsel-linux-gnu`
  + PSn00bSDK built by `install-psn00bsdk.sh`. Simplest.
- **Prebuilt release** for Windows/Linux (bundles `mipsel-none-elf` GCC): set
  `PSN00BSDK_LIBS=<sdk>/lib/libpsn00b` and put `<sdk>/bin` on `PATH`.
- Build it yourself: GCC for `mipsel-none-elf` (or Debian's `mipsel-linux-gnu`),
  CMake ≥ 3.21, Ninja; `cmake --preset default` + `cmake --install`.

`cmake --preset default && cmake --build build` builds `game.elf` → `game.exe`
(elf2x) → `game.bin`/`game.cue` (mkpsxiso, from `iso.xml`).

## Toolchain pitfalls

- `mipsel-linux-gnu` (Ubuntu/Debian package) works, with care:
  - its libgcc is MIPS32r2 with hard-float helpers → "reserved instruction"
    exceptions when GCC calls an integer helper (`__bswapsi2`, 64-bit division …)
    and "coprocessor unusable" ones for `float`/`double` (`__addsf3` uses the FPU
    the PS1 lacks). The template's install script builds `libmips1rt.a` (LLVM
    compiler-rt's C runtime, incl. soft-float, for MIPS I) and the template links
    it ahead of libgcc; without it, `src/libgcc_mips1.c` covers integers only.
    `check` explains either exception.
  - it emits a `PT_GNU_STACK` program header at address 0: stock `elf2x` then makes a
    2 GB EXE. The template's install script applies `elf2x-ptload.patch`.
  - `float`/`double` then work, but in software (hundreds of cycles each): use
    fixed point in per-frame code.
- Let the SDK's CMake set the flags (`-march=r3000 -msoft-float`, gp-relative
  data with `GPREL`); extra `-march`/`-mips32` flags or prebuilt libraries made for
  another MIPS bring back the reserved-instruction crash.

## The frame

```c
DISPENV disp[2]; DRAWENV draw[2];
SetDefDispEnv(&disp[0], 0, 0, 320, 240);   SetDefDrawEnv(&draw[0], 0, 240, 320, 240);
SetDefDispEnv(&disp[1], 0, 240, 320, 240); SetDefDrawEnv(&draw[1], 0, 0, 320, 240);
setRGB0(&draw[0], 32, 32, 64); draw[0].isbg = 1;   /* clear on PutDrawEnv */
...
for (;;) {
    ClearOTagR(ot[db], OT_LEN);  nextpri = pribuff[db];
    /* build primitives: addPrim(&ot[db][z], prim) */
    DrawSync(0); VSync(0);
    PutDispEnv(&disp[db]); PutDrawEnv(&draw[db]);
    SetDispMask(1);
    DrawOTag(&ot[db][OT_LEN - 1]);
    db ^= 1;
}
```

- `ResetGraph(0)` first; `SetVideoMode(MODE_PAL)` for PAL.
- Primitive macros: `setPolyF3/FT4/G4…`, `setSprt/Sprt16`, `setXY0..3`, `setUV0..3`,
  `setRGB0`, `setClut(p, x, y)`, `setTPage`/`getTPage(mode, abr, x, y)`;
  `DR_TPAGE`/`DR_MODE` packets set the texture page for sprites.
- Text: `FntLoad(960, 0); FntOpen(x, y, w, h, 0, maxchars); FntPrint(-1, …); FntFlush(-1);`
  (debug font; its texture goes at the `FntLoad` position — keep it clear of yours).

## Textures

```c
extern const uint32_t player_tim[];   /* psn00bsdk_target_incbin */
TIM_IMAGE tim; GetTimInfo(player_tim, &tim);
LoadImage(tim.prect, tim.paddr); if (tim.mode & 8) LoadImage(tim.crect, tim.caddr);
DrawSync(0);
```
Make TIMs with the `texture` tool (`convert`), or `background` for tilesets.

## GTE

`InitGeom(); gte_SetGeomOffset(cx, cy); gte_SetGeomScreen(h);`
Per object: `RotMatrix(&rot, &m); TransMatrix(&m, &pos); gte_SetRotMatrix(&m);
gte_SetTransMatrix(&m);` then `gte_ldv3(&v0,&v1,&v2); gte_rtpt(); gte_nclip();
gte_stopz(&n)` (skip if `n <= 0`), `gte_avsz3(); gte_stotz(&z)` → OT index, and
`gte_stsxy3(&p->x0, &p->x1, &p->x2)`. Angles: 4096 = 360°. `isin`/`icos` (or a
`data` table) for fixed-point trig. See the template's `src/cube.c`.

## Pads

`InitPAD(buf0, 34, buf1, 34); StartPAD(); ChangeClearPAD(0);` then each frame cast
`buf0` to `PADTYPE*`: `stat == 0` means a pad answered; ignore it while
`type == 0` (not polled yet); `btn` is active-low (`!(pad->btn & PAD_CROSS)`
= pressed); `type` 0x4 digital, 0x7 DualShock analog, 0x5 analog stick
(`PAD_ID_*`); sticks in `ls_x/ls_y/rs_x/rs_y`, 128 = centre.

## Sound

```c
SpuInit();
SpuSetTransferMode(SPU_TRANSFER_BY_DMA);
SpuSetTransferStartAddr(0x1010);              /* >= 0x1010, 8-byte aligned */
SpuWrite((const uint32_t *)(vag + 48), (size + 63) & ~63);   /* skip the VAG header */
SpuIsTransferCompleted(SPU_TRANSFER_WAIT);
/* play on voice ch */
SpuSetKey(0, 1 << ch);
SPU_CH_FREQ(ch) = getSPUSampleRate(rate);     /* 0x1000 = 44.1 kHz */
SPU_CH_ADDR(ch) = getSPUAddr(0x1010);
SPU_CH_VOL_L(ch) = SPU_CH_VOL_R(ch) = 0x3fff;
SPU_CH_ADSR1(ch) = 0x00ff; SPU_CH_ADSR2(ch) = 0;
SpuSetKey(1, 1 << ch);
```
The VAG header is big-endian (size at +12, rate at +16). The `data` tool makes the
`.vag` and prints the pitch.

## CD files

`CdInit();` then `CdSearchFile(&file, "\\DATA\\LEVEL1.BIN;1")`, `CdControl(CdlSetloc,
&file.pos, 0); CdRead(sectors, buf, CdlModeSpeed); CdReadSync(0, 0);` (buffers in
2048-byte sectors, word aligned). Add the file to `iso.xml`.

## Memory cards

Through the BIOS (`psxapi.h`): `InitCARD(1); StartCARD(); _bu_init();` then
`open("bu00:BASLUS-00000GAME", (blocks << 16) | 0x200)` to create (port 1 =
`bu00`, port 2 = `bu10`), `write`/`read` in 128-byte multiples, `firstfile`/
`nextfile` to list, `erase` to delete. The first 128 bytes of a save must be the
"SC" title frame (title, icon palette) followed by its icon frame(s), or the BIOS
browser shows it as corrupt. Test with the `memory_card` tool (`format`, run the
save, `list`).
