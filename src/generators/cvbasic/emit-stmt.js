/**
 * Lowered statement AST -> CVBasic text.
 *
 * This is the second of the two lowering levels. Block trees become this
 * small AST (see blockly-lower.js); this file turns the AST into text. The
 * split is what makes width inference possible: by the time we get here
 * every expression already knows whether it is 8- or 16-bit, so the emitter
 * can choose `v` versus `#v` consistently and the user never meets a `#`.
 *
 * It is also what makes a second backend cheap. A Genesis emitter reads this
 * same AST; if blocks emitted CVBasic text directly, a second target would
 * mean rewriting every block.
 */

import {SFX_ORDER} from './emit-assets.js';

const FLAG = {NEW: 1, DYING: 2, HFLIP: 4, HIDDEN: 8, ANIMEND: 16};

/**
 * @param {Array} stmts lowered statements
 * @param {object} ctx  {ir, type, indent, scope, spawnDepth}
 * @returns {string[]} lines
 */
export function emitStmts(stmts, ctx) {
  const out = [];
  (stmts || []).forEach((s) => emitStmt(s, ctx, out));
  return out;
}

function emitStmt(s, ctx, out) {
  if (!s || !s.op) return;
  const pad = ctx.indent || '\t';

  // Provenance. The marker survives CVBasic's own "source line as a comment"
  // pass into the generated assembly and then into gasm80's listing, so a
  // compiler error can be mapped back to the exact block that produced it -
  // and a PC sample from the emulator can be attributed to one too.
  if (s.blockId) out.push(`${pad}' @blk:${s.blockId}`);

  switch (s.op) {
    case 'setPos': {
      if (s.x != null) {
        out.push(`${pad}e_x(self) = ${expr(s.x, ctx)}`);
        out.push(`${pad}e_xf(self) = 0`);
      }
      if (s.y != null) {
        out.push(`${pad}e_y(self) = ${expr(s.y, ctx)}`);
        out.push(`${pad}e_yf(self) = 0`);
      }
      break;
    }

    case 'movePos': {
      // Whole-pixel nudge, distinct from velocity: this is "move me by", not
      // "set my speed". Signed constants are folded into an add or subtract
      // so no runtime sign handling is needed.
      if (s.dx != null) out.push(`${pad}e_x(self) = ${addExpr('e_x(self)', s.dx, ctx)}`);
      if (s.dy != null) out.push(`${pad}e_y(self) = ${addExpr('e_y(self)', s.dy, ctx)}`);
      break;
    }

    case 'setVel': {
      // Velocities are stored biased by 128 in sixteenths of a pixel. The
      // bias is applied here, once, so no generated code ever does signed
      // arithmetic - see k_move in the kernel.
      if (s.vx != null) out.push(`${pad}e_vx(self) = ${biased(s.vx, ctx)}`);
      if (s.vy != null) out.push(`${pad}e_vy(self) = ${biased(s.vy, ctx)}`);
      break;
    }

    case 'spawn': {
      const t = findType(ctx.ir, s.actor);
      if (!t) break;
      const depth = ctx.spawnDepth || 0;
      const save = `k_s${Math.min(depth, 3)}`;
      out.push(`${pad}sp_x = ${expr(s.x, ctx)}`);
      out.push(`${pad}sp_y = ${expr(s.y, ctx)}`);
      out.push(`${pad}GOSUB spawn_${t.symbol}`);
      if (hasScript(t, 'create')) {
        // A spawned instance runs `on create` immediately and its first
        // `on update` next frame (the kernel sets FLAG_NEW, cleared by
        // k_reap). Without that rule, spawn order would silently change
        // behaviour depending on slot numbers.
        out.push(`${pad}IF sp_slot <> 255 THEN`);
        out.push(`${pad}\t${save} = self`);
        out.push(`${pad}\tself = sp_slot`);
        out.push(`${pad}\tGOSUB ${t.symbol}_create`);
        out.push(`${pad}\tself = ${save}`);
        out.push(`${pad}END IF`);
      }
      break;
    }

    case 'destroy': {
      // Deferred: sets the flag, k_reap frees the slot at end of frame. The
      // rest of this script still runs, and a pair that killed each other
      // both get their `on destroy`.
      const who = s.target === 'other' ? 'other' : 'self';
      out.push(`${pad}e_flags(${who}) = e_flags(${who}) OR ${FLAG.DYING}`);
      break;
    }

    case 'setTimer':
      out.push(`${pad}e_timer(self) = ${expr(s.value, ctx)}`);
      break;

    case 'setField': {
      const f = findField(ctx.type, s.field);
      if (!f) break;
      const who = s.target === 'other' ? 'other' : 'self';
      out.push(`${pad}${f.symbol}(${who}) = ${expr(s.value, ctx)}`);
      break;
    }

    case 'changeField': {
      const f = findField(ctx.type, s.field);
      if (!f) break;
      const who = s.target === 'other' ? 'other' : 'self';
      out.push(`${pad}${f.symbol}(${who}) = ${addExpr(`${f.symbol}(${who})`, s.delta, ctx)}`);
      break;
    }

    case 'setGlobal': {
      const g = findGlobal(ctx.ir, s.name);
      if (!g) break;
      out.push(`${pad}${g.symbol} = ${expr(s.value, ctx)}`);
      break;
    }

    case 'changeGlobal': {
      const g = findGlobal(ctx.ir, s.name);
      if (!g) break;
      out.push(`${pad}${g.symbol} = ${addExpr(g.symbol, s.delta, ctx)}`);
      break;
    }

    case 'playAnim': {
      const a = findAnim(ctx.ir, ctx.type, s.anim);
      if (a == null) break;
      out.push(`${pad}k_a = ${a}`);
      out.push(`${pad}GOSUB k_setanim`);
      break;
    }

    case 'show':
      out.push(`${pad}e_flags(self) = e_flags(self) AND ${255 - FLAG.HIDDEN}`);
      break;

    case 'hide':
      out.push(`${pad}e_flags(self) = e_flags(self) OR ${FLAG.HIDDEN}`);
      break;

    case 'if': {
      probeForCond(s.cond, ctx, out, pad);
      out.push(`${pad}IF ${cond(s.cond, ctx)} THEN`);
      pushBlock(s.then, ctx, out, pad);
      if (s.else && s.else.length) {
        out.push(`${pad}ELSE`);
        pushBlock(s.else, ctx, out, pad);
      }
      out.push(`${pad}END IF`);
      break;
    }

    case 'repeat': {
      // Bounded only. There is no general loop block, because an unbounded
      // loop inside a per-frame update stalls the whole pool and a beginner
      // has no way to see why.
      const v = ctx.loopVar || 'k_lp';
      out.push(`${pad}FOR ${v} = 1 TO ${expr(s.count, ctx)}`);
      pushBlock(s.body, {...ctx, loopVar: 'k_lp2'}, out, pad);
      out.push(`${pad}NEXT ${v}`);
      break;
    }

    case 'goRoom': {
      const r = (ctx.ir.rooms || []).find((x) => x.key === s.room);
      if (!r) break;
      out.push(`${pad}next_room = ${r.index}`);
      out.push(`${pad}room_change = 1`);
      break;
    }

    case 'restartRoom':
      out.push(`${pad}room_change = 1`);
      break;

    case 'gameOver':
      out.push(`${pad}game_state = 2`);
      out.push(`${pad}room_change = 1`);
      break;

    case 'playSound': {
      // Restarting an effect that is already playing is the right default:
      // rapid fire should sound like rapid fire, not like one long note.
      const i = SFX_ORDER.indexOf(s.sound);
      out.push(`${pad}sfx_id = ${i < 0 ? 0 : i}`);
      out.push(`${pad}sfx_t = 0`);
      break;
    }

    case 'playMusic': {
      // Only a tune the IR collected can be named. `PLAY <label>` for a tune
      // that was never emitted assembles to an undefined label, which gasm80
      // reports as an error while still exiting 0 and writing a full-size
      // ROM - a silently corrupt cartridge. The lint catches this first; the
      // guard here means codegen cannot produce one even if it does not.
      if (!(ctx.ir.music || []).includes(s.music)) {
        out.push(`${pad}' play music: no such tune "${s.music}"`);
        break;
      }
      out.push(`${pad}PLAY music_${s.music}`);
      break;
    }

    case 'stopMusic':
      out.push(`${pad}PLAY OFF`);
      break;

    case 'print': {
      const pos = (s.row | 0) * 32 + (s.col | 0);
      if (s.text != null) {
        out.push(`${pad}PRINT AT ${pos},"${String(s.text).replace(/"/g, '')}"`);
      } else {
        const g = findGlobal(ctx.ir, s.global);
        if (g) {
          const digits = g.width === 16 ? 5 : 3;
          out.push(`${pad}PRINT AT ${pos},<${digits}>${g.symbol}`);
        }
      }
      break;
    }

    case 'raw':
      // The escape hatch for imported ".bas fragments as opaque custom code".
      String(s.code || '').split('\n').forEach((l) => out.push(`${pad}${l}`));
      break;

    default:
      out.push(`${pad}' unsupported statement: ${s.op}`);
  }
}

/**
 * Emit the terrain probe a condition needs before testing it.
 *
 * `tile below me is solid` compiles to a read of k_cell, which only means
 * anything if something has just filled it. Leaving that to chance made the
 * block read whatever the Platform behaviour's last probe happened to leave
 * behind - so it silently reported the tile under the actor's head, or its
 * left foot, or nothing at all, depending on which branch ran that frame.
 *
 * The probe goes under the middle of the actor's feet, which is what "below
 * me" means to the person who dragged the block.
 */
function probeForCond(c, ctx, out, pad) {
  if (!c || !hasTileTest(c) || !ctx.type) return;
  const t = ctx.type;
  out.push(`${pad}k_px = e_x(self) + ${Math.floor(t.width / 2)}`);
  out.push(`${pad}k_py = e_y(self) + ${t.height}`);
  out.push(`${pad}GOSUB k_cell_at`);
}

function hasTileTest(c) {
  if (!c || typeof c !== 'object') return false;
  if (c.op === 'tileAt') return true;
  return hasTileTest(c.a) || hasTileTest(c.b);
}

function pushBlock(stmts, ctx, out, pad) {
  emitStmts(stmts, {...ctx, indent: pad + '\t', spawnDepth: (ctx.spawnDepth || 0) + 1})
      .forEach((l) => out.push(l));
}

/* ------------------------------------------------------------------ */
/* expressions                                                         */
/* ------------------------------------------------------------------ */

export function expr(e, ctx) {
  if (e == null) return '0';
  if (typeof e === 'number') return String(e | 0);
  switch (e.op) {
    case 'num': return String(e.value | 0);
    case 'myX': return 'e_x(self)';
    case 'myY': return 'e_y(self)';
    case 'myTimer': return 'e_timer(self)';
    case 'myFrame': return 'e_frame(self)';
    case 'otherX': return 'e_x(other)';
    case 'otherY': return 'e_y(other)';

    case 'field': {
      const f = findField(ctx.type, e.field);
      if (!f) return '0';
      return `${f.symbol}(${e.target === 'other' ? 'other' : 'self'})`;
    }

    case 'global': {
      const g = findGlobal(ctx.ir, e.name);
      return g ? g.symbol : '0';
    }

    case 'playerX':
      return ctx.ir.player ? `e_x(${ctx.ir.player.first})` : '0';
    case 'playerY':
      return ctx.ir.player ? `e_y(${ctx.ir.player.first})` : '0';

    case 'random':
      return `RANDOM(${expr(e.max, ctx)})`;

    case 'randomRange': {
      const lo = e.min | 0;
      const hi = e.max | 0;
      const span = Math.max(1, hi - lo + 1);
      return lo ? `RANDOM(${span}) + ${lo}` : `RANDOM(${span})`;
    }

    case 'frameCounter':
      return 'FRAME';

    case 'cond':
      // A yes/no block dropped into a number socket. CVBasic conditions
      // evaluate to a non-zero value, so this is meaningful rather than a
      // silent zero - which is what it used to be.
      return `(${cond(e.cond, ctx)})`;

    case 'countGroup': {
      // One array read. The kernel keeps these counts incrementally - spawn
      // increments, reap decrements - because "are all the enemies dead" is
      // checked every frame of every game anyone will ever make with this,
      // and scanning the pool for it would be the most-executed loop in the
      // program for no reason.
      const i = (irGroups(ctx) || []).indexOf(e.group);
      return i < 0 ? '0' : `g_count(${i})`;
    }

    case 'binop': {
      const a = expr(e.a, ctx);
      const b = expr(e.b, ctx);
      // CVBasic multiplies and divides by non-powers of two via a routine
      // call, so folding constants here is worth real cycles.
      if (isNum(e.a) && isNum(e.b)) return String(fold(e.oper, e.a.value, e.b.value));
      return `(${a} ${e.oper} ${b})`;
    }

    default:
      return '0';
  }
}

export function cond(c, ctx) {
  if (!c) return '0';
  switch (c.op) {
    case 'button':
      return `CONT1.BUTTON`;
    case 'button2':
      return `CONT1.BUTTON2`;
    case 'pad':
      return `CONT1.${String(c.dir || 'UP').toUpperCase()}`;
    case 'pad2':
      return `CONT2.${String(c.dir || 'UP').toUpperCase()}`;

    case 'offScreen':
      // The whole hitbox has left the visible area. X wraps at 256 so the
      // left-hand case shows up as a large value, which is why this is a
      // single unsigned range test rather than two signed ones.
      return `(e_y(self) > 200) OR (e_x(self) > 248)`;

    case 'tileAt': {
      const attr = {solid: 1, hazard: 2, ladder: 4, breakable: 8, platform: 16};
      return `(k_cell AND ${attr[c.attr] || 1})`;
    }

    case 'compare': {
      const a = expr(c.a, ctx);
      const b = expr(c.b, ctx);
      const opers = {eq: '=', ne: '<>', lt: '<', le: '<=', gt: '>', ge: '>='};
      return `${a} ${opers[c.oper] || '='} ${b}`;
    }

    case 'and':
      return `(${cond(c.a, ctx)}) AND (${cond(c.b, ctx)})`;
    case 'or':
      return `(${cond(c.a, ctx)}) OR (${cond(c.b, ctx)})`;
    case 'not':
      // NOT in CVBasic is a bitwise complement, not a logical negation, so
      // `NOT CONT1.BUTTON` compiles to AND 64 / CPL and is non-zero whether
      // or not the button is held - it is always true. Comparing against
      // zero is the only form that actually negates.
      return `(${cond(c.a, ctx)}) = 0`;

    case 'nearPlayer': {
      // Deliberately coarse and deliberately cheap - a true distance needs a
      // multiply per axis. The profiler shows what this costs; there is no
      // general "nearest instance" machinery because with a recycled pool a
      // stale reference is a use-after-free a beginner cannot reason about.
      if (!ctx.ir.player) return '0';
      const px = `e_x(${ctx.ir.player.first})`;
      const py = `e_y(${ctx.ir.player.first})`;
      const d = c.distance | 0;
      return `(ABS(e_x(self) - ${px}) < ${d}) AND (ABS(e_y(self) - ${py}) < ${d})`;
    }

    case 'animEnded':
      return `(e_flags(self) AND ${FLAG.ANIMEND})`;

    default:
      return '0';
  }
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

/** `base + delta`, folded into a subtract when the constant is negative. */
function addExpr(base, delta, ctx) {
  if (isNum(delta)) {
    const v = delta.value | 0;
    if (v === 0) return base;
    return v < 0 ? `${base} - ${-v}` : `${base} + ${v}`;
  }
  if (typeof delta === 'number') {
    if (delta === 0) return base;
    return delta < 0 ? `${base} - ${-delta}` : `${base} + ${delta}`;
  }
  return `${base} + ${expr(delta, ctx)}`;
}

/** Velocity in pixels/frame -> the kernel's biased sixteenths. */
function biased(v, ctx) {
  // The unit depends on which mover this type uses: sixteenths of a pixel
  // for the 8.8 one, whole pixels for the cheap one. Always using sixteenths
  // meant "set my speed to 1" on a whole-pixel type asked for 16 px a frame.
  const unit = ctx.type && ctx.type.subpixel ? 16 : 1;
  if (isNum(v) || typeof v === 'number') {
    const px = typeof v === 'number' ? v : v.value;
    const units = Math.round(px * unit);
    return String(Math.max(0, Math.min(255, 128 + units)));
  }
  return unit === 1 ? `128 + ${expr(v, ctx)}` : `128 + (${expr(v, ctx)} * 16)`;
}

function isNum(e) {
  return e && typeof e === 'object' && e.op === 'num';
}

function fold(oper, a, b) {
  switch (oper) {
    case '+': return (a + b) | 0;
    case '-': return (a - b) | 0;
    case '*': return (a * b) | 0;
    case '/': return b ? Math.floor(a / b) : 0;
    default: return 0;
  }
}

function irGroups(ctx) {
  return ctx.ir && ctx.ir.groups;
}

function findType(ir, key) {
  return (ir.types || []).find((t) => t.key === key || t.name === key);
}

function findField(type, name) {
  if (!type) return null;
  return (type.fields || []).find((f) => f.name === name);
}

function findGlobal(ir, name) {
  return (ir.globals || []).find((g) => g.name === name);
}

function findAnim(ir, type, name) {
  if (!type) return null;
  const ids = type.animations || [];
  for (const id of ids) {
    if (ir.anims[id] && ir.anims[id].name === name) return id;
  }
  return ids.length ? ids[0] : null;
}

export function hasScript(type, event) {
  const s = type.scripts && type.scripts[event];
  return !!(s && s.stmts && s.stmts.length);
}

export {FLAG};
