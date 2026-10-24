# PS1 GPU and GTE

## VRAM

1024 × 512 16-bit words. Pixel format: bit 15 mask/semi-transparency (STP),
bits 10-14 blue, 5-9 green, 0-4 red. A display buffer is usually 320×240 at (0,0)
and (0,240); textures and CLUTs go in the rest (x ≥ 320, or below 480 …).

Textures:
- **Texture page**: 64 VRAM words wide (x multiple of 64), 256 lines tall (y 0 or 256).
  A primitive samples one page. 4-bit texels = 256 pixels per 64 words,
  8-bit = 128 pixels, 16-bit = 64 pixels.
- **CLUT**: 16 or 256 colours in one row, x a multiple of 16.
- A texel/CLUT colour of 0x0000 is **transparent**; opaque black is 0x8000.
  With semi-transparency on, STP-set texels are blended, others drawn opaque.
- Texture window (E2) repeats a sub-rectangle; texture coordinates are 8-bit.

The tools: `view_vram` (`gpu: true` outlines the texture pages and CLUTs this
frame used, `what: "texture"` shows one through its CLUT), `texture` (PNG → TIM).

## GP0 commands

Primitive header byte (bits 24-31):

| Range | Kind | Flags |
|---|---|---|
| 0x20-0x3F | polygon | bit 4 gouraud, bit 3 quad (4 vertices, two triangles 0-1-2 and 1-2-3), bit 2 textured, bit 1 semi-transparent, bit 0 raw texture (no colour modulation) |
| 0x40-0x5F | line | bit 4 gouraud, bit 3 polyline (ends with 0x5xxx5xxx), bit 1 semi-transparent |
| 0x60-0x7F | rectangle (sprite) | bits 3-4 size: 0 variable, 1 1×1, 2 8×8, 3 16×16; bit 2 textured |
| 0x02 | fill rectangle in VRAM (ignores the drawing area and mask) | |
| 0x80 | VRAM→VRAM copy | |
| 0xA0 | CPU→VRAM upload (then data words) | |
| 0xC0 | VRAM→CPU download | |
| 0xE1 | draw mode: texture page x/64 (bits 0-3), y/256 (bit 4), blend mode (5-6: 0 B/2+F/2, 1 B+F, 2 B−F, 3 B+F/4), colour depth (7-8), dither (9), draw to display area (10) |
| 0xE2 | texture window |
| 0xE3 / 0xE4 | drawing area top-left / bottom-right (x 10 bits, y 9/10 bits) |
| 0xE5 | drawing offset (signed 11-bit x, y) added to every vertex |
| 0xE6 | mask bit: set when drawing / don't draw over masked pixels |

Vertex word: `y << 16 | x` (signed 11-bit). Textured vertices carry a UV word
(UV + CLUT in the first, UV + texpage in the second).

Rules (the `check` tool tests these):
- A polygon whose vertices are more than 1023 apart horizontally or 511 vertically
  is not drawn at all — clip/subdivide large polygons near the camera.
- Primitives outside the drawing area (E3/E4 after the E5 offset) cost time and
  show nothing: cull them.
- Sprites (0x60-0x7F) use the texture page from the last E1, not their own: set it
  with a DR_TPAGE / DR_MODE packet before them.
- Don't sample a texture page that overlaps the framebuffer being drawn unless
  that's the effect you want.

## Ordering tables

An OT is an array of list heads, one per depth. `ClearOTagR` (DMA 6) links every
entry to the previous; `addPrim(&ot[z], prim)` inserts a primitive after entry z;
`DrawOTag(&ot[OT_LEN-1])` sends the list from the far end, so larger z draws first
(further away). Primitives are built in a per-frame buffer that must not overflow:
size it for the worst frame and assert on it.

Double buffering: two `DRAWENV`/`DISPENV` pairs; each frame draw into one while the
other is displayed, then `DrawSync(0); VSync(0); PutDispEnv; PutDrawEnv; DrawOTag`.

## GTE (COP2)

Fixed point: 1.0 = 4096 (12 fractional bits) for rotation matrices and normals;
screen coordinates in pixels.

- Rotation matrix RT (3×3, 1.3.12), translation TR (32-bit), screen offset OFX/OFY
  (16.16), projection distance H, depth queue DQA/DQB.
- Key commands: RTPS (one vertex), RTPT (three), NCLIP (winding / back-face: result
  in MAC0, ≤ 0 = facing away), AVSZ3/AVSZ4 (average Z for the OT index), NCDS/NCCS
  (lighting), MVMVA (matrix × vector), SQR, OP, GPF/GPL (interpolation).
- Results: SXY0-2 screen positions (FIFO), SZ0-3 depths, IR1-3, MAC0-3, FLAG
  (overflow/saturation bits; bit 31 = an error bit set, e.g. vertex behind the camera).
- Hazards: after `mtc2`/`ctc2`/`lwc2` wait 2 instructions before a GTE command uses
  the value; after a command, reading results stalls until it finishes (RTPS 15
  cycles, RTPT 23). PSn00bSDK's `gte_*` macros include the needed `nop`s;
  hand-written sequences must.
- Precision: keep model coordinates small (a few thousand units); large
  translations overflow (FLAG) and vertices wobble. Wobble and texture warping
  (affine mapping, no perspective correction) are normal PS1 looks — subdivide
  large textured polygons to reduce warping.

`read_cpu` with `gte: true` shows the GTE registers.
