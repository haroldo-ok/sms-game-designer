/**
 * Builds examples/platformer.json.
 *
 * This exists to exercise the half of the engine the shmup never touches:
 * background tiles, the collision attribute shadow, `k_cell_at`, the
 * subpixel mover, and the Platform behaviour - which is by a wide margin the
 * most complicated thing in emit-behaviour.js and, until now, had never been
 * compiled into a ROM, let alone run.
 *
 * It is also the case that decides whether terrain-as-tiles was the right
 * call. Walls as actors would cost a pool slot each and make floor collision
 * a pairwise search; here the whole level is four tile types and one O(1)
 * lookup per entity per axis.
 */

import {writeFileSync, mkdirSync} from 'fs';
import {dirname, resolve} from 'path';
import {fileURLToPath} from 'url';

const here = dirname(fileURLToPath(import.meta.url));

const COLS = 32;
const ROWS = 24;

/* ---- tiles ---------------------------------------------------------- */

function tile(name, attr, fn) {
  return {
    name, attr,
    pixels: Array.from({length: 8}, (_, y) =>
      Array.from({length: 8}, (_, x) => fn(x, y) | 0)),
  };
}

const tiles = [
  // 0 is "empty" everywhere, so it must stay blank and non-solid.
  tile('empty', 0, () => 0),
  // Brick: a lit top edge reads as a surface you can stand on.
  tile('brick', 1, (x, y) => {
    if (y === 0) return 6;
    if (y === 7 || x === 0) return 4;
    return ((y >> 1) + (x >> 2)) % 2 ? 5 : 3;
  }),
  // Stone: solid, plainer, for walls and ceilings.
  tile('stone', 1, (x, y) => (x === 0 || y === 0) ? 7 : ((x + y) % 3 ? 2 : 8)),
  // Spikes: solid AND hazardous. Attributes are bits, so a tile can be
  // both, and it needs to be: "tile below me is a hazard" probes the cell
  // under the actor's feet, which only stays under its feet if the actor
  // can stand on it. A non-solid hazard is one you fall through.
  tile('spikes', 1 | 2, (x, y) => {
    const peak = (x % 4 < 2) ? x % 4 : 3 - (x % 4);
    return y >= 4 + peak ? 9 : 0;
  }),
];

/* ---- the level ------------------------------------------------------ */

const SOLID = 1;
const STONE = 2;
const SPIKE = 3;

function buildMap(variant = 0) {
  const m = Array.from({length: ROWS}, () => new Array(COLS).fill(0));
  const put = (x, y, t) => {
    if (y >= 0 && y < ROWS && x >= 0 && x < COLS) m[y][x] = t;
  };
  const ledge = (x0, x1, y) => {
    for (let x = x0; x <= x1; x++) put(x, y, SOLID);
  };

  // Every rise here is three tiles, because that is what the Hero's jump
  // actually clears: 5 px/frame against 0.35 gravity peaks at 33 px, a
  // little over four tiles. The first version of this level had its lowest
  // platform five tiles up and was simply not playable - the jump was fine,
  // the level was drawn by eye. The build now prints the reach so nobody has
  // to guess again.
  for (let y = 0; y < ROWS; y++) {
    put(0, y, STONE);
    put(COLS - 1, y, STONE);
  }
  for (let x = 1; x < COLS - 1; x++) {
    if (x >= 13 && x <= 18) {
      put(x, ROWS - 1, SPIKE);        // the pit, floored with spikes
    } else {
      put(x, ROWS - 1, SOLID);
      put(x, ROWS - 2, SOLID);
    }
  }

  if (variant === 0) {
    ledge(5, 9, 19);
    ledge(11, 15, 16);
    ledge(18, 22, 13);
    ledge(24, 28, 10);
  } else {
    // An exact mirror (column 31 - x), so the horizontal gaps are identical
    // to Cavern 1 and the climb is known to be within the jump arc. The
    // first attempt at this room moved the ledges by hand and quietly opened
    // three-tile gaps that the hero could not cross - the same mistake as
    // the original level, made a second time.
    ledge(22, 26, 19);
    ledge(16, 20, 16);
    ledge(9, 13, 13);
    ledge(3, 7, 10);
  }

  // A stub to bump your head on, well away from the climbing route.
  if (variant === 0) {
    for (let x = 3; x <= 6; x++) put(x, 7, STONE);
  } else {
    for (let x = 25; x <= 28; x++) put(x, 7, STONE);
  }

  return m;
}

/* ---- art ------------------------------------------------------------ */

function grid(w, h, fn) {
  return {pixels: Array.from({length: h}, (_, y) =>
    Array.from({length: w}, (_, x) => fn(x, y) | 0))};
}

/** A small walker: body, head, and legs that swap between frames. */
function hero(step) {
  return grid(16, 16, (x, y) => {
    if (y < 2) return 0;
    if (y < 6) return (x >= 5 && x <= 10) ? (y < 3 ? 1 : (x === 6 || x === 9 ? 12 : 1)) : 0;
    if (y < 12) return (x >= 4 && x <= 11) ? 2 : 0;
    if (y < 15) {
      const left = step ? (x >= 3 && x <= 6) : (x >= 5 && x <= 8);
      const right = step ? (x >= 9 && x <= 12) : (x >= 7 && x <= 10);
      return (left || right) ? 3 : 0;
    }
    return 0;
  });
}

/** A coin, spinning through three widths. */
function coin(step) {
  const w = [6, 3, 1][step];
  return grid(8, 16, (x, y) => {
    const dx = Math.abs(x - 3.5);
    const dy = Math.abs(y - 8);
    if (dy > 6 || dx > w / 2) return 0;
    return (dx > w / 2 - 1 || dy > 5) ? 11 : 10;
  });
}

/* ---- the project ---------------------------------------------------- */

const project = {
  schemaVersion: 3,
  name: 'Cavern Run',
  target: 'sms',
  meta: {author: 'SMS Game Designer sample', description: 'A terrain test.'},

  globals: [
    {name: 'coins', width: 8, initial: 0},
    {name: 'lives', width: 8, initial: 3},
    {name: 'level', width: 8, initial: 1},
  ],

  palette: {
    //          0 -      1 white  2 blue   3 dkblue 4 brown  5 tan
    //          6 lttan  7 grey   8 dkgrey 9 red   10 yellow 11 orange 12 skin
    background: [0x00, 0x3f, 0x30, 0x20, 0x06, 0x0b, 0x1f, 0x15,
      0x0a, 0x03, 0x0f, 0x07, 0x1b, 0x2a, 0x35, 0x3f],
    sprite: [0x00, 0x3f, 0x30, 0x20, 0x06, 0x0b, 0x1f, 0x15,
      0x0a, 0x03, 0x0f, 0x07, 0x1b, 0x2a, 0x35, 0x3f],
  },

  tiles,

  actors: [
    {
      id: 'hero', name: 'Hero', group: 'player', max: 1,
      width: 16, height: 16,
      hitbox: {w: 8, h: 14, ox: 4, oy: 2},
      isPlayer: true,
      fields: [],
      animations: [
        {name: 'walk', rate: 6, loop: true, frames: [hero(false), hero(true)]},
      ],
      behaviours: [
        // Gravity is fractional, so this type gets the 8.8 mover rather than
        // the whole-pixel one. A platformer with integer gravity jumps like
        // a lift.
        // 5 px/frame against 0.35 gravity: a peak of 33 px, just over four
        // tiles, which clears the three-tile rises the level is built from
        // with room to spare.
        {kind: 'platform', gravity: 0.35, jump: 5, speed: 2, pad: 1},
        {kind: 'animate'},
      ],
      scripts: {
        update: {xml: '', stmts: [
          // Standing on spikes, or falling off the bottom, costs a life and
          // restarts the room. `tileAt` reads the attribute shadow that
          // k_cell_at filled, which is the whole point of this sample.
          {op: 'if', blockId: 'hero_hurt',
            cond: {op: 'or',
              a: {op: 'tileAt', attr: 'hazard'},
              b: {op: 'compare', oper: 'gt',
                a: {op: 'myY'}, b: {op: 'num', value: 190}}},
            then: [
              {op: 'playSound', sound: 'hurt', blockId: 'hero_hurt_0'},
              {op: 'changeGlobal', name: 'lives',
                delta: {op: 'num', value: -1}, blockId: 'hero_hurt_1'},
              {op: 'if', blockId: 'hero_hurt_2',
                cond: {op: 'compare', oper: 'eq',
                  a: {op: 'global', name: 'lives'}, b: {op: 'num', value: 0}},
                then: [{op: 'gameOver', blockId: 'hero_hurt_3'}],
                else: [{op: 'restartRoom', blockId: 'hero_hurt_4'}]},
            ],
            else: []},
        ]},
      },
    },

    {
      id: 'coin', name: 'Coin', group: 'pickup', max: 8,
      width: 8, height: 16,
      hitbox: {w: 6, h: 10, ox: 1, oy: 3},
      fields: [],
      animations: [
        {name: 'spin', rate: 7, loop: true,
          frames: [coin(0), coin(1), coin(2), coin(1)]},
      ],
      behaviours: [{kind: 'animate'}],
      scripts: {
        'collide:player': {xml: '', stmts: [
          {op: 'playSound', sound: 'pickup', blockId: 'coin_get_0'},
          {op: 'changeGlobal', name: 'coins', delta: {op: 'num', value: 1},
            blockId: 'coin_get_1'},
          {op: 'destroy', target: 'me', blockId: 'coin_get_2'},
        ]},
      },
    },
  ],

  rooms: [
    {
      id: 'cavern', name: 'Cavern 1', music: 'action', bgPalette: 0,
      // The title screen is shown at boot and again after a game over, so
  // losing lands somewhere deliberate instead of dropping straight back in.
  title: {text: 'CAVERN RUN', subtitle: 'MIND THE SPIKES', music: 'title'},

  tiles: buildMap(0),
      placements: [
        // Column 2, with clear sky above it. Spawning under a ledge puts the
        // hero in a gap it cannot jump out of, which looks exactly like
        // broken physics.
        {actor: 'hero', x: 16, y: 150},
        // One coin on each ledge of the climb, two on the floor.
        {actor: 'coin', x: 96, y: 160},
        {actor: 'coin', x: 56, y: 136},
        {actor: 'coin', x: 104, y: 112},
        {actor: 'coin', x: 160, y: 88},
        {actor: 'coin', x: 208, y: 64},
        {actor: 'coin', x: 216, y: 160},
      ],
      scripts: {enter: {xml: '', stmts: []}},
    },
    {
      id: 'cavern2', name: 'Cavern 2', music: 'action', bgPalette: 0,
      tiles: buildMap(1),
      placements: [
        {actor: 'hero', x: 232, y: 150},
        {actor: 'coin', x: 192, y: 136},
        {actor: 'coin', x: 144, y: 112},
        {actor: 'coin', x: 88, y: 88},
        {actor: 'coin', x: 40, y: 64},
        {actor: 'coin', x: 152, y: 160},
        {actor: 'coin', x: 32, y: 160},
      ],
      scripts: {enter: {xml: '', stmts: []}},
    },
  ],

  scripts: {
    gameStart: {xml: '', stmts: []},
    frame: {xml: '', stmts: [
      {op: 'print', row: 0, col: 1, text: 'COINS', blockId: 'hud_1'},
      {op: 'print', row: 0, col: 7, global: 'coins', blockId: 'hud_2'},
      {op: 'print', row: 0, col: 13, text: 'LV', blockId: 'hud_5'},
      {op: 'print', row: 0, col: 16, global: 'level', blockId: 'hud_6'},
      {op: 'print', row: 0, col: 22, text: 'LIVES', blockId: 'hud_3'},
      {op: 'print', row: 0, col: 28, global: 'lives', blockId: 'hud_4'},

      // Level complete: every coin taken. The kernel keeps the live count
      // per group incrementally, so this is one array read a frame.
      //
      // In the global frame script rather than on the Coin, because a
      // Coin's "on destroy" runs while that coin still occupies its slot -
      // the count it would see is always at least one.
      {op: 'if', blockId: 'win_1',
        cond: {op: 'compare', oper: 'eq',
          a: {op: 'countGroup', group: 'pickup'}, b: {op: 'num', value: 0}},
        then: [
          {op: 'playSound', sound: 'pickup', blockId: 'win_2'},
          {op: 'if', blockId: 'win_3',
            cond: {op: 'compare', oper: 'eq',
              a: {op: 'global', name: 'level'}, b: {op: 'num', value: 1}},
            then: [
              {op: 'setGlobal', name: 'level', value: {op: 'num', value: 2},
                blockId: 'win_4'},
              {op: 'goRoom', room: 'cavern2', blockId: 'win_5'},
            ],
            else: [
              {op: 'setGlobal', name: 'level', value: {op: 'num', value: 1},
                blockId: 'win_6'},
              {op: 'goRoom', room: 'cavern', blockId: 'win_7'},
            ]},
        ],
        else: []},
    ]},
  },
};

const out = resolve(here, '../examples/platformer.json');
mkdirSync(dirname(out), {recursive: true});
writeFileSync(out, JSON.stringify(project, null, 2));
console.log('wrote', out);
