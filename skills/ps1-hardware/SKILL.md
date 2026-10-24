---
name: ps1-hardware
description: PlayStation (PS1/PSX) hardware reference — memory map, I/O registers (interrupts, DMA, timers, GPU, SPU, CD-ROM, pads and memory cards), the R3000A CPU and GTE, GPU primitives and VRAM rules, SPU RAM, and the numbers behind frame budgets. Use when you need an address, a bit, a limit or a timing to write, read or debug PS1 code, or to interpret read_memory / read_cpu / gpu_capture output.
---

# PS1 hardware

Details: [references/memory-map.md](references/memory-map.md) (addresses, registers,
interrupts, DMA, timers, SPU, CD, pads, memory cards) and
[references/gpu-gte.md](references/gpu-gte.md) (GPU commands, VRAM, textures, GTE).

## The console in numbers

| Part | Facts |
|---|---|
| CPU | MIPS R3000A (MIPS I), 33.8688 MHz, little-endian, no FPU, 4 KB I-cache, no D-cache (1 KB scratchpad instead) |
| Frame | NTSC 59.94 Hz ≈ 564,480 CPU cycles, 263 lines; PAL 50 Hz ≈ 677,376 cycles, 314 lines |
| RAM | 2 MB at 0x80000000 (KSEG0, cached) / 0xA0000000 (KSEG1, uncached) / 0x00000000; first 64 KB belong to the BIOS kernel |
| Scratchpad | 1 KB at 0x1F800000 (fast, not reachable by DMA, no KSEG1 mirror) |
| GPU | 1 MB VRAM as 1024×512 16-bit pixels; framebuffers and textures share it |
| GTE | Coprocessor 2: fixed-point 3D maths (rotate/translate/perspective, lighting) |
| SPU | 24 ADPCM voices, 512 KB sound RAM, reverb |
| CD-ROM | 2× speed (300 KB/s), 2048-byte data sectors (Mode 2 Form 1), XA audio |
| Pads | Digital (ID 0x41), DualShock / analog (0x73), analog stick (0x53); 16 buttons active-low |
| Memory card | 128 KB, 15 save blocks of 8 KB + directory |
| BIOS | 512 KB at 0xBFC00000 (Sony dump or the free OpenBIOS); kernel calls via A0/B0/C0 tables |

## Things that bite

- **Delay slots**: the instruction after a branch/jump always runs; a loaded register
  isn't ready for the next instruction (load delay). Compilers handle both in C;
  hand-written assembly must.
- **No unaligned access**: `lw`/`sw` on an address not multiple of 4 (2 for halfwords)
  raises an address error exception. Packed structs and casting `char*` buffers to
  `int*` are the usual cause (`check` names the exception and function).
- **Integer division** is a slow multi-cycle instruction (36 cycles) and `float`
  is software emulated (hundreds of cycles). Use fixed point (GTE: 4096 = 1.0).
- **GPU limits**: polygons wider than 1023 or taller than 511 pixels are dropped;
  textures are addressed through 64×256 texture pages; a 16-bit texel or CLUT entry
  of 0x0000 is transparent (store opaque black as 0x8000).
- **VSync/DrawSync order**: wait for drawing (`DrawSync`), then `VSync`, then swap
  buffers and send the next list; otherwise you draw into the visible buffer.
- **DMA**: sources must be in main RAM, word-aligned; GPU ordering tables are linked
  lists that end with 0x00FFFFFF.
- **SPU RAM** below 0x1010 is reserved (capture buffers); transfers are in 8-byte
  units, sample data in 16-byte ADPCM blocks with loop flags.
- **Caches**: code loaded or patched at run time needs `FlushCache()` before it runs.
- **Interrupts**: acknowledge in I_STAT by writing 0 to the bit (not 1, unlike most
  systems).

## Reading the harness output

- `read_cpu`: `pc`, the 31 registers, `hi`/`lo`, COP0 `sr`, `cause` (exception
  code in bits 2-6: 4 AdEL load address error, 5 AdES store, 6/7 bus error,
  8 syscall, 9 break, 10 reserved instruction, 12 overflow; bit 31 BD = it happened
  in a delay slot, so the faulting instruction is at `epc`+4) and `epc`. `check`
  also names the bad address and the function.
- `gpu_capture`: GP0 commands per frame with the drawing environment (E1-E6 words),
  primitive kind, vertices, texture page/CLUT; `src` says CPU write or DMA.
- `read_memory` reads RAM, the scratchpad, I/O registers (`0x1F801070` …) and the
  BIOS live; VRAM is read with `view_vram` (or `texture`), SPU RAM is in save states.
