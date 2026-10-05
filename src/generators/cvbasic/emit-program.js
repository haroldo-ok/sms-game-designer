/**
 * IR -> a complete CVBasic program.
 *
 * Emission order is load-bearing. CVBasic compiles top to bottom and the
 * CPU will happily execute a BITMAP block as instructions, so execution has
 * to be parked - by an unconditional GOTO - before any PROCEDURE, DATA or
 * BITMAP. Everything below `GOTO game_loop` in the output is definitions.
 *
 * The other ordering rule is CONST before INCLUDE: CVBasic treats CONST as a
 * directive that applies from its point of appearance onwards, which is what
 * lets the hand-written kernel declare `DIM e_x(MAX_ENT)` without knowing
 * the pool size.
 *
 * Generated source is kept readable and commented on purpose. It is the
 * escape hatch for a user who outgrows blocks, and it is the primary
 * debugging surface for the tool itself.
 */

import {
  emitActorConstants, emitActorDims, emitSpawns, emitActorScripts,
  emitRunBehaviours, emitRunUpdates, emitDestroyDispatch, emitGroupTable,
} from './emit-actors.js';
import {emitCollisionProcs, emitRunCollisions} from './emit-collision.js';
import {emitRoomData, emitRoomProcs} from './emit-rooms.js';
import {
  emitSpriteData, emitTileData, emitPalette, emitAnimTables, emitSfxData,
  emitMusicData,
} from './emit-assets.js';
import {emitStmts} from './emit-stmt.js';

export const ENGINE_VERSION = 1;

export function generateProgram(ir, opts = {}) {
  const L = [];
  const map = []; // generated line -> block id, for error mapping
  const push = (line) => {
    L.push(line);
    const m = /^\s*' @blk:(\S+)/.exec(line);
    if (m) map.push({line: L.length, blockId: m[1]});
  };
  const pushAll = (lines) => lines.forEach(push);

  banner(push, ir, opts);

  push('\t\' ===== constants =====');
  pushAll(emitActorConstants(ir));
  push('');

  push('\t\' ===== entity pool and kernel declarations =====');
  push(`\tINCLUDE "engine/core.bas"`);
  push('');

  push('\t\' ===== generated variables =====');
  pushAll(emitActorDims(ir));
  push('');

  push('\t\' ===== start =====');
  push('\tGOSUB init_game');
  push('');
  push('game_loop:');
  push('\tWAIT');
  push('\tGOSUB run_behaviours');
  push('\tGOSUB run_updates');
  push('\tGOSUB run_collisions');
  push('\tGOSUB k_sfx');
  push('\tGOSUB k_reap');
  push('\tGOSUB k_render');
  if (hasStmts(ir.scripts.frame)) push('\tGOSUB frame_script');
  push('\tIF room_change THEN GOSUB go_to_room');
  push('\tGOTO game_loop');
  push('');
  push('\t\' ---------------------------------------------------------------');
  push('\t\' Everything below this line is procedures and data, never');
  push('\t\' reached by falling through.');
  push('\t\' ---------------------------------------------------------------');
  push('');

  push('init_game:\tPROCEDURE');
  if (ir.target.video === 'tms') {
    // Graphics II. Character definitions are faster in this mode, and it is
    // the only one with a full 256x192 bitmap-like background.
    push('\tMODE 2');
  } else {
    push('\tMODE 4');
    push('\tBORDER 0,4');
  }
  // Sprite flicker is deliberately left ON, which is CVBasic's default.
  //
  // It is tempting to turn it off: this engine tracks its own hardware
  // sprite budget and does its own drop rotation, so it does not want
  // CVBasic's as well. But SPRITE FLICKER OFF selects a path in the SMS
  // prologue that reloads HL with `sprites` instead of `sprites+$80` before
  // copying the X/pattern half of the attribute table, so that half gets
  // filled from the Y table. Every sprite ends up with a pattern number
  // equal to its Y coordinate, which draws the whole cast as thin vertical
  // slivers.
  //
  // The flicker path is correct - it steps the source seven sprites at a
  // time, which is a permutation of the 64 slots and invisible as long as
  // every slot always holds valid data. k_render guarantees that by parking
  // unused slots instead of terminating the list with $d0.
  //
  // Staying on stock CVBasic matters more than the few cycles this costs: a
  // patched compiler would break the promise that exported source builds
  // as-is.
  if (ir.target.video === 'sms') {
    push('\tPALETTE LOAD palette_data');
  }
  if ((ir.music || []).length) {
    // SIMPLE uses two channels and NO DRUMS leaves the noise channel alone,
    // which is exactly what the sound effect player needs. FULL would take
    // all three and silence every effect in the game.
    push('\tPLAY SIMPLE NO DRUMS');
  }
  if (ir.layout.spriteDefs > 0) {
    push(`\tDEFINE SPRITE 0,${ir.layout.spriteDefs},sprite_data`);
  }
  // Every project now starts with a tile set, but a game with no tilemap
  // should not spend ROM and VRAM on art it never draws.
  if (ir.tiles.length && ir.rooms.some((r) => r.hasTerrain)) {
    push(`\tDEFINE CHAR ${ir.layout.tileBase},${ir.tiles.length},tile_data`);
  }
  ir.globals.forEach((g) => push(`\t${g.symbol} = ${g.initial}`));
  push('\tgame_state = 0');
  push('\tdropped = 0');
  push('\tsfx_t = 255');
  ir.types.filter((t) => t.reuseOldest).forEach((t) => {
    push(`\t${t.symbol}_rr = ${t.first}`);
  });
  if (hasStmts(ir.scripts.gameStart)) {
    pushAll(emitStmts(ir.scripts.gameStart.stmts,
        {ir, type: null, indent: '\t', spawnDepth: 0}));
  }
  push('\tGOSUB do_title');
  push('\tnext_room = 0');
  push('\tGOSUB go_to_room');
  push('\tEND');
  push('');

  if (hasStmts(ir.scripts.frame)) {
    push('\t\'');
    push('\t\' The global "on frame" script: HUD, score, room flow. Runs after');
    push('\t\' rendering, so a value it prints is this frame\'s value.');
    push('\t\'');
    push('frame_script:\tPROCEDURE');
    pushAll(emitStmts(ir.scripts.frame.stmts,
        {ir, type: null, indent: '\t', spawnDepth: 0}));
    push('\tEND');
    push('');
  }

  push('\t\' ===== dispatchers =====');
  pushAll(emitRunBehaviours(ir));
  push('');
  pushAll(emitRunUpdates(ir));
  push('');
  pushAll(emitRunCollisions(ir));
  push('');
  pushAll(emitDestroyDispatch(ir));
  push('');

  push('\t\' ===== spawning =====');
  pushAll(emitSpawns(ir));

  push('\t\' ===== actor scripts and behaviours =====');
  pushAll(emitActorScripts(ir));

  push('\t\' ===== collision =====');
  pushAll(emitCollisionProcs(ir));

  push('\t\' ===== rooms =====');
  pushAll(emitRoomProcs(ir));
  push('');

  push('\t\' ===== engine kernel =====');
  push(`\tINCLUDE "engine/kernel.bas"`);
  // Only the renderer is target-specific. Everything else - pool, movers,
  // animation, reaping, terrain, sound - is shared, which is the claim the
  // whole target-profile idea rests on.
  push(`\tINCLUDE "engine/render_${ir.target.video}.bas"`);
  if (ir.rooms.some((r) => r.hasTerrain)) {
    push(`\tINCLUDE "engine/terrain.bas"`);
  }
  push('');

  push('\t\' ===== data =====');
  pushAll(emitAnimTables(ir));
  push('');
  pushAll(emitGroupTable(ir));
  push('');
  pushAll(emitSfxData());
  push('');
  pushAll(emitMusicData(ir));
  push('');
  if (ir.target.video === 'sms') {
    pushAll(emitPalette(ir));
    push('');
  }
  pushAll(emitSpriteData(ir));
  push('');
  if (ir.rooms.some((r) => r.hasTerrain)) pushAll(emitTileData(ir));
  push('');
  pushAll(emitRoomData(ir));

  return {source: L.join('\n') + '\n', lineMap: map};
}

function banner(push, ir, opts) {
  const bar = '\t\' ' + '*'.repeat(72);
  push(bar);
  push(`\t' ${ir.name || 'Untitled'}`);
  push(`\t' Target: ${ir.target.label}`);
  if (opts.author) push(`\t' Author: ${opts.author}`);
  push('\t\'');
  push('\t\' Generated by SMS Game Designer. Engine kernel version ' + ENGINE_VERSION + '.');
  push('\t\'');
  push(`\t' ${ir.layout.maxEnt} entity slots, ${ir.types.length} actor types, ` +
    `${ir.pairs.length} collision pair${ir.pairs.length === 1 ? '' : 's'},`);
  push(`\t' ${ir.layout.spriteDefs} sprite definitions of ` +
    `${ir.target.spriteDefBudget}, about ${ir.layout.ramEstimate} bytes of RAM.`);
  push('\t\'');
  push('\t\' This file is meant to be readable: if you have outgrown the');
  push('\t\' blocks, it builds as-is with cvbasic + gasm80 once you have the');
  push('\t\' engine/ directory alongside it.');
  push(bar);
  push('');
}

function hasStmts(script) {
  return !!(script && script.stmts && script.stmts.length);
}
