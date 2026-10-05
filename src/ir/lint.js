/**
 * Lint rules over the IR.
 *
 * These run on every edit, cheaply, and surface as inline badges on the
 * actor and room lists rather than as a compile error after the fact. A
 * beginner has no mental model of console limits; the point is to make the
 * price visible next to the choice, so "my game broke" becomes "I cannot
 * afford twelve of these".
 *
 * Budget problems that are structural (pool overflow, VRAM overflow, field
 * budget) are raised by the IR builder itself, because it cannot finish its
 * allocation without noticing them. This file holds the rules that are about
 * the project making sense rather than about it fitting.
 */

export function lint(ir) {
  const out = [];

  if (!ir.types.length) {
    out.push(warn('no-actors', 'This project has no actor types yet.'));
    return out;
  }

  if (!ir.player) {
    out.push(warn('no-player',
        'No actor is flagged as the player. Blocks like "the player\'s x", ' +
      '"move toward the player" and the Chase behaviour will do nothing.'));
  } else if (ir.player.max !== 1) {
    out.push(warn('player-max',
        `${ir.player.name} is the player but its Max instances is ` +
      `${ir.player.max}. Only the first one counts as "the player".`));
  }

  ir.types.forEach((t) => {
    // A type with no way to be created is almost always a mistake, and it is
    // invisible otherwise: the game simply never shows it.
    const placed = ir.rooms.some((r) => r.placements.some((p) => p.type.key === t.key));
    const spawned = isSpawnedAnywhere(ir, t);
    if (!placed && !spawned) {
      out.push(warn('unreachable-actor',
          `${t.name} is never placed in a room and never spawned, so it will ` +
        `never appear.`, {actor: t.key}));
    }

    // Shoot and `on timer` both own e_timer. Letting them fight silently
    // would produce a bug with no visible cause.
    const shoots = (t.behaviours || []).some((b) => b.kind === 'shoot');
    if (shoots && hasStmts(t.scripts.timer)) {
      out.push(error('timer-conflict',
          `${t.name} has both the Shoot behaviour and an "on timer" script, ` +
        `and they share the same per-instance timer. Use one or the other.`,
          {actor: t.key}));
    }

    // Report what a Platform actor can actually reach.
    //
    // Jump height is not something anyone can eyeball from "jump strength
    // 4": it falls out of the initial velocity, the gravity, and the
    // quantisation of both into sixteenths of a pixel. Without this, levels
    // get drawn by eye and turn out to be unplayable - which is exactly what
    // happened to the sample platformer, whose lowest ledge was five tiles
    // up against a jump that cleared under three.
    (t.behaviours || []).forEach((b) => {
      if (b.kind !== 'platform') return;
      const reach = jumpReach(b, t);
      out.push(info('jump-reach',
          `${t.name} jumps ${reach.peakPx} px (${reach.peakTiles} tiles) and ` +
        `covers ${reach.spanPx} px (${reach.spanTiles} tiles) in the air. ` +
        `Keep ledges within ${Math.max(1, reach.peakTiles - 1)} tiles of ` +
        `each other.`, {actor: t.key}));
      if (reach.peakPx < 16) {
        out.push(warn('jump-too-weak',
            `${t.name} can only clear ${reach.peakTiles} tiles, so it cannot ` +
          `get onto anything. Raise Jump strength or lower Gravity.`,
            {actor: t.key}));
      }
    });

    // Health watches a field that has to exist.
    (t.behaviours || []).forEach((b) => {
      if (b.kind !== 'health') return;
      const fname = b.field || 'hp';
      if (!(t.fields || []).some((f) => f.name === fname)) {
        out.push(error('health-field',
            `${t.name}'s Health behaviour watches a field called "${fname}", ` +
          `but that actor has no such field.`, {actor: t.key}));
      }
    });

    // Spawning a type that has no slots in this project can never work.
    (t.behaviours || []).forEach((b) => {
      if (b.kind !== 'shoot' || !b.actor) return;
      const target = ir.types.find((x) => x.key === b.actor);
      if (!target) {
        out.push(error('shoot-target',
            `${t.name} shoots an actor that no longer exists.`, {actor: t.key}));
      } else if (target.max < 1) {
        out.push(error('shoot-target-max',
            `${t.name} shoots ${target.name}, but its Max instances is 0.`,
            {actor: t.key}));
      }
    });

    // A hitbox larger than the art is legal but almost never intended.
    if (t.hitbox.w > t.width || t.hitbox.h > t.height) {
      out.push(warn('hitbox-oversize',
          `${t.name}'s hitbox (${t.hitbox.w}x${t.hitbox.h}) is bigger than its ` +
        `art (${t.width}x${t.height}).`, {actor: t.key}));
    }

    // Nothing renders without an animation, and a frame count of one with a
    // rate set is a common confusion worth naming.
    t.animations.forEach((id) => {
      const a = ir.anims[id];
      if (a.len === 1 && a.loop === 0) {
        out.push(warn('animend-never',
            `${t.name}'s "${a.name}" has a single frame and does not loop, so ` +
          `"on animation end" will never fire for it.`, {actor: t.key}));
      }
    });
  });

  // A collide handler against a group with no members is dead code.
  ir.types.forEach((t) => {
    Object.keys(t.scripts || {}).forEach((key) => {
      if (!key.startsWith('collide:')) return;
      const group = key.slice('collide:'.length);
      if (!ir.byGroup[group]) {
        out.push(warn('empty-group',
            `${t.name} handles collisions with "${group}", but no actor is in ` +
          `that group.`, {actor: t.key}));
      }
    });
  });

  // A tune that does not exist would assemble to an undefined label, which
  // gasm80 reports while still exiting 0 and writing a ROM. Catch it here,
  // where the message can name the block.
  const knownTunes = ['title', 'action', 'gameover'];
  (ir.music || []).forEach((name) => {
    if (!knownTunes.includes(name)) {
      out.push(error('unknown-tune',
          `There is no tune called "${name}". Available: ` +
        knownTunes.join(', ') + '.'));
    }
  });

  // Blocks that name an actor which no longer exists.
  //
  // Deleting an actor strips its placements and any Shoot behaviour aimed at
  // it, because those are structural - a position with nothing to put there
  // means nothing. A `spawn` block is different: it is something the user
  // wrote, inside a script they may still want. So it is left alone and
  // reported, rather than quietly deleted behind their back.
  //
  // It has to be reported, though. The generator emits nothing at all for a
  // spawn it cannot resolve, so without this the block would sit in the
  // workspace looking correct and do nothing forever.
  const known = new Set(ir.types.map((t) => t.key));
  const danglingSpawns = [];
  const scan = (stmts, where) => (stmts || []).forEach((st) => {
    if (st.op === 'spawn' && st.actor && !known.has(st.actor)) {
      danglingSpawns.push({where, blockId: st.blockId});
    }
    scan(st.then, where);
    scan(st.else, where);
    scan(st.body, where);
  });
  Object.entries(ir.scripts || {}).forEach(([name, sc]) =>
    scan(sc && sc.stmts, `the "${name}" script`));
  ir.rooms.forEach((room) =>
    Object.values(room.scripts || {}).forEach((sc) =>
      scan(sc && sc.stmts, room.name)));
  ir.types.forEach((t) =>
    Object.entries(t.scripts || {}).forEach(([ev, sc]) =>
      scan(sc && sc.stmts, `${t.name}'s "${ev}"`)));
  danglingSpawns.forEach((d) => {
    out.push(error('dangling-spawn',
        `A "spawn" block in ${d.where} refers to an actor that no longer ` +
      `exists. Point it at something, or delete the block.`,
        {blockId: d.blockId}));
  });

  // Tilemaps are emitted in the Master System's two-bytes-a-cell format with
  // a RAM collision shadow. The TMS9918 machines need a different layout and
  // the profile turns the shadow off, so a room with tiles would build into
  // garbage there. Better refused than shipped.
  if (ir.target.video !== 'sms' && ir.rooms.some((r) => r.hasTerrain)) {
    out.push(error('terrain-unsupported',
        `Painted tiles are not supported on ${ir.target.label} yet. Clear ` +
      `the tiles from your rooms, or switch the target to the Master System.`));
  }

  // A cell pointing past the end of the tile set draws whatever happens to
  // be in VRAM there.
  ir.rooms.forEach((room) => {
    if (!room.tiles) return;
    let worst = -1;
    room.tiles.forEach((row) => (row || []).forEach((t) => {
      if ((t | 0) >= ir.tiles.length) worst = Math.max(worst, t | 0);
    }));
    if (worst >= 0) {
      out.push(error('tile-missing',
          `${room.name} uses tile ${worst}, but the tile set only goes up ` +
        `to ${ir.tiles.length - 1}.`, {room: room.key}));
    }
  });

  ir.rooms.forEach((room) => {
    if (!room.placements.length && !hasStmts(room.scripts.enter)) {
      out.push(warn('empty-room',
          `${room.name} places no actors and has no "on enter" script.`,
          {room: room.key}));
    }
  });

  // The two budgets the compiler cannot tell us about, because they are
  // about worst case rather than about this build.
  const hwPct = Math.round((ir.layout.worstHw / ir.target.hardwareSprites) * 100);
  if (hwPct > 100) {
    out.push(warn('sprite-rotate',
        `A full pool needs ${ir.layout.worstHw} of ${ir.target.hardwareSprites} ` +
      `hardware sprites. Over budget, actors flicker in and out rather than ` +
      `one disappearing for good.`));
  }

  return out;
}

function isSpawnedAnywhere(ir, target) {
  const inStmts = (stmts) => (stmts || []).some((s) => {
    if (s.op === 'spawn' && s.actor === target.key) return true;
    return inStmts(s.then) || inStmts(s.else) || inStmts(s.body);
  });

  if (inStmts(ir.scripts.gameStart?.stmts) || inStmts(ir.scripts.frame?.stmts)) return true;
  if (ir.rooms.some((r) => inStmts(r.scripts.enter?.stmts))) return true;
  return ir.types.some((t) =>
    (t.behaviours || []).some((b) => b.kind === 'shoot' && b.actor === target.key) ||
    Object.values(t.scripts || {}).some((s) => inStmts(s && s.stmts)));
}

function hasStmts(script) {
  return !!(script && script.stmts && script.stmts.length);
}

/**
 * What a Platform actor's jump actually reaches, in the same quantised units
 * the code generator will use - so the number the editor shows is the number
 * the game gets, not an idealised one.
 *
 * Velocity is v/16 px per frame and gravity g/16 px per frame squared, so
 * the peak is v^2 / (32g) pixels and the actor is airborne for 2v/g frames.
 */
export function jumpReach(b, type) {
  const v = Math.max(1, Math.round(num(b.jump, 3.5) * 16));
  const g = Math.max(1, Math.round(num(b.gravity, 0.25) * 16));
  const speed = Math.max(1, Math.round(num(b.speed, 2)));
  const peakPx = Math.floor((v * v) / (32 * g));
  const frames = Math.round((2 * v) / g);
  const spanPx = frames * speed;
  return {
    peakPx, spanPx, frames,
    peakTiles: Math.floor(peakPx / 8),
    spanTiles: Math.floor(spanPx / 8),
  };
}

function num(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

function info(code, message, extra = {}) {
  return {severity: 'info', code, message, ...extra};
}

function warn(code, message, extra = {}) {
  return {severity: 'warning', code, message, ...extra};
}

function error(code, message, extra = {}) {
  return {severity: 'error', code, message, ...extra};
}
