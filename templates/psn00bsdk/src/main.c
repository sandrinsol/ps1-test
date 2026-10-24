/*
 * A small PS1 game for PSn00bSDK: a player sprite you move with the D-pad (or
 * the left stick on an analog pad), some text, and a spinning cube drawn with
 * the GTE. Double-buffered, with an ordering table, like most PS1 games.
 *
 * Cross plays a sound effect (a VAG sample uploaded to SPU RAM at start).
 *
 * Variables the test harness reads by name (see ps1test.json):
 *   frame_count    incremented once per main-loop iteration (lag detection)
 *   cpu_usage      % of the last frame spent before waiting for VSync
 *   player_x/y     the player's position
 *   sounds_played  how many times the sound effect was started
 */
#include <stdint.h>
#include <stdio.h>
#include <psxgpu.h>
#include <psxgte.h>
#include <inline_c.h>
#include <psxpad.h>
#include <psxapi.h>
#include <psxetc.h>
#include <psxspu.h>
#include <hwregs_c.h>

#define SCREEN_W 320
#define SCREEN_H 240
#define OT_LEN   256
#define PRIM_LEN 8192

typedef struct {
	DISPENV disp;
	DRAWENV draw;
	uint32_t ot[OT_LEN];
	uint8_t prims[PRIM_LEN];
} Buffer;

static Buffer buffers[2];
static int active;
static uint8_t *next_prim;

volatile uint32_t frame_count;
volatile int32_t cpu_usage;
int16_t player_x = 152, player_y = 160;
volatile uint32_t sounds_played;

static uint8_t pad_buffers[2][34];
extern const uint32_t player_tim[];
static TIM_IMAGE player;
extern const uint8_t blip_vag[];

/* SPU RAM below 0x1010 is reserved (capture buffers, psxspu's dummy sample). */
#define BLIP_ADDR 0x1010
static int blip_rate;
static uint16_t last_buttons = 0xffff;

/* .vag files: a 48-byte big-endian header, then the ADPCM data. */
static void load_sound(void) {
	uint32_t size = __builtin_bswap32(*(const uint32_t *)(blip_vag + 12));
	blip_rate = __builtin_bswap32(*(const uint32_t *)(blip_vag + 16));
	SpuSetTransferMode(SPU_TRANSFER_BY_DMA);
	SpuSetTransferStartAddr(BLIP_ADDR);
	SpuWrite((const uint32_t *)(blip_vag + 48), (size + 63) & ~63);
	SpuIsTransferCompleted(SPU_TRANSFER_WAIT);
}

static void play_sound(void) {
	SpuSetKey(0, 1 << 0);
	SPU_CH_FREQ(0) = getSPUSampleRate(blip_rate);
	SPU_CH_ADDR(0) = getSPUAddr(BLIP_ADDR);
	SPU_CH_VOL_L(0) = 0x3fff;
	SPU_CH_VOL_R(0) = 0x3fff;
	SPU_CH_ADSR1(0) = 0x00ff;
	SPU_CH_ADSR2(0) = 0x0000;
	SpuSetKey(1, 1 << 0);
	sounds_played++;
}

void draw_cube(uint32_t *ot, int ot_len, uint8_t **prims, int angle);

static void init(void) {
	ResetGraph(0);
	for (int i = 0; i < 2; i++) {
		/* Draw into one half of VRAM while the other is shown. */
		SetDefDispEnv(&buffers[i].disp, i ? 0 : SCREEN_W, 0, SCREEN_W, SCREEN_H);
		SetDefDrawEnv(&buffers[i].draw, i ? SCREEN_W : 0, 0, SCREEN_W, SCREEN_H);
		setRGB0(&buffers[i].draw, 16, 24, 48);
		buffers[i].draw.isbg = 1;
		buffers[i].draw.dtd = 1;
	}
	active = 0;
	next_prim = buffers[0].prims;
	ClearOTagR(buffers[0].ot, OT_LEN);
	ClearOTagR(buffers[1].ot, OT_LEN);

	/* Texture + CLUT go into VRAM once; primitives refer to them by position. */
	GetTimInfo(player_tim, &player);
	LoadImage(player.prect, player.paddr);
	if (player.mode & 8)
		LoadImage(player.crect, player.caddr);
	DrawSync(0);

	FntLoad(960, 0);
	FntOpen(16, 16, 288, 48, 0, 256);

	InitGeom();
	gte_SetGeomOffset(SCREEN_W / 2, SCREEN_H / 2 - 20);
	gte_SetGeomScreen(SCREEN_W / 2);

	SpuInit();
	load_sound();

	InitPAD(pad_buffers[0], 34, pad_buffers[1], 34);
	StartPAD();
	ChangeClearPAD(0);

	/* Root counter 1 counts scanlines: how far into the frame we are. */
	TIMER_CTRL(1) = 0x0100;

	SetDispMask(1);
}

static void read_pad(void) {
	PADTYPE *pad = (PADTYPE *)pad_buffers[0];
	/* stat 0 = a pad answered; type 0 = the BIOS hasn't polled it yet (the
	 * buffer is still all zeros, which would read as every button held). */
	if (pad->stat != 0 || pad->type == 0)
		return;
	if (!(pad->btn & PAD_LEFT))  player_x -= 2;
	if (!(pad->btn & PAD_RIGHT)) player_x += 2;
	if (!(pad->btn & PAD_UP))    player_y -= 2;
	if (!(pad->btn & PAD_DOWN))  player_y += 2;
	/* Cross pressed this frame (buttons are active-low). */
	if (!(pad->btn & PAD_CROSS) && (last_buttons & PAD_CROSS))
		play_sound();
	last_buttons = pad->btn;
	/* Analog (DualShock in analog mode, or an analog pad): the left stick too. */
	if ((pad->type == PAD_ID_ANALOG_STICK || pad->type == PAD_ID_ANALOG) && pad->len >= 3) {
		int lx = pad->ls_x - 128, ly = pad->ls_y - 128;
		if (lx < -32 || lx > 32) player_x += lx / 32;
		if (ly < -32 || ly > 32) player_y += ly / 32;
	}
	if (player_x < 0) player_x = 0;
	if (player_x > SCREEN_W - 16) player_x = SCREEN_W - 16;
	if (player_y < 64) player_y = 64;
	if (player_y > SCREEN_H - 16) player_y = SCREEN_H - 16;
}

static void draw_player(uint32_t *ot) {
	SPRT_16 *s = (SPRT_16 *)next_prim;
	setSprt16(s);
	setXY0(s, player_x, player_y);
	setRGB0(s, 128, 128, 128);
	setUV0(s, (player.prect->x % 64) * (4 >> (player.mode & 3)), player.prect->y & 0xff);
	setClut(s, player.crect->x, player.crect->y);
	addPrim(ot, s);
	next_prim += sizeof(SPRT_16);
	/* The sprite primitive has no texture page: set it with a draw mode packet. */
	DR_TPAGE *t = (DR_TPAGE *)next_prim;
	setDrawTPage(t, 0, 1, getTPage(player.mode & 3, 0, player.prect->x, player.prect->y));
	addPrim(ot, t);
	next_prim += sizeof(DR_TPAGE);
}

static void display(void) {
	DrawSync(0);
	cpu_usage = (TIMER_VALUE(1) * 100) / 263;
	VSync(0);
	TIMER_VALUE(1) = 0;
	active ^= 1;
	next_prim = buffers[active].prims;
	ClearOTagR(buffers[active].ot, OT_LEN);
	PutDispEnv(&buffers[active].disp);
	PutDrawEnv(&buffers[active].draw);
	DrawOTag(buffers[active ^ 1].ot + OT_LEN - 1);
}

int main(int argc, const char **argv) {
	init();
	for (;;) {
		Buffer *b = &buffers[active];
		read_pad();
		FntPrint(-1, "PS1 TEST GAME\n\nFRAME %d  CPU %d%%\n", frame_count, cpu_usage);
		FntFlush(-1);
		draw_player(b->ot);
		draw_cube(b->ot, OT_LEN, &next_prim, frame_count * 16);
		frame_count++;
		display();
	}
	return 0;
}
