#!/usr/bin/env python3
"""
Playtest the built ROM.

Compiling is not the same as working. The shmup compiled cleanly, reported
91% of a frame, passed twenty-two tests, and drew its entire cast as thin
vertical slivers - because the bug was in how CVBasic uploads the sprite
attribute table, somewhere no part of the pipeline had ever looked.

So this runs the ROM on the headless machine in sms.py, looks at the screen
and at the emulated RAM, and asserts things a player would notice. The symbol
file from gasm80 is what makes the RAM half possible: it maps `array_E_TYPE`
and friends to addresses, so the test can reach into the entity pool the same
way the editor's live inspector does.

    python3 tools/playtest.py out/shmup.sms out/shmup.sym
"""

import re
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sms import SMS  # noqa: E402

PAD_UP, PAD_DOWN, PAD_LEFT, PAD_RIGHT, PAD_FIRE = 0x01, 0x02, 0x04, 0x08, 0x10

failures = []
checks = 0


def check(name, cond, detail=''):
    global checks
    checks += 1
    if cond:
        print(f'  ok    {name}')
    else:
        failures.append(name)
        print(f'  FAIL  {name}')
        if detail:
            print(f'        {detail}')


def load_symbols(path):
    syms = {}
    for line in open(path):
        m = re.match(r'\s*([A-Za-z_][\w#]*):\s*equ\s*([0-9A-Fa-f]+)h', line)
        if m:
            syms[m.group(1).upper()] = int(m.group(2), 16)
    return syms


def start_game(sms, frames=40):
    """Get past the title screen: wait, then tap fire."""
    sms.run_frames(4)
    sms.pad = 0xFF & ~PAD_FIRE
    sms.run_frames(3)
    sms.pad = 0xFF
    sms.run_frames(3)
    return sms


def live_sprites(vdp):
    """Every attribute entry that is not parked in the invisible band."""
    if not vdp.mode4:
        sat = vdp.tms_sprite_attr
        out = []
        for i in range(32):
            y = vdp.vram[sat + i * 4]
            if y == 0xD0:
                break
            if y >= 0xC0:
                continue
            out.append({
                'slot': i, 'y': y,
                'x': vdp.vram[sat + i * 4 + 1],
                'pattern': vdp.vram[sat + i * 4 + 2],
                'colour': vdp.vram[sat + i * 4 + 3] & 15,
            })
        return out
    sat = vdp.sprite_attr_table
    out = []
    for i in range(64):
        y = vdp.vram[sat + i]
        if y >= 0xC0:
            continue
        out.append({
            'slot': i, 'y': y,
            'x': vdp.vram[sat + 0x80 + i * 2],
            'pattern': vdp.vram[sat + 0x80 + i * 2 + 1],
            'colour': None,
        })
    return out


def pool(sms, syms, n=27):
    base_t = syms.get('ARRAY_E_TYPE')
    base_x = syms.get('ARRAY_E_X')
    base_y = syms.get('ARRAY_E_Y')
    if base_t is None:
        return []
    mem = sms.cpu.memory
    return [{'slot': i, 'type': mem[base_t + i],
             'x': mem[base_x + i], 'y': mem[base_y + i]}
            for i in range(n) if mem[base_t + i]]


def check_title(rom_path, syms, pool_size=27):
    """
    The title screen, which every sample now boots into.

    It is the first thing anyone sees, and it is made of the two things this
    project has repeatedly got wrong: a wait loop that has to actually
    respond to the button, and a music call that has to name a tune that
    exists. Both failed silently the first time.
    """
    print('\ntitle screen')
    sms = SMS(open(rom_path, 'rb').read())
    psg = []
    base_out = sms.output

    def tap(port, value):
        if (port & 0xFF) == 0x7F:
            psg.append(value)
        return base_out(port, value)

    sms.cpu.set_output_callback(tap)
    sms.run_frames(30)
    m = sms.cpu.memory
    et = syms['ARRAY_E_TYPE']
    alive = sum(1 for i in range(pool_size) if m[et + i])

    check('the game boots to a title rather than straight into play',
          alive == 0, f'{alive} entities already spawned')
    check('the title screen has music', len(psg) > 20,
          f'{len(psg)} PSG writes in 30 frames')

    sms.run_frames(60)
    check('the title waits rather than starting on its own',
          sum(1 for i in range(pool_size) if m[et + i]) == 0,
          'the game started with no input')

    sms.pad = 0xFF & ~PAD_FIRE
    started = False
    for _ in range(60):
        sms.run_frames(1)
        if sum(1 for i in range(pool_size) if m[et + i]) > 0:
            started = True
            break
    sms.pad = 0xFF
    check('pressing fire starts the game', started,
          'the title screen ignored the button')


def playtest_shmup(rom_path, sym_path):
    syms = load_symbols(sym_path)
    check_title(rom_path, syms)

    sms = SMS(open(rom_path, 'rb').read())
    start_game(sms)
    sms.run_frames(8)
    vdp = sms.vdp

    print('\nscreen')

    check('the VDP is actually displaying', vdp.display_on,
          f'register 1 = ${vdp.regs[1]:02x}')
    check('sprites are 8x16', vdp.sprites_8x16)
    check('sprite patterns are read from $2000',
          vdp.sprite_pattern_base == 0x2000,
          f'base is ${vdp.sprite_pattern_base:04x}')

    spr = live_sprites(vdp)
    # Wave 1 places eight bugs and one ship, all 16 wide, so two hardware
    # sprites each. Bugs start dropping bombs within a few frames, so this is
    # a floor rather than an exact count.
    check('the whole cast is on screen', len(spr) >= 18,
          f'{len(spr)} visible hardware sprites, expected at least 18')

    # The signature of the SPRITE FLICKER OFF prologue bug: the X/pattern
    # half of the attribute table gets filled from the Y half, so every
    # sprite ends up with pattern == x == y.
    corrupt = [s for s in spr if s['pattern'] == s['y'] and s['x'] == s['y']]
    check('the attribute table is not filled from the Y table',
          not corrupt,
          f'{len(corrupt)} sprites have pattern == x == y, which means the '
          'X/pattern upload is reading the wrong half of the buffer')

    # Every pattern must land inside the 16 definitions the project uses.
    bad = [s for s in spr if s['pattern'] >= 32]
    check('every sprite pattern is inside the loaded art', not bad,
          f'patterns out of range: {[s["pattern"] for s in bad][:6]}')

    # Two rows of four bugs, plus the ship near the bottom.
    ys = sorted({s['y'] for s in spr})
    check('actors are spread over the screen, not stacked', len(ys) >= 3,
          f'distinct Y values: {ys}')
    check('the player is near the bottom',
          any(s['y'] > 150 for s in spr),
          f'lowest sprite Y is {max(s["y"] for s in spr)}')

    print('\nentity pool')

    live = pool(sms, syms)
    bugs = [e for e in live if e['type'] == 3]
    check('the ship and all eight bugs are alive',
          len(bugs) == 8 and any(e['slot'] == 0 for e in live),
          f'{len(live)} live: {[(e["slot"], e["type"]) for e in live]}')
    check('the player owns slot 0',
          any(e['slot'] == 0 for e in live))

    print('\nplaying')

    # Hold fire and check that shots actually get spawned and travel.
    sms.pad = 0xFF & ~PAD_FIRE
    sms.run_frames(10)
    live = pool(sms, syms)
    shots = [e for e in live if e['type'] == 2]
    check('holding fire spawns shots', len(shots) > 0,
          'no entity of the Shot type appeared')
    if shots:
        check('shots travel up the screen',
              all(e['y'] < 168 for e in shots),
              f'shot Y values: {[e["y"] for e in shots]}')

    # Sound. The PSG is the one output that no amount of reading the
    # screen can verify, and "play sound" was a block that set a variable
    # nothing read for most of this project's life.
    psg = []
    base_out = sms.output

    def tap(port, value):
        if (port & 0xFF) == 0x7F:
            psg.append(value)
        return base_out(port, value)

    sms.cpu.set_output_callback(tap)
    sms.pad = 0xFF
    sms.run_frames(8)
    quiet = len(psg)
    sms.pad = 0xFF & ~PAD_FIRE
    sms.run_frames(16)
    check('firing makes a sound', len(psg) - quiet > 20,
          f'{len(psg) - quiet} PSG writes while holding fire')

    # Move left and confirm the player responds to the pad.
    before = next((e['x'] for e in pool(sms, syms) if e['slot'] == 0), None)
    sms.pad = 0xFF & ~PAD_LEFT
    sms.run_frames(10)
    after = next((e['x'] for e in pool(sms, syms) if e['slot'] == 0), None)
    check('the pad moves the player',
          before is not None and after is not None and after < before,
          f'x went from {before} to {after}')
    sms.pad = 0xFF

    print('\nlevel progression')

    # Clear the wave from underneath the game, exactly as killing every bug
    # would, and confirm it advances. Poking the pool is much more reliable
    # than trying to actually shoot twelve enemies with scripted input, and
    # it tests the thing that was broken: the win condition.
    base_t = syms['ARRAY_E_TYPE']
    g_count = syms.get('ARRAY_G_COUNT')
    for i in range(27):
        if sms.cpu.memory[base_t + i] == 3:      # Bug
            sms.cpu.memory[base_t + i] = 0
    if g_count is not None:
        sms.cpu.memory[g_count + 2] = 0          # enemy group

    room_before = sms.cpu.memory[syms['CVB_CUR_ROOM']] \
        if 'CVB_CUR_ROOM' in syms else None
    sms.run_frames(6)
    room_after = sms.cpu.memory[syms['CVB_CUR_ROOM']] \
        if 'CVB_CUR_ROOM' in syms else None

    check('clearing the wave advances the room',
          room_before is not None and room_after != room_before,
          f'cur_room stayed at {room_before}')

    live = pool(sms, syms)
    bugs = [e for e in live if e['type'] == 3]
    check('the next wave is populated', len(bugs) >= 8,
          f'{len(bugs)} enemies in the new room')

    score = None
    if 'CVB_#SCORE' in syms:
        a = syms['CVB_#SCORE']
        score = sms.cpu.memory[a] | (sms.cpu.memory[a + 1] << 8)
    check('clearing the wave scores', score is None or score >= 100,
          f'score is {score}')


def playtest_platformer(rom_path, sym_path):
    """
    The terrain half of the engine, which the shmup never touches: the
    attribute shadow, k_cell_at, the subpixel mover and the Platform
    behaviour - by a distance the most complicated thing the generator
    emits, and the part most likely to break silently.
    """
    syms = load_symbols(sym_path)
    check_title(rom_path, syms, pool_size=9)
    ex, ey = syms['ARRAY_E_X'], syms['ARRAY_E_Y']
    f3 = syms['ARRAY_E_F3']
    lives, coins = syms['CVB_LIVES'], syms['CVB_COINS']

    def fresh():
        s = SMS(open(rom_path, 'rb').read())
        start_game(s)
        s.run_frames(12)
        return s, s.cpu.memory

    print('\nterrain')

    sms, m = fresh()
    check('the room has a tilemap on screen',
          any(sms.vdp.vram[sms.vdp.name_table + i * 2] > 128 for i in range(768)),
          'the name table is empty, so SCREEN never copied the room')

    # The RAM shadow must be a byte-for-byte copy of the ROM table the room
    # loaded from. Guessing at a plausible number of solid cells would only
    # test the level design; this tests k_load_map.
    shadow = syms['ARRAY_MAP_ATTR']
    # Found by prefix, not by name: the label is derived from the room's
    # title, so renaming the room in the editor would otherwise break the
    # test rather than the thing it is testing.
    rom_tbl = next((v for k, v in sorted(syms.items())
                    if k.startswith('CVB_ATTR_')), None)
    rom = open(rom_path, 'rb').read()
    check('the room has a collision table in ROM', rom_tbl is not None,
          'no attr_* label was emitted for any room')
    same = rom_tbl is not None and all(
        m[shadow + i] == rom[rom_tbl + i] for i in range(768))
    solid = sum(1 for i in range(768) if m[shadow + i] & 1)
    check('the collision shadow matches the room table', same,
          'k_load_map did not copy the attributes correctly')
    check('the room actually has terrain in it', solid > 50,
          f'only {solid} solid cells of 768')

    print('\nphysics')

    check('gravity brought the hero to rest on the floor',
          m[ey] == 160 and m[f3] == 1,
          f'y={m[ey]} grounded={m[f3]}')

    # Jump: a real arc, not a twitch, and it must come back down.
    sms.pad = 0xFF & ~PAD_FIRE
    ys = []
    # A full jump is airborne for about 27 frames at these settings, so give
    # it comfortably longer than that to land again.
    for i in range(40):
        sms.run_frames(1)
        ys.append(m[ey])
        if i == 2:
            sms.pad = 0xFF
    # Three tiles is the rise the level is built from, so the jump has to
    # clear more than that with something to spare.
    check('the jump clears more than three tiles', 160 - min(ys) > 24,
          f'peak was only {160 - min(ys)} px, under the 24 px a three-tile '
          'rise needs')
    check('the hero comes back down and lands', ys[-1] == 160 and m[f3] == 1,
          f'ended at y={ys[-1]} grounded={m[f3]}')
    # No step may exceed the launch velocity, and the fall cap keeps it
    # there: a bigger step means something teleported.
    check('the jump is a smooth arc',
          all(abs(ys[i + 1] - ys[i]) <= 6 for i in range(len(ys) - 1)),
          f'arc: {ys}')

    print('\nis the level playable')

    # The question no unit test can ask: can you actually get up there?
    #
    # Cavern 1 originally put its lowest ledge five tiles above the floor
    # against a jump that cleared under three. Everything passed - gravity,
    # the arc, the landing - and the game was unfinishable. Cavern 2 then
    # repeated the mistake horizontally, with gaps three tiles wider than the
    # jump could cross. Both rooms are walked here, in both directions,
    # because a level that cannot be climbed is a bug and nothing else
    # notices it.
    def climb(sms, m, ledges, direction):
        """Walk to each ledge's edge, jump, and report which were reached."""
        towards = PAD_LEFT if direction < 0 else PAD_RIGHT
        reached = []
        for edge, top, label in ledges:
            sms.pad = 0xFF & ~towards
            for _ in range(70):
                near = m[ex] <= edge + 10 if direction < 0 else m[ex] >= edge - 26
                if m[f3] and near:
                    break
                sms.run_frames(1)
            sms.pad = 0xFF & ~(towards | PAD_FIRE)
            for i in range(45):
                sms.run_frames(1)
                if i == 3:
                    sms.pad = 0xFF & ~towards      # a tap, not a held button
                if m[f3] and m[ey] <= top + 2:
                    break
            sms.pad = 0xFF
            sms.run_frames(2)
            if m[f3] and m[ey] <= top + 2:
                reached.append(label)
        return reached

    sms, m = fresh()
    ledges1 = [(40, 136, 'A'), (88, 112, 'B'), (144, 88, 'C'), (192, 64, 'D')]
    got = climb(sms, m, ledges1, +1)
    check('Cavern 1: every ledge is reachable from the one below',
          len(got) == len(ledges1),
          f'got up to {got[-1] if got else "nothing"}; '
          f'{len(ledges1) - len(got)} ledge(s) out of reach')
    check('climbing collects the coins on the way', m[coins] >= 3,
          f'{m[coins]} coins after the climb')

    print('\nlevel completion')

    # Collecting every coin has to end the level. There is no way to check
    # this by looking at one screen, and the block that does it lives in the
    # global frame script rather than on the Coin - a Coin's "on destroy"
    # runs while it still occupies its slot, so the count it sees is never
    # zero.
    sms, m = fresh()
    et = syms['ARRAY_E_TYPE']
    g_count = syms['ARRAY_G_COUNT']
    room_before = m[syms['CVB_CUR_ROOM']]
    level_before = m[syms['CVB_LEVEL']]
    for i in range(9):
        if m[et + i] == 2:
            m[et + i] = 0
    for g in range(4):
        m[g_count + g] = 0
    sms.run_frames(6)
    check('collecting every coin ends the level',
          m[syms['CVB_CUR_ROOM']] != room_before,
          f'still in room {room_before}')
    check('the next level counts up',
          m[syms['CVB_LEVEL']] != level_before,
          f'level stayed at {level_before}')
    check('the next level has its own coins',
          sum(1 for i in range(9) if m[et + i] == 2) >= 5,
          'the new room has no pickups in it')

    # Cavern 2 is a mirror, so it is climbed leftwards.
    ledges2 = [(215, 136, 'A'), (167, 112, 'B'), (111, 88, 'C'), (63, 64, 'D')]
    got2 = climb(sms, m, ledges2, -1)
    check('Cavern 2: every ledge is reachable from the one below',
          len(got2) == len(ledges2),
          f'got up to {got2[-1] if got2 else "nothing"}; '
          f'{len(ledges2) - len(got2)} ledge(s) out of reach')

    print('\ngame over')

    # The screen has to come back when you press the button. It did not: the
    # wait loop used NOT, which in CVBasic is a bitwise complement, so
    # `NOT CONT1.BUTTON` was non-zero whether or not the button was held and
    # the loop never exited.
    sms, m = fresh()
    m[lives] = 1
    m[ex], m[ey] = 120, 150
    for _ in range(30):
        sms.run_frames(1)
        if m[syms['CVB_GAME_STATE']] == 2:
            break
    check('running out of lives reaches the game over screen',
          m[syms['CVB_GAME_STATE']] == 2,
          'game_state never became 2')

    sms.run_frames(120)
    check('the game over screen waits rather than skipping past',
          m[syms['CVB_GAME_STATE']] == 2,
          'it left the screen on its own with no input')

    # Game over holds for a moment, then returns to the title, which waits
    # for the button to be released before it accepts a press - otherwise the
    # shot that killed you would skip straight past it. So tap, do not hold.
    sms.pad = 0xFF
    sms.run_frames(70)
    check('the game over screen hands back to the title',
          m[syms['CVB_GAME_STATE']] == 0,
          'game_state never cleared')
    check('restarting puts the globals back', m[lives] == 3,
          f'lives={m[lives]} after restart')

    et2 = syms['ARRAY_E_TYPE']
    check('the title is waiting, with nothing spawned',
          sum(1 for i in range(9) if m[et2 + i]) == 0,
          'the game restarted without waiting for input')

    sms.pad = 0xFF & ~PAD_FIRE
    sms.run_frames(3)
    sms.pad = 0xFF
    sms.run_frames(6)
    check('fire from the title starts a fresh game',
          m[syms['CVB_CUR_ROOM']] == 0 and m[ex] == 16,
          f'room={m[syms["CVB_CUR_ROOM"]]} hero_x={m[ex]}')

    print('\ncollision with terrain')

    sms, m = fresh()
    start = m[ex]
    sms.pad = 0xFF & ~PAD_LEFT
    sms.run_frames(30)
    # The left wall is column 0, so the hero's left edge stops at 8.
    check('walking into the wall stops the hero', m[ex] == 8,
          f'x went from {start} to {m[ex]}; 0 would mean it walked through')

    sms, m = fresh()
    m[ex], m[ey] = 120, 150          # over the pit
    for i in range(30):
        sms.run_frames(1)
        if m[lives] != 3:
            break
    check('the spike pit costs a life', m[lives] == 2,
          f'lives={m[lives]} after {i} frames at y={m[ey]}')
    check('losing a life restarts the room', m[ex] == 16,
          f'hero is at x={m[ex]}, not the spawn point')

    print('\npickups')

    sms, m = fresh()
    m[ex], m[ey] = 96, 158           # onto the coin resting at (96,160)
    sms.run_frames(3)
    check('touching a coin collects it', m[coins] == 1,
          f'coins={m[coins]}')
    check('the pickup made a sound', m[syms['CVB_SFX_T']] != 255,
          'sfx_t is idle, so "play sound" did nothing')
    et = syms['ARRAY_E_TYPE']
    check('the collected coin is gone from the pool',
          sum(1 for i in range(9) if m[et + i] == 2) == 5,
          'the coin was scored but never destroyed')


def playtest_kitchen_sink(rom_path, sym_path):
    """
    A smoke test for the coverage sample.

    It is not a game and there is nothing to play, so the checks are about
    liveness rather than fun: does it keep running, does every subsystem
    move, and does the room flow actually fire. What this catches is a block
    that compiles and then wedges or corrupts something at runtime - which no
    amount of reading the generated source will tell you.
    """
    syms = load_symbols(sym_path)
    check_title(rom_path, syms, pool_size=10)
    m = None

    sms = SMS(open(rom_path, 'rb').read())
    start_game(sms)
    sms.run_frames(20)
    m = sms.cpu.memory
    vdp = sms.vdp

    print('\nliveness')

    check('it is still running, not wedged', not sms.stalled,
          'the CPU never reached its WAIT, so something loops forever')
    check('the display is on', vdp.display_on)

    spr = live_sprites(vdp)
    check('something is on screen', len(spr) > 0, 'no unparked sprites')
    corrupt = [s for s in spr if s['pattern'] == s['y'] and s['x'] == s['y']]
    check('the sprite attribute table is sane', not corrupt,
          f'{len(corrupt)} sprites with pattern == x == y')

    print('\nsubsystems')

    def score():
        a = syms['CVB_#SCORE']
        return m[a] | (m[a + 1] << 8)

    before = score()
    sms.run_frames(20)
    check('scripts are running', score() != before,
          'the score never changed, so the per-frame scripts are not running')

    et = syms['ARRAY_E_TYPE']
    live = [m[et + i] for i in range(10) if m[et + i]]
    check('the entity pool is populated and in range',
          live and all(1 <= t <= 4 for t in live),
          f'types present: {sorted(set(live))}')

    psg = []
    base_out = sms.output

    def tap(port, value):
        if (port & 0xFF) == 0x7F:
            psg.append(value)
        return base_out(port, value)

    sms.cpu.set_output_callback(tap)
    sms.pad = 0xFF & ~PAD_FIRE
    sms.run_frames(30)
    sms.pad = 0xFF
    check('sound is reaching the PSG', len(psg) > 0,
          'no PSG writes at all in 30 frames of play')

    print('\nroom flow')

    # goRoom is the one statement whose effect is invisible from a single
    # screen, so watch the transition happen on a fresh machine rather than
    # poking at it: the score in this sample climbs fast enough that by the
    # time the other checks are done it has already moved on.
    sms2 = SMS(open(rom_path, 'rb').read())
    m2 = sms2.cpu.memory
    start_game(sms2)
    sms2.run_frames(8)
    start_room = m2[syms['CVB_CUR_ROOM']]
    check('the game starts in the first room', start_room == 0,
          f'cur_room is {start_room}')

    moved = False
    for _ in range(80):
        sms2.run_frames(2)
        if m2[syms['CVB_CUR_ROOM']] != start_room:
            moved = True
            break
    check('crossing the score threshold changes room', moved,
          'cur_room never left the first room')

    et2 = syms['ARRAY_E_TYPE']
    check('the new room spawned its actors',
          any(m2[et2 + i] for i in range(10)),
          'the pool is empty after the room change')


def playtest_sg1000(rom_path, sym_path):
    """
    The same project on a different machine.

    This is the test the whole target-profile idea stands or falls on. The
    actors, the collision matrix, the scripts and every behaviour are
    identical to the Master System build; only the instance counts and the
    video backend change. If the abstraction is real, this passes without a
    single actor-level difference - and if it is not, this is where that
    shows up.
    """
    syms = load_symbols(sym_path)
    check_title(rom_path, syms, pool_size=14)

    sms = SMS(open(rom_path, 'rb').read())
    start_game(sms)
    sms.run_frames(10)
    m = sms.cpu.memory
    vdp = sms.vdp

    print('\nTMS9918 video')

    check('the VDP is in a TMS graphics mode, not Mode 4', not vdp.mode4,
          f'register 0 = ${vdp.regs[0]:02x}')
    check('sprites are 16x16', vdp.tms_sprites_16,
          f'register 1 = ${vdp.regs[1]:02x}')
    check('the display is on', vdp.display_on)

    spr = live_sprites(vdp)
    # One ship and six bugs, one hardware sprite each - half what the same
    # cast costs on the SMS, where a 16-wide actor is two 8x16 sprites.
    check('the whole cast is on screen', len(spr) >= 7,
          f'{len(spr)} visible sprites, expected at least 7')
    check('every sprite has a visible colour',
          all(s['colour'] for s in spr),
          'a sprite colour of 0 is transparent, so it draws nothing - which '
          'is what happens when an art index is passed through as a TMS '
          'colour instead of being matched to the fixed palette')
    check('sprite patterns are inside the loaded art',
          all(s['pattern'] < 64 for s in spr),
          f'patterns: {sorted({s["pattern"] for s in spr})}')

    print('\nthe same game, smaller')

    et = syms['ARRAY_E_TYPE']
    live = [m[et + i] for i in range(14) if m[et + i]]
    # One ship and six bugs are placed; shots and bombs come and go, so only
    # the placed cast is asserted exactly.
    check('the placed cast is all present',
          live.count(1) == 1 and live.count(3) == 6,
          f'{live.count(1)} ship, {live.count(3)} bugs: {sorted(live)}')
    check('the pool stays within the smaller machine',
          len(live) <= 14, f'{len(live)} entities in a 14-slot pool')

    before = next((m[syms['ARRAY_E_X'] + i] for i in range(14)
                   if m[et + i] == 1), None)
    sms.pad = 0xFF & ~PAD_LEFT
    sms.run_frames(10)
    after = next((m[syms['ARRAY_E_X'] + i] for i in range(14)
                  if m[et + i] == 1), None)
    sms.pad = 0xFF
    check('the pad still moves the player',
          before is not None and after is not None and after < before,
          f'x went from {before} to {after}')

    psg = []
    base_out = sms.output

    def tap(port, value):
        if (port & 0xFF) == 0x7F:
            psg.append(value)
        return base_out(port, value)

    sms.cpu.set_output_callback(tap)
    # Count across the whole window rather than at one instant: a shot is
    # only alive for the few frames it takes to cross the screen, so sampling
    # once is a coin flip.
    seen_shot = False
    sms.pad = 0xFF & ~PAD_FIRE
    for _ in range(16):
        sms.run_frames(1)
        if any(m[et + i] == 2 for i in range(14)):
            seen_shot = True
    sms.pad = 0xFF
    check('firing still makes a sound', len(psg) > 20,
          f'{len(psg)} PSG writes while holding fire')
    check('firing still spawns shots', seen_shot,
          'no Shot entity appeared at any point while fire was held')


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('-')]
    rom_path = args[0] if args else 'out/shmup.sms'
    sym_path = args[1] if len(args) > 1 else rom_path.rsplit('.', 1)[0] + '.sym'

    if 'sg1000' in rom_path:
        playtest_sg1000(rom_path, sym_path)
    elif 'platformer' in rom_path:
        playtest_platformer(rom_path, sym_path)
    elif 'kitchen' in rom_path:
        playtest_kitchen_sink(rom_path, sym_path)
    else:
        playtest_shmup(rom_path, sym_path)

    print(f'\n{checks - len(failures)} passed, {len(failures)} failed\n')
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(main())
