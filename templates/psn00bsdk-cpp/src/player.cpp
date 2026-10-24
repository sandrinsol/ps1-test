#include "player.h"

// Read by the test harness (ps1test.json "watch").
int16_t player_x = 152, player_y = 160;

void Player::load(const uint32_t *tim) {
	/* Texture + CLUT go into VRAM once; primitives refer to them by position. */
	GetTimInfo(tim, &tim_);
	LoadImage(tim_.prect, tim_.paddr);
	if (tim_.mode & 8)
		LoadImage(tim_.crect, tim_.caddr);
	DrawSync(0);
}

bool Player::update(const PADTYPE *pad) {
	/* stat 0 = a pad answered; type 0 = the BIOS hasn't polled it yet (the
	 * buffer is still all zeros, which would read as every button held). */
	if (pad->stat != 0 || pad->type == 0)
		return false;
	if (!(pad->btn & PAD_LEFT))  player_x -= 2;
	if (!(pad->btn & PAD_RIGHT)) player_x += 2;
	if (!(pad->btn & PAD_UP))    player_y -= 2;
	if (!(pad->btn & PAD_DOWN))  player_y += 2;
	/* Cross pressed this frame (buttons are active-low). */
	bool cross = !(pad->btn & PAD_CROSS) && (lastButtons_ & PAD_CROSS);
	lastButtons_ = pad->btn;
	/* Analog (DualShock in analog mode, or an analog pad): the left stick too. */
	if ((pad->type == PAD_ID_ANALOG_STICK || pad->type == PAD_ID_ANALOG) && pad->len >= 3) {
		int lx = pad->ls_x - 128, ly = pad->ls_y - 128;
		if (lx < -32 || lx > 32) player_x += lx / 32;
		if (ly < -32 || ly > 32) player_y += ly / 32;
	}
	if (player_x < 0) player_x = 0;
	if (player_x > Display::Width - 16) player_x = Display::Width - 16;
	if (player_y < 64) player_y = 64;
	if (player_y > Display::Height - 16) player_y = Display::Height - 16;
	return cross;
}

void Player::draw(Display &display) {
	SPRT_16 *s = display.alloc<SPRT_16>();
	setSprt16(s);
	setXY0(s, player_x, player_y);
	setRGB0(s, 128, 128, 128);
	setUV0(s, (tim_.prect->x % 64) * (4 >> (tim_.mode & 3)), tim_.prect->y & 0xff);
	setClut(s, tim_.crect->x, tim_.crect->y);
	addPrim(display.ot(), s);
	/* The sprite primitive has no texture page: set it with a draw mode packet. */
	DR_TPAGE *t = display.alloc<DR_TPAGE>();
	setDrawTPage(t, 0, 1, getTPage(tim_.mode & 3, 0, tim_.prect->x, tim_.prect->y));
	addPrim(display.ot(), t);
}
