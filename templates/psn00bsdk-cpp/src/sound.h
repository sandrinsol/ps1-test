// A sound effect: a VAG sample uploaded to SPU RAM, played on one voice.
#pragma once
#include <stdint.h>

class Sound {
public:
	void load(const uint8_t *vag, uint32_t spuAddress);
	void play(int voice);

private:
	uint32_t address_ = 0;
	int rate_ = 0;
};
