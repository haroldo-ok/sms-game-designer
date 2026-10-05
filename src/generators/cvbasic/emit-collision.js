/**
 * Collision matrix -> CVBasic procedures.
 *
 * The user never writes a collision test. They write `on collide with
 * <group>` on a type and the IR derives the matrix; this file emits one
 * specialised, doubly-nested loop per enabled pair, with both slot ranges
 * and both hitbox extents baked in as literals.
 *
 * The overlap test
 *
 *     ct = (a - b + h)        ' 8-bit, wrapping
 *     IF ct < 2h THEN ...
 *
 * is the standard unsigned-wrap AABB check: one subtract, one add and one
 * compare per axis, with no ABS and no signed arithmetic.
 *
 * It only compiles to that, though, if the whole expression is stored into
 * an 8-bit variable first. Written inline inside the IF, CVBasic promotes
 * the intermediate to 16 bits (LD L,A / LD H,0 before the add), the wrap
 * never happens, and every negative difference reads as a large positive
 * number - so the test silently rejects half of all real overlaps. Assigning
 * to `ct` keeps it in the accumulator: SUB B / ADD A,n / CP m. That is four
 * instructions instead of a dozen, and it is correct.
 *
 * Y is tested first. Vertical separation rejects most candidate pairs in
 * shmups and platformers, so the X test runs only for the survivors.
 */

export function emitCollisionProcs(ir) {
  const out = [];
  ir.pairs.forEach((p) => {
    out.push('\t\'');
    out.push(`\t' ${p.groupA} vs ${p.groupB} - ${p.candidates} candidate pairs` +
      (p.timeSlice ? ', checked every other frame' : ''));
    out.push('\t\'');
    out.push(`${p.symbol}:\tPROCEDURE`);
    if (!p.ranges.length) {
      out.push(`\t' no type pair in this group pair has a handler`);
      out.push('\tEND');
      out.push('');
      return;
    }
    p.ranges.forEach((r) => emitRange(r, p, out));
    out.push('\tEND');
    out.push('');
  });
  return out;
}

function emitRange(r, pair, out) {
  const ua = r.a.symbol.toUpperCase();
  const ub = r.b.symbol.toUpperCase();

  // Fold the two hitbox offsets and the half-extent into one constant each,
  // added once in the outer loop rather than twice per candidate.
  const kx = r.ax - r.bx + r.hx;
  const ky = r.ay - r.by + r.hy;
  const spanX = r.hx * 2;
  const spanY = r.hy * 2;

  const singleA = r.a.max === 1;
  const singleB = r.b.max === 1;

  let pad = '\t';
  if (singleA) {
    out.push(`${pad}IF e_type(${r.a.first}) THEN`);
    out.push(`${pad}\tca = ${r.a.first}`);
    pad += '\t';
  } else if (pair.timeSlice) {
    // Half the outer range on even frames, half on odd. A bullet travelling
    // 4 px a frame can afford a two-frame collision period; the profiler
    // says so explicitly rather than leaving it a mystery.
    out.push(`${pad}FOR ca = ${ua}_FIRST + (FRAME AND 1) TO ${ua}_LAST STEP 2`);
    out.push(`${pad}\tIF e_type(ca) THEN`);
    pad += '\t\t';
  } else {
    out.push(`${pad}FOR ca = ${ua}_FIRST TO ${ua}_LAST`);
    out.push(`${pad}\tIF e_type(ca) THEN`);
    pad += '\t\t';
  }

  out.push(`${pad}cax = ${offsetExpr('e_x(ca)', kx)}`);
  out.push(`${pad}cay = ${offsetExpr('e_y(ca)', ky)}`);

  let innerPad = pad;
  if (singleB) {
    out.push(`${pad}IF e_type(${r.b.first}) THEN`);
    out.push(`${pad}\tcb = ${r.b.first}`);
    innerPad = pad + '\t';
  } else {
    out.push(`${pad}FOR cb = ${ub}_FIRST TO ${ub}_LAST`);
    out.push(`${pad}\tIF e_type(cb) THEN`);
    innerPad = pad + '\t\t';
  }

  out.push(`${innerPad}ct = cay - e_y(cb)`);
  out.push(`${innerPad}IF ct < ${spanY} THEN`);
  out.push(`${innerPad}\tct = cax - e_x(cb)`);
  out.push(`${innerPad}\tIF ct < ${spanX} THEN`);

  // If only one side declares a handler, only that side is called. This
  // halves the work for the very common "bullet hits enemy, enemy reacts"
  // shape, where the bullet has nothing to say.
  if (r.aHandler) {
    out.push(`${innerPad}\t\tself = ca`);
    out.push(`${innerPad}\t\tother = cb`);
    out.push(`${innerPad}\t\tGOSUB ${r.aHandler}`);
  }
  if (r.bHandler) {
    out.push(`${innerPad}\t\tself = cb`);
    out.push(`${innerPad}\t\tother = ca`);
    out.push(`${innerPad}\t\tGOSUB ${r.bHandler}`);
  }
  // Destruction is deferred, so e_type(ca) is still set here and the loop
  // stays valid. But a bullet that just died should not go on to hit a
  // second enemy in the same frame, so bail out of the inner loop.
  if (!singleB) {
    out.push(`${innerPad}\t\tIF e_flags(ca) AND 2 THEN EXIT FOR`);
  }

  out.push(`${innerPad}\tEND IF`);
  out.push(`${innerPad}END IF`);

  if (singleB) {
    out.push(`${pad}END IF`);
  } else {
    out.push(`${pad}\tEND IF`);
    out.push(`${pad}NEXT cb`);
  }

  if (singleA) {
    out.push('\tEND IF');
  } else {
    out.push(`${pad.slice(0, -1)}END IF`);
    out.push(`${pad.slice(0, -2)}NEXT ca`);
  }
}

export function emitRunCollisions(ir) {
  const out = ['run_collisions:\tPROCEDURE'];
  if (!ir.pairs.length) {
    out.push(`\t' no group pair has a collision handler`);
  } else {
    ir.pairs.forEach((p) => out.push(`\tGOSUB ${p.symbol}`));
  }
  out.push('\tEND');
  return out;
}

/** `base + k`, folded to a subtract when k is negative and dropped when 0. */
function offsetExpr(base, k) {
  const v = ((k % 256) + 256) % 256;
  if (v === 0) return base;
  if (v > 128) return `${base} - ${256 - v}`;
  return `${base} + ${v}`;
}
