# PS1 memory map and registers

## Address space

| Address (KSEG0 / KSEG1) | Size | What |
|---|---|---|
| 0x80000000 / 0xA0000000 (also 0x00000000) | 2 MB | Main RAM (mirrored ×4 up to 8 MB on retail units). 0x0000-0xFFFF: BIOS kernel (vectors at 0x80, tables, its stack). Programs load at 0x80010000 |
| 0x1F000000 | 8 MB | Expansion 1 (parallel port: cheat carts, Xplorer, PIO debug carts) |
| 0x1F800000 | 1 KB | Scratchpad (D-cache used as RAM). Not in KSEG1, not a DMA source/target |
| 0x1F801000 | 8 KB | I/O registers (below) |
| 0x1F802000 | | Expansion 2 (DUART, POST LEDs on dev units) |
| 0xBFC00000 | 512 KB | BIOS ROM (reset vector 0xBFC00000) |
| 0xFFFE0130 | 4 | Cache control |

Exception vector: 0x80000080 (general); the kernel dispatches interrupts and
syscalls from there. A `pc` there every frame is normal (interrupt handling).

## Interrupts

| Reg | Address |
|---|---|
| I_STAT | 0x1F801070 (write 0 to a bit to acknowledge) |
| I_MASK | 0x1F801074 |

Bits: 0 VBLANK, 1 GPU (GP0 0x1F), 2 CDROM, 3 DMA, 4 TMR0, 5 TMR1, 6 TMR2,
7 controller/memory card byte received, 8 SIO, 9 SPU, 10 lightpen/PIO.

COP0 SR bit 0 IEc (interrupts enabled), bit 10 IM2 (the hardware line); the BIOS
manages both — PSn00bSDK and libpsx use the kernel's handlers.

## DMA

Channel n registers at 0x1F801080 + 0x10·n: MADR (+0 address), BCR (+4 block
size/count), CHCR (+8 control; bit 24 start/busy, bit 28 manual trigger).

| n | Device |
|---|---|
| 0 | MDEC in |
| 1 | MDEC out |
| 2 | GPU (linked-list mode for ordering tables; block mode for VRAM uploads) |
| 3 | CD-ROM |
| 4 | SPU (sound RAM uploads) |
| 5 | PIO |
| 6 | OTC (clears an ordering table backwards: each entry points at the previous) |

DPCR 0x1F8010F0 (priority + enable per channel), DICR 0x1F8010F4 (interrupt flags
per channel; bit 31 master flag).

Linked list (GPU): each node = header word `(count << 24) | next_address(24 bits)`
then `count` GP0 words. The end marker is 0x00FFFFFF. Nodes must be word aligned
and in main RAM.

## Timers (root counters)

Timer n at 0x1F801100 + 0x10·n: value (+0), mode (+4), target (+8).

| n | Clock sources (mode bits 8-9) |
|---|---|
| 0 | system clock or dot clock |
| 1 | system clock or **horizontal blank** (counts scanlines: mode 0x0100) |
| 2 | system clock or system clock / 8 |

Timer 1 counting HBlanks gives "how far into the frame" — 263 lines NTSC,
314 PAL — which is how the template computes `cpu_usage`.

## GPU

| Reg | Address | |
|---|---|---|
| GP0 | 0x1F801810 | write: drawing commands and VRAM transfers; read: GPUREAD (VRAM→CPU data) |
| GP1 | 0x1F801814 | write: display control; read: GPUSTAT |

GPUSTAT bits: 26 ready for command, 27 ready to send VRAM data, 28 ready for DMA
block, 29-30 DMA direction, 31 odd/even line, 23 display disabled, 22 interlace,
20 PAL, 21 24-bit colour, 16-19/17-18 horizontal/vertical resolution.

GP1 commands: 0x00 reset, 0x01 reset command buffer, 0x02 ack IRQ, 0x03 display
on/off (bit 0: 1 = off), 0x04 DMA direction, 0x05 display area start (VRAM x,y),
0x06 horizontal range, 0x07 vertical range, 0x08 display mode (width 256/320/
368/512/640, height 240/480, PAL, 24-bit, interlace), 0x10 get GPU info.

## SPU (0x1F801C00-0x1F801FFF)

| Reg | Address |
|---|---|
| Voice n | 0x1F801C00 + 0x10·n: volume L/R (+0/+2), pitch (+4; 0x1000 = 44.1 kHz), start address/8 (+6), ADSR (+8/+A), ADSR volume (+C), repeat address/8 (+E) |
| Main volume L/R | 0x1F801D80 / 0x1D82 |
| Reverb volume | 0x1F801D84 / 0x1D86 |
| KON (key on) | 0x1F801D88 (voices 0-15) / 0x1D8A (16-23) |
| KOFF (key off) | 0x1F801D8C / 0x1D8E |
| ENDX | 0x1F801D9C (voices that reached an end flag) |
| Transfer address/8 | 0x1F801DA6 |
| Transfer FIFO | 0x1F801DA8 |
| SPUCNT | 0x1F801DAA (bit 15 enable, 14 unmute, 4-5 transfer mode) |
| SPUSTAT | 0x1F801DAE |
| CD volume | 0x1F801DB0 |

SPU RAM (512 KB): 0x0000-0x0FFF CD audio and voice 1/3 capture buffers, 0x1000 a
silent loop block is customary; samples from 0x1010 up; the reverb work area at
the top (size set by the reverb mode). Samples are 4-bit ADPCM: 16-byte blocks of
28 samples, byte 1 holds the flags (bit 0 end, bit 1 repeat, bit 2 loop start).
DMA transfers to SPU RAM move 64-byte blocks best; addresses are in 8-byte units.

## CD-ROM (0x1F801800-0x1F801803)

Index/status register 0x1F801800 selects which register the other three are.
Commands (written to 0x1F801801, index 0): 0x01 Getstat, 0x02 Setloc, 0x06 ReadN,
0x09 Pause, 0x0A Init, 0x0E Setmode, 0x15 SeekL, 0x19 Test, 0x1A GetID, 0x1B ReadS.
Responses arrive with INT1-INT5 (data ready, complete, acknowledge, end, error).
Data sectors: 2352 bytes raw; Mode 2 Form 1 carries 2048 bytes of user data at
offset 24. Sector 16 is the ISO9660 primary volume descriptor; sectors 0-15
the system area (licence text in sector 4 on discs that boot on unmodified
consoles).

`SYSTEM.CNF` in the root: `BOOT = cdrom:\GAME.EXE;1`, `TCB = 4`, `EVENT = 10`,
`STACK = 801FFFF0`. Without it the BIOS runs `PSX.EXE`.

## Pads and memory cards (SIO0, 0x1F801040)

Serial at 250 kHz; port 1/2 chosen with the /CS select (JOY_CTRL 0x1F80104A bit 13).
Pad poll: 0x01, 0x42, 0x00 → ID (0x41 digital, 0x73 DualShock analog, 0x53 analog
stick, 0x12 mouse, 0x23 neGcon), 0x5A, then 2 bytes buttons (active low:
byte 1 SELECT L3 R3 START UP RIGHT DOWN LEFT, byte 2 L2 R2 L1 R1 TRIANGLE
CIRCLE CROSS SQUARE), then for analog 4 bytes RX RY LX LY (0x80 = centre).
DualShock config mode (0x43 …) switches analog on/off and lock; vibration with 0x4D.

Memory card: 0x81 select, then 0x52 read / 0x57 write sector (128 bytes, 1024
sectors). Block 0 frame 0 "MC"; directory frames 1-15 (state 0x51 first, 0x52
middle, 0x53 last, 0xA0 free), each with a size, next-block link and a filename
like `BASLUS-01234GAME` (region BA/BE/BI + product code + name). A save starts
with its title frame "SC" + icon frames.

## Kernel calls

`A0`/`B0`/`C0` tables: jump to 0xA0/0xB0/0xC0 with the function number in t1.
Common: A(0x44) FlushCache, A(0x47) GPU_SendPackets, B(0x08) OpenEvent,
B(0x12) InitPAD, B(0x13) StartPAD, B(0x4A) InitCARD, B(0x5B) ChangeClearPAD,
C(0x0A) ChangeClearRCnt. Syscall (`syscall` instruction) with a0: 1 EnterCriticalSection,
2 ExitCriticalSection.
