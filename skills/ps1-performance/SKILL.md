---
name: ps1-performance
description: Make a PlayStation (PS1) game hold its frame rate — measure CPU load and lag per frame, find what is slow (CPU, GTE, GPU fill rate, ordering tables, CD loading), and fix it (fixed point instead of floats, avoiding division, scratchpad, GTE batching, culling, fewer/smaller primitives, DMA). Use when a PS1 game slows down, drops frames, or the user asks to optimise it.
---

# PS1 performance

A frame is ≈ 564,000 CPU cycles at 59.94 Hz NTSC (263 scanlines, ≈ 2,146 cycles each),
≈ 677,000 at 50 Hz PAL (314 lines). CPU and GPU run in parallel: the CPU builds
frame N+1's ordering table while the GPU draws frame N. A frame is late when
either side doesn't finish in time.

## 1. Measure first

- Keep `frame_count` (incremented once per main loop) and `cpu_usage` (% of the
  frame spent before waiting) as globals and name them in `ps1test.json`
  (`frameCounter`, `cpuUsage`). The template measures with root counter 1 in
  HBlank mode: `TIMER_CTRL(1) = 0x0100` at start; before `VSync(0)`
  `cpu_usage = TIMER_VALUE(1) * 100 / 263;` then `TIMER_VALUE(1) = 0` after it.
- `check` with `frames` over the slow part: lag frames (VSyncs the loop missed),
  min/average/max CPU %, primitives per frame, primitives dropped or off-screen.
- `describe` with `watch` on `cpu_usage` shows the cost of each action as you play.
- `profile` (`frames` over the slow part) samples the pc every 256 CPU cycles and
  lists the share of time per function, with the time spent waiting for VSync
  apart: the first place to look, before timing sections by hand.
- Time sections: read `TIMER_VALUE(1)` (scanlines) before and after into globals
  (`t_ai`, `t_draw`) and `read_memory` them.
- CPU low but still lagging → the GPU is the bottleneck: measure the time spent in
  `DrawSync(0)` the same way; `gpu_capture` shows how many and how big the
  primitives are.

## 2. CPU fixes, biggest first

| Cost | Fix |
|---|---|
| `float`/`double` (software, hundreds of cycles per operation) | Fixed point: `int` with 12 fraction bits (4096 = 1.0) like the GTE |
| Division / modulo by a variable (`div` ≈ 36 cycles, plus checks) | Shifts, reciprocal tables (`data` `table: "reciprocal"`), divide once per frame not per object |
| Trig / sqrt per object | `isin`/`icos` or `data` tables; compare squared distances |
| 3D maths in C | The GTE: `gte_rtpt` transforms 3 vertices in 23 cycles; `gte_nclip` for back-face culling before building the primitive; `gte_avsz3`/`avsz4` for the OT index |
| Hot data in main RAM (no data cache) | Put the hottest small buffers (matrices, vertex temp, the stack of a hot routine) in the 1 KB scratchpad at 0x1F800000 |
| Copying with byte loops | 32-bit copies; DMA for VRAM (`LoadImage`), SPU and OT clearing (`ClearOTagR`) |
| Per-object work every frame | Every 2nd/4th frame, or only on change; early-out for off-screen objects before transforming them |
| O(n²) collision | Grid/tile lookups; sort by x and compare neighbours |
| Many tiny function calls in a hot loop | `static inline`; pass pointers, not structs |
| Pad/CD/BIOS calls each frame | Use the SDK's interrupt-driven pad and CD reads; never busy-wait on the CD in the game loop |

## 3. GPU fixes

The GPU is fill-rate bound: big, textured, semi-transparent primitives cost the most.

- Cull: off-screen (`check` counts primitives outside the drawing area), back
  faces (`gte_nclip`), objects beyond a draw distance.
- Smaller/fewer polygons: LOD for far objects; sprites (`SPRT`) instead of quads
  for 2D; one big `TILE`/fill instead of many small ones.
- Semi-transparency and gouraud shading cost more than flat opaque; dithering
  costs little.
- 4-bit textures read less VRAM than 8/16-bit: prefer them (`texture` `depth: 4`).
- Clearing: `isbg` in the DRAWENV fills the screen once; don't also draw a
  full-screen quad.
- Ordering table: size it to what you need (a 4096-entry OT costs a DMA clear and
  a long walk every frame); primitive buffer big enough for the worst frame.
- Polygons over 1023×511 are dropped, not slow: subdivide them (it also reduces
  texture warping).

## 4. Loading and memory

- CD reads are 300 KB/s at 2×: load a level once, stream only music/XA; group files
  so they're read in one seek.
- 2 MB RAM: watch the image end (`check` reports the stack low point vs the data
  end); compress assets (LZ) if the image grows.
- Upload textures once at level start, not per frame; reuse VRAM regions.

## 5. Verify

Re-run the same `run_sequence` (or a saved state at the heavy scene) with `check`
before and after the change; compare lag frames and max CPU, and `ab_compare` the
two builds to prove the picture didn't change.
