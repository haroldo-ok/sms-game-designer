/**
 * Behaviours -> CVBasic.
 *
 * Most beginner scripts are the same six programs. Shipping them as
 * configurable components rather than making people assemble them from
 * blocks is the main lever on two things at once:
 *
 *   - Time to first working game. A shmup should be buildable with zero
 *     blocks; blocks are then how you make it yours, not how you make it run.
 *   - Generated code size, which is what decides whether a game fits in
 *     32 KB. A behaviour is ~10 lines of engine-quality CVBasic where the
 *     literal block-by-block translation of the same thing is ~40.
 *
 * Behaviours run before `on update`, so a script can always correct one.
 */

import {SFX_ORDER} from './emit-assets.js';

const SCREEN_BOTTOM = 191;
const SCREEN_RIGHT = 255;

/**
 * @returns {string[]} lines for one actor type's behaviour procedure body
 */
export function emitBehaviours(type, ir) {
  const out = [];
  const pad = '\t';
  // Velocity unit and mover procedure for this type - see needsSubpixel in
  // the IR builder and k_move_int in the kernel.
  const unit = type.subpixel ? 16 : 1;
  const mover = type.subpixel ? 'k_move' : 'k_move_int';
  const bias = (pxPerFrame) => String(Math.max(0, Math.min(255,
      128 + Math.round(pxPerFrame * unit))));
  const env = {bias, mover};
  if (type.needsMover) {
    // Applies whatever velocity this type's scripts set. Nothing else would:
    // see needsMover in the IR builder.
    out.push(`${pad}' apply the velocity set by this actor's scripts`);
    out.push(`${pad}GOSUB ${mover}`);
  }
  (type.behaviours || []).forEach((b) => {
    const fn = BEHAVIOURS[b.kind];
    if (!fn) {
      out.push(`${pad}' unknown behaviour: ${b.kind}`);
      return;
    }
    out.push(`${pad}' behaviour: ${b.kind}`);
    fn(b, type, ir, out, pad, env);
  });
  return out;
}

export function behaviourNeedsMove(type) {
  return (type.behaviours || []).some((b) =>
    ['move', 'control8', 'platform', 'chase', 'patrol'].includes(b.kind));
}

const BEHAVIOURS = {
  /**
   * Move in a fixed direction at a fixed speed. Constant-folded into a pair
   * of biased velocity literals, so the per-frame cost is just k_move.
   */
  move(b, type, ir, out, pad, {bias, mover}) {
    const speed = num(b.speed, 1);
    const dirs = {
      up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0],
      upleft: [-1, -1], upright: [1, -1],
      downleft: [-1, 1], downright: [1, 1],
    };
    const [dx, dy] = dirs[b.direction] || [0, 1];
    // A fixed direction at a fixed speed does not need the velocity bytes
    // at all: the whole thing folds to one or two adds.
    if (!type.subpixel) {
      if (dx) out.push(`${pad}e_x(self) = ${signedAdd('e_x(self)', dx * speed)}`);
      if (dy) out.push(`${pad}e_y(self) = ${signedAdd('e_y(self)', dy * speed)}`);
    } else {
      out.push(`${pad}e_vx(self) = ${bias(dx * speed)}`);
      out.push(`${pad}e_vy(self) = ${bias(dy * speed)}`);
      out.push(`${pad}GOSUB ${mover}`);
    }
    if (b.atEdge === 'wrap') {
      out.push(`${pad}IF e_y(self) > ${SCREEN_BOTTOM} THEN`);
      out.push(`${pad}\tIF e_vy(self) > 128 THEN e_y(self) = 0 ELSE e_y(self) = ${SCREEN_BOTTOM}`);
      out.push(`${pad}END IF`);
    } else if (b.atEdge === 'destroy') {
      destroyOffScreen(out, pad, num(b.margin, 8));
    }
  },

  /**
   * Eight-way pad control for the player. Clamping is done against the
   * actor's own width so the sprite never half-leaves the screen, which is
   * the behaviour a beginner expects and would otherwise have to discover.
   */
  control8(b, type, ir, out, pad) {
    const speed = Math.max(1, Math.round(num(b.speed, 2)));
    const pad1 = b.pad === 2 ? 'CONT2' : 'CONT1';
    const w = type.width;
    const h = type.height;
    out.push(`${pad}IF ${pad1}.LEFT THEN IF e_x(self) >= ${speed} THEN e_x(self) = e_x(self) - ${speed}`);
    out.push(`${pad}IF ${pad1}.RIGHT THEN IF e_x(self) < ${SCREEN_RIGHT - w - speed} THEN e_x(self) = e_x(self) + ${speed}`);
    out.push(`${pad}IF ${pad1}.UP THEN IF e_y(self) >= ${speed} THEN e_y(self) = e_y(self) - ${speed}`);
    out.push(`${pad}IF ${pad1}.DOWN THEN IF e_y(self) < ${SCREEN_BOTTOM - h + 1 - speed} THEN e_y(self) = e_y(self) + ${speed}`);
  },

  /**
   * Gravity, jumping and solid tiles. Terrain is always tiles and never
   * actors: the O(1) cell lookup is why a platformer is affordable at all,
   * where walls-as-actors would be O(n) pairwise against a pool that has no
   * room to spare.
   *
   * Vertical velocity is kept in the biased byte so it shares k_move with
   * everything else.
   */
  platform(b, type, ir, out, pad) {
    const gravity = Math.max(1, Math.round(num(b.gravity, 0.25) * 16));
    const jump = Math.max(1, Math.round(num(b.jump, 3.5) * 16));
    const speed = Math.max(1, Math.round(num(b.speed, 2)));
    const pad1 = b.pad === 2 ? 'CONT2' : 'CONT1';
    const w = type.width;
    const h = type.height;

    // Horizontal first, then undo the move if it put us inside a wall.
    // Both vertical edges of the hitbox are probed, at head height as well
    // as at the feet: probing only the feet lets an actor walk its head
    // straight through an overhang, which is a bug that shows up the first
    // time somebody builds a low doorway.
    out.push(`${pad}k_t = e_x(self)`);
    out.push(`${pad}IF ${pad1}.LEFT THEN IF e_x(self) >= ${speed} THEN e_x(self) = e_x(self) - ${speed}`);
    out.push(`${pad}IF ${pad1}.RIGHT THEN IF e_x(self) < ${SCREEN_RIGHT - w - speed} THEN e_x(self) = e_x(self) + ${speed}`);
    [[0, h - 1], [w - 1, h - 1], [0, 1], [w - 1, 1]].forEach(([dx, dy]) => {
      probeSolid(out, pad, dx ? `e_x(self) + ${dx}` : 'e_x(self)',
          `e_y(self) + ${dy}`);
      out.push(`${pad}IF k_cell AND 1 THEN e_x(self) = k_t`);
    });

    // Gravity, capped so a long fall cannot tunnel through a one-tile floor.
    out.push(`${pad}IF e_vy(self) < ${128 + 96} THEN e_vy(self) = e_vy(self) + ${gravity}`);
    out.push(`${pad}k_t = e_y(self)`);
    out.push(`${pad}GOSUB k_move`);

    // Floor: probe under both bottom corners.
    out.push(`${pad}IF e_vy(self) > 128 THEN`);
    probeSolid(out, pad + '\t', 'e_x(self)', `e_y(self) + ${h}`);
    out.push(`${pad}\tk_x = k_cell`);
    probeSolid(out, pad + '\t', `e_x(self) + ${w - 1}`, `e_y(self) + ${h}`);
    out.push(`${pad}\tIF (k_cell OR k_x) AND 1 THEN`);
    out.push(`${pad}\t\te_y(self) = (e_y(self) / 8) * 8`);
    out.push(`${pad}\t\te_yf(self) = 0`);
    out.push(`${pad}\t\te_vy(self) = 128`);
    out.push(`${pad}\t\te_f3(self) = 1`); // grounded flag
    out.push(`${pad}\tELSE`);
    out.push(`${pad}\t\te_f3(self) = 0`);
    out.push(`${pad}\tEND IF`);
    out.push(`${pad}ELSE`);
    // Ceiling: both top corners, not just the left one. And the fraction
    // has to be cleared along with the whole-pixel part, or the actor keeps
    // a sub-pixel of upward momentum it can never spend and jitters against
    // the ceiling forever.
    probeSolid(out, pad + '\t', 'e_x(self)', 'e_y(self)');
    out.push(`${pad}\tk_x = k_cell`);
    probeSolid(out, pad + '\t', `e_x(self) + ${w - 1}`, 'e_y(self)');
    out.push(`${pad}\tIF (k_cell OR k_x) AND 1 THEN`);
    out.push(`${pad}\t\te_y(self) = ((e_y(self) / 8) + 1) * 8`);
    out.push(`${pad}\t\te_yf(self) = 0`);
    out.push(`${pad}\t\te_vy(self) = 128`);
    out.push(`${pad}\tEND IF`);
    out.push(`${pad}\te_f3(self) = 0`);
    out.push(`${pad}END IF`);

    out.push(`${pad}IF ${pad1}.BUTTON THEN IF e_f3(self) THEN e_vy(self) = ${128 - jump}`);
  },

  /**
   * Chase the player. `rate` throttles the decision, not the movement: a
   * chaser that re-aims every frame looks robotic and costs the most cycles
   * of any behaviour in the set.
   */
  chase(b, type, ir, out, pad, {bias, mover}) {
    if (!ir.player) {
      out.push(`${pad}' no actor is flagged as the player; Chase does nothing`);
      return;
    }
    const p = ir.player.first;
    const speed = num(b.speed, 1);
    const rate = Math.max(1, num(b.rate, 8));
    const mask = (rate & (rate - 1)) === 0 ? rate - 1 : null;
    const guard = mask != null ? `(FRAME AND ${mask}) = 0` : `(FRAME / ${rate}) * ${rate} = FRAME`;
    out.push(`${pad}IF ${guard} THEN`);
    out.push(`${pad}\tIF e_x(${p}) < e_x(self) THEN e_vx(self) = ${bias(-speed)} ELSE e_vx(self) = ${bias(speed)}`);
    out.push(`${pad}\tIF e_y(${p}) < e_y(self) THEN e_vy(self) = ${bias(-speed)} ELSE e_vy(self) = ${bias(speed)}`);
    out.push(`${pad}END IF`);
    out.push(`${pad}GOSUB ${mover}`);
  },

  /** Walk back and forth, turning at the screen edge or at a wall. */
  patrol(b, type, ir, out, pad, {bias, mover}) {
    const speed = num(b.speed, 1);
    const w = type.width;
    out.push(`${pad}IF e_vx(self) = 128 THEN e_vx(self) = ${bias(speed)}`);
    out.push(`${pad}GOSUB ${mover}`);
    out.push(`${pad}IF e_x(self) < 2 THEN e_vx(self) = ${bias(speed)}`);
    out.push(`${pad}IF e_x(self) > ${SCREEN_RIGHT - w - 2} THEN e_vx(self) = ${bias(-speed)}`);
    if (b.turnAtWall) {
      probeSolid(out, pad, `e_x(self) + ${Math.floor(w / 2)}`, `e_y(self) + ${type.height}`);
      out.push(`${pad}IF (k_cell AND 1) = 0 THEN`);
      out.push(`${pad}\tIF e_vx(self) > 128 THEN e_vx(self) = ${bias(-speed)} ELSE e_vx(self) = ${bias(speed)}`);
      out.push(`${pad}END IF`);
    }
  },

  /**
   * Fire an actor on an interval. Uses the per-instance general timer, so a
   * type cannot have both Shoot and an `on timer` script - the lint catches
   * that rather than letting the two quietly fight.
   */
  shoot(b, type, ir, out, pad, {bias}) {
    const target = (ir.types || []).find((t) => t.key === b.actor);
    if (!target) {
      out.push(`${pad}' Shoot: no such actor`);
      return;
    }
    const interval = Math.max(1, num(b.interval, 12));
    const ox = num(b.offsetX, Math.floor(type.width / 2) - 4);
    const oy = num(b.offsetY, 0);
    out.push(`${pad}IF e_timer(self) THEN`);
    out.push(`${pad}\te_timer(self) = e_timer(self) - 1`);
    out.push(`${pad}ELSE`);
    if (b.onButton) {
      out.push(`${pad}\tIF CONT1.BUTTON THEN`);
      shootBody(out, pad + '\t\t', target, ox, oy, interval, b, ir, bias);
      out.push(`${pad}\tEND IF`);
    } else if (b.randomise) {
      // Snapped to a power of two. CVBasic compiles RANDOM(n) to a call
      // into its 16-bit modulo routine for a general n, but to a single
      // AND when n is a power of two - so a fire chance of "about 1 in 90"
      // costs several hundred cycles more than "1 in 64" for no visible
      // difference in play.
      out.push(`${pad}\tIF RANDOM(${pow2(Math.max(2, num(b.randomise, 32)))}) = 0 THEN`);
      shootBody(out, pad + '\t\t', target, ox, oy, interval, b, ir, bias);
      out.push(`${pad}\tEND IF`);
    } else {
      shootBody(out, pad + '\t', target, ox, oy, interval, b, ir, bias);
    }
    out.push(`${pad}END IF`);
  },

  /** Advance the current animation. */
  animate(b, type, ir, out, pad) {
    out.push(`${pad}GOSUB k_animate`);
  },

  /** Free the slot once the hitbox is fully outside the screen. */
  destroyOffscreen(b, type, ir, out, pad) {
    destroyOffScreen(out, pad, num(b.margin, 8));
  },

  /**
   * Hit points in a named field, with a configurable action at zero. The
   * damage itself is applied by whichever collide handler the user wrote;
   * this behaviour only watches the field, which keeps the two independent.
   */
  health(b, type, ir, out, pad) {
    const f = (type.fields || []).find((x) => x.name === (b.field || 'hp'));
    if (!f) {
      out.push(`${pad}' Health: no field named "${b.field || 'hp'}"`);
      return;
    }
    out.push(`${pad}IF ${f.symbol}(self) = 0 THEN e_flags(self) = e_flags(self) OR 2`);
  },
};

function shootBody(out, pad, target, ox, oy, interval, b, ir, bias) {
  // The bullet's own velocity encoding is the TARGET type's, not the
  // shooter's, so aimed fire biases in the bullet's unit.
  const bbias = (px) => String(Math.max(0, Math.min(255,
      128 + Math.round(px * (target.subpixel ? 16 : 1)))));
  out.push(`${pad}sp_x = e_x(self) + ${ox}`);
  out.push(`${pad}sp_y = e_y(self) + ${oy}`);
  out.push(`${pad}GOSUB spawn_${target.symbol}`);
  if (b.aim === 'player' && ir.player) {
    const p = ir.player.first;
    const speed = num(b.bulletSpeed, 2);
    out.push(`${pad}IF sp_slot <> 255 THEN`);
    out.push(`${pad}\tIF e_x(${p}) < sp_x THEN e_vx(sp_slot) = ${bbias(-speed)} ELSE e_vx(sp_slot) = ${bbias(speed)}`);
    out.push(`${pad}\tIF e_y(${p}) < sp_y THEN e_vy(sp_slot) = ${bbias(-speed)} ELSE e_vy(sp_slot) = ${bbias(speed)}`);
    out.push(`${pad}END IF`);
  }
  if (b.sound) {
    out.push(`${pad}sfx_id = ${SFX_ORDER.indexOf(b.sound)}`);
    out.push(`${pad}sfx_t = 0`);
  }
  out.push(`${pad}e_timer(self) = ${interval}`);
}

function destroyOffScreen(out, pad, margin) {
  // X wraps at 256, so "off the left edge" shows up as a large X. One
  // unsigned range test per axis covers both sides.
  out.push(`${pad}IF e_y(self) > ${191 + margin} THEN e_flags(self) = e_flags(self) OR 2`);
  out.push(`${pad}IF e_x(self) > ${255 - margin} THEN e_flags(self) = e_flags(self) OR 2`);
}

function probeSolid(out, pad, x, y) {
  out.push(`${pad}k_px = ${x}`);
  out.push(`${pad}k_py = ${y}`);
  out.push(`${pad}GOSUB k_cell_at`);
}

/** `base + n`, folded to a subtract when n is negative. */
function signedAdd(base, n) {
  const v = Math.round(n);
  if (v === 0) return base;
  return v < 0 ? `${base} - ${-v}` : `${base} + ${v}`;
}

/** Nearest power of two, so RANDOM compiles to an AND rather than a modulo. */
function pow2(n) {
  const e = Math.max(1, Math.round(Math.log2(n)));
  return 1 << Math.min(e, 15);
}

function num(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}
