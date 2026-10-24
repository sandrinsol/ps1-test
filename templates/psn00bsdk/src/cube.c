/* A flat-shaded cube transformed by the GTE and depth-sorted into the
 * ordering table. */
#include <stdint.h>
#include <psxgpu.h>
#include <psxgte.h>
#include <inline_c.h>

static const SVECTOR verts[8] = {
	{ -40, -40, -40 }, {  40, -40, -40 }, { -40,  40, -40 }, {  40,  40, -40 },
	{  40, -40,  40 }, { -40, -40,  40 }, {  40,  40,  40 }, { -40,  40,  40 },
};
static const uint8_t faces[6][4] = {
	{ 0, 1, 2, 3 }, { 4, 5, 6, 7 }, { 5, 4, 0, 1 }, { 6, 7, 3, 2 }, { 0, 2, 5, 7 }, { 3, 1, 6, 4 },
};
static const uint8_t colours[6][3] = {
	{ 224, 64, 64 }, { 64, 224, 64 }, { 64, 64, 224 }, { 224, 224, 64 }, { 64, 224, 224 }, { 224, 64, 224 },
};

void draw_cube(uint32_t *ot, int ot_len, uint8_t **prims, int angle) {
	SVECTOR rot = { angle, angle / 2, 0 };
	VECTOR pos = { 0, 0, 300 };
	MATRIX m;
	RotMatrix(&rot, &m);
	TransMatrix(&m, &pos);
	gte_SetRotMatrix(&m);
	gte_SetTransMatrix(&m);

	POLY_F4 *p = (POLY_F4 *)*prims;
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
		if ((z >> 2) >= ot_len)
			continue;
		setPolyF4(p);
		gte_stsxy0(&p->x0);
		gte_stsxy1(&p->x1);
		gte_stsxy2(&p->x2);
		gte_ldv0(&verts[faces[i][3]]);
		gte_rtps();
		gte_stsxy(&p->x3);
		setRGB0(p, colours[i][0], colours[i][1], colours[i][2]);
		addPrim(ot + (z >> 2), p);
		p++;
	}
	*prims = (uint8_t *)p;
}
