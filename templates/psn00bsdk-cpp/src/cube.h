// A flat-shaded cube transformed by the GTE and depth-sorted into the ordering table.
#pragma once
#include "display.h"

class Cube {
public:
	void draw(Display &display, int angle) const;
};
