#include "sound.h"
#include <psxspu.h>
#include <hwregs_c.h>

// Read by the test harness (ps1test.json "watch").
volatile uint32_t sounds_played;

/* .vag files: a 48-byte big-endian header, then the ADPCM data. */
void Sound::load(const uint8_t *vag, uint32_t spuAddress) {
	uint32_t size = __builtin_bswap32(*reinterpret_cast<const uint32_t *>(vag + 12));
	rate_ = __builtin_bswap32(*reinterpret_cast<const uint32_t *>(vag + 16));
	address_ = spuAddress;
	SpuSetTransferMode(SPU_TRANSFER_BY_DMA);
	SpuSetTransferStartAddr(address_);
	SpuWrite(reinterpret_cast<const uint32_t *>(vag + 48), (size + 63) & ~63);
	SpuIsTransferCompleted(SPU_TRANSFER_WAIT);
}

void Sound::play(int voice) {
	SpuSetKey(0, 1 << voice);
	SPU_CH_FREQ(voice) = getSPUSampleRate(rate_);
	SPU_CH_ADDR(voice) = getSPUAddr(address_);
	SPU_CH_VOL_L(voice) = 0x3fff;
	SPU_CH_VOL_R(voice) = 0x3fff;
	SPU_CH_ADSR1(voice) = 0x00ff;
	SPU_CH_ADSR2(voice) = 0x0000;
	SpuSetKey(1, 1 << voice);
	sounds_played++;
}
