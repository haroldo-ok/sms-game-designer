	'
	' SMS Game Designer - engine kernel: procedures
	' engine/kernel.bas    (engine version 1)
	'
	' Everything here is a PROCEDURE, so this file must be placed in the
	' "parked" region of the generated program - after the GOTO that closes
	' the main loop, never anywhere execution can fall into it.
	'
	' Generated code must provide one hook:
	'
	'   k_on_destroy: PROCEDURE    ' runs each dying entity's "on destroy"
	'                              ' script with self already set
	'
	' and these ROM tables:
	'
	'   a_fofs   per animation: where its frames start in af_data
	'   a_len    per animation: number of frames
	'   a_rate   per animation: video frames each frame is held for
	'   a_loop   per animation: 1 = loop, 0 = stop on the last frame
	'   t_group  per actor type id: which collision group it belongs to
	'   af_data  per frame, flat: the SPRITE "f" value, with bit 0 set when
	'            the actor is 16 pixels wide
	'
	' af_data is flat rather than computed from a base and a stride on
	' purpose. The obvious form, "fbase + frame * fstep", makes CVBasic emit
	' a CALL to its 16-bit multiply routine, and that call was landing once
	' per visible entity per frame - comfortably the most expensive thing in
	' the whole engine. A flat table turns it into two indexed reads.
	'

	'
	' Move "self" by its velocity, in 8.8 fixed point.
	'
	' Velocities are stored biased by 128 (128 = stationary) in units of
	' 1/16 pixel per frame, giving a range of -8.0 .. +7.9 px/frame. All
	' signed arithmetic in the whole engine happens here and nowhere else:
	' generated code never open-codes it.
	'
	' The subtraction of the bias is done in 16 bits on purpose. CVBasic
	' compiles "(#d - 128) * 16" to ADD HL,65408 followed by four ADD HL,HL,
	' so two's complement does the sign handling for free.
	'
k_move:	PROCEDURE
	#k_d = e_vx(self)
	IF #k_d <> 128 THEN
		#k_p = e_x(self) * 256 + e_xf(self)
		#k_d = (#k_d - 128) * 16
		#k_p = #k_p + #k_d
		e_x(self) = #k_p / 256
		e_xf(self) = #k_p AND 255
	END IF
	#k_d = e_vy(self)
	IF #k_d <> 128 THEN
		#k_p = e_y(self) * 256 + e_yf(self)
		#k_d = (#k_d - 128) * 16
		#k_p = #k_p + #k_d
		e_y(self) = #k_p / 256
		e_yf(self) = #k_p AND 255
	END IF
	END

	'
	' Move "self" by a whole number of pixels per frame.
	'
	' Same biasing convention as k_move, but the unit is one pixel instead of
	' a sixteenth, so no fraction and no 16-bit arithmetic is involved. This
	' is about four times cheaper than k_move and it is what most actors
	' actually need: "move down at 2" does not want subpixels.
	'
	' Codegen picks between the two per actor type and emits the matching
	' GOSUB, so the two encodings never meet inside one type. A type gets the
	' subpixel path only if some behaviour or script actually asks for a
	' fractional speed.
	'
k_move_int: PROCEDURE
	k_t = e_vx(self) - 128
	IF k_t THEN e_x(self) = e_x(self) + k_t
	k_t = e_vy(self) - 128
	IF k_t THEN e_y(self) = e_y(self) + k_t
	END

	'
	' Advance "self"'s animation by one video frame.
	'
	' Sets FLAG_ANIMEND exactly once, on the frame a non-looping animation
	' reaches its last frame, so "on animation end" fires once rather than
	' every frame afterwards.
	'
k_setframe: PROCEDURE
	k_a = e_anim(self)
	e_sprf(self) = af_data(a_fofs(k_a) + e_frame(self))
	END

k_animate: PROCEDURE
	e_flags(self) = e_flags(self) AND (255 - FLAG_ANIMEND)
	k_a = e_anim(self)
	k_t = a_len(k_a)
	IF k_t < 2 THEN RETURN
	IF a_loop(k_a) = 0 THEN
		IF e_frame(self) >= k_t - 1 THEN RETURN
	END IF
	IF e_atimer(self) <> 0 THEN
		e_atimer(self) = e_atimer(self) - 1
		RETURN
	END IF
	e_atimer(self) = a_rate(k_a)
	k_f = e_frame(self) + 1
	IF k_f >= k_t THEN
		IF a_loop(k_a) THEN
			k_f = 0
		ELSE
			k_f = k_t - 1
			e_flags(self) = e_flags(self) OR FLAG_ANIMEND
		END IF
	END IF
	e_frame(self) = k_f
	e_sprf(self) = af_data(a_fofs(k_a) + k_f)
	END

	'
	' Switch "self" to animation k_a, restarting it from frame 0.
	' A no-op if that animation is already playing, so it is safe to call
	' unconditionally every frame ("play walk animation" in a script).
	'
k_setanim: PROCEDURE
	IF e_anim(self) = k_a THEN RETURN
	e_anim(self) = k_a
	e_frame(self) = 0
	e_atimer(self) = a_rate(k_a)
	e_flags(self) = e_flags(self) AND (255 - FLAG_ANIMEND)
	e_sprf(self) = af_data(a_fofs(k_a))
	END

	'
	' End of frame: run "on destroy" for every dying entity, free its slot,
	' and clear the NEW flag on everything that was spawned this frame.
	'
	' Destruction is deferred to here rather than happening inside "destroy
	' me" so that a collision handler can never free a slot the collision
	' loop it was called from is still iterating over, and so that two
	' entities that killed each other both get their "on destroy".
	'
k_reap:	PROCEDURE
	FOR k_i = 0 TO MAX_ENT - 1
		k_t = e_flags(k_i)
		IF k_t THEN
			IF k_t AND FLAG_DYING THEN
				self = k_i
				GOSUB k_on_destroy
				' Read the group AFTER the script runs: "on destroy" may
				' spawn something, and that spawn's own increment must not
				' be undone by this decrement.
				k_a = t_group(e_type(k_i))
				g_count(k_a) = g_count(k_a) - 1
				e_type(k_i) = 0
				e_flags(k_i) = 0
			ELSE
				e_flags(k_i) = k_t AND (255 - FLAG_NEW)
			END IF
		END IF
	NEXT k_i
	END

	'
k_clear_pool: PROCEDURE
	' Park every hardware sprite, so no attribute entry is left holding stale
	' data for the flicker permutation to scatter across the screen. The
	' count and the SPRITE argument list differ between VDPs, so this lives
	' in the renderer.
	GOSUB k_park_all
	k_hwprev = 0
	FOR k_i = 0 TO MAX_ENT - 1
		e_type(k_i) = 0
		e_flags(k_i) = 0
	NEXT k_i
	FOR k_i = 0 TO NUM_GROUPS - 1
		g_count(k_i) = 0
	NEXT k_i
	hw = 0
	k_rot = 0
	END

	'
	' Sound effects.
	'
	' A sound effect is a short envelope played on one PSG channel, one step
	' per frame, from a flat ROM table. That is deliberately the cheapest
	' thing that still sounds like something: a shot, a pickup and an
	' explosion are what a beginner actually needs, and none of them is worth
	' a driver with its own timebase to get wrong.
	'
	' Channel 2 carries tones and channel 3 carries noise, which leaves
	' channels 0 and 1 free for CVBasic's own music player. Effects therefore
	' never silence the music, which is the usual failing of a home-made
	' sound layer.
	'
	' sfx_id is the effect's index; sfx_t counts steps. sfx_t = 255 means
	' idle. Each step is three bytes: frequency low, frequency high, and a
	' volume byte whose top bit selects the noise channel.
	'
k_sfx:	PROCEDURE
	IF sfx_t = 255 THEN RETURN
	' A running pointer rather than "offset + step * 3". CVBasic compiles a
	' multiply by a non-power of two into a call to its 16-bit multiply
	' routine, and one of those in a procedure that runs every frame is
	' exactly the thing the whole engine is careful to avoid.
	IF sfx_t = 0 THEN #sfx_p = VARPTR sfx_data(0) + sfx_ofs(sfx_id)
	k_t = PEEK(#sfx_p + 2)
	IF k_t = 255 THEN
		SOUND 2,0,0
		SOUND 3,0,0
		sfx_t = 255
		RETURN
	END IF
	k_x = PEEK(#sfx_p)
	k_y = PEEK(#sfx_p + 1)
	IF k_t AND 128 THEN
		SOUND 3,k_x,k_t AND 15
	ELSE
		SOUND 2,k_x + k_y * 256,k_t AND 15
	END IF
	#sfx_p = #sfx_p + 3
	sfx_t = 1
	END
