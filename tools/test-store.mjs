#!/usr/bin/env node
/**
 * Exercise the project store.
 *
 * This is the editor's model layer: every mutation a person makes goes
 * through it, and none of it had ever run. The mutations that matter are the
 * destructive ones - deleting an actor has to take every reference to it
 * with it, or the project becomes unbuildable and the error names something
 * the user never touched.
 *
 * It loads in Node because the composition API only needs a Vue instance
 * registered, and `localStorage` is small enough to stand in for.
 *
 *   node tools/test-store.mjs
 */

import {createRequire} from 'module';
import {resolve, dirname} from 'path';
import {fileURLToPath} from 'url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(root + '/');

/* ---- browser shims, before the store loads -------------------------- */

const cells = new Map();
global.localStorage = {
  getItem: (k) => (cells.has(k) ? cells.get(k) : null),
  setItem: (k, v) => cells.set(k, String(v)),
  removeItem: (k) => cells.delete(k),
  clear: () => cells.clear(),
};

const Vue = require('vue');
Vue.config.productionTip = false;
Vue.config.devtools = false;
// Register on the ESM copy of the plugin: the CJS copy is a separate module
// instance with its own state, and the store imports the ESM one.
const ca = await import('@vue/composition-api');
Vue.use(ca.default);

const store = await import('../src/hooks/project.js');
const {buildIR} = await import('../src/ir/build-ir.js');
const {lint} = await import('../src/ir/lint.js');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    store.newProject('Test');
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

const p = () => store.project.value;

console.log('\nactors');

test('the first actor created becomes the player', () => {
  const a = store.addActor('Ship');
  assert(a.isPlayer, 'the first actor is not the player');
  assert(a.max === 1, `the player has Max instances ${a.max}`);
  assert(a.group === 'player', `the player is in group ${a.group}`);
});

test('later actors do not steal the player flag', () => {
  store.addActor('Ship');
  const b = store.addActor('Bug');
  assert(!b.isPlayer, 'the second actor took the player flag');
  assert(p().actors.filter((x) => x.isPlayer).length === 1,
      'more than one actor is flagged as the player');
});

test('exactly one actor can be the player', () => {
  const a = store.addActor('Ship');
  const b = store.addActor('Bug');
  store.setPlayer(b.id);
  assert(!a.isPlayer && b.isPlayer, 'setPlayer did not move the flag');
  assert(p().actors.filter((x) => x.isPlayer).length === 1,
      'setPlayer left two players');
});

test('actor ids are unique even after deletions', () => {
  const ids = new Set();
  for (let i = 0; i < 4; i++) ids.add(store.addActor(`A${i}`).id);
  store.removeActor([...ids][1]);
  const fresh = store.addActor('Another');
  assert(!p().actors.filter((x) => x !== fresh).some((x) => x.id === fresh.id),
      `the new actor reused the id ${fresh.id}`);
});

console.log('\ndeleting an actor takes its references with it');

test('placements of a deleted actor are removed', () => {
  const ship = store.addActor('Ship');
  const bug = store.addActor('Bug');
  p().rooms[0].placements = [
    {actor: ship.id, x: 100, y: 100},
    {actor: bug.id, x: 50, y: 50},
  ];
  store.removeActor(bug.id);
  const left = p().rooms[0].placements.map((x) => x.actor);
  assert(!left.includes(bug.id),
      `a placement still points at the deleted actor: ${left.join(', ')}`);
  assert(left.includes(ship.id), 'the wrong placement was removed');
});

test('a Shoot behaviour aimed at a deleted actor is removed', () => {
  const ship = store.addActor('Ship');
  const shot = store.addActor('Shot');
  ship.behaviours = [
    {kind: 'shoot', actor: shot.id, interval: 12},
    {kind: 'animate'},
  ];
  store.removeActor(shot.id);
  assert(!ship.behaviours.some((b) => b.actor === shot.id),
      'a Shoot behaviour still fires a deleted actor');
  assert(ship.behaviours.some((b) => b.kind === 'animate'),
      'unrelated behaviours were removed too');
});

test('a spawn block aimed at a deleted actor is reported, not silently dropped', () => {
  // A reference buried inside a script rather than in a list the editor
  // already walks. Placements and Shoot behaviours are structural and get
  // removed with the actor; a spawn block is something the user wrote, so it
  // stays - but the generator emits nothing for a spawn it cannot resolve,
  // so it has to be reported or it sits in the workspace doing nothing.
  const ship = store.addActor('Ship');
  const boom = store.addActor('Boom');
  ship.scripts = {update: {xml: '', stmts: [
    {op: 'spawn', actor: boom.id, x: {op: 'myX'}, y: {op: 'myY'}, blockId: 'b1'},
    {op: 'if', blockId: 'b2',
      cond: {op: 'button'},
      then: [{op: 'spawn', actor: boom.id, x: {op: 'myX'}, y: {op: 'myY'},
        blockId: 'b3'}],
      else: []},
    {op: 'destroy', target: 'me', blockId: 'b4'},
  ]}};
  store.removeActor(boom.id);
  const json = JSON.stringify(ship.scripts);
  assert(json.includes('destroy'), 'unrelated statements were removed too');
  assert(json.includes(boom.id),
      'the spawn block was deleted; the user loses authored work with no ' +
    'way to see what happened');

  const problems = lint(buildIR(p()));
  const dangling = problems.filter((x) => x.code === 'dangling-spawn');
  assert(dangling.length === 2,
      `${dangling.length} dangling spawns reported, expected 2 (one nested)`);
  assert(dangling.every((x) => x.severity === 'error'),
      'a spawn that generates no code is only a warning');
  assert(dangling.some((x) => x.blockId === 'b3'),
      'the nested spawn inside an if block was missed');
});

test('a project with a deleted actor still builds cleanly', () => {
  const ship = store.addActor('Ship');
  ship.animations[0].frames = [blank(16, 16)];
  const shot = store.addActor('Shot');
  shot.animations[0].frames = [blank(16, 16)];
  ship.behaviours = [{kind: 'shoot', actor: shot.id, interval: 12}];
  p().rooms[0].placements = [
    {actor: ship.id, x: 100, y: 150},
    {actor: shot.id, x: 10, y: 10},
  ];
  store.removeActor(shot.id);
  const ir = buildIR(p());
  const problems = [...ir.diagnostics, ...lint(ir)]
      .filter((d) => d.severity === 'error');
  assert(!problems.length,
      `deleting an actor left errors behind: ${problems.map((x) => x.message).join('; ')}`);
});

function blank(w, h) {
  return {pixels: Array.from({length: h}, () => new Array(w).fill(0))};
}

console.log('\nbudgets and limits');

test('fields stop at the target budget', () => {
  const a = store.addActor('Ship');
  const added = [];
  for (let i = 0; i < 8; i++) {
    const f = store.addField(a, `f${i}`);
    if (f) added.push(f);
  }
  assert(added.length === 4,
      `${added.length} fields accepted, the SMS budget is 4 slots`);
});

test('a 16-bit field costs two slots', () => {
  const a = store.addActor('Ship');
  const big = store.addField(a, 'score');
  big.width = 16;
  store.addField(a, 'b');
  store.addField(a, 'c');
  const fourth = store.addField(a, 'd');
  assert(fourth === null,
      'a fourth field was accepted even though a 16-bit one costs two slots');
});

test('the last room cannot be deleted', () => {
  assert(p().rooms.length === 1, 'a new project should start with one room');
  store.removeRoom(p().rooms[0].id);
  assert(p().rooms.length === 1,
      'the only room was deleted, leaving nowhere for the game to start');
});

test('deleting a room moves the selection somewhere valid', () => {
  const b = store.addRoom('Second');
  store.removeRoom(b.id);
  assert(p().rooms.some((r) => r.id === store.selectedRoom.value),
      `selection points at ${store.selectedRoom.value}, which no longer exists`);
});

console.log('\nediting');

test('adding a frame copies the last one rather than starting blank', () => {
  // People animate by nudging, not by redrawing.
  const a = store.addActor('Ship');
  const anim = a.animations[0];
  anim.frames[0].pixels[3][4] = 7;
  store.addFrame(a, anim);
  assert(anim.frames.length === 2, 'no frame was added');
  assert(anim.frames[1].pixels[3][4] === 7,
      'the new frame came up blank instead of copying the last one');
  anim.frames[1].pixels[3][4] = 9;
  assert(anim.frames[0].pixels[3][4] === 7,
      'the frames share the same pixel array, so editing one edits both');
});

test('scripts are created on demand and kept', () => {
  const a = store.addActor('Ship');
  const s = store.scriptFor(a, 'update');
  assert(s && Array.isArray(s.stmts), 'no script was created');
  s.stmts.push({op: 'show', blockId: 'x'});
  assert(store.scriptFor(a, 'update').stmts.length === 1,
      'asking again returned a different script object');
  store.removeScript(a, 'update');
  assert(!a.scripts.update, 'the script was not removed');
});

console.log('\npersistence');

test('a project survives a save and a reload', async () => {
  const a = store.addActor('Ship');
  a.name = 'Interceptor';
  p().name = 'Round Trip';
  store.save();
  const raw = global.localStorage.getItem('sms-game-designer:project');
  assert(raw, 'nothing was written to storage');
  const {migrate} = await import('../src/ir/schema.js');
  const back = migrate(JSON.parse(raw));
  assert(back.name === 'Round Trip', `name came back as ${back.name}`);
  assert(back.actors[0].name === 'Interceptor',
      `actor came back as ${back.actors[0].name}`);
});

test('an export round-trips through the zip', async () => {
  const a = store.addActor('Ship');
  a.name = 'Interceptor';
  store.addField(a, 'hp');
  p().name = 'Zipped';

  // exportProject hands the blob to the browser, so build the same zip here
  // and read it back the way importProject would.
  const JSZip = require('jszip');
  const zip = new JSZip();
  zip.file('project.json', JSON.stringify(p(), null, 2));
  const buf = await zip.generateAsync({type: 'nodebuffer'});
  const again = await JSZip.loadAsync(buf);
  const text = await again.file('project.json').async('string');
  const {migrate} = await import('../src/ir/schema.js');
  const back = migrate(JSON.parse(text));
  assert(back.name === 'Zipped', `name came back as ${back.name}`);
  assert(back.actors[0].fields.length === 1, 'fields did not survive');
  assert(buildIR(back).types.length === 1, 'the reloaded project has no types');
});

test('a corrupt autosave does not lose the editor', async () => {
  global.localStorage.setItem('sms-game-designer:project', '{not json at all');
  const {migrate} = await import('../src/ir/schema.js');
  let recovered = null;
  try {
    recovered = migrate(JSON.parse(
        global.localStorage.getItem('sms-game-designer:project')));
  } catch {
    recovered = migrate(null);
  }
  assert(recovered && recovered.rooms.length >= 1,
      'a corrupt autosave leaves no usable project to fall back to');
});

console.log('\ntiles');

test('a new project can paint straight away', () => {
  // It used to start with no tiles, so "Paint tiles" painted references to
  // a tile that did not exist.
  const tiles = p().tiles;
  assert(tiles.length >= 4, `a new project has ${tiles.length} tiles`);
  assert(tiles[0].attr === 0, 'tile 0 is not walk-through');
  assert(tiles[0].pixels.flat().every((v) => v === 0), 'tile 0 is not empty');
  assert(tiles.some((t) => t.attr & 1), 'no solid tile to build ground with');
  assert(tiles.some((t) => t.attr & 2), 'no hazard tile');
});

test('an old project with no tiles gets the starter set', async () => {
  const {migrate} = await import('../src/ir/schema.js');
  const old = {schemaVersion: 3, name: 'Old', actors: [], globals: [],
    tiles: [],
    rooms: [{id: 'r', name: 'R', placements: [],
      tiles: Array.from({length: 24}, () => new Array(32).fill(1))}]};
  const m = migrate(old);
  assert(m.tiles.length > 1,
      'the cells this project painted still point at tiles that do not exist');
  const problems = lint(buildIR(m)).filter((x) => x.code === 'tile-missing');
  assert(!problems.length, 'migrated project still reports missing tiles');
});

test('duplicating a tile copies its art and its meaning', () => {
  const n = p().tiles.length;
  const i = store.addTile(1);
  assert(i === n, `new tile index ${i}, expected ${n}`);
  assert(p().tiles[i].attr === p().tiles[1].attr, 'attributes not copied');
  p().tiles[i].pixels[0][0] = 13;
  assert(p().tiles[1].pixels[0][0] !== 13,
      'the copy shares its pixel rows with the original');
});

test('a copy of tile 0 is not forced to be empty', () => {
  const i = store.addTile(0);
  assert(p().tiles[i].attr === 0 && i > 0, 'copying tile 0 went wrong');
});

test('deleting a tile remaps every room that uses later tiles', () => {
  // Rooms store indices. Removing tile 2 turns every 3 into a 2 - unless the
  // rooms are remapped, the whole map shifts onto the wrong art.
  const tiles = p().tiles;
  const a = p().rooms[0];
  const b = store.addRoom('Second');
  a.tiles = Array.from({length: 24}, () => new Array(32).fill(0));
  b.tiles = Array.from({length: 24}, () => new Array(32).fill(0));
  a.tiles[0].splice(0, 4, 1, 2, 3, 4);
  b.tiles[5].splice(0, 2, 3, 2);
  const nameOf3 = tiles[3].name;
  const nameOf4 = tiles[4].name;

  assert(store.removeTile(2), 'removeTile refused');
  assert(a.tiles[0].slice(0, 4).join(',') === '1,0,2,3',
      `room A row 0 is ${a.tiles[0].slice(0, 4).join(',')}, expected 1,0,2,3`);
  assert(b.tiles[5].slice(0, 2).join(',') === '2,0',
      `room B row 5 is ${b.tiles[5].slice(0, 2).join(',')}, expected 2,0`);
  assert(tiles[2].name === nameOf3 && tiles[3].name === nameOf4,
      'the cells point at indices that no longer hold the same art');
});

test('tile 0 cannot be deleted', () => {
  const n = p().tiles.length;
  assert(!store.removeTile(0), 'removeTile accepted tile 0');
  assert(p().tiles.length === n, 'a tile disappeared anyway');
});

console.log('\nopening a project');

test('an example opens as the current project', async () => {
  const {readFileSync} = await import('fs');
  const {join} = await import('path');
  const data = JSON.parse(readFileSync(join(root, 'examples/shmup.json'), 'utf8'));
  store.addActor('Throwaway');
  store.openProject(data);
  assert(p().name === data.name, `opened "${p().name}"`);
  assert(p().actors.length === data.actors.length, 'actors missing');
  assert(!p().actors.some((a) => a.name === 'Throwaway'),
      'the previous project leaked into the opened one');
  assert(store.selectedActor.value === p().actors[0].id,
      'nothing is selected, so the Actors tab opens on an empty editor');
  assert(store.selectedRoom.value === p().rooms[0].id, 'no room selected');
});

test('opening an example does not alter the bundled copy', async () => {
  const {readFileSync} = await import('fs');
  const {join} = await import('path');
  const data = JSON.parse(readFileSync(join(root, 'examples/platformer.json'), 'utf8'));
  const before = JSON.stringify(data);
  store.openProject(data);
  p().actors[0].name = 'Edited';
  assert(JSON.stringify(data) === before,
      'editing the opened project changed the example it came from');
});

console.log('\nthe rename');

test('work autosaved under the old name is still there after the rename', async () => {
  // The tool was renamed from "SMS Game Maker". Its autosave key had the old
  // name in it, so without carrying it across, the first launch afterwards
  // would open an empty project - indistinguishable from losing the work.
  const oldKey = 'sms-game-maker:project';
  const newKey = 'sms-game-designer:project';
  global.localStorage.removeItem(newKey);
  const before = JSON.parse(JSON.stringify(p()));
  before.name = 'Made Before The Rename';
  global.localStorage.setItem(oldKey, JSON.stringify(before));

  // A fresh copy of the store module, so its startup load runs again against
  // this storage - which is what a page load does.
  const fresh = await import(`../src/hooks/project.js?legacy=${Date.now()}`);
  assert(fresh.project.value.name === 'Made Before The Rename',
      `the renamed editor opened "${fresh.project.value.name}" instead`);
  assert(global.localStorage.getItem(newKey),
      'the old autosave was read but not carried over to the new key');
  assert(global.localStorage.getItem(oldKey),
      'the old autosave was removed, so going back to an older build loses it');
});

test('a new autosave wins over an old one', async () => {
  global.localStorage.setItem('sms-game-maker:project',
      JSON.stringify({...p(), name: 'Stale'}));
  global.localStorage.setItem('sms-game-designer:project',
      JSON.stringify({...p(), name: 'Current'}));
  const fresh = await import(`../src/hooks/project.js?both=${Date.now()}`);
  assert(fresh.project.value.name === 'Current',
      `opened "${fresh.project.value.name}"; an old copy overrode newer work`);
});

test('project files from before the rename still open', () => {
  assert(store.LEGACY_PROJECT_EXTS.includes('.smsgm'),
      'the old .smsgm extension is no longer recognised');
  assert(store.PROJECT_EXT === '.smsgd', `projects save as ${store.PROJECT_EXT}`);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
