	'
	' SMS Game Designer - renderer: TMS9918 (SG-1000, ColecoVision, MSX)
	' engine/render_tms.bas    (engine version 1)
	'
	' The other half of the claim that only drawing differs between these
	' machines. Everything this file does not contain - the entity pool, both
	' movers, animation, reaping, terrain, sound - is shared verbatim with
	' the Master System.
	'
	' What actually changes:
	'
	'   - A hardware sprite is 16x16, so an actor costs one rather than two.
	'     There are 32 of them and only four may share a scanline.
	'   - A sprite has one colour for all its pixels, passed as a fifth
	'     argument to SPRITE. Art is therefore a one-bit mask and the colour
	'     comes from a per-animation table.
	'   - The frame number counts whole 16x16 definitions in steps of four,
	'     where the SMS counts 8x8 blocks in steps of two.
	'
	' e_sprf still holds the ready-made frame number, computed when the frame
	' changes rather than per entity per video frame; the generator puts the
	' right units in it. Bit 0 carries no meaning here because every actor is
	' one sprite wide, so the renderer masks it off and ignores it.
	'
	' Four sprites per line is a hard limit and a low one. Unlike the SMS,
	' going over it is normal rather than exceptional, so the drop rotation
	' matters much more: whichever actors lose out change every frame and
	' flicker instead of one of them vanishing for good.
	'
k_render: PROCEDURE
	hw = 0
	k_drop = 0
	k_i = k_rot
	FOR k_n = 0 TO MAX_ENT - 1
		IF e_type(k_i) <> 0 THEN
			IF (e_flags(k_i) AND FLAG_HIDDEN) = 0 THEN
				IF hw < MAX_HW THEN
					k_a = e_anim(k_i)
					k_f = e_sprf(k_i) AND 252
					k_y = e_y(k_i) - 1
					k_x = e_x(k_i)
					SPRITE hw, k_y, k_x, k_f, a_col(k_a)
					hw = hw + 1
				ELSE
					k_drop = 1
				END IF
			END IF
		END IF
		k_i = k_i + 1
		IF k_i = MAX_ENT THEN k_i = 0
	NEXT k_n
	' Park what this frame no longer uses. As on the SMS the list is never
	' terminated with $d0: CVBasic's flicker rotates the attribute table, so
	' a terminator would land somewhere different every frame and chop the
	' list at a random point.
	IF hw < k_hwprev THEN
		FOR k_n = hw TO k_hwprev - 1
			SPRITE k_n, SPR_OFF, 0, 0, 0
		NEXT k_n
	END IF
	k_hwprev = hw
	IF k_drop THEN
		k_rot = k_rot + 1
		IF k_rot = MAX_ENT THEN k_rot = 0
	END IF
	END

	'
	' Park all 32 hardware sprites.
	'
k_park_all: PROCEDURE
	FOR k_i = 0 TO 31
		SPRITE k_i, SPR_OFF, 0, 0, 0
	NEXT k_i
	END
