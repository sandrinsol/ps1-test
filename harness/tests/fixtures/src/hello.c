/* Test fixture: a coloured box the D-pad (or the left stick) moves, a frame
 * counter, the pad reading in RAM, and an SPU tone while Cross is held. Bare
 * metal (no BIOS calls after boot), so it runs the same under OpenBIOS, HLE
 * and a real BIOS. */
#include <stdint.h>

#define REG(a) (*(volatile uint32_t *)(a))
#define GP0 REG(0x1f801810)
#define GP1 REG(0x1f801814)
#define GPUSTAT REG(0x1f801814)
#define I_STAT REG(0x1f801070)
#define I_MASK REG(0x1f801074)
#define JOY_DATA (*(volatile uint8_t *)0x1f801040)
#define JOY_STAT (*(volatile uint16_t *)0x1f801044)
#define JOY_MODE (*(volatile uint16_t *)0x1f801048)
#define JOY_CTRL (*(volatile uint16_t *)0x1f80104a)
#define JOY_BAUD (*(volatile uint16_t *)0x1f80104e)

volatile uint32_t frame_count;
volatile uint16_t pad_buttons; /* active-high: 1 = pressed */
volatile int16_t box_x = 144, box_y = 104;
volatile uint8_t pad_id;
volatile uint8_t stick_lx = 0x80, stick_ly = 0x80, stick_rx = 0x80, stick_ry = 0x80;
volatile uint8_t tone_on;

#define SPU16(o) (*(volatile uint16_t *)(0x1f801c00 + (o)))

static void gp0_wait(void) { while (!(GPUSTAT & (1u << 26))) ; }

static void fill(int x, int y, int w, int h, uint32_t bgr) {
  gp0_wait();
  GP0 = 0x02000000 | bgr;
  GP0 = ((uint32_t)y << 16) | (uint32_t)x;
  GP0 = ((uint32_t)h << 16) | (uint32_t)w;
}

static void vsync(void) {
  while (!(I_STAT & 1)) ;
  I_STAT = ~1u;
}

static uint8_t joy_xfer(uint8_t b) {
  while (!(JOY_STAT & 1)) ;
  JOY_DATA = b;
  for (int i = 0; i < 2000; i++) if (JOY_STAT & 2) break;
  uint8_t r = JOY_DATA;
  for (volatile int i = 0; i < 100; i++) ;
  return r;
}

static uint16_t read_pad(void) {
  JOY_CTRL = 0x1003; /* TX enable, /JOY1 select */
  for (volatile int i = 0; i < 500; i++) ;
  joy_xfer(0x01);
  pad_id = joy_xfer(0x42);
  joy_xfer(0x00);
  uint16_t lo = joy_xfer(0x00);
  uint16_t hi = joy_xfer(0x00);
  if ((pad_id >> 4) == 7) {          /* analog: right X, right Y, left X, left Y */
    stick_rx = joy_xfer(0x00);
    stick_ry = joy_xfer(0x00);
    stick_lx = joy_xfer(0x00);
    stick_ly = joy_xfer(0x00);
  }
  JOY_CTRL = 0;
  return (uint16_t)~(lo | (hi << 8));
}

/* Upload a two-block looping square wave (SPU ADPCM) to SPU RAM 0x1000 and set
 * voice 0 up to play it. */
static void spu_init(void) {
  SPU16(0x1aa) = 0xc000;               /* SPU on, unmuted */
  SPU16(0x180) = 0x3fff; SPU16(0x182) = 0x3fff;
  SPU16(0x1a6) = 0x1000 >> 3;          /* transfer address */
  for (int b = 0; b < 2; b++) {
    uint16_t blk[8];
    blk[0] = (uint16_t)((b ? 3 : 4) << 8); /* shift 0 filter 0; flags: loop start, then end+repeat */
    for (int i = 1; i < 8; i++) blk[i] = i < 4 ? 0x7777 : 0x8888;
    for (int i = 0; i < 8; i++) SPU16(0x1a8) = blk[i];
  }
  SPU16(0x1aa) = 0xc010;               /* manual write */
  while (SPU16(0x1ae) & 0x400) ;
  SPU16(0x1aa) = 0xc000;
  SPU16(0x000) = 0x3fff; SPU16(0x002) = 0x3fff;  /* voice 0 volume */
  SPU16(0x004) = 0x0800;               /* pitch: 22.05 kHz */
  SPU16(0x006) = 0x1000 >> 3;          /* start address */
  SPU16(0x008) = 0x80ff; SPU16(0x00a) = 0x1fc0;  /* ADSR: fast attack, sustain */
}

int main(void) {
  I_MASK = 0;
  GP1 = 0x00000000;            /* reset GPU */
  GP1 = 0x06c60260;            /* horizontal display range */
  GP1 = 0x07042018;            /* vertical display range (NTSC) */
  GP1 = 0x08000001;            /* 320x240, NTSC, 15-bit */
  GP1 = 0x05000000;            /* display starts at VRAM 0,0 */
  gp0_wait();
  GP0 = 0xe1000400;            /* draw mode: allow drawing to display area */
  GP0 = 0xe3000000;            /* drawing area top-left 0,0 */
  GP0 = 0xe4000000 | (239 << 10) | 319;
  GP0 = 0xe5000000;            /* drawing offset 0,0 */
  GP1 = 0x03000000;            /* display on */
  JOY_MODE = 0x000d;
  JOY_BAUD = 0x0088;
  spu_init();

  for (;;) {
    vsync();
    frame_count++;
    uint16_t b = read_pad();
    pad_buttons = b;
    if (b & (1 << 4)) box_y--;     /* up */
    if (b & (1 << 6)) box_y++;     /* down */
    if (b & (1 << 7)) box_x--;     /* left */
    if (b & (1 << 5)) box_x++;     /* right */
    if ((pad_id >> 4) == 7) {      /* left stick moves the box too, 1 px per 32 units */
      box_x += ((int)stick_lx - 128) / 32;
      box_y += ((int)stick_ly - 128) / 32;
    }
    uint8_t want = (b & (1 << 14)) != 0;
    if (want && !tone_on) SPU16(0x188) = 1;       /* key on voice 0 */
    if (!want && tone_on) SPU16(0x18c) = 1;       /* key off */
    tone_on = want;
    fill(0, 0, 320, 240, 0x402010);          /* dark blue background */
    uint32_t c = (b & (1 << 14)) ? 0x00ff00 : 0x0000ff; /* X held: green, else red */
    fill(box_x, box_y, 32, 32, c);
  }
}
