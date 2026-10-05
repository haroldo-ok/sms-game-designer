/**
 * Project model -> intermediate representation.
 *
 * This is where the program stops being a pile of editor state and becomes
 * one object you can allocate resources over. Four things can only be
 * decided globally, and this is the only place they are decided:
 *
 *   1. Slot allocation. Each actor type owns a contiguous index range in the
 *      entity pool, sized by its Max instances. Spawning is then a short
 *      scan of one range, collision loops have compile-time constant bounds,
 *      and dispatch needs no indirection because every slot in a range has
 *      the same type.
 *   2. The collision matrix. Derived from which types declare `on collide
 *      with <group>` handlers, so the user never enumerates pairs.
 *   3. Sprite definition numbers. Every animation frame of every actor gets
 *      a fixed definition index, computed once here.
 *   4. RAM layout. Pool size, map shadow size, globals.
 *
 * Nothing in this file touches Blockly or the DOM, so the whole code
 * generator is testable in Node.
 */

import {targetProfile, GROUPS} from './schema.js';

/** Reserved CVBasic / kernel identifiers that user names must not collide with. */
const RESERVED = new Set([
  'self', 'other', 'hw', 'frame', 'rand', 'random', 'pos', 'vdp', 'music',
  'e_type', 'e_x', 'e_y', 'e_xf', 'e_yf', 'e_vx', 'e_vy', 'e_anim',
  'e_frame', 'e_atimer', 'e_timer', 'e_flags', 'e_f0', 'e_f1', 'e_f2', 'e_f3',
  'map_attr', 'sp_x', 'sp_y', 'sp_slot', 'sp_i', 'ca', 'cb', 'cax', 'cay',
  'ct', 'k_i', 'k_n', 'k_a', 'k_f', 'k_x', 'k_y', 'k_t', 'k_rot', 'k_drop',
  'k_s0', 'k_s1', 'k_s2', 'k_s3', 'k_cell', 'k_px', 'k_py',
  'a_fbase', 'a_fstep', 'a_wide', 'a_len', 'a_rate', 'a_loop',
]);

export function buildIR(project) {
  return buildIRInner(project, targetProfile(project), []);
}

function buildIRInner(project, target, diagnostics) {
  const actors = (project.actors || []).filter((a) => (a.max | 0) > 0 || a.isPlayer);

  // ---- 1. slot ranges -------------------------------------------------
  // Contiguous per type, in declaration order. The player type is forced to
  // the front so the kernel can cache its slot as a constant rather than
  // searching for it: "the player" is by far the most common cross-instance
  // reference and this makes it free.
  const ordered = [...actors].sort((a, b) => (b.isPlayer ? 1 : 0) - (a.isPlayer ? 1 : 0));

  let slot = 0;
  const types = ordered.map((actor, i) => {
    const max = Math.max(1, actor.max | 0);
    const first = slot;
    slot += max;
    return {
      key: actor.id,
      name: actor.name,
      symbol: symbolise(actor.name, `type${i}`),
      typeId: i + 1, // 0 means "free slot", so ids start at 1
      group: GROUPS.includes(actor.group) ? actor.group : 'neutral',
      max,
      first,
      last: slot - 1,
      width: actor.width || 16,
      height: actor.height || 16,
      hitbox: normaliseHitbox(actor),
      isPlayer: !!actor.isPlayer,
      reuseOldest: !!actor.reuseOldest,
      fields: [],
      // Whole-pixel movement unless something genuinely needs a fraction.
      // See k_move_int in engine/kernel.bas: the subpixel path costs about
      // four times as much, and most actors never use it.
      subpixel: needsSubpixel(actor) && target.subpixel,
      // A script that sets velocity needs something to apply it every frame.
      // Movement used to happen only inside the movement behaviours, so an
      // actor with none never moved at all: "set my speed" compiled, set a
      // byte, and did nothing. Decided after `subpixel`, below.
      scriptVelocity: scriptsSetVelocity(actor),
      behaviours: actor.behaviours || [],
      scripts: actor.scripts || {},
      animations: [],
      source: actor,
    };
  });

  // Does anything already apply this type's velocity every frame? If not,
  // and a script sets one, the behaviour procedure has to call the mover
  // itself. The whole-pixel Move behaviour inlines its own adds and never
  // reads the velocity bytes, so it does not count.
  types.forEach((t) => {
    const moves = (t.behaviours || []).some((b) =>
      ['chase', 'patrol', 'platform'].includes(b.kind) ||
      (b.kind === 'move' && t.subpixel));
    t.needsMover = t.scriptVelocity && !moves;
  });

  const maxEnt = Math.max(1, slot);
  if (maxEnt > target.maxSlots) {
    diagnostics.push({
      severity: 'error',
      code: 'pool-overflow',
      message: `${maxEnt} slots used of ${target.maxSlots} available on ` +
        `${target.label}. Lower some actors' Max instances.`,
    });
  }

  // ---- 2. user fields -------------------------------------------------
  // Each type names the shared per-instance field slots independently:
  // Bug's field0 might be `hp` while Pickup's field0 is `value`. The budget
  // is project-wide and small on purpose - it is a 1985 console, and an
  // explicit "2 of 4 used" is much kinder than letting a user declare twelve
  // variables and discover at compile time that the game does not fit.
  types.forEach((t) => {
    const declared = (t.source.fields || []);
    let index = 0;
    declared.forEach((f) => {
      const width = f.width === 16 ? 16 : 8;
      const cost = width === 16 ? 2 : 1;
      if (index + cost > target.userFields) {
        diagnostics.push({
          severity: 'error',
          code: 'field-budget',
          actor: t.key,
          message: `${t.name} uses more than ${target.userFields} field ` +
            `slots (a 16-bit field costs two).`,
        });
        return;
      }
      t.fields.push({
        name: f.name,
        symbol: `e_f${index}`,
        index,
        width,
        initial: f.initial | 0,
      });
      index += cost;
    });
  });

  // ---- 3. animations and sprite definitions ---------------------------
  // Sprite definitions are allocated globally and sequentially. On the SMS a
  // hardware sprite is 8x16, so a 16-wide actor costs two definitions per
  // animation frame; the SPRITE statement's `f` argument counts 8x8 blocks,
  // hence the *2. All of this arithmetic lives here and in the kernel, never
  // in generated user code.
  // On the SMS a definition is an 8x16 sprite and the frame number counts
  // 8x8 blocks, so a 16-wide actor is two definitions and the step is 2 per
  // definition. On a TMS9918 a definition is a whole 16x16 sprite and the
  // frame number counts in fours. The renderer never has to know.
  const tms = target.video === 'tms';
  const anims = [];
  let nextDef = 0;
  types.forEach((t) => {
    const wide = t.width >= 16 ? 1 : 0;
    const defsPerFrame = tms ? 1 : (wide ? 2 : 1);
    (t.source.animations || []).forEach((anim, ai) => {
      const frames = anim.frames || [];
      const count = Math.max(1, frames.length);
      const firstDef = nextDef;
      nextDef += count * defsPerFrame;
      const id = anims.length;
      anims.push({
        id,
        symbol: `${t.symbol}_${symbolise(anim.name, `anim${ai}`)}`,
        owner: t.key,
        name: anim.name,
        wide,
        fbase: firstDef * (tms ? 4 : 2),
        fstep: defsPerFrame * (tms ? 4 : 2),
        colour: dominantColour(frames, project.palette),
        len: count,
        rate: clamp(anim.rate == null ? 8 : anim.rate, 1, 255),
        loop: anim.loop === false ? 0 : 1,
        firstDef,
        defCount: count * defsPerFrame,
        frames,
        width: t.width,
        height: t.height,
      });
      t.animations.push(id);
    });
    if (!t.animations.length) {
      // Every type needs at least one animation, because e_anim indexes the
      // render tables unconditionally.
      const id = anims.length;
      anims.push({
        id, symbol: `${t.symbol}_blank`, owner: t.key, name: 'idle',
        wide, fbase: nextDef * (tms ? 4 : 2), fstep: defsPerFrame * (tms ? 4 : 2),
        colour: 15, len: 1, rate: 8,
        loop: 1, firstDef: nextDef, defCount: defsPerFrame,
        frames: [blank(t.width, t.height)], width: t.width, height: t.height,
      });
      nextDef += defsPerFrame;
      t.animations.push(id);
    }
  });

  if (nextDef > target.spriteDefBudget) {
    diagnostics.push({
      severity: 'error',
      code: 'vram-overflow',
      message: `Sprite art needs ${nextDef} definitions; the ` +
        `${target.label} budget is ${target.spriteDefBudget}. Remove ` +
        `animation frames or share animations between actors.`,
    });
  }

  // ---- 4. collision matrix --------------------------------------------
  // A pair is enabled when at least one side declares a handler for the
  // other's group. Codegen emits one specialised procedure per enabled
  // pair - four of them in the worked shmup, not the 300 a named-object
  // model would need.
  const byGroup = {};
  types.forEach((t) => {
    (byGroup[t.group] = byGroup[t.group] || []).push(t);
  });

  // Group indices, used by the kernel's per-group population counts. Ordered
  // by the canonical group list so the index is stable as actors come and go.
  const usedGroups = GROUPS.filter((g) => byGroup[g]);
  types.forEach((t) => {
    t.groupIndex = usedGroups.indexOf(t.group);
  });

  const pairs = [];
  const seen = new Set();
  types.forEach((t) => {
    Object.keys(t.scripts || {}).forEach((key) => {
      if (!key.startsWith('collide:')) return;
      const otherGroup = key.slice('collide:'.length);
      if (!byGroup[otherGroup]) {
        diagnostics.push({
          severity: 'warning',
          code: 'empty-group',
          actor: t.key,
          message: `${t.name} handles collisions with "${otherGroup}", but ` +
            `no actor is in that group.`,
        });
        return;
      }
      const a = t.group;
      const b = otherGroup;
      const id = a <= b ? `${a}|${b}` : `${b}|${a}`;
      if (seen.has(id)) return;
      seen.add(id);
      pairs.push({
        id,
        symbol: `col_${a}_${b}`,
        groupA: a <= b ? a : b,
        groupB: a <= b ? b : a,
      });
    });
  });

  // Expand each group pair into the concrete type-range pairs it covers, and
  // note which side has a handler. Skipping a side with no handler halves
  // the work for the very common "bullet hits enemy, enemy reacts" case.
  pairs.forEach((p) => {
    p.ranges = [];
    (byGroup[p.groupA] || []).forEach((ta) => {
      (byGroup[p.groupB] || []).forEach((tb) => {
        if (ta.key === tb.key && p.groupA === p.groupB) return;
        const aHandler = ta.scripts[`collide:${p.groupB}`] ? handlerName(ta, p.groupB) : null;
        const bHandler = tb.scripts[`collide:${p.groupA}`] ? handlerName(tb, p.groupA) : null;
        if (!aHandler && !bHandler) return;
        p.ranges.push({
          a: ta, b: tb, aHandler, bHandler,
          // Overlap thresholds for the unsigned-wrap AABB test. The test is
          // `(a - b + h) < 2h`, so these are the half-extent sums.
          hx: halfSum(ta.hitbox.w, tb.hitbox.w),
          hy: halfSum(ta.hitbox.h, tb.hitbox.h),
          ax: ta.hitbox.ox, ay: ta.hitbox.oy,
          bx: tb.hitbox.ox, by: tb.hitbox.oy,
          candidates: ta.max * tb.max,
        });
      });
    });
    p.candidates = p.ranges.reduce((n, r) => n + r.candidates, 0);
  });

  // ---- 5. CPU budget advice -------------------------------------------
  // Measured on the generated Z80 (see docs/MEASUREMENTS.md): a two-axis
  // rejected candidate is ~120 cycles, an accepted one a little more. An
  // NTSC frame is ~59,600 cycles, so a 25% collision budget is ~124 tests.
  const totalCandidates = pairs.reduce((n, p) => n + p.candidates, 0);
  pairs.forEach((p) => {
    p.timeSlice = false;
  });
  (project.timeSlicedPairs || []).forEach((id) => {
    const p = pairs.find((x) => x.id === id);
    if (p) p.timeSlice = true;
  });
  const effective = pairs.reduce((n, p) => n + (p.timeSlice ? p.candidates / 2 : p.candidates), 0);
  if (effective > 124) {
    diagnostics.push({
      severity: 'warning',
      code: 'collision-budget',
      message: `About ${Math.round(effective)} collision checks per frame; ` +
        `roughly 124 fit in a quarter of an NTSC frame. Enable half-rate ` +
        `checking on the biggest pair, or lower a Max instances.`,
    });
  }

  // ---- 6. globals ------------------------------------------------------
  // Width is inferred and fixed here, which is what keeps generated code out
  // of CVBasic's `score` vs `#score` trap. The user never sees a `#`.
  const globals = (project.globals || []).map((g) => {
    const width = g.width === 16 || (g.initial | 0) > 255 ? 16 : 8;
    return {
      name: g.name,
      symbol: (width === 16 ? '#' : '') + symbolise(g.name, 'g'),
      width,
      initial: g.initial | 0,
    };
  });

  // ---- 7. rooms --------------------------------------------------------
  const rooms = (project.rooms || []).map((room, i) => {
    const placements = (room.placements || []).map((pl) => {
      const t = types.find((x) => x.key === pl.actor);
      return t ? {type: t, x: pl.x | 0, y: pl.y | 0} : null;
    }).filter(Boolean);

    // A placement consumes one of that type's slots at room start.
    const used = {};
    placements.forEach((pl) => {
      used[pl.type.key] = (used[pl.type.key] || 0) + 1;
    });
    Object.keys(used).forEach((key) => {
      const t = types.find((x) => x.key === key);
      if (used[key] > t.max) {
        diagnostics.push({
          severity: 'error',
          code: 'placement-overflow',
          room: room.id,
          message: `${room.name} places ${used[key]} of ${t.name}, but its ` +
            `Max instances is ${t.max}.`,
        });
      }
    });

    return {
      key: room.id,
      symbol: symbolise(room.name, `room${i}`),
      index: i,
      name: room.name,
      music: room.music,
      tiles: room.tiles,
      hasTerrain: !!room.tiles,
      placements,
      scripts: room.scripts || {},
    };
  });

  const anyTerrain = rooms.some((r) => r.hasTerrain) && target.terrainShadow;

  if ((project.tiles || []).length > 128) {
    diagnostics.push({
      severity: 'error',
      code: 'tile-overflow',
      message: `${project.tiles.length} background tiles; 128 are available ` +
        `above the ASCII charset.`,
    });
  }

  // ---- 8. hardware sprite budget --------------------------------------
  // Worst case: every slot occupied, each costing one or two hardware
  // sprites. This is the number the budget meter shows, and the number that
  // decides whether the renderer ever has to rotate.
  const worstHw = types.reduce((n, t) =>
    n + t.max * (tms ? 1 : (t.width >= 16 ? 2 : 1)), 0);
  if (worstHw > target.hardwareSprites) {
    diagnostics.push({
      severity: 'warning',
      code: 'sprite-budget',
      message: `A full pool needs ${worstHw} hardware sprites; the ` +
        `${target.label} has ${target.hardwareSprites}. Over budget the ` +
        `renderer rotates which actors it drops, so they flicker rather ` +
        `than one vanishing.`,
    });
  }

  return {
    name: project.name,
    target,
    types,
    anims,
    pairs,
    groups: usedGroups,
    byGroup,
    rooms,
    globals,
    palette: project.palette,
    // Only the tunes this project mentions are emitted: an unused tune is a
    // few hundred bytes of a 32 KB cartridge.
    music: collectMusic(project),
    title: project.title || null,
    scripts: project.scripts || {},
    tiles: project.tiles || [],
    layout: {
      maxEnt,
      maxHw: Math.min(target.hardwareSprites, Math.max(1, worstHw)),
      worstHw,
      mapCells: anyTerrain ? target.screenCols * target.screenRows : 1,
      spriteDefs: nextDef,
      // CVBasic defines the ASCII charset at characters 32..127 so PRINT
      // works out of the box. Room tiles therefore start at 128, which
      // leaves the HUD usable and still allows 128 distinct tiles.
      tileBase: 128,
      ramEstimate: estimateRam(target, maxEnt, anyTerrain, globals),
    },
    stats: {totalCandidates, effectiveCandidates: Math.round(effective)},
    player: types.find((t) => t.isPlayer) || null,
    diagnostics,
  };
}

/** Every tune named by a room, the title, or a `play music` block. */
function collectMusic(project) {
  const names = new Set();
  if (project.title && project.title.music) names.add(project.title.music);
  (project.rooms || []).forEach((r) => {
    if (r.music) names.add(r.music);
  });
  const walk = (list) => (list || []).forEach((st) => {
    if (st.op === 'playMusic' && st.music) names.add(st.music);
    walk(st.then);
    walk(st.else);
    walk(st.body);
  });
  Object.values(project.scripts || {}).forEach((sc) => walk(sc && sc.stmts));
  (project.rooms || []).forEach((r) =>
    Object.values(r.scripts || {}).forEach((sc) => walk(sc && sc.stmts)));
  (project.actors || []).forEach((a) =>
    Object.values(a.scripts || {}).forEach((sc) => walk(sc && sc.stmts)));
  return [...names];
}

function estimateRam(target, maxEnt, anyTerrain, globals) {
  const pool = target.poolArrays.length * maxEnt;
  const map = anyTerrain ? target.screenCols * target.screenRows : 1;
  const glob = globals.reduce((n, g) => n + (g.width === 16 ? 2 : 1), 0);
  // ~30 bytes of kernel scratch, measured from a real compile.
  return pool + map + glob + 30;
}

/**
 * Does anything about this actor ask for a fractional pixels-per-frame
 * speed? Gravity always does - a platformer with integer gravity is a
 * platformer that jumps like a lift.
 */
function needsSubpixel(actor) {
  const frac = (v) => Number.isFinite(Number(v)) && Number(v) % 1 !== 0;
  const fromBehaviour = (actor.behaviours || []).some((b) => {
    if (b.kind === 'platform') return true;
    return frac(b.speed) || frac(b.bulletSpeed);
  });
  // A script asking for half a pixel a frame needs the 8.8 mover as much as
  // a behaviour does.
  const fromScript = velocityLiterals(actor).some(frac);
  return fromBehaviour || fromScript;
}

/** Every `set my speed` in any of this actor's scripts. */
function velocityStatements(actor) {
  const found = [];
  const walk = (list) => (list || []).forEach((st) => {
    if (st.op === 'setVel') found.push(st);
    walk(st.then);
    walk(st.else);
    walk(st.body);
  });
  Object.values(actor.scripts || {}).forEach((sc) => walk(sc && sc.stmts));
  return found;
}

function velocityLiterals(actor) {
  const out = [];
  velocityStatements(actor).forEach((st) => [st.vx, st.vy].forEach((v) => {
    if (typeof v === 'number') out.push(v);
    else if (v && v.op === 'num') out.push(v.value);
  }));
  return out;
}

function scriptsSetVelocity(actor) {
  return velocityStatements(actor).length > 0;
}

/**
 * The TMS9918's fixed 16-colour palette, in RGB.
 *
 * Fixed is the operative word: unlike the SMS there is nothing to load, so a
 * pixel index in the project's art means an entry in the *project's* palette
 * and has to be translated, not passed through. Passing it through paints a
 * green enemy blue and a white ship black - which is exactly what happened
 * the first time, and the black ship simply vanished against the backdrop.
 */
const TMS_PALETTE = [
  null, [0, 0, 0], [33, 200, 66], [94, 220, 120],
  [84, 85, 237], [125, 118, 252], [212, 82, 77], [66, 235, 245],
  [252, 85, 84], [255, 121, 120], [212, 193, 84], [230, 206, 128],
  [33, 176, 59], [201, 91, 186], [204, 204, 204], [255, 255, 255],
];

/**
 * The single colour a TMS9918 sprite will be drawn in.
 *
 * These machines give a sprite one colour for all of its pixels, so art that
 * was drawn per-pixel has to collapse to one. The most-used non-transparent
 * index wins - which keeps a two-tone character recognisable, since its
 * outline disappears but its body does not - and that index is then matched
 * to the nearest fixed TMS colour by RGB distance.
 *
 * The sprite editor already shows a monochrome preview on these targets, so
 * the flattening is not a surprise at export time.
 */
function dominantColour(frames, palette) {
  const counts = new Array(16).fill(0);
  (frames || []).forEach((f) => (f.pixels || []).forEach((row) =>
    (row || []).forEach((v) => {
      if (v) counts[v & 15]++;
    })));
  let best = 0;
  let bestN = 0;
  for (let i = 1; i < 16; i++) {
    if (counts[i] > bestN) {
      bestN = counts[i];
      best = i;
    }
  }
  if (!best) return 15;
  return nearestTms(sixBitToRgb((palette && palette.sprite && palette.sprite[best]) | 0));
}

/** SMS colour registers are 00BBGGRR, two bits a channel. */
function sixBitToRgb(v) {
  return [(v & 3) * 85, ((v >> 2) & 3) * 85, ((v >> 4) & 3) * 85];
}

function nearestTms([r, g, b]) {
  let best = 15;
  let bestD = Infinity;
  for (let i = 1; i < 16; i++) {
    const c = TMS_PALETTE[i];
    const d = (c[0] - r) ** 2 + (c[1] - g) ** 2 + (c[2] - b) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

function normaliseHitbox(actor) {
  const w = actor.width || 16;
  const h = actor.height || 16;
  const hb = actor.hitbox || {};
  return {
    w: clamp(hb.w == null ? w : hb.w, 1, 64),
    h: clamp(hb.h == null ? h : hb.h, 1, 64),
    ox: clamp(hb.ox | 0, 0, 63),
    oy: clamp(hb.oy | 0, 0, 63),
  };
}

/** Half-extent sum for the AABB test, clamped so `2*sum` still fits a byte. */
function halfSum(wa, wb) {
  return clamp(Math.floor((wa + wb) / 2), 1, 127);
}

function handlerName(type, group) {
  return `${type.symbol}_hit_${group}`;
}

function blank(w, h) {
  return {pixels: Array.from({length: h}, () => new Array(w).fill(0))};
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v | 0));
}

/**
 * Turn a user-facing name into a CVBasic identifier. Collisions with kernel
 * names would produce assembler errors a beginner could not act on, so
 * reserved names get a suffix rather than being rejected.
 */
export function symbolise(name, fallback) {
  let s = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
  if (!s || /^[0-9]/.test(s)) s = fallback + (s ? '_' + s : '');
  if (RESERVED.has(s)) s = s + '_u';
  return s;
}
