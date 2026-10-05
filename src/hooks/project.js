/**
 * Project state.
 *
 * One versioned JSON document holds everything - logic, art, maps, rooms,
 * globals. `vcs-game-maker` keeps a dozen independent localStorage keys, one
 * per editor tab, which is fine when the tabs are fixed (player0, player1,
 * playfield) and stops working the moment the user can create an unbounded
 * number of actor types. One document also makes migration a single function
 * instead of twelve, and makes "download my project" a one-liner.
 */

import {ref, computed, watch} from '@vue/composition-api';
// file-saver is CommonJS, and a named import of a CJS module resolves under
// webpack but not under plain Node. Taking the default and destructuring
// works under both, which is what lets this module - and the project
// mutations in it - be tested outside a browser build.
import FileSaver from 'file-saver';

const {saveAs} = FileSaver;
import JSZip from 'jszip';

import {
  migrate, emptyProject, newActor, newRoom, newAnimation, emptyScript,
  SCHEMA_VERSION, TARGETS,
} from '../ir/schema.js';

const STORAGE_KEY = 'sms-game-designer:project';

// The tool was renamed from "SMS Game Maker", because a different tool
// already had that name. Autosaves written before the rename live under the
// old key; without reading it, the first launch after the rename would open
// an empty project and look exactly as though the work had been lost.
const LEGACY_STORAGE_KEYS = ['sms-game-maker:project'];

/** Project file extension, and the one used before the rename. */
export const PROJECT_EXT = '.smsgd';
export const LEGACY_PROJECT_EXTS = ['.smsgm'];
const AUTOSAVE_MS = 1200;

export const project = ref(load());
export const dirty = ref(false);
export const selectedActor = ref(null);
export const selectedRoom = ref(null);

function load() {
  try {
    let raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      // First launch since the rename: carry the old autosave across. It is
      // copied, not moved, so going back to an older build still finds it.
      for (const key of LEGACY_STORAGE_KEYS) {
        raw = localStorage.getItem(key);
        if (raw) {
          localStorage.setItem(STORAGE_KEY, raw);
          break;
        }
      }
    }
    if (raw) return migrate(JSON.parse(raw));
  } catch (e) {
    // A corrupt autosave should not mean a blank screen with no explanation.
    console.warn('Could not restore the last project; starting a new one.', e);
  }
  return emptyProject('My Game');
}

let saveTimer = null;
watch(project, () => {
  dirty.value = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, AUTOSAVE_MS);
}, {deep: true});

export function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(project.value));
    dirty.value = false;
  } catch (e) {
    // Quota is the realistic failure here, and it is worth being honest
    // about rather than silently losing work.
    console.error('Autosave failed', e);
  }
}

export function newProject(name = 'My Game') {
  project.value = emptyProject(name);
  selectedActor.value = null;
  selectedRoom.value = project.value.rooms[0]?.id || null;
  save();
}

/* ---- actors --------------------------------------------------------- */

export function addActor(name) {
  const p = project.value;
  const actor = newActor(name || `Actor ${p.actors.length + 1}`);
  actor.id = uniqueId('actor', p.actors);
  // The first actor a user creates is almost always the player, and having
  // to discover the flag afterwards is a small papercut with a large effect:
  // half the Sensing palette does nothing until something is the player.
  if (!p.actors.some((a) => a.isPlayer)) {
    actor.isPlayer = true;
    actor.group = 'player';
    actor.max = 1;
  }
  p.actors.push(actor);
  selectedActor.value = actor.id;
  return actor;
}

export function removeActor(id) {
  const p = project.value;
  p.actors = p.actors.filter((a) => a.id !== id);
  // Placements and Shoot behaviours that pointed at it would otherwise
  // become dangling references that only surface as a lint error later.
  p.rooms.forEach((r) => {
    r.placements = (r.placements || []).filter((pl) => pl.actor !== id);
  });
  p.actors.forEach((a) => {
    a.behaviours = (a.behaviours || []).filter((b) => b.actor !== id);
  });
  if (selectedActor.value === id) selectedActor.value = p.actors[0]?.id || null;
}

export function setPlayer(id) {
  // Exactly one type can be the player; the kernel caches its slot.
  project.value.actors.forEach((a) => {
    a.isPlayer = a.id === id;
  });
}

export function addAnimation(actor, name) {
  const anim = newAnimation(name || `anim${actor.animations.length}`);
  anim.frames = [blankFrameFor(actor)];
  actor.animations.push(anim);
  return anim;
}

export function addFrame(actor, anim) {
  // Duplicating the last frame rather than adding a blank one: people draw
  // animations by nudging, not by starting over.
  const last = anim.frames[anim.frames.length - 1];
  anim.frames.push(last ?
    {pixels: last.pixels.map((row) => [...row])} :
    blankFrameFor(actor));
}

function blankFrameFor(actor) {
  return {
    pixels: Array.from({length: actor.height || 16},
        () => new Array(actor.width || 16).fill(0)),
  };
}

/**
 * Field slots are a shared, project-wide budget that each type names
 * independently. Surfacing "2 of 4 used" is much kinder than letting someone
 * declare twelve variables and find out at compile time.
 */
export function addField(actor, name) {
  const target = TARGETS[project.value.target];
  const used = (actor.fields || []).reduce((n, f) => n + (f.width === 16 ? 2 : 1), 0);
  if (used >= target.userFields) return null;
  const field = {name: name || `field${actor.fields.length}`, width: 8, initial: 0};
  actor.fields.push(field);
  return field;
}

export const fieldBudget = computed(() => {
  const target = TARGETS[project.value.target];
  const actor = currentActor.value;
  const used = actor ?
    (actor.fields || []).reduce((n, f) => n + (f.width === 16 ? 2 : 1), 0) :
    0;
  return {used, total: target.userFields};
});

/* ---- scripts --------------------------------------------------------- */

export function scriptFor(owner, event) {
  if (!owner.scripts) owner.scripts = {};
  if (!owner.scripts[event]) owner.scripts[event] = emptyScript();
  return owner.scripts[event];
}

export function removeScript(owner, event) {
  if (owner.scripts) delete owner.scripts[event];
}

/* ---- tiles ----------------------------------------------------------- */

/**
 * Add a tile, copying an existing one when given - people draw tiles the way
 * they draw animation frames, by nudging the last one. Returns its index.
 */
export function addTile(copyFrom = null) {
  const tiles = project.value.tiles;
  const src = copyFrom == null ? null : tiles[copyFrom];
  tiles.push({
    name: src ? `${src.name} copy` : `tile ${tiles.length}`,
    // Tile 0 is the empty cell, so a copy of it should not inherit "empty".
    attr: src && copyFrom !== 0 ? src.attr : 0,
    pixels: src ?
      src.pixels.map((row) => [...row]) :
      Array.from({length: 8}, () => new Array(8).fill(0)),
  });
  return tiles.length - 1;
}

/**
 * Delete a tile and keep every room pointing at the right art.
 *
 * Rooms store tile *indices*, so removing tile 3 silently turns every 4 into
 * a 3, every 5 into a 4, and so on - the whole map shifts to the wrong
 * graphics. Cells that used the deleted tile become empty; cells after it
 * move down by one. Tile 0 is the empty cell and cannot be deleted.
 */
export function removeTile(index) {
  const tiles = project.value.tiles;
  if (index <= 0 || index >= tiles.length) return false;
  tiles.splice(index, 1);
  project.value.rooms.forEach((room) => {
    if (!room.tiles) return;
    room.tiles.forEach((row, y) => row.forEach((t, x) => {
      if (t === index) row.splice(x, 1, 0);
      else if (t > index) row.splice(x, 1, t - 1);
    }));
  });
  return true;
}

/* ---- rooms ----------------------------------------------------------- */

export function addRoom(name) {
  const p = project.value;
  const room = newRoom(name || `Room ${p.rooms.length + 1}`);
  room.id = uniqueId('room', p.rooms);
  p.rooms.push(room);
  selectedRoom.value = room.id;
  return room;
}

export function removeRoom(id) {
  const p = project.value;
  if (p.rooms.length <= 1) return;
  p.rooms = p.rooms.filter((r) => r.id !== id);
  if (selectedRoom.value === id) selectedRoom.value = p.rooms[0].id;
}

/* ---- selection ------------------------------------------------------- */

export const currentActor = computed(() =>
  project.value.actors.find((a) => a.id === selectedActor.value) || null);

export const currentRoom = computed(() =>
  project.value.rooms.find((r) => r.id === selectedRoom.value) ||
  project.value.rooms[0] || null);

/* ---- import and export ----------------------------------------------- */

export async function exportProject() {
  const zip = new JSZip();
  zip.file('project.json', JSON.stringify(project.value, null, 2));
  const blob = await zip.generateAsync({type: 'blob'});
  saveAs(blob, `${safeName(project.value.name)}${PROJECT_EXT}`);
}

/**
 * Replace the current project with one supplied as data - an example from
 * the Open menu, say. Goes through the same migration as everything else,
 * so an example written for an older schema still opens.
 */
export function openProject(data) {
  project.value = migrate(JSON.parse(JSON.stringify(data)));
  selectedActor.value = project.value.actors[0]?.id || null;
  selectedRoom.value = project.value.rooms[0]?.id || null;
  save();
}

export async function importProject(file) {
  const zip = await JSZip.loadAsync(file);
  const entry = zip.file('project.json');
  if (!entry) throw new Error('That file does not contain a project.');
  const data = JSON.parse(await entry.async('string'));
  project.value = migrate(data);
  selectedActor.value = project.value.actors[0]?.id || null;
  selectedRoom.value = project.value.rooms[0]?.id || null;
  save();
}

/**
 * The eject button: a readable, commented .bas plus the engine, so it builds
 * standalone with cvbasic and gasm80. This is the answer to every "can it
 * also do X" - a user who outgrows blocks gets real source rather than being
 * stuck.
 */
export async function exportSource(source, engine) {
  const zip = new JSZip();
  const name = safeName(project.value.name);
  zip.file(`${name}.bas`, source);
  const dir = zip.folder('engine');
  Object.keys(engine).forEach((f) => dir.file(f, engine[f]));
  zip.file('README.txt',
      `Built with SMS Game Designer (schema v${SCHEMA_VERSION}).\n\n` +
    `  cvbasic --sms ${name}.bas ${name}.asm\n` +
    `  gasm80 ${name}.asm -o ${name}.sms -sms\n\n` +
    `The engine/ directory must sit alongside the .bas file.\n`);
  saveAs(await zip.generateAsync({type: 'blob'}), `${name}-source.zip`);
}

export function exportRom(rom) {
  const ext = TARGETS[project.value.target].romExt;
  saveAs(new Blob([rom], {type: 'application/octet-stream'}),
      `${safeName(project.value.name)}.${ext}`);
}

function uniqueId(prefix, list) {
  let n = list.length + 1;
  const taken = new Set(list.map((x) => x.id));
  while (taken.has(`${prefix}_${n}`)) n++;
  return `${prefix}_${n}`;
}

function safeName(s) {
  return String(s || 'game').replace(/[^\w-]+/g, '_').replace(/^_+|_+$/g, '') || 'game';
}
