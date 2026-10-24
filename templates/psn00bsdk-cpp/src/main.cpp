/*
 * A small PS1 game in C++ with PSn00bSDK: a player sprite you move with the
 * D-pad (or the left stick on an analog pad), some text, and a spinning cube
 * drawn with the GTE. Cross plays a sound effect. The same game as the C
 * template, organised in classes (Display, Player, Cube, Sound).
 *
 * C++ here is the embedded subset: no exceptions, RTTI or standard library
 * (PSn00bSDK builds with -fno-exceptions -fno-rtti); classes, templates,
 * constexpr, references and namespaces all work.
 *
 * Variables the test harness reads by name (see ps1test.json):
 *   frame_count    incremented once per main-loop iteration (lag detection)
 *   cpu_usage      % of the last frame spent before waiting for VSync
 *   player_x/y     the player's position (player.cpp)
 *   sounds_played  how many times the sound effect was started (sound.cpp)
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
#include "display.h"
#include "player.h"
#include "cube.h"
#include "sound.h"

volatile uint32_t frame_count;
volatile int32_t cpu_usage;

extern "C" const uint32_t player_tim[];
extern "C" const uint8_t blip_vag[];

namespace {
Display display;
Player player;
Cube cube;
Sound blip;
uint8_t padBuffers[2][34];

/* SPU RAM below 0x1010 is reserved (capture buffers, psxspu's dummy sample). */
constexpr uint32_t BlipAddress = 0x1010;

void init() {
	display.init();
	player.load(player_tim);

	FntLoad(960, 0);
	FntOpen(16, 16, 288, 48, 0, 256);

	InitGeom();
	gte_SetGeomOffset(Display::Width / 2, Display::Height / 2 - 20);
	gte_SetGeomScreen(Display::Width / 2);

	SpuInit();
	blip.load(blip_vag, BlipAddress);

	InitPAD(padBuffers[0], 34, padBuffers[1], 34);
	StartPAD();
	ChangeClearPAD(0);

	SetDispMask(1);
}
}

int main(int argc, const char **argv) {
	init();
	for (;;) {
		if (player.update(reinterpret_cast<const PADTYPE *>(padBuffers[0])))
			blip.play(0);
		FntPrint(-1, "PS1 TEST GAME\n\nFRAME %d  CPU %d%%\n", frame_count, cpu_usage);
		FntFlush(-1);
		player.draw(display);
		cube.draw(display, frame_count * 16);
		frame_count++;
		cpu_usage = display.flip();
	}
	return 0;
}
