#include "display.h"
#include <hwregs_c.h>

void Display::init() {
	ResetGraph(0);
	for (int i = 0; i < 2; i++) {
		SetDefDispEnv(&buffers_[i].disp, i ? 0 : Width, 0, Width, Height);
		SetDefDrawEnv(&buffers_[i].draw, i ? Width : 0, 0, Width, Height);
		setRGB0(&buffers_[i].draw, 16, 24, 48);
		buffers_[i].draw.isbg = 1;
		buffers_[i].draw.dtd = 1;
	}
	active_ = 0;
	next_ = buffers_[0].prims;
	ClearOTagR(buffers_[0].ot, OtLength);
	ClearOTagR(buffers_[1].ot, OtLength);
	/* Root counter 1 counts scanlines: how far into the frame we are. */
	TIMER_CTRL(1) = 0x0100;
}

int Display::flip() {
	DrawSync(0);
	int usage = (TIMER_VALUE(1) * 100) / 263;
	VSync(0);
	TIMER_VALUE(1) = 0;
	active_ ^= 1;
	next_ = buffers_[active_].prims;
	ClearOTagR(buffers_[active_].ot, OtLength);
	PutDispEnv(&buffers_[active_].disp);
	PutDrawEnv(&buffers_[active_].draw);
	DrawOTag(buffers_[active_ ^ 1].ot + OtLength - 1);
	return usage;
}
