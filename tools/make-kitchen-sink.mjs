/**
 * Builds examples/kitchen-sink.json: a project that uses every statement and
 * every condition the block language can produce.
 *
 * Three blocks in this project have shipped, at one point or another, doing
 * nothing at all: `game over` set a flag nothing read, `play sound` set a
 * variable nothing read, and `tile below me is solid` tested a scratch
 * variable nobody had filled. Each was found by a person playing the game,
 * which is the worst way to find it.
 *
 * All three share a shape: the block lowers cleanly, the generator emits
 * something, the program compiles, and the behaviour is absent. Nothing that
 * reads source catches that, and neither does a sample that happens not to
 * use the block.
 *
 * So this sample uses all of them, `tools/test.mjs` asserts that it covers
 * every case the emitter handles, and the playtest runs the result. It is
 * not a game and is not meant to be one; it is a program whose only job is
 * to be complete.
 */

import {writeFileSync, mkdirSync} from 'fs';
import {dirname, resolve} from 'path';
import {fileURLToPath} from 'url';

const here = dirname(fileURLToPath(import.meta.url));

function grid(w, h, fn) {
  return {pixels: Array.from({length: h}, (_, y) =>
    Array.from({length: w}, (_, x) => fn(x, y) | 0))};
}

const box = (c) => grid(16, 16, (x, y) =>
  (x === 0 || y === 0 || x === 15 || y === 15) ? c : (x + y) % 4 ? 0 : c);
const dot = (c) => grid(8, 16, (x, y) =>
  (Math.abs(x - 3.5) < 3 && Math.abs(y - 8) < 5) ? c : 0);

const tiles = [
  {name: 'empty', attr: 0, pixels: Array.from({length: 8}, () => new Array(8).fill(0))},
  {name: 'floor', attr: 1, pixels: Array.from({length: 8}, (_, y) =>
    Array.from({length: 8}, () => y === 0 ? 6 : 4))},
];

const map = Array.from({length: 24}, () => new Array(32).fill(0));
for (let x = 0; x < 32; x++) map[22][x] = 1;

const project = {
  schemaVersion: 3,
  name: 'Kitchen Sink',
  target: 'sms',
  meta: {author: 'coverage sample', description: 'Uses every block.'},

  globals: [
    {name: 'score', width: 16, initial: 0},
    {name: 'lives', width: 8, initial: 5},
    {name: 'phase', width: 8, initial: 0},
  ],

  palette: {
    background: [0x00, 0x3f, 0x30, 0x0c, 0x06, 0x0b, 0x1f, 0x03,
      0x0a, 0x3c, 0x0f, 0x07, 0x1b, 0x2a, 0x35, 0x15],
    sprite: [0x00, 0x3f, 0x30, 0x0c, 0x06, 0x0b, 0x1f, 0x03,
      0x0a, 0x3c, 0x0f, 0x07, 0x1b, 0x2a, 0x35, 0x15],
  },

  tiles,

  actors: [
    {
      id: 'avatar', name: 'Avatar', group: 'player', max: 1,
      width: 16, height: 16,
      hitbox: {w: 12, h: 12, ox: 2, oy: 2},
      isPlayer: true,
      fields: [
        {name: 'hp', width: 8, initial: 3},
        {name: 'ammo', width: 8, initial: 9},
      ],
      animations: [
        {name: 'idle', rate: 8, loop: true, frames: [box(1), box(2)]},
        {name: 'hurt', rate: 4, loop: false, frames: [box(9), box(7)]},
      ],
      behaviours: [
        {kind: 'control8', speed: 2, pad: 1},
        {kind: 'animate'},
      ],
      scripts: {
        // on create: setPos, setVel, setTimer, setField, playAnim, show
        create: {xml: '', stmts: [
          {op: 'setPos', x: {op: 'num', value: 120}, y: {op: 'num', value: 150},
            blockId: 'k_setpos'},
          {op: 'setVel', vx: 0, vy: 0, blockId: 'k_setvel'},
          {op: 'setTimer', value: {op: 'num', value: 90}, blockId: 'k_settimer'},
          {op: 'setField', field: 'hp', value: {op: 'num', value: 3},
            blockId: 'k_setfield'},
          {op: 'playAnim', anim: 'idle', blockId: 'k_playanim'},
          {op: 'show', blockId: 'k_show'},
          {op: 'playSound', sound: 'jump', blockId: 'k_playsound'},
        ]},

        // on update: every condition, plus movePos, repeat, spawn, arithmetic
        update: {xml: '', stmts: [
          // pad / button / pad2 / button2
          {op: 'if', blockId: 'k_pad',
            cond: {op: 'or',
              a: {op: 'pad', dir: 'UP'},
              b: {op: 'pad2', dir: 'DOWN'}},
            then: [{op: 'movePos', dx: {op: 'num', value: 0},
              dy: {op: 'num', value: -1}, blockId: 'k_movepos'}],
            else: []},
          {op: 'if', blockId: 'k_button',
            cond: {op: 'and',
              a: {op: 'button'},
              b: {op: 'not', a: {op: 'button2'}}},
            then: [
              {op: 'spawn', actor: 'pellet',
                x: {op: 'binop', oper: '+', a: {op: 'myX'}, b: {op: 'num', value: 4}},
                y: {op: 'myY'}, blockId: 'k_spawn'},
              {op: 'changeField', field: 'ammo',
                delta: {op: 'num', value: -1}, blockId: 'k_changefield'},
            ],
            else: []},
          // terrain, off-screen, animation end, distance to the player
          {op: 'if', blockId: 'k_tile',
            cond: {op: 'tileAt', attr: 'solid'},
            then: [{op: 'setGlobal', name: 'phase',
              value: {op: 'num', value: 1}, blockId: 'k_setglobal'}],
            else: [{op: 'setGlobal', name: 'phase',
              value: {op: 'num', value: 0}, blockId: 'k_setglobal2'}]},
          {op: 'if', blockId: 'k_offscreen',
            cond: {op: 'offScreen'},
            then: [{op: 'setPos', x: {op: 'num', value: 120},
              y: {op: 'num', value: 150}, blockId: 'k_setpos2'}],
            else: []},
          {op: 'if', blockId: 'k_animend',
            cond: {op: 'animEnded'},
            then: [{op: 'playAnim', anim: 'idle', blockId: 'k_playanim2'}],
            else: []},
          {op: 'if', blockId: 'k_near',
            cond: {op: 'nearPlayer', distance: 40},
            then: [{op: 'changeGlobal', name: 'score',
              delta: {op: 'num', value: 1}, blockId: 'k_changeglobal'}],
            else: []},
          // every comparison operator, and every arithmetic operator
          {op: 'if', blockId: 'k_cmp',
            cond: {op: 'or',
              a: {op: 'compare', oper: 'ge',
                a: {op: 'field', field: 'hp'}, b: {op: 'num', value: 1}},
              b: {op: 'compare', oper: 'lt',
                a: {op: 'binop', oper: '*',
                  a: {op: 'field', field: 'ammo'}, b: {op: 'num', value: 2}},
                b: {op: 'binop', oper: '/',
                  a: {op: 'global', name: 'score'}, b: {op: 'num', value: 4}}}},
            then: [
              {op: 'repeat', count: {op: 'num', value: 2},
                body: [{op: 'changeGlobal', name: 'score',
                  delta: {op: 'num', value: 1}, blockId: 'k_repeat_body'}],
                blockId: 'k_repeat'},
            ],
            else: []},
          // random, frame counter, my timer, my frame, the player's position
          {op: 'if', blockId: 'k_rand',
            cond: {op: 'compare', oper: 'eq',
              a: {op: 'randomRange', min: 0, max: 63},
              b: {op: 'num', value: 0}},
            then: [
              {op: 'setTimer',
                value: {op: 'binop', oper: '-',
                  a: {op: 'num', value: 90}, b: {op: 'myFrame'}},
                blockId: 'k_settimer2'},
            ],
            else: []},
          // my timer, the frame counter, random(n), and a yes/no block used
          // as a number - all expression forms the emitter handles and no
          // other sample reaches.
          {op: 'if', blockId: 'k_misc',
            cond: {op: 'compare', oper: 'gt',
              a: {op: 'binop', oper: '+',
                a: {op: 'myTimer'}, b: {op: 'frameCounter'}},
              b: {op: 'random', max: {op: 'num', value: 64}}},
            then: [
              {op: 'changeGlobal', name: 'score',
                delta: {op: 'cond', cond: {op: 'button'}}, blockId: 'k_condexpr'},
            ],
            else: []},
          {op: 'if', blockId: 'k_count',
            cond: {op: 'compare', oper: 'ne',
              a: {op: 'countGroup', group: 'enemy'}, b: {op: 'num', value: 0}},
            then: [{op: 'hide', blockId: 'k_hide'},
              {op: 'show', blockId: 'k_show2'}],
            else: []},
        ]},

        // on timer / on animation end / on leave screen / on destroy
        timer: {xml: '', stmts: [
          {op: 'playAnim', anim: 'hurt', blockId: 'k_timer_1'},
          {op: 'setTimer', value: {op: 'num', value: 120}, blockId: 'k_timer_2'},
        ]},
        animend: {xml: '', stmts: [
          {op: 'playAnim', anim: 'idle', blockId: 'k_animend_1'},
        ]},
        leave: {xml: '', stmts: [
          {op: 'setPos', x: {op: 'num', value: 120},
            y: {op: 'num', value: 150}, blockId: 'k_leave_1'},
        ]},
        destroy: {xml: '', stmts: [
          {op: 'playSound', sound: 'explode', blockId: 'k_destroy_1'},
        ]},

        // collide: other's fields and destroying the other one
        'collide:enemy': {xml: '', stmts: [
          {op: 'playSound', sound: 'hurt', blockId: 'k_hit_1'},
          {op: 'changeField', field: 'hp', delta: {op: 'num', value: -1},
            blockId: 'k_hit_2'},
          {op: 'destroy', target: 'other', blockId: 'k_hit_3'},
          {op: 'if', blockId: 'k_hit_4',
            cond: {op: 'compare', oper: 'le',
              a: {op: 'field', field: 'hp'}, b: {op: 'num', value: 0}},
            then: [{op: 'gameOver', blockId: 'k_gameover'}],
            else: [{op: 'playAnim', anim: 'hurt', blockId: 'k_hit_5'}]},
        ]},
        'collide:pickup': {xml: '', stmts: [
          // the other one's position, and the player's, which only make
          // sense inside a collide script
          {op: 'setPos', x: {op: 'otherX'}, y: {op: 'otherY'},
            blockId: 'k_pick_0'},
          {op: 'setTimer',
            value: {op: 'binop', oper: '-',
              a: {op: 'playerX'}, b: {op: 'playerY'}}, blockId: 'k_pick_0b'},
          {op: 'changeGlobal', name: 'score', delta: {op: 'num', value: 5},
            blockId: 'k_pick_1'},
          {op: 'destroy', target: 'other', blockId: 'k_pick_2'},
        ]},
      },
    },

    {
      id: 'pellet', name: 'Pellet', group: 'player_shot', max: 4,
      width: 8, height: 16,
      hitbox: {w: 4, h: 8, ox: 2, oy: 4},
      reuseOldest: true,
      fields: [],
      animations: [{name: 'fly', rate: 8, loop: true, frames: [dot(1)]}],
      behaviours: [
        {kind: 'move', direction: 'up', speed: 4, atEdge: 'destroy', margin: 8},
      ],
      scripts: {
        'collide:enemy': {xml: '', stmts: [
          {op: 'destroy', target: 'me', blockId: 'k_pellet_1'},
        ]},
      },
    },

    {
      id: 'drone', name: 'Drone', group: 'enemy', max: 3,
      width: 16, height: 16,
      hitbox: {w: 12, h: 12, ox: 2, oy: 2},
      fields: [{name: 'hp', width: 8, initial: 2}],
      animations: [{name: 'fly', rate: 6, loop: true, frames: [box(9), box(7)]}],
      // chase and shoot, which no other sample exercises together
      behaviours: [
        {kind: 'chase', speed: 0.5, rate: 8},
        {kind: 'shoot', actor: 'pellet', interval: 60, randomise: 64,
          offsetX: 4, offsetY: 12, aim: 'player', bulletSpeed: 2},
        {kind: 'animate'},
        {kind: 'health', field: 'hp'},
      ],
      scripts: {
        'collide:player_shot': {xml: '', stmts: [
          {op: 'changeField', field: 'hp', delta: {op: 'num', value: -1},
            blockId: 'k_drone_1'},
        ]},
        destroy: {xml: '', stmts: [
          {op: 'playSound', sound: 'explode', blockId: 'k_drone_2'},
          {op: 'changeGlobal', name: 'score', delta: {op: 'num', value: 20},
            blockId: 'k_drone_3'},
        ]},
      },
    },

    {
      id: 'orb', name: 'Orb', group: 'pickup', max: 2,
      width: 8, height: 16,
      hitbox: {w: 6, h: 10, ox: 1, oy: 3},
      fields: [],
      animations: [{name: 'glow', rate: 5, loop: true, frames: [dot(10), dot(11)]}],
      behaviours: [
        {kind: 'patrol', speed: 1, turnAtWall: false},
        {kind: 'animate'},
        {kind: 'destroyOffscreen', margin: 8},
      ],
      scripts: {},
    },
  ],

  rooms: [
    {
      id: 'roomA', name: 'Room A', music: 'action', bgPalette: 0, tiles: map,
      placements: [
        {actor: 'avatar', x: 120, y: 150},
        {actor: 'drone', x: 60, y: 40},
        {actor: 'drone', x: 180, y: 40},
        {actor: 'orb', x: 100, y: 96},
      ],
      // on enter: spawn from a room script, and print
      scripts: {enter: {xml: '', stmts: [
        {op: 'spawn', actor: 'orb', x: {op: 'num', value: 200},
          y: {op: 'num', value: 96}, blockId: 'k_room_spawn'},
        {op: 'setGlobal', name: 'phase', value: {op: 'num', value: 0},
          blockId: 'k_room_set'},
      ]}},
    },
    {
      id: 'roomB', name: 'Room B', music: 'action', bgPalette: 0, tiles: null,
      placements: [{actor: 'avatar', x: 120, y: 150}],
      scripts: {enter: {xml: '', stmts: []}},
    },
  ],

  scripts: {
    gameStart: {xml: '', stmts: [
      {op: 'setGlobal', name: 'score', value: {op: 'num', value: 0},
        blockId: 'k_start_1'},
      {op: 'playSound', sound: 'pickup', blockId: 'k_start_2'},
      {op: 'stopMusic', blockId: 'k_start_3'},
      {op: 'playMusic', music: 'action', blockId: 'k_start_4'},
    ]},
    frame: {xml: '', stmts: [
      {op: 'print', row: 0, col: 1, text: 'SC', blockId: 'k_print_1'},
      {op: 'print', row: 0, col: 4, global: 'score', blockId: 'k_print_2'},
      {op: 'print', row: 0, col: 12, text: 'HP', blockId: 'k_print_3'},
      {op: 'print', row: 0, col: 15, global: 'lives', blockId: 'k_print_4'},
      // room flow: goRoom and restartRoom both reachable
      {op: 'if', blockId: 'k_flow',
        cond: {op: 'compare', oper: 'gt',
          a: {op: 'global', name: 'score'}, b: {op: 'num', value: 400}},
        then: [{op: 'goRoom', room: 'roomB', blockId: 'k_goroom'}],
        else: []},
      {op: 'if', blockId: 'k_flow2',
        cond: {op: 'compare', oper: 'eq',
          a: {op: 'global', name: 'lives'}, b: {op: 'num', value: 0}},
        then: [{op: 'restartRoom', blockId: 'k_restart'}],
        else: []},
      // the raw escape hatch
      {op: 'raw', code: "' raw passthrough, used by .bas import", blockId: 'k_raw'},
    ]},
  },
};

const out = resolve(here, '../examples/kitchen-sink.json');
mkdirSync(dirname(out), {recursive: true});
writeFileSync(out, JSON.stringify(project, null, 2));
console.log('wrote', out);
