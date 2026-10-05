/**
 * Actor types -> CVBasic procedures.
 *
 * Everything here exploits one decision made in the IR: each type owns a
 * contiguous slot range. Because every slot in a range holds the same type,
 * the update loop for a range can call one procedure directly - no
 * per-instance `ON type GOSUB` in the hot path - and per-type constants
 * (hitbox size, animation base, speed) become literals instead of table
 * lookups.
 */

import {emitStmts, hasScript} from './emit-stmt.js';
import {emitBehaviours} from './emit-behaviour.js';

export function emitActorConstants(ir) {
  const out = [];
  out.push(`\tCONST MAX_ENT = ${ir.layout.maxEnt}`);
  out.push(`\tCONST MAX_HW = ${ir.layout.maxHw}`);
  out.push(`\tCONST #MAP_CELLS = ${ir.layout.mapCells}`);
  out.push(`\tCONST NUM_GROUPS = ${Math.max(1, ir.groups.length)}`);
  out.push(`\tCONST MAP_MAXY = ${ir.target.screenRows * 8 - 1}`);
  out.push('');
  ir.types.forEach((t) => {
    const u = t.symbol.toUpperCase();
    out.push(`\tCONST T_${u} = ${t.typeId} : CONST ${u}_FIRST = ${t.first} : CONST ${u}_LAST = ${t.last}`);
  });
  return out;
}

/** Extra RAM the generated code needs beyond the kernel's own declarations. */
export function emitActorDims(ir) {
  const out = [];
  const rotors = ir.types.filter((t) => t.reuseOldest);
  if (rotors.length) {
    out.push(`\tDIM ${rotors.map((t) => `${t.symbol}_rr`).join(',')}`);
  }
  out.push('\tDIM game_state, room_change, next_room, cur_room');
  out.push('\tDIM k_lp, k_lp2, dropped');
  const globals = ir.globals.map((g) => g.symbol);
  if (globals.length) out.push(`\tDIM ${globals.join(',')}`);
  return out;
}

/* ------------------------------------------------------------------ */
/* spawning                                                            */
/* ------------------------------------------------------------------ */

export function emitSpawns(ir) {
  const out = [];
  ir.types.forEach((t) => {
    const u = t.symbol.toUpperCase();
    out.push(`\t'`);
    out.push(`\t' Spawn a ${t.name}. Position in sp_x/sp_y; the new slot comes`);
    out.push(`\t' back in sp_slot, or 255 if the type is at its cap.`);
    out.push(`\t'`);
    out.push(`spawn_${t.symbol}:\tPROCEDURE`);
    out.push(`\tsp_slot = 255`);
    if (t.max === 1) {
      // A singleton needs no scan at all.
      out.push(`\tIF e_type(${t.first}) = 0 THEN sp_slot = ${t.first}`);
    } else {
      out.push(`\tFOR sp_i = ${u}_FIRST TO ${u}_LAST`);
      out.push(`\t\tIF e_type(sp_i) = 0 THEN`);
      out.push(`\t\t\tsp_slot = sp_i`);
      out.push(`\t\t\tEXIT FOR`);
      out.push(`\t\tEND IF`);
      out.push(`\tNEXT sp_i`);
    }

    if (t.reuseOldest) {
      // Default on for bullets and effects, off for enemies: recycling an
      // enemy mid-fight is confusing, recycling the oldest explosion is not.
      out.push(`\tIF sp_slot = 255 THEN`);
      out.push(`\t\tsp_slot = ${t.symbol}_rr`);
      out.push(`\t\t${t.symbol}_rr = ${t.symbol}_rr + 1`);
      out.push(`\t\tIF ${t.symbol}_rr > ${u}_LAST THEN ${t.symbol}_rr = ${u}_FIRST`);
      out.push(`\tEND IF`);
    } else {
      // A failed spawn silently does nothing. The profiler counts them and
      // surfaces the total, because "37 shots dropped this session - raise
      // Max instances or lower the fire rate" is actionable where a silent
      // failure is not.
      out.push(`\tIF sp_slot = 255 THEN`);
      out.push(`\t\tdropped = dropped + 1`);
      out.push(`\t\tRETURN`);
      out.push(`\tEND IF`);
    }

    out.push(`\te_type(sp_slot) = T_${u}`);
    out.push(`\te_x(sp_slot) = sp_x`);
    out.push(`\te_y(sp_slot) = sp_y`);
    out.push(`\te_xf(sp_slot) = 0`);
    out.push(`\te_yf(sp_slot) = 0`);
    out.push(`\te_vx(sp_slot) = 128`);
    out.push(`\te_vy(sp_slot) = 128`);
    out.push(`\te_anim(sp_slot) = ${t.animations[0]}`);
    out.push(`\te_frame(sp_slot) = 0`);
    // Precomputed render value for frame 0 of the default animation, so the
    // renderer never has to derive it.
    out.push(`\te_sprf(sp_slot) = ${ir.anims[t.animations[0]].fbase | ir.anims[t.animations[0]].wide}`);
    out.push(`\te_atimer(sp_slot) = ${ir.anims[t.animations[0]].rate}`);
    out.push(`\te_timer(sp_slot) = 0`);
    out.push(`\te_flags(sp_slot) = 1`);
    out.push(`\tg_count(${t.groupIndex}) = g_count(${t.groupIndex}) + 1`);
    // Field initialisation is free here because codegen writes this
    // procedure from the type definition.
    t.fields.forEach((f) => {
      out.push(`\t${f.symbol}(sp_slot) = ${f.initial}`);
    });
    for (let i = t.fields.reduce((n, f) => n + (f.width === 16 ? 2 : 1), 0);
      i < ir.target.userFields; i++) {
      out.push(`\te_f${i}(sp_slot) = 0`);
    }
    out.push(`\tEND`);
    out.push('');
  });
  return out;
}

/* ------------------------------------------------------------------ */
/* per-type event procedures                                           */
/* ------------------------------------------------------------------ */

export function emitActorScripts(ir) {
  const out = [];
  ir.types.forEach((t) => {
    const ctx = {ir, type: t, indent: '\t', spawnDepth: 0};

    const beh = emitBehaviours(t, ir);
    if (beh.length) {
      out.push(`${t.symbol}_behave:\tPROCEDURE`);
      beh.forEach((l) => out.push(l));
      out.push('\tEND');
      out.push('');
    }

    ['create', 'update', 'destroy', 'animend', 'leave', 'timer'].forEach((ev) => {
      if (!hasScript(t, ev)) return;
      out.push(`${t.symbol}_${ev}:\tPROCEDURE`);
      emitStmts(t.scripts[ev].stmts, ctx).forEach((l) => out.push(l));
      out.push('\tEND');
      out.push('');
    });

    Object.keys(t.scripts || {}).forEach((key) => {
      if (!key.startsWith('collide:')) return;
      const group = key.slice('collide:'.length);
      const s = t.scripts[key];
      if (!s || !s.stmts || !s.stmts.length) return;
      out.push(`${t.symbol}_hit_${group}:\tPROCEDURE`);
      emitStmts(s.stmts, ctx).forEach((l) => out.push(l));
      out.push('\tEND');
      out.push('');
    });
  });
  return out;
}

/**
 * Type id -> group index, for the kernel's population counting. Index 0 is
 * the "free slot" type id and is never read.
 */
export function emitGroupTable(ir) {
  const byId = [0];
  ir.types.forEach((t) => {
    byId[t.typeId] = t.groupIndex;
  });
  for (let i = 0; i < byId.length; i++) if (byId[i] == null) byId[i] = 0;
  return [`t_group:\tDATA BYTE ${byId.join(',')}`];
}

/* ------------------------------------------------------------------ */
/* dispatchers                                                         */
/* ------------------------------------------------------------------ */

/**
 * Behaviours run before scripts, so a script can correct a behaviour. This
 * ordering is user-visible semantics and worth being explicit about.
 */
export function emitRunBehaviours(ir) {
  const out = ['run_behaviours:\tPROCEDURE'];
  let any = false;
  ir.types.forEach((t) => {
    if (!(t.behaviours || []).length && !t.needsMover) return;
    any = true;
    const u = t.symbol.toUpperCase();
    if (t.max === 1) {
      out.push(`\tIF e_type(${t.first}) THEN`);
      out.push(`\t\tself = ${t.first}`);
      out.push(`\t\tGOSUB ${t.symbol}_behave`);
      out.push(`\tEND IF`);
    } else {
      out.push(`\tFOR k_i = ${u}_FIRST TO ${u}_LAST`);
      out.push(`\t\tIF e_type(k_i) THEN`);
      out.push(`\t\t\tself = k_i`);
      out.push(`\t\t\tGOSUB ${t.symbol}_behave`);
      out.push(`\t\tEND IF`);
      out.push(`\tNEXT k_i`);
    }
  });
  if (!any) out.push(`\t' no type has behaviours`);
  out.push('\tEND');
  return out;
}

/**
 * `on update` plus the three events that are really per-frame checks:
 * `on timer`, `on leave screen` and `on animation end`. Folding them into
 * this loop means one pass over each range rather than four.
 *
 * FLAG_NEW is checked here: an instance spawned this frame runs its
 * `on create` immediately but its first `on update` next frame, so spawn
 * order cannot silently change behaviour depending on slot numbers.
 */
export function emitRunUpdates(ir) {
  const out = ['run_updates:\tPROCEDURE'];
  let any = false;

  ir.types.forEach((t) => {
    const events = ['update', 'timer', 'leave', 'animend'].filter((e) => hasScript(t, e));
    if (!events.length) return;
    any = true;
    const u = t.symbol.toUpperCase();
    const single = t.max === 1;
    const pad = single ? '\t\t' : '\t\t\t';

    if (single) {
      out.push(`\tIF e_type(${t.first}) THEN`);
      out.push(`\t\tself = ${t.first}`);
    } else {
      out.push(`\tFOR k_i = ${u}_FIRST TO ${u}_LAST`);
      out.push(`\t\tIF e_type(k_i) THEN`);
      out.push(`\t\t\tself = k_i`);
    }
    out.push(`${pad}IF (e_flags(self) AND 1) = 0 THEN`);

    if (hasScript(t, 'update')) {
      out.push(`${pad}\tGOSUB ${t.symbol}_update`);
    }
    if (hasScript(t, 'timer')) {
      out.push(`${pad}\tIF e_timer(self) THEN`);
      out.push(`${pad}\t\te_timer(self) = e_timer(self) - 1`);
      out.push(`${pad}\t\tIF e_timer(self) = 0 THEN GOSUB ${t.symbol}_timer`);
      out.push(`${pad}\tEND IF`);
    }
    if (hasScript(t, 'animend')) {
      out.push(`${pad}\tIF e_flags(self) AND 16 THEN GOSUB ${t.symbol}_animend`);
    }
    if (hasScript(t, 'leave')) {
      out.push(`${pad}\tIF e_y(self) > 200 THEN`);
      out.push(`${pad}\t\tGOSUB ${t.symbol}_leave`);
      out.push(`${pad}\tELSE`);
      out.push(`${pad}\t\tIF e_x(self) > 248 THEN GOSUB ${t.symbol}_leave`);
      out.push(`${pad}\tEND IF`);
    }

    out.push(`${pad}END IF`);
    if (single) {
      out.push(`\tEND IF`);
    } else {
      out.push(`\t\tEND IF`);
      out.push(`\tNEXT k_i`);
    }
  });

  if (!any) out.push(`\t' no type has an update-time script`);
  out.push('\tEND');
  return out;
}

/**
 * The hook the kernel's k_reap calls for each dying entity, with self
 * already set. Types with no `on destroy` fall straight through.
 */
export function emitDestroyDispatch(ir) {
  const out = ['k_on_destroy:\tPROCEDURE'];
  const withScript = ir.types.filter((t) => hasScript(t, 'destroy'));
  if (!withScript.length) {
    out.push(`\t' no type has an "on destroy" script`);
  } else {
    withScript.forEach((t) => {
      out.push(`\tIF e_type(self) = T_${t.symbol.toUpperCase()} THEN GOSUB ${t.symbol}_destroy`);
    });
  }
  out.push('\tEND');
  return out;
}
