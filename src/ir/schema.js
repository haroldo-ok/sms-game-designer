/**
 * Project schema, target profiles and migration.
 *
 * The project is one versioned JSON document holding everything: actor
 * types, rooms, art, globals and scripts. `vcs-game-maker` spreads the same
 * information across a dozen independent localStorage keys, one per editor
 * tab, which works when the tabs are fixed (player0, player1, playfield) and
 * stops working the moment the user can create an unbounded number of actor
 * types. One document also makes migration a single function instead of
 * twelve.
 */

export const SCHEMA_VERSION = 3;

/**
 * Per-target profiles.
 *
 * These are the numbers every budget in the editor is measured against.
 * `ram` comes from CVBasic itself, which prints "N RAM bytes used of M bytes
 * available" on every compile - so the budget meter can check its own
 * arithmetic against the compiler rather than trusting this table.
 */
export const TARGETS = {
  sms: {
    id: 'sms',
    // Whether in-editor play is bundled for this console (public/emulator).
    bundledEmulator: true,
    // Largest cartridge the generator will produce without bank switching.
    // gasm80 rounds the image up to a power of two, so a build can quietly
    // grow from 8K to 16K; what it cannot do is exceed this.
    romBudget: 32768,
    label: 'Sega Master System',
    cvbasicFlag: '--sms',
    romExt: 'sms',
    // Which renderer the engine includes, and which asset format the
    // generator writes. 'sms' is Mode 4: 8x16 sprites, per-pixel colour from
    // a palette. 'tms' is the TMS9918 in Graphics II: 16x16 sprites, one
    // colour each, one-bit-per-pixel art.
    video: 'sms',
    emulatorCore: 'segaMS',
    ram: 7966,
    hardwareSprites: 64,
    spritesPerLine: 8,
    // An SMS hardware sprite is 8x16. A 16x16 actor therefore costs two of
    // them, which is why `hardwareSprites` alone never answers "does this
    // room fit".
    spriteWidth: 8,
    spriteHeight: 16,
    screenCols: 32,
    // The name table is 32x28 so the VDP can scroll vertically, but only 24
    // rows are displayed in 192-line mode. Rooms are authored at the visible
    // size: a tile the player can never see is a trap, not a feature.
    screenRows: 24,
    // In MODE 4 the CVBasic prologue puts background bitmaps at $0000-$1fff
    // (256 tiles of 32 bytes) and sprite bitmaps at $2000-$37ff. Sprite
    // definition n lives at $2000 + n*64, so definition 96 would collide
    // with the name table at $3800: 96 is the real 8x16 sprite budget, not
    // the 128 that DEFINE SPRITE will accept without complaint.
    spriteDefBudget: 96,
    bgTileBudget: 256,
    // The pool arrays the kernel declares. Present on SMS; the smaller
    // machines drop some of these (see below).
    // One core.bas serves every target, so every target allocates the same
    // seventeen arrays. `subpixel` and `userFields` below describe what the
    // generator will *use*, not what it reserves - a smaller machine saves
    // its RAM by having fewer slots, not by having narrower ones.
    poolArrays: ['type', 'x', 'y', 'xf', 'yf', 'vx', 'vy', 'anim', 'frame',
      'atimer', 'timer', 'flags', 'sprf', 'f0', 'f1', 'f2', 'f3'],
    userFields: 4,
    subpixel: true,
    terrainShadow: true,
    maxSlots: 40,
    perPixelSpriteColour: true,
    paletteSize: 16,
  },
  sg1000: {
    id: 'sg1000',
    // Whether in-editor play is bundled for this console (public/emulator).
    bundledEmulator: true,
    // Largest cartridge the generator will produce without bank switching.
    // gasm80 rounds the image up to a power of two, so a build can quietly
    // grow from 8K to 16K; what it cannot do is exceed this.
    romBudget: 32768,
    video: 'tms',
    label: 'Sega SG-1000',
    cvbasicFlag: '--sg1000',
    romExt: 'sg',
    emulatorCore: 'segaMS',
    ram: 814,
    hardwareSprites: 32,
    spritesPerLine: 4,
    spriteWidth: 16,
    spriteHeight: 16,
    screenCols: 32,
    screenRows: 24,
    spriteDefBudget: 64,
    bgTileBudget: 256,
    // 814 bytes is the whole budget, so the Coleco-class profile drops the
    // optional arrays rather than shrinking the pool to uselessness:
    // subpixel movement becomes "move every N frames" and the user field
    // budget halves. Codegen knows which arrays exist and refuses, with a
    // clear editor message, any project that needs a missing one.
    poolArrays: ['type', 'x', 'y', 'xf', 'yf', 'vx', 'vy', 'anim', 'frame',
      'atimer', 'timer', 'flags', 'sprf', 'f0', 'f1', 'f2', 'f3'],
    userFields: 2,
    subpixel: false,
    terrainShadow: false,
    maxSlots: 14,
    perPixelSpriteColour: false,
    paletteSize: 15,
  },
  coleco: {
    id: 'coleco',
    // Whether in-editor play is bundled for this console (public/emulator).
    bundledEmulator: false,
    // Largest cartridge the generator will produce without bank switching.
    // gasm80 rounds the image up to a power of two, so a build can quietly
    // grow from 8K to 16K; what it cannot do is exceed this.
    romBudget: 32768,
    video: 'tms',
    label: 'ColecoVision',
    cvbasicFlag: '',
    romExt: 'rom',
    emulatorCore: 'coleco',
    ram: 814,
    hardwareSprites: 32,
    spritesPerLine: 4,
    spriteWidth: 16,
    spriteHeight: 16,
    screenCols: 32,
    screenRows: 24,
    spriteDefBudget: 64,
    bgTileBudget: 256,
    poolArrays: ['type', 'x', 'y', 'xf', 'yf', 'vx', 'vy', 'anim', 'frame',
      'atimer', 'timer', 'flags', 'sprf', 'f0', 'f1', 'f2', 'f3'],
    userFields: 2,
    subpixel: false,
    terrainShadow: false,
    maxSlots: 14,
    perPixelSpriteColour: false,
    paletteSize: 15,
    // The only target that needs a BIOS image in the browser, which is why
    // it is a secondary export and not the default.
    needsBios: true,
  },
  msx: {
    id: 'msx',
    // Whether in-editor play is bundled for this console (public/emulator).
    bundledEmulator: false,
    // Largest cartridge the generator will produce without bank switching.
    // gasm80 rounds the image up to a power of two, so a build can quietly
    // grow from 8K to 16K; what it cannot do is exceed this.
    romBudget: 32768,
    video: 'tms',
    label: 'MSX',
    cvbasicFlag: '--msx',
    romExt: 'rom',
    emulatorCore: 'msx',
    ram: 4782,
    hardwareSprites: 32,
    spritesPerLine: 4,
    spriteWidth: 16,
    spriteHeight: 16,
    screenCols: 32,
    screenRows: 24,
    spriteDefBudget: 64,
    bgTileBudget: 256,
    poolArrays: ['type', 'x', 'y', 'xf', 'yf', 'vx', 'vy', 'anim', 'frame',
      'atimer', 'timer', 'flags', 'sprf', 'f0', 'f1', 'f2', 'f3'],
    userFields: 2,
    subpixel: true,
    terrainShadow: false,
    maxSlots: 32,
    perPixelSpriteColour: false,
    paletteSize: 15,
  },
};

export const DEFAULT_TARGET = 'sms';

/** The collision groups the toolbox offers. Order fixes the matrix order. */
export const GROUPS = ['player', 'player_shot', 'enemy', 'enemy_shot',
  'pickup', 'hazard', 'neutral'];

/** Actor sizes the sprite editor can snap to, as [width, height] in pixels. */
export const ACTOR_SIZES = [[8, 16], [16, 16]];

/** The events a script can be attached to. */
export const EVENTS = [
  {id: 'create', label: 'on create', other: false},
  {id: 'update', label: 'on update', other: false},
  {id: 'collide', label: 'on collide with', other: true, perGroup: true},
  {id: 'destroy', label: 'on destroy', other: false},
  {id: 'animend', label: 'on animation end', other: false},
  {id: 'leave', label: 'on leave screen', other: false},
  {id: 'timer', label: 'on timer', other: false},
];

export function emptyProject(name = 'Untitled') {
  return {
    schemaVersion: SCHEMA_VERSION,
    name,
    target: DEFAULT_TARGET,
    meta: {author: '', description: ''},
    globals: [
      {name: 'score', width: 16, initial: 0},
      {name: 'lives', width: 8, initial: 3},
    ],
    palette: defaultPalette(),
    actors: [],
    rooms: [newRoom('Level 1')],
    // The global scripts. These live outside any actor, so their toolbox has
    // no `me` and no `other` - blocks that need an instance simply do not
    // exist there, which removes a whole class of confusing errors rather
    // than diagnosing them after the fact.
    scripts: {
      gameStart: emptyScript(),
      frame: emptyScript(),
    },
    tiles: starterTiles(),
    sounds: [],
    music: [],
  };
}

export function newActor(name = 'Actor') {
  return {
    id: null,
    name,
    group: 'enemy',
    max: 4,
    width: 16,
    height: 16,
    hitbox: {w: 12, h: 12, ox: 2, oy: 2},
    isPlayer: false,
    reuseOldest: false,
    fields: [],
    animations: [newAnimation('idle')],
    behaviours: [],
    scripts: {},
  };
}

export function newAnimation(name = 'idle') {
  return {name, rate: 8, loop: true, frames: [blankFrame(16, 16)]};
}

export function blankFrame(w, h) {
  return {pixels: Array.from({length: h}, () => new Array(w).fill(0))};
}

/**
 * The tiles every new project starts with.
 *
 * There was no tile editor at all until this existed, and a new project had
 * an empty tile set - so "Paint tiles" painted references to tile 1, which
 * did not exist. A starter set means painting works the first time someone
 * tries it, and each one demonstrates an attribute: solid ground, a hazard,
 * and plain scenery.
 *
 * Tile 0 is special: it is what every unpainted cell holds, so it has to be
 * empty and walk-through. The editor will not delete it or make it solid.
 * Colours are indices into the background palette.
 */
export function starterTiles() {
  const t = (name, attr, fn) => ({
    name, attr,
    pixels: Array.from({length: 8}, (_, y) =>
      Array.from({length: 8}, (_, x) => fn(x, y) | 0)),
  });
  return [
    t('empty', 0, () => 0),
    // Running bond: mortar every fourth row, joints offset each course.
    t('brick', ATTR.solid, (x, y) => {
      if (y % 4 === 3) return 9;
      if ((y < 4 && x === 7) || (y >= 4 && x === 3)) return 9;
      return 2;
    }),
    // Lit from the top left, so it reads as a raised block.
    t('stone', ATTR.solid, (x, y) => {
      if (x === 0 || y === 0) return 9;
      if (x === 7 || y === 7) return 14;
      return (x * 3 + y * 5) % 7 ? 8 : 14;
    }),
    t('grass', ATTR.solid, (x, y) => {
      if (y === 0) return (x % 3) ? 11 : 0;
      if (y === 1) return 11;
      return (x + y) % 4 ? 10 : 2;
    }),
    // Solid as well as hazardous: "tile below me is a hazard" probes the
    // cell under the actor's feet, which only stays there if it can stand
    // on it. A non-solid hazard is one you fall straight through.
    t('spikes', ATTR.solid | ATTR.hazard, (x, y) => {
      const peak = Math.abs((x % 4) - 1.5);
      if (y >= 6) return 8;
      return y >= 2 + peak * 2 ? 1 : 0;
    }),
    t('sky', 0, (x, y) => ((x * 7 + y * 3) % 23 === 0 ? 1 : 0)),
  ];
}

/** Tile attribute bits, matching ATTR_* in engine/core.bas. */
export const ATTR = {solid: 1, hazard: 2, ladder: 4, breakable: 8, platform: 16};

export function newRoom(name = 'Room') {
  return {
    id: null,
    name,
    music: null,
    bgPalette: 0,
    // 32 x 28 of tile indices; 0 means "empty".
    tiles: null,
    placements: [],
    scripts: {enter: emptyScript()},
    onExit: null,
  };
}

export function emptyScript() {
  // A script is stored as Blockly XML plus the lowered statement list. The
  // XML is what the editor reloads; the statements are what codegen reads.
  // Keeping both means the Node-side build tool never has to instantiate
  // Blockly, which is what makes IR -> text unit-testable with no browser.
  return {xml: '', stmts: []};
}

function defaultPalette() {
  // SMS colours are 6-bit 00BBGGRR. Entry 0 of the sprite palette is
  // transparent and is never drawn.
  return {
    background: [0x00, 0x3f, 0x02, 0x0a, 0x28, 0x20, 0x0f, 0x3c,
      0x15, 0x2a, 0x05, 0x0c, 0x30, 0x33, 0x24, 0x38],
    sprite: [0x00, 0x3f, 0x03, 0x0f, 0x30, 0x0c, 0x3c, 0x33,
      0x15, 0x2a, 0x05, 0x2c, 0x38, 0x23, 0x1f, 0x10],
  };
}

/**
 * Migration. The actor schema will change; this is the single place that
 * knows how. Run on every load, including autosave restores.
 */
export function migrate(project) {
  if (!project || typeof project !== 'object') return emptyProject();
  let p = JSON.parse(JSON.stringify(project));
  const from = p.schemaVersion || 1;

  if (from < 2) {
    // v1 stored one flat `maxInstances` on the project and let every actor
    // share it. v2 moved the budget onto the actor, because "how many of
    // these can exist" is a per-type design decision the user needs to see
    // next to the type.
    (p.actors || []).forEach((a) => {
      if (a.max == null) a.max = p.maxInstances || 4;
    });
    delete p.maxInstances;
  }

  if (from < 3) {
    // v2 had a single `frames` list per actor with no animation grouping,
    // so "play animation" had nothing to name.
    (p.actors || []).forEach((a) => {
      if (!a.animations && a.frames) {
        a.animations = [{name: 'idle', rate: 8, loop: true, frames: a.frames}];
        delete a.frames;
      }
      if (!a.scripts) a.scripts = {};
      if (!a.behaviours) a.behaviours = [];
      if (!a.fields) a.fields = [];
      if (!a.hitbox) {
        a.hitbox = {w: a.width || 16, h: a.height || 16, ox: 0, oy: 0};
      }
    });
  }

  // A project saved before the tile editor existed has an empty tile set,
  // and any cell it painted points at a tile that was never defined. The
  // starter set fills that in: those cells become bricks rather than garbage.
  if (!Array.isArray(p.tiles) || !p.tiles.length) p.tiles = starterTiles();

  const base = emptyProject(p.name || 'Untitled');
  p = {...base, ...p, schemaVersion: SCHEMA_VERSION};
  p.meta = {...base.meta, ...(p.meta || {})};
  p.scripts = {...base.scripts, ...(p.scripts || {})};
  p.palette = {...base.palette, ...(p.palette || {})};
  assignIds(p);
  return p;
}

/** Ids are positional and stable within a session; assign any that are null. */
function assignIds(p) {
  let n = 1;
  (p.actors || []).forEach((a) => {
    if (!a.id) a.id = `actor_${n}`;
    n++;
  });
  let r = 1;
  (p.rooms || []).forEach((room) => {
    if (!room.id) room.id = `room_${r}`;
    r++;
  });
}

export function targetProfile(project) {
  return TARGETS[project.target] || TARGETS[DEFAULT_TARGET];
}
