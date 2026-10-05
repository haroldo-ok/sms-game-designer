/**
 * Builds examples/shmup.json - the worked example from the actor-model
 * document, as a real project file.
 *
 * Totals: 27 slots, 3 collision pairs, 9 scripts averaging 3 statements.
 * The equivalent in a VCS-style named-object model is unbuildable, which is
 * the whole reason this tool authors types rather than objects.
 *
 * The art is generated rather than hand-typed so this file stays readable;
 * in the real editor it comes from the sprite editor or a PNG import.
 */

import {writeFileSync, mkdirSync} from 'fs';
import {dirname, resolve} from 'path';
import {fileURLToPath} from 'url';

const here = dirname(fileURLToPath(import.meta.url));

/* ---- tiny pixel-art helpers ---------------------------------------- */

function grid(w, h, fn) {
  return {pixels: Array.from({length: h}, (_, y) =>
    Array.from({length: w}, (_, x) => fn(x, y) | 0))};
}

/** Ship: a triangle with an engine flame that alternates between frames. */
function ship(flame) {
  return grid(16, 16, (x, y) => {
    const cx = Math.abs(x - 7.5);
    if (y < 3) return cx < 1.5 ? 1 : 0;
    if (y < 11) return cx < (y - 1) * 0.9 ? (cx < 2 ? 2 : 1) : 0;
    if (y < 13) return cx < 7 ? 1 : 0;
    if (cx > 1 && cx < 4) return flame ? 3 : 4;
    return 0;
  });
}

/** Bug: a round body with legs that swap sides between frames. */
function bug(step) {
  return grid(16, 16, (x, y) => {
    const dx = x - 7.5;
    const dy = y - 8;
    const r = dx * dx + dy * dy * 1.4;
    if (r < 20) return (dy < -1 && Math.abs(dx) < 3) ? 6 : 5;
    if (r < 34) return 5;
    if (y > 4 && y < 12 && (x < 3 || x > 12)) {
      return ((y + (step ? 1 : 0)) & 1) ? 6 : 0;
    }
    return 0;
  });
}

/** Shot / bomb: a small vertical streak, 8 pixels wide. */
function shot(colour) {
  return grid(8, 16, (x, y) => {
    const cx = Math.abs(x - 3.5);
    if (y < 3 || y > 12) return 0;
    if (cx < 0.6) return colour;
    if (cx < 1.6) return colour === 7 ? 1 : 8;
    return 0;
  });
}

/** Explosion: three expanding rings. */
function boom(step) {
  const radii = [3, 6, 8];
  const r = radii[step];
  return grid(16, 16, (x, y) => {
    const d = Math.sqrt((x - 7.5) ** 2 + (y - 7.5) ** 2);
    if (d > r) return 0;
    if (d > r - 2) return 9;
    return step === 2 ? 0 : 10;
  });
}

/* ---- the project ---------------------------------------------------- */

const project = {
  schemaVersion: 3,
  name: 'Bug Blaster',
  target: 'sms',
  meta: {author: 'SMS Game Designer sample', description: 'The worked shmup.'},

  globals: [
    {name: 'score', width: 16, initial: 0},
    {name: 'lives', width: 8, initial: 3},
    {name: 'level', width: 8, initial: 0},
  ],

  palette: {
    //          0 transparent  1 white   2 cyan    3 orange  4 yellow
    //          5 green        6 dkgreen 7 red     8 dkred   9 white
    //         10 yellow      11 grey   12 blue   13 dkblue 14 magenta
    background: [0x00, 0x3f, 0x30, 0x0b, 0x0f, 0x08, 0x04, 0x03,
      0x02, 0x3f, 0x0f, 0x15, 0x30, 0x20, 0x33, 0x2a],
    sprite: [0x00, 0x3f, 0x3c, 0x0b, 0x0f, 0x08, 0x04, 0x03,
      0x02, 0x3f, 0x0f, 0x15, 0x30, 0x20, 0x33, 0x2a],
  },

  // The title screen is shown at boot and again after a game over, so
  // losing lands somewhere deliberate instead of dropping straight back in.
  title: {text: 'BUG BLASTER', subtitle: 'THE SWARM RETURNS', music: 'title'},

  tiles: [],

  // enemy vs player_shot is 48 candidate pairs a frame, the most expensive
  // thing in the game. Bullets travel 4 px a frame, so a two-frame collision
  // period is invisible in play and halves the cost.
  timeSlicedPairs: ['enemy|player_shot'],

  actors: [
    {
      id: 'ship', name: 'Ship', group: 'player', max: 1,
      width: 16, height: 16,
      hitbox: {w: 10, h: 10, ox: 3, oy: 3},
      isPlayer: true,
      fields: [],
      animations: [
        {name: 'fly', rate: 4, loop: true, frames: [ship(false), ship(true)]},
      ],
      behaviours: [
        {kind: 'control8', speed: 2, pad: 1},
        {kind: 'shoot', actor: 'shot', interval: 12, onButton: true,
          offsetX: 4, offsetY: -6, sound: 'shoot'},
        {kind: 'animate'},
      ],
      scripts: {
        'collide:enemy': {xml: '', stmts: [
          {op: 'playSound', sound: 'hurt', blockId: 'ship_hit_0'},
          {op: 'changeGlobal', name: 'lives', delta: {op: 'num', value: -1}, blockId: 'ship_hit_1'},
          // "lives" is a byte, so decrementing past zero wraps to 255 and
          // the player quietly becomes immortal. Check before restarting.
          {op: 'if', blockId: 'ship_hit_2',
            cond: {op: 'compare', oper: 'eq',
              a: {op: 'global', name: 'lives'}, b: {op: 'num', value: 0}},
            then: [{op: 'gameOver', blockId: 'ship_hit_3'}],
            else: [{op: 'restartRoom', blockId: 'ship_hit_4'}]},
        ]},
      },
    },

    {
      id: 'shot', name: 'Shot', group: 'player_shot', max: 4,
      width: 8, height: 16,
      hitbox: {w: 4, h: 12, ox: 2, oy: 2},
      reuseOldest: true,
      fields: [],
      animations: [{name: 'fly', rate: 8, loop: true, frames: [shot(1)]}],
      behaviours: [
        {kind: 'move', direction: 'up', speed: 4, atEdge: 'destroy', margin: 8},
      ],
      scripts: {
        'collide:enemy': {xml: '', stmts: [
          {op: 'destroy', target: 'me', blockId: 'shot_hit_1'},
        ]},
      },
    },

    {
      id: 'bug', name: 'Bug', group: 'enemy', max: 12,
      width: 16, height: 16,
      hitbox: {w: 12, h: 12, ox: 2, oy: 2},
      fields: [{name: 'hp', width: 8, initial: 2}],
      animations: [
        {name: 'walk', rate: 6, loop: true, frames: [bug(false), bug(true)]},
      ],
      behaviours: [
        // A whole-pixel speed on purpose: it keeps this type on the cheap
        // integer mover instead of the 8.8 one, which is worth about 8% of
        // a frame across twelve bugs. 0.75 looks marginally nicer and does
        // not fit; this is exactly the kind of trade the budget meter is
        // meant to make visible while you are still editing.
        {kind: 'patrol', speed: 1},
        {kind: 'shoot', actor: 'bomb', interval: 40, randomise: 90,
          offsetX: 4, offsetY: 12},
        {kind: 'animate'},
        {kind: 'health', field: 'hp'},
      ],
      scripts: {
        'collide:player_shot': {xml: '', stmts: [
          {op: 'changeField', field: 'hp', delta: {op: 'num', value: -1}, blockId: 'bug_hit_1'},
        ]},
        destroy: {xml: '', stmts: [
          {op: 'changeGlobal', name: 'score', delta: {op: 'num', value: 10}, blockId: 'bug_die_1'},
          {op: 'spawn', actor: 'boom', x: {op: 'myX'}, y: {op: 'myY'}, blockId: 'bug_die_2'},
          {op: 'playSound', sound: 'explode', blockId: 'bug_die_3'},
        ]},
      },
    },

    {
      id: 'bomb', name: 'Bomb', group: 'enemy_shot', max: 6,
      width: 8, height: 16,
      hitbox: {w: 4, h: 10, ox: 2, oy: 3},
      reuseOldest: true,
      fields: [],
      animations: [{name: 'fall', rate: 8, loop: true, frames: [shot(7)]}],
      behaviours: [
        {kind: 'move', direction: 'down', speed: 2, atEdge: 'destroy', margin: 8},
      ],
      scripts: {
        'collide:player': {xml: '', stmts: [
          {op: 'destroy', target: 'me', blockId: 'bomb_hit_1'},
          {op: 'changeGlobal', name: 'lives', delta: {op: 'num', value: -1}, blockId: 'bomb_hit_2'},
          {op: 'if', blockId: 'bomb_hit_3',
            cond: {op: 'compare', oper: 'eq',
              a: {op: 'global', name: 'lives'}, b: {op: 'num', value: 0}},
            then: [{op: 'gameOver', blockId: 'bomb_hit_4'}],
            else: [{op: 'restartRoom', blockId: 'bomb_hit_5'}]},
        ]},
      },
    },

    {
      id: 'boom', name: 'Boom', group: 'neutral', max: 4,
      width: 16, height: 16,
      hitbox: {w: 2, h: 2, ox: 7, oy: 7},
      reuseOldest: true,
      fields: [],
      animations: [
        {name: 'blast', rate: 4, loop: false,
          frames: [boom(0), boom(1), boom(2)]},
      ],
      behaviours: [{kind: 'animate'}],
      scripts: {
        animend: {xml: '', stmts: [
          {op: 'destroy', target: 'me', blockId: 'boom_end_1'},
        ]},
      },
    },
  ],

  rooms: [
    {
      id: 'wave1', name: 'Wave 1', music: 'action', bgPalette: 0, tiles: null,
      placements: [
        {actor: 'ship', x: 120, y: 168},
        ...Array.from({length: 8}, (_, i) => ({
          actor: 'bug',
          x: 24 + (i % 4) * 48,
          y: 24 + Math.floor(i / 4) * 32,
        })),
      ],
      scripts: {enter: {xml: '', stmts: []}},
    },
    {
      id: 'wave2', name: 'Wave 2', music: 'action', bgPalette: 0, tiles: null,
      placements: [
        {actor: 'ship', x: 120, y: 168},
        ...Array.from({length: 12}, (_, i) => ({
          actor: 'bug',
          x: 16 + (i % 4) * 56,
          y: 16 + Math.floor(i / 4) * 28,
        })),
      ],
      scripts: {enter: {xml: '', stmts: []}},
    },
  ],

  scripts: {
    gameStart: {xml: '', stmts: []},
    frame: {xml: '', stmts: [
      {op: 'print', row: 0, col: 1, text: 'SCORE', blockId: 'hud_1'},
      {op: 'print', row: 0, col: 7, global: 'score', blockId: 'hud_2'},
      {op: 'print', row: 0, col: 22, text: 'LIVES', blockId: 'hud_3'},
      {op: 'print', row: 0, col: 28, global: 'lives', blockId: 'hud_4'},

      // Wave cleared. The kernel keeps the live count per group
      // incrementally, so this is one array read per frame rather than a
      // scan over the pool.
      //
      // Deliberately in the global "on frame" script and not on the Bug:
      // an "on destroy" handler runs while that Bug is still occupying its
      // slot, so the count it would see is always at least one.
      {op: 'if', blockId: 'win_1',
        cond: {op: 'compare', oper: 'eq',
          a: {op: 'countGroup', group: 'enemy'}, b: {op: 'num', value: 0}},
        then: [
          {op: 'changeGlobal', name: 'score', delta: {op: 'num', value: 100},
            blockId: 'win_2'},
          {op: 'if', blockId: 'win_3',
            cond: {op: 'compare', oper: 'eq',
              a: {op: 'global', name: 'level'}, b: {op: 'num', value: 0}},
            then: [
              {op: 'setGlobal', name: 'level', value: {op: 'num', value: 1},
                blockId: 'win_4'},
              {op: 'goRoom', room: 'wave2', blockId: 'win_5'},
            ],
            else: [
              {op: 'setGlobal', name: 'level', value: {op: 'num', value: 0},
                blockId: 'win_6'},
              {op: 'goRoom', room: 'wave1', blockId: 'win_7'},
            ]},
        ],
        else: []},
    ]},
  },
};

/**
 * A scaled-down SG-1000 cut of the same game.
 *
 * The full shmup asks for 27 entity slots and the SG-1000 profile allows 14,
 * so the tool refuses to build it - which is the profiles working. This is
 * the same design with the counts brought inside the machine, and it is the
 * real test of whether the IR abstraction holds: nothing about the actors,
 * the collision matrix or the scripts changes, only the numbers and the
 * video backend.
 */
function scaleForSg1000(base) {
  const p = JSON.parse(JSON.stringify(base));
  p.name = 'Bug Blaster SG';
  p.target = 'sg1000';
  const caps = {ship: 1, shot: 2, bug: 6, bomb: 3, boom: 2};
  p.actors.forEach((a) => {
    if (caps[a.id]) a.max = caps[a.id];
  });
  // Four sprites per scanline on this VDP, so the tidy grid of bugs becomes
  // a stagger: a straight row of four would flicker badly.
  p.rooms.forEach((room, i) => {
    const bugs = room.placements.filter((x) => x.actor === 'bug').slice(0, 6);
    bugs.forEach((b, n) => {
      b.x = 24 + (n % 3) * 72;
      b.y = 24 + Math.floor(n / 3) * 40 + (n % 2) * 8;
    });
    room.placements = room.placements.filter((x) => x.actor !== 'bug').concat(bugs);
  });
  return p;
}

const out = resolve(here, '../examples/shmup.json');
mkdirSync(dirname(out), {recursive: true});
writeFileSync(out, JSON.stringify(project, null, 2));
console.log('wrote', out);

const sg = resolve(here, '../examples/shmup-sg1000.json');
writeFileSync(sg, JSON.stringify(scaleForSg1000(project), null, 2));
console.log('wrote', sg);
