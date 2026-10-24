// The player: a 16x16 sprite (a TIM in VRAM) moved by the D-pad or the left stick.
#pragma once
#include <stdint.h>
#include <psxgpu.h>
#include <psxpad.h>
#include "display.h"

class Player {
public:
	void load(const uint32_t *tim);
	// Returns true when Cross was pressed this frame.
	bool update(const PADTYPE *pad);
	void draw(Display &display);

private:
	TIM_IMAGE tim_;
	uint16_t lastButtons_ = 0xffff;
};
