	'
	' SMS Game Designer - engine kernel: declarations
	' engine/core.bas    (engine version 1)
	'
	' This file contains DECLARATIONS ONLY. It generates no executable code,
	' so it is safe to INCLUDE at the very top of the generated program.
	'
	' The generated program MUST define these constants BEFORE including
	' this file (CVBasic CONST is a directive applied from its point of
	' appearance onwards):
	'
	'   CONST MAX_ENT   = <total entity slots>
	'   CONST MAX_HW    = <hardware sprite budget, 1..64>
	'   CONST #MAP_CELLS = <32*28 when the room needs terrain, else 1>
	'   CONST NUM_GROUPS = <how many collision groups the project uses>
	'   CONST MAP_MAXY   = <last valid pixel row of a room, screenRows*8-1>
	'

	' ---- entity flag bits -------------------------------------------------
	CONST FLAG_NEW     = 1		' spawned this frame; skip update until next
	CONST FLAG_DYING   = 2		' destroy pending; freed by k_reap
	CONST FLAG_HFLIP   = 4		' reserved (SMS sprites have no h-flip bit)
	CONST FLAG_HIDDEN  = 8		' skip rendering
	CONST FLAG_ANIMEND = 16		' non-looping animation finished this frame

	' ---- tile attribute bits ----------------------------------------------
	CONST ATTR_SOLID     = 1
	CONST ATTR_HAZARD    = 2
	CONST ATTR_LADDER    = 4
	CONST ATTR_BREAKABLE = 8
	CONST ATTR_PLATFORM  = 16

	' ---- sprite Y magic values --------------------------------------------
	' $d0 would terminate the sprite list, but this engine never uses it:
	' see the note in k_render. Unused hardware sprites are parked at $e0
	' instead, inside the invisible band 191..239.
	CONST SPR_OFF       = $d1

	' ---- entity pool (structure of arrays, 15 bytes per entity) -----------
	DIM e_type(MAX_ENT)		' 0 = free slot, otherwise the actor type id
	DIM e_x(MAX_ENT)		' pixel X (integer part)
	DIM e_y(MAX_ENT)		' pixel Y (integer part)
	DIM e_xf(MAX_ENT)		' X fraction, 1/256 px
	DIM e_yf(MAX_ENT)		' Y fraction, 1/256 px
	DIM e_vx(MAX_ENT)		' X velocity, biased: 128 = zero, units 1/16 px
	DIM e_vy(MAX_ENT)		' Y velocity, biased the same way
	DIM e_anim(MAX_ENT)		' current animation id (index into the a_* tables)
	DIM e_frame(MAX_ENT)		' frame index within the animation
	' The SPRITE "f" value for the current frame, precomputed whenever the
	' frame changes rather than recomputed for every entity every frame.
	' A sprite definition is two 8x8 patterns, so every valid f is even and
	' bit 0 is free: it carries the "this actor is 16 pixels wide, draw a
	' second hardware sprite" flag. That makes the whole render inner loop
	' one array read where it used to be two table lookups and a 16-bit
	' multiply.
	DIM e_sprf(MAX_ENT)
	DIM e_atimer(MAX_ENT)		' animation tick countdown
	DIM e_timer(MAX_ENT)		' general countdown ("on timer" / behaviours)
	DIM e_flags(MAX_ENT)		' FLAG_* bits above
	DIM e_f0(MAX_ENT)		' user field 0
	DIM e_f1(MAX_ENT)		' user field 1
	DIM e_f2(MAX_ENT)		' user field 2
	DIM e_f3(MAX_ENT)		' user field 3

	' ---- live population, per collision group -----------------------------
	' Maintained incrementally: spawn increments, k_reap decrements. That
	' makes "how many enemies are left" a single array read instead of a scan
	' over the pool, which matters because a win condition is checked every
	' frame, forever, in every game anyone makes.
	DIM g_count(NUM_GROUPS)

	' ---- terrain -----------------------------------------------------------
	' Per-cell attribute bytes for the current room. The SMS name table is
	' two bytes per cell and VPEEK goes through RDVRM with interrupts off
	' (~90 cycles a read), so terrain collision reads this RAM shadow
	' instead. 32 x 28 = 896 bytes; codegen sets MAP_CELLS to 1 when the
	' project has no terrain at all.
	DIM map_attr(#MAP_CELLS)

	' ---- kernel scratch ----------------------------------------------------
	' "self" is the implicit "me" of every generated script; "other" is the
	' collision partner. Never use "self" as a FOR variable: a nested spawn
	' reassigns it.
	DIM self, other
	DIM k_i, k_n, k_rot, k_drop, hw, k_hwprev
	DIM k_a, k_f, k_x, k_y, k_t
	DIM sp_x, sp_y, sp_slot, sp_i
	DIM ca, cb, cax, cay, ct
	DIM k_s0, k_s1, k_s2, k_s3	' self save slots, one per spawn nesting level
	DIM k_cell, k_px, k_py
	DIM sfx_id, sfx_t
	DIM #sfx_p
	DIM #k_p, #k_d, #k_ci
