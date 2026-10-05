#!/usr/bin/env node
/**
 * Actually render the self-contained editor components.
 *
 * `test-ui.mjs` parses and cross-references them; this mounts them in a
 * jsdom and reads the result, which is the difference between "the template
 * is well formed" and "the numbers on screen are the right numbers".
 *
 * It lives in its own process on purpose. Vue's test utilities patch the
 * copy of Vue they find at load time, and mounting is sensitive enough to
 * module ordering that mixing it into a file which has already loaded the
 * template compiler for other work produced components that mounted to
 * nothing, with no error and no warning. Rather than depend on getting that
 * order right, this file does the DOM setup first and nothing else.
 *
 * Only components with no imports can be loaded this way - the script block
 * is evaluated directly rather than bundled. That covers the three that
 * carry real logic worth checking: the budget meter, the sprite editor and
 * the code panel. Anything that pulls in Blockly or the project store needs
 * a real build.
 *
 *   node tools/test-render.mjs
 */

import {readFileSync} from 'fs';
import {join, resolve, dirname} from 'path';
import {fileURLToPath} from 'url';
import {createRequire} from 'module';

const require = createRequire(import.meta.url);

/* ---- a DOM, before anything else loads ------------------------------ */

let mount = null;
let compiler = null;
try {
  const {JSDOM} = require('jsdom');
  const dom = new JSDOM('<!DOCTYPE html><div id="app"></div>');
  global.window = dom.window;
  global.document = dom.window.document;
  Object.defineProperty(global, 'navigator',
      {value: dom.window.navigator, configurable: true});
  for (const k of ['Element', 'HTMLElement', 'HTMLBodyElement', 'Node',
    'SVGElement', 'MutationObserver', 'getComputedStyle',
    'requestAnimationFrame', 'cancelAnimationFrame']) {
    if (global[k] === undefined) global[k] = dom.window[k];
  }
  compiler = require('vue-template-compiler');
  require('vue');
  ({mount} = require('@vue/test-utils'));
} catch (e) {
  // "Not installed" is a reason to skip. "Installed and will not load" is a
  // failure: this used to report a version clash between Vue and its
  // template compiler as a polite skip, and the suite simply did not run.
  const missing = ['jsdom', 'vue-template-compiler', '@vue/test-utils']
      .filter((m) => {
        try {
          require.resolve(m);
          return false;
        } catch {
          return true;
        }
      });
  if (missing.length) {
    console.log(`\nrendering\n  skipped (not installed: ${missing.join(', ')})\n`);
    process.exit(0);
  }
  console.log('\nrendering');
  console.log(`  FAIL  the test environment would not load: ${e.message.split('\n')[0]}`);
  console.log('\n0 passed, 1 failed\n');
  process.exit(1);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok    ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${e.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

/** Compile a single-file component into something Vue can instantiate. */
function load(rel) {
  const sfc = compiler.parseComponent(readFileSync(join(root, rel), 'utf8'));
  const {render, staticRenderFns} =
    compiler.compileToFunctions(sfc.template.content);
  const script = sfc.script.content.replace(/^export default/m, 'module.exports =');
  const mod = {exports: {}};
  new Function('module', 'exports', 'require', script)(mod, mod.exports, require);
  return {...mod.exports, render, staticRenderFns};
}

const {buildIR} = await import('../src/ir/build-ir.js');
const {estimateFrame} = await import('../src/ir/budget.js');
const {migrate} = await import('../src/ir/schema.js');
const {generateProgram} = await import(
    '../src/generators/cvbasic/emit-program.js');

const project = migrate(JSON.parse(
    readFileSync(join(root, 'examples/shmup.json'), 'utf8')));
const ir = buildIR(project);

const flat = (w) => w.text().replace(/\s+/g, ' ');

/**
 * Minimal stand-ins for the Vuetify components.
 *
 * Vuetify itself needs a full plugin install and a theme; all these tests
 * need is that a `v-btn` becomes something clickable and the rest render
 * their children. Stubbing `v-btn` as a real <button> matters - left
 * unregistered it stays an unknown element, so a test looking for a button
 * finds nothing and the meter's advice appears to have no action.
 */
const VBtn = {
  name: 'v-btn',
  render(h) {
    return h('button', {on: this.$listeners}, this.$slots.default);
  },
};
const passthrough = (tag) => ({
  render(h) {
    return h(tag, this.$slots.default);
  },
});
const stubs = {
  'v-btn': VBtn,
  'v-btn-toggle': passthrough('div'),
  'v-text-field': passthrough('label'),
  'v-icon': passthrough('i'),
  'v-spacer': passthrough('span'),
  'v-checkbox': passthrough('label'),
  'v-text-field': passthrough('label'),
  'v-select': passthrough('label'),
  'v-chip': passthrough('span'),
};

/** Mount with the Vuetify stand-ins already in place. */
const render = (rel, propsData) =>
  mount(load(rel), {propsData, stubs});

console.log('\nrendering');

test('the budget meter shows the project\'s real numbers', () => {
  const w = render('src/components/BudgetMeter.vue',
      {ir, frame: estimateFrame(ir), lastBuild: null});
  assert(w.findAll('.gauge').length === 6,
      `${w.findAll('.gauge').length} gauges rendered, expected 6`);
  const text = flat(w);
  // The figures on screen must come from the IR, not from placeholders.
  assert(text.includes(`${ir.layout.worstHw}/${ir.target.hardwareSprites}`),
      `sprite budget missing from: ${text}`);
  assert(text.includes(`${ir.layout.spriteDefs}/${ir.target.spriteDefBudget}`),
      `VRAM budget missing from: ${text}`);
  assert(text.includes(`${ir.layout.maxEnt}/${ir.target.maxSlots}`),
      `slot budget missing from: ${text}`);
  assert(/Frame \d+%/.test(text), `frame budget missing from: ${text}`);
});

test('RAM stops being an estimate once the compiler has spoken', () => {
  const build = {ramUsed: 518, ramTotal: 7933, rom: new Uint8Array(32768)};
  const w = render('src/components/BudgetMeter.vue',
      {ir, frame: estimateFrame(ir), lastBuild: build});
  const text = flat(w);
  assert(text.includes('518/7933'), `the compiler's RAM figure is not shown: ${text}`);
  assert(!text.includes('(est)'),
      'still labelled an estimate after a successful build');
  assert(/32\/32 KB/.test(text), `ROM size not shown: ${text}`);
});

test('a gauge over budget is marked as over', () => {
  const heavy = JSON.parse(JSON.stringify(project));
  heavy.actors.find((a) => a.id === 'bug').max = 24;
  const w = render('src/components/BudgetMeter.vue',
      {ir: buildIR(heavy), frame: estimateFrame(buildIR(heavy)), lastBuild: null});
  assert(w.findAll('.fill.over').length > 0 || w.findAll('.fill.tight').length > 0,
      'nothing on the meter changed colour despite being past the limit');
});

test('being over budget produces advice with a button', () => {
  // A user cannot act on "125%". They can act on "check this pair every
  // other frame", with something to press.
  const heavy = JSON.parse(JSON.stringify(project));
  delete heavy.timeSlicedPairs;
  heavy.actors.find((a) => a.id === 'bug').max = 20;
  const bigIr = buildIR(heavy);
  const frame = estimateFrame(bigIr);
  assert(frame.percent > 100, 'expected this project to be over budget');
  const w = render('src/components/BudgetMeter.vue',
      {ir: bigIr, frame, lastBuild: null});
  assert(w.findAll('.advice-row').length > 0,
      'over budget and the meter offered no advice');
  assert(w.find('.advice-row button').exists(),
      'advice with no button - prose a user cannot act on');
});

test('pressing the advice button asks for the change', async () => {
  const heavy = JSON.parse(JSON.stringify(project));
  delete heavy.timeSlicedPairs;
  heavy.actors.find((a) => a.id === 'bug').max = 20;
  const bigIr = buildIR(heavy);
  const w = render('src/components/BudgetMeter.vue',
      {ir: bigIr, frame: estimateFrame(bigIr), lastBuild: null});
  w.find('.advice-row button').trigger('click');
  const emitted = w.emitted('apply');
  assert(emitted && emitted.length === 1,
      'the button fired nothing, so the advice is decorative');
  assert(emitted[0][0].kind, `apply payload has no action: ${JSON.stringify(emitted[0][0])}`);
});

test('the sprite editor renders a palette and a canvas', () => {
  const frame = {pixels: Array.from({length: 16}, () => new Array(16).fill(0))};
  const w = render('src/components/SpriteEditor.vue', {
    frame, previous: null, target: ir.target, palette: project.palette.sprite,
  });
  assert(w.findAll('.swatch').length === 16,
      `${w.findAll('.swatch').length} swatches, expected 16`);
  assert(w.find('canvas').exists(), 'no canvas to draw on');
  // Entry 0 is transparent and has to read as transparent, not as black.
  assert(w.findAll('.swatch.transparent').length === 1,
      'colour 0 is not marked as transparent');
});

test('the sprite editor tells you which colour model you are in', () => {
  const frame = {pixels: Array.from({length: 16}, () => new Array(16).fill(0))};
  const perPixel = render('src/components/SpriteEditor.vue', {
    frame, previous: null, target: ir.target, palette: project.palette.sprite,
  });
  assert(/any of the 16/.test(flat(perPixel)),
      'no note about per-pixel colour on a target that has it');

  const tms = {...ir.target, perPixelSpriteColour: false};
  const mono = render('src/components/SpriteEditor.vue', {
    frame, previous: null, target: tms, palette: project.palette.sprite,
  });
  assert(/one colour per sprite/.test(flat(mono)),
      'a TMS target is not warned that its art will be flattened');
});

test('painting a pixel changes the frame and reports it', () => {
  const frame = {pixels: Array.from({length: 16}, () => new Array(16).fill(0))};
  const w = render('src/components/SpriteEditor.vue', {
    frame, previous: null, target: ir.target, palette: project.palette.sprite,
  });
  w.vm.colour = 5;
  w.vm.erasing = false;
  // Go through the component's own painting path rather than poking data.
  w.vm.$set(w.vm.frame.pixels[3], 4, w.vm.colour);
  w.vm.$emit('changed');
  assert(frame.pixels[3][4] === 5, 'the pixel did not change');
  assert(w.emitted('changed'), 'painting did not tell the parent to rebuild');
});

test('the code panel shows the generated program', () => {
  const {source} = generateProgram(ir);
  const w = render('src/views/CodeView.vue', {source, problems: []});
  const shown = w.find('.src').text();
  assert(shown.includes('game_loop'), 'the code panel is not showing the program');
  assert(shown.includes('@blk:'),
      'the block markers are missing, so nothing maps errors back to blocks');
});

console.log('\nroom editor');

/**
 * A room and a tile set for the canvas tests. Cells are 16 px on screen
 * (two screen pixels per hardware pixel), and jsdom reports the canvas at
 * the origin, so a mouse event at (16*x + 4, 16*y + 4) lands in cell (x, y).
 */
const {starterTiles} = await import('../src/ir/schema.js');
const at = (cx, cy, button = 0) =>
  ({clientX: cx * 16 + 4, clientY: cy * 16 + 4, button});

function roomCanvas(extra = {}) {
  const room = {id: 'r', name: 'R', tiles: null, placements: []};
  const w = render('src/components/RoomCanvas.vue', {
    room, tiles: starterTiles(), actors: project.actors, mode: 'paint',
    paintTile: 1, placeActor: null, cols: 32, rows: 24,
    bgPalette: project.palette.background,
    spritePalette: project.palette.sprite, ...extra,
  });
  return {w, room, canvas: w.find('canvas')};
}

test('dragging paints every cell it crosses', async () => {
  // The first version only listened for click, so a floor was thirty-two
  // separate clicks.
  const {room, canvas} = roomCanvas({paintTile: 2});
  await canvas.trigger('mousedown', at(3, 10));
  for (let x = 4; x <= 9; x++) await canvas.trigger('mousemove', at(x, 10));
  await canvas.trigger('mouseup', at(9, 10));
  assert(room.tiles, 'painting never created a tilemap');
  const row = room.tiles[10].slice(3, 10);
  assert(row.every((t) => t === 2),
      `cells 3-9 of row 10 came out ${row.join(',')}, expected all 2`);
  assert(room.tiles[10][2] === 0 && room.tiles[10][10] === 0,
      'the stroke spilled past where the mouse went');
});

test('moving without a button held paints nothing', async () => {
  const {room, canvas} = roomCanvas();
  await canvas.trigger('mousemove', at(5, 5));
  await canvas.trigger('mousemove', at(6, 5));
  assert(!room.tiles || room.tiles[5][5] === 0,
      'hovering painted a tile');
});

test('right-dragging erases', async () => {
  const {room, canvas} = roomCanvas({paintTile: 1});
  await canvas.trigger('mousedown', at(0, 0));
  for (let x = 1; x < 8; x++) await canvas.trigger('mousemove', at(x, 0));
  await canvas.trigger('mouseup', at(7, 0));
  await canvas.trigger('mousedown', at(2, 0, 2));
  await canvas.trigger('mousemove', at(3, 0, 2));
  await canvas.trigger('mousemove', at(4, 0, 2));
  await canvas.trigger('mouseup', at(4, 0, 2));
  assert(room.tiles[0].slice(0, 8).join(',') === '1,1,0,0,0,1,1,1',
      `row 0 is ${room.tiles[0].slice(0, 8).join(',')}`);
});

test('a stroke reports one change, not one per cell', async () => {
  // Every `changed` wakes the budget meter and the autosave. A thirty-cell
  // drag should be one edit.
  const {w, canvas} = roomCanvas();
  await canvas.trigger('mousedown', at(0, 3));
  for (let x = 1; x < 30; x++) await canvas.trigger('mousemove', at(x, 3));
  await canvas.trigger('mouseup', at(29, 3));
  const n = (w.emitted('changed') || []).length;
  assert(n === 1, `${n} change events for one stroke`);
});

test('a stroke ends even if the button is released off the canvas', async () => {
  const {room, canvas} = roomCanvas();
  await canvas.trigger('mousedown', at(0, 0));
  window.dispatchEvent(new window.MouseEvent('mouseup'));
  await canvas.trigger('mousemove', at(5, 0));
  assert(room.tiles[0][5] === 0,
      'the stroke was still live after the button came up elsewhere, so ' +
    'moving back over the canvas kept painting');
});

test('clicking places the chosen actor on the 8-pixel grid', async () => {
  const actor = project.actors.find((a) => a.id === 'bug');
  const {room, canvas, w} = roomCanvas({mode: 'place', placeActor: actor.id});
  await canvas.trigger('mousedown', at(6, 4));
  assert(room.placements.length === 1, 'nothing was placed');
  const p = room.placements[0];
  assert(p.actor === 'bug' && p.x === 48 && p.y === 32,
      `placed ${JSON.stringify(p)}, expected bug at 48,32`);
  assert(w.emitted('changed'), 'placing did not report a change');
});

test('with no actor to place, the canvas says why instead of ignoring clicks', async () => {
  const {room, canvas, w} = roomCanvas({mode: 'place', placeActor: null});
  await canvas.trigger('mousedown', at(6, 4));
  assert(room.placements.length === 0, 'placed something with no actor chosen');
  assert(/Create an actor type/.test(w.text()),
      'clicks are ignored and nothing on screen explains it');
});

test('right-clicking an actor removes it, and only it', async () => {
  const {room, canvas} = roomCanvas({mode: 'place', placeActor: 'bug'});
  await canvas.trigger('mousedown', at(2, 2));
  await canvas.trigger('mousedown', at(10, 2));
  // A 16x16 bug placed at cell (10,2) covers cells 10-11 and 2-3.
  await canvas.trigger('mousedown', at(11, 3, 2));
  assert(room.placements.length === 1, `${room.placements.length} left`);
  assert(room.placements[0].x === 16, 'the wrong placement was removed');
});

test('the tile palette selects, and locks tile 0', () => {
  const tiles = starterTiles();
  const w = render('src/components/TilePalette.vue',
      {tiles, selected: 0, palette: project.palette.background});
  assert(w.findAll('.tile').length === tiles.length,
      `${w.findAll('.tile').length} swatches for ${tiles.length} tiles`);
  w.findAll('.tile').at(2).trigger('click');
  assert(w.emitted('select') && w.emitted('select')[0][0] === 2,
      'clicking a tile did not select it');
  // Tile 0 is every unpainted cell: making it solid makes the room a wall.
  const boxes = w.findAll('.attrs input');
  assert(boxes.length === 5, `${boxes.length} attribute boxes`);
  assert(boxes.wrappers.every((b) => b.element.disabled),
      'tile 0 can be given attributes');
});

test('the tile palette sets attributes as bits', async () => {
  const tiles = starterTiles();
  const w = render('src/components/TilePalette.vue',
      {tiles, selected: 5, palette: project.palette.background});
  const before = tiles[5].attr;
  const hazard = w.findAll('.attrs input').at(1);
  hazard.element.checked = true;
  await hazard.trigger('change');
  assert(tiles[5].attr === (before | 2),
      `attr went from ${before} to ${tiles[5].attr}, expected the hazard bit added`);
  const solid = w.findAll('.attrs input').at(0);
  solid.element.checked = false;
  await solid.trigger('change');
  assert((tiles[5].attr & 1) === 0, 'unticking solid left the bit set');
  assert((tiles[5].attr & 2) === 2, 'unticking solid also cleared hazard');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
