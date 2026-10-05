	'
	' SMS Game Designer - renderer: Sega Master System
	' engine/render_sms.bas    (engine version 1)
	'
	' The VDP-specific half of the engine. Everything else - the pool, the
	' movers, animation, reaping, terrain, sound - is shared, which is the
	' whole claim the target profiles rest on: only drawing is genuinely
	' different between these machines.
	'
	' On the SMS a hardware sprite is 8x16 with per-pixel colour taken from a
	' 16-entry palette, so a 16-wide actor costs two of them and SPRITE takes
	' no colour argument.
	'

	'
	' Draw every live entity as a metasprite and park the rest.
	'
	' An 8-wide actor is one hardware sprite, a 16-wide actor is two. The
	' SMS has 64 hardware sprites and no built-in flicker, so when a room
	' runs over budget the scan start rotates one slot per frame: the actors
	' that get dropped alternate instead of one unlucky enemy vanishing
	' permanently. A room that fits its budget never rotates, so sprites
	' stay perfectly stable - rotation only costs something once you are
	' already over.
	'
	' Y is passed as y-1 exactly once, here. No generated code ever writes a
	' SPRITE statement, which makes the single most common CVBasic sprite
	' bug structurally unreachable.
	'
k_render: PROCEDURE
	hw = 0
	k_drop = 0
	k_i = k_rot
	FOR k_n = 0 TO MAX_ENT - 1
		IF e_type(k_i) <> 0 THEN
			IF (e_flags(k_i) AND FLAG_HIDDEN) = 0 THEN
				IF hw < MAX_HW THEN
					k_f = e_sprf(k_i)
					k_y = e_y(k_i) - 1
					k_x = e_x(k_i)
					SPRITE hw, k_y, k_x, k_f AND 254
					hw = hw + 1
					IF k_f AND 1 THEN
						IF hw < MAX_HW THEN
							SPRITE hw, k_y, k_x + 8, (k_f AND 254) + 2
							hw = hw + 1
						ELSE
							k_drop = 1
						END IF
					END IF
				ELSE
					k_drop = 1
				END IF
			END IF
		END IF
		k_i = k_i + 1
		IF k_i = MAX_ENT THEN k_i = 0
	NEXT k_n
	' Park the slots this frame no longer uses, rather than terminating the
	' list with a Y of $d0.
	'
	' The terminator cannot be used here. CVBasic uploads the SMS sprite
	' attribute table by stepping through its buffer seven sprites at a time
	' (stride 7 mod 64, so it visits all of them in a scrambled order), which
	' is its sprite flicker. That is a pure permutation and harmless when
	' every entry holds valid data - but a $d0 terminator lands somewhere
	' different every frame and chops the list at a random point, which looks
	' like violent flicker even well inside the sprite budget.
	'
	' So every one of the 64 entries is always valid: used ones are drawn,
	' the rest sit at Y=$e0, inside the invisible band. Only the entries that
	' were used last frame and are not used now need parking, which is
	' normally none.
	IF hw < k_hwprev THEN
		FOR k_n = hw TO k_hwprev - 1
			SPRITE k_n, SPR_OFF, 0, 0
		NEXT k_n
	END IF
	k_hwprev = hw
	IF k_drop THEN
		k_rot = k_rot + 1
		IF k_rot = MAX_ENT THEN k_rot = 0
	END IF
	END

	'
	' Park all 64 hardware sprites. SMS sprites take no colour argument.
	'
k_park_all: PROCEDURE
	FOR k_i = 0 TO 63
		SPRITE k_i, SPR_OFF, 0, 0
	NEXT k_i
	END
