/**
 * Frame budget, from measured cycle counts.
 *
 * Every number in this file was taken from the generated Z80 with
 * tools/cycles.py, not estimated. See docs/MEASUREMENTS.md for how, and for
 * what changed when the numbers disagreed with the design.
 *
 * This gives the budget meter a "Frame %" before a single compile, so the
 * editor can say "this room will not hold 60 fps" while the user is still
 * editing rather than after they wonder why the game crawls. The profiler
 * later replaces the estimate with a real measurement from the emulator;
 * until then this is close enough to be worth acting on, and it is the same
 * model for every target because every target runs the same kernel.
 */

/** NTSC: 3.579545 MHz / 59.92 Hz. PAL gives about 20% more headroom. */
export const FRAME_CYCLES = {ntsc: 59736, pal: 70938};

/**
 * Measured costs, in Z80 T-states. Where a path has two figures the first is
 * the cheap case (slot empty / entity stationary).
 */
export const COST = {
  // --- collision, per candidate pair, including the loop tail ---
  colSlotEmpty: 165,
  colRejectY: 267,
  colRejectX: 369,
  colOuterActive: 272,
  colOuterEmpty: 110,

  // --- movement, per entity per frame ---
  // Two encodings: whole-pixel (k_move_int) and subpixel 8.8 (k_move). The
  // subpixel path is about four times the cost, which is why the IR gives it
  // only to actors that genuinely ask for a fractional speed.
  moveIntStill: 120,
  moveInt: 322,
  moveSubStill: 236,
  moveSubOneAxis: 740,
  moveSubBothAxes: 1244,
  // A fixed direction at a fixed whole-pixel speed compiles to a bare add
  // and needs no mover call at all.
  moveInline: 60,

  // --- rendering, per slot per frame ---
  renderEmpty: 166,
  renderNarrow: 649,
  renderWide: 820,

  // --- end of frame ---
  reapPerSlot: 12,

  // --- dispatch overhead per slot in a range that has any script ---
  dispatchPerSlot: 95,

  // --- behaviours, rough per-entity figures ---
  behaviour: {
    move: 60, control8: 420, platform: 1500, chase: 380,
    patrol: 220, shoot: 120, animate: 210,
    destroyOffscreen: 130, health: 90,
  },
};

/**
 * Estimate the per-frame cost of a room at worst case: every slot of every
 * type that the room can contain is occupied.
 *
 * Worst case rather than typical on purpose. A game that is fine until the
 * moment eight enemies are on screen at once is a game that stutters exactly
 * when it matters, and that is the hardest kind of performance problem for a
 * beginner to diagnose.
 */
export function estimateFrame(ir, {video = 'ntsc'} = {}) {
  const budget = FRAME_CYCLES[video] || FRAME_CYCLES.ntsc;
  const parts = [];

  // Rendering touches every slot whether or not it is occupied.
  let render = 0;
  ir.types.forEach((t) => {
    render += t.max * (t.width >= 16 ? COST.renderWide : COST.renderNarrow);
  });
  parts.push({name: 'Sprites', cycles: render});

  // Behaviours and the movement they imply.
  let behave = 0;
  ir.types.forEach((t) => {
    let per = 0;
    let mover = null;
    (t.behaviours || []).forEach((b) => {
      per += COST.behaviour[b.kind] || 100;
      if (b.kind === 'move') {
        mover = mover || (t.subpixel ? 'sub' : 'inline');
      } else if (['chase', 'patrol', 'platform'].includes(b.kind)) {
        mover = t.subpixel ? 'sub' : 'int';
      }
    });
    if (mover === 'sub') per += COST.moveSubOneAxis;
    else if (mover === 'int') per += COST.moveInt;
    else if (mover === 'inline') per += COST.moveInline;
    behave += t.max * per;
  });
  parts.push({name: 'Behaviours', cycles: behave});

  // Scripts: dispatch plus a flat allowance per statement, since a statement
  // is typically one or two array accesses.
  let scripts = 0;
  ir.types.forEach((t) => {
    const events = ['update', 'timer', 'leave', 'animend'];
    const n = events.reduce((acc, e) => acc + stmtCount(t.scripts[e]), 0);
    if (n || events.some((e) => hasStmts(t.scripts[e]))) {
      scripts += t.max * (COST.dispatchPerSlot + n * 90);
    }
  });
  parts.push({name: 'Scripts', cycles: scripts});

  // Collision, per enabled pair.
  let collision = 0;
  const pairDetail = [];
  ir.pairs.forEach((p) => {
    let c = 0;
    p.ranges.forEach((r) => {
      const outer = r.a.max * COST.colOuterActive;
      // Most candidates are rejected on the Y test; a handful get as far as
      // the X test. 85/15 matches what a shmup actually does.
      const inner = r.candidates * (COST.colRejectY * 0.85 + COST.colRejectX * 0.15);
      c += outer + inner;
    });
    if (p.timeSlice) c = c / 2;
    pairDetail.push({id: p.id, cycles: Math.round(c), candidates: p.candidates});
    collision += c;
  });
  parts.push({name: 'Collision', cycles: Math.round(collision), detail: pairDetail});

  parts.push({name: 'End of frame', cycles: ir.layout.maxEnt * COST.reapPerSlot});

  const total = parts.reduce((n, p) => n + p.cycles, 0);
  return {
    video,
    budget,
    total: Math.round(total),
    percent: Math.round((total / budget) * 100),
    parts: parts.map((p) => ({...p, percent: Math.round((p.cycles / budget) * 100)})),
    // The advice a number alone cannot give. A user cannot act on "61%".
    advice: advise(parts, total, budget, ir),
  };
}

function advise(parts, total, budget, ir) {
  const out = [];
  if (total <= budget) return out;

  const over = Math.round(((total - budget) / budget) * 100);
  out.push({
    text: `This room is about ${over}% over a single frame at worst case, so ` +
      `it will drop to 30 fps when it is busiest.`,
  });

  const collision = parts.find((p) => p.name === 'Collision');
  if (collision && collision.cycles > budget * 0.2) {
    const worst = (collision.detail || []).slice()
        .sort((a, b) => b.cycles - a.cycles)[0];
    if (worst) {
      out.push({
        text: `${worst.id.replace('|', ' vs ')} is the most expensive pair: ` +
          `${worst.candidates} checks a frame. Checking it every other frame ` +
          `halves that, and at these speeds it is not noticeable.`,
        action: {kind: 'timeSlice', pair: worst.id},
      });
    }
  }

  const sprites = parts.find((p) => p.name === 'Sprites');
  if (sprites && sprites.cycles > budget * 0.35) {
    const biggest = ir.types.slice().sort((a, b) => b.max - a.max)[0];
    if (biggest) {
      out.push({
        text: `Drawing costs ${sprites.percent}% of the frame. Lowering ` +
          `${biggest.name}'s Max instances is the most direct saving.`,
        action: {kind: 'lowerMax', actor: biggest.key},
      });
    }
  }

  return out;
}

function stmtCount(script) {
  if (!script || !script.stmts) return 0;
  const walk = (list) => (list || []).reduce((n, s) =>
    n + 1 + walk(s.then) + walk(s.else) + walk(s.body), 0);
  return walk(script.stmts);
}

function hasStmts(script) {
  return !!(script && script.stmts && script.stmts.length);
}
