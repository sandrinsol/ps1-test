#include "cube.h"
#include <psxgte.h>
#include <inline_c.h>

namespace {
const SVECTOR verts[8] = {
	{ -40, -40, -40 }, {  40, -40, -40 }, { -40,  40, -40 }, {  40,  40, -40 },
	{  40, -40,  40 }, { -40, -40,  40 }, {  40,  40,  40 }, { -40,  40,  40 },
};
const uint8_t faces[6][4] = {
	{ 0, 1, 2, 3 }, { 4, 5, 6, 7 }, { 5, 4, 0, 1 }, { 6, 7, 3, 2 }, { 0, 2, 5, 7 }, { 3, 1, 6, 4 },
};
const uint8_t colours[6][3] = {
	{ 224, 64, 64 }, { 64, 224, 64 }, { 64, 64, 224 }, { 224, 224, 64 }, { 64, 224, 224 }, { 224, 64, 224 },
};
}

void Cube::draw(Display &display, int angle) const {
	SVECTOR rot = { static_cast<int16_t>(angle), static_cast<int16_t>(angle / 2), 0 };
	VECTOR pos = { 0, 0, 300 };
	MATRIX m;
	RotMatrix(&rot, &m);
	TransMatrix(&m, &pos);
	gte_SetRotMatrix(&m);
	gte_SetTransMatrix(&m);

	uint32_t *ot = display.ot();
	for (int i = 0; i < 6; i++) {
		int z;
		gte_ldv3(&verts[faces[i][0]], &verts[faces[i][1]], &verts[faces[i][2]]);
		gte_rtpt();
		gte_nclip();
		gte_stopz(&z);
		if (z < 0)
			continue;            /* facing away */
		gte_avsz3();
		gte_stotz(&z);
		if ((z >> 2) >= Display::OtLength)
			continue;
		POLY_F4 *p = display.alloc<POLY_F4>();
		setPolyF4(p);
		gte_stsxy0(&p->x0);
		gte_stsxy1(&p->x1);
		gte_stsxy2(&p->x2);
		gte_ldv0(&verts[faces[i][3]]);
		gte_rtps();
		gte_stsxy(&p->x3);
		setRGB0(p, colours[i][0], colours[i][1], colours[i][2]);
		addPrim(ot + (z >> 2), p);
	}
}
