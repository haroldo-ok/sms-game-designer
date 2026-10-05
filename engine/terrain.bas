	'
	' SMS Game Designer - engine kernel: terrain
	' engine/terrain.bas    (engine version 1)
	'
	' Included only when some room in the project actually has a tilemap.
	' A game with no terrain pays nothing for this - neither the ROM for the
	' procedures nor the 896 bytes of RAM shadow, which codegen collapses to
	' one byte by setting #MAP_CELLS to 1.
	'
	'
	' Terrain lookup: k_px, k_py in (pixels), k_cell out (ATTR_* bits).
	'
	' O(1) per query against the RAM shadow of the room's collision layer.
	' This is why terrain is tiles and never actors: walls as actors would
	' make floor collision O(n) pairwise against a pool that has no room
	' for them.
	'
k_cell_at: PROCEDURE
	' Out of bounds reads as empty. The limit is generated, not hardcoded:
	' rooms are as tall as the visible screen, which differs between targets,
	' and a stale 223 here silently indexed past the end of the shadow and
	' returned whatever byte happened to follow it.
	IF k_py > MAP_MAXY THEN
		k_cell = 0
		RETURN
	END IF
	#k_ci = (k_py / 8) * 32 + (k_px / 8)
	k_cell = map_attr(#k_ci)
	END

	'
	' Load the current room's collision shadow from a ROM attribute table.
	' #k_p points at the packed per-cell attribute bytes.
	'
k_load_map: PROCEDURE
	FOR #k_ci = 0 TO #MAP_CELLS - 1
		map_attr(#k_ci) = PEEK(#k_p + #k_ci)
	NEXT #k_ci
	END

