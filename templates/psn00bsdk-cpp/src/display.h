// Double-buffered display: draw into one half of VRAM while the other is shown,
// with an ordering table and a primitive buffer per half.
#pragma once
#include <stdint.h>
#include <psxgpu.h>

class Display {
public:
	static constexpr int Width = 320, Height = 240, OtLength = 256;

	void init();
	// The ordering table being built this frame.
	uint32_t *ot() { return buffers_[active_].ot; }
	// Room for one primitive of type T in this frame's buffer.
	template <typename T> T *alloc() {
		T *p = reinterpret_cast<T *>(next_);
		next_ += sizeof(T);
		return p;
	}
	uint8_t **cursor() { return &next_; }
	// Wait for the GPU and VSync, show what was drawn, start the next frame.
	// Returns the % of the frame the CPU spent before waiting.
	int flip();

private:
	static constexpr int PrimLength = 8192;
	struct Buffer {
		DISPENV disp;
		DRAWENV draw;
		uint32_t ot[OtLength];
		uint8_t prims[PrimLength];
	};
	Buffer buffers_[2];
	int active_ = 0;
	uint8_t *next_ = nullptr;
};
