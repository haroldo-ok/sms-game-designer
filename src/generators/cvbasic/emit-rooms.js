/**
 * Rooms -> CVBasic.
 *
 * A room is a tilemap, a set of placed instances, and an `on enter` script.
 * It is also the unit of resource budgeting: all the art for every actor
 * type that a room can contain is in VRAM for the whole time the room runs,
 * so "does this fit" is a per-room question.
 *
 * Two tables per room with terrain:
 *
 *   - the name table image, two bytes per cell, copied straight to VRAM with
 *     one SCREEN statement (the SMS doubles the offsets and width for you);
 *   - the collision attribute shadow, one byte per cell, copied into RAM.
 *
 * The shadow exists because terrain collision is queried several times per
 * entity per frame and VPEEK on the SMS goes through RDVRM with interrupts
 * disabled - around ninety cycles a read, against roughly forty for the RAM
 * array. At 896 bytes it is an easy trade on a machine with 8 KB.
 */

import {emitStmts} from './emit-stmt.js';

export function emitRoomData(ir) {
  const out = [];
  ir.rooms.forEach((room) => {
    if (!room.hasTerrain) return;
    const cols = ir.target.screenCols;
    const rows = ir.target.screenRows;
    const tiles = room.tiles || [];

    out.push(`\t' ---- ${room.name}: name table image (2 bytes per cell) ----`);
    out.push(`map_${room.symbol}:`);
    for (let y = 0; y < rows; y++) {
      const bytes = [];
      for (let x = 0; x < cols; x++) {
        const t = (tiles[y] && tiles[y][x]) | 0;
        // Low byte is the pattern number, high byte the per-cell flags
        // (bit 0 selects patterns 256-511, bit 3 uses the sprite palette).
        bytes.push((t + ir.layout.tileBase) & 255, 0);
      }
      out.push(`\tDATA BYTE ${bytes.join(',')}`);
    }

    out.push(`\t' ---- ${room.name}: collision attributes (1 byte per cell) ----`);
    out.push(`attr_${room.symbol}:`);
    for (let y = 0; y < rows; y++) {
      const bytes = [];
      for (let x = 0; x < cols; x++) {
        const t = (tiles[y] && tiles[y][x]) | 0;
        const def = ir.tiles[t];
        bytes.push((def && def.attr) | 0);
      }
      out.push(`\tDATA BYTE ${bytes.join(',')}`);
    }
    out.push('');
  });
  return out;
}

/**
 * Room entry: clear the pool, load terrain, place the room's instances, then
 * run `on enter`. Each placement runs the type's `on create`, exactly as a
 * runtime spawn would, so an actor behaves the same whether it was placed in
 * the editor or spawned by a script.
 */
export function emitRoomProcs(ir) {
  const out = [];
  ir.rooms.forEach((room) => {
    out.push(`\t'`);
    out.push(`\t' Enter room: ${room.name}`);
    out.push(`\t'`);
    out.push(`enter_${room.symbol}:\tPROCEDURE`);
    out.push('\tGOSUB k_clear_pool');

    if (room.music && (ir.music || []).includes(room.music)) {
      out.push(`\tPLAY music_${room.music}`);
    }
    if (room.hasTerrain) {
      out.push(`\tSCREEN map_${room.symbol},0,0,${ir.target.screenCols},${ir.target.screenRows}`);
      out.push(`\t#k_p = VARPTR attr_${room.symbol}(0)`);
      out.push('\tGOSUB k_load_map');
    } else {
      out.push('\tCLS');
    }

    room.placements.forEach((pl) => {
      out.push(`\tsp_x = ${pl.x} : sp_y = ${pl.y}`);
      out.push(`\tGOSUB spawn_${pl.type.symbol}`);
      if (hasStmts(pl.type.scripts.create)) {
        out.push('\tIF sp_slot <> 255 THEN');
        out.push('\t\tself = sp_slot');
        out.push(`\t\tGOSUB ${pl.type.symbol}_create`);
        out.push('\tEND IF');
      }
    });

    if (hasStmts(room.scripts.enter)) {
      const ctx = {ir, type: null, indent: '\t', spawnDepth: 0};
      emitStmts(room.scripts.enter.stmts, ctx).forEach((l) => out.push(l));
    }

    out.push('\tcur_room = ' + room.index);
    out.push('\tEND');
    out.push('');
  });

  // Room flow. A plain IF chain rather than ON..GOSUB: at the handful of
  // rooms a project this size has, the chain is smaller and it keeps the
  // generated source readable, which is the export path for users
  // graduating to real CVBasic.
  out.push('\t\'');
  out.push('\t\' Switch to whichever room next_room names.');
  out.push('\t\'');
  out.push('go_to_room:\tPROCEDURE');
  out.push('\tIF game_state = 2 THEN GOSUB do_game_over');
  ir.rooms.forEach((room) => {
    out.push(`\tIF next_room = ${room.index} THEN GOSUB enter_${room.symbol}`);
  });
  out.push('\troom_change = 0');
  out.push('\tEND');
  out.push('');

  // "game over" used to set a flag that nothing read, so the block silently
  // did nothing. It clears the field, says so, waits for the player, then
  // puts every global back to its starting value and returns to room 0.
  out.push('\t\'');
  out.push('\t\' Game over: clear the field, wait for the player, start again.');
  out.push('\t\'');
  const title = ir.title || {};
  const name = (title.text || ir.name || 'GAME').toUpperCase().slice(0, 30);
  out.push('\t\'');
  out.push('\t\' Title screen. Shown at boot and again after a game over, so');
  out.push('\t\' losing returns you somewhere that looks deliberate rather');
  out.push('\t\' than dropping you straight back into play.');
  out.push('\t\'');
  out.push('do_title:\tPROCEDURE');
  out.push('\tGOSUB k_clear_pool');
  out.push('\tGOSUB k_render');
  out.push('\tCLS');
  if (title.music && (ir.music || []).includes(title.music)) {
    out.push(`\tPLAY music_${title.music}`);
  }
  out.push(`\tPRINT AT ${centre(name, 9)},"${name}"`);
  if (title.subtitle) {
    const sub = String(title.subtitle).toUpperCase().slice(0, 30);
    out.push(`\tPRINT AT ${centre(sub, 12)},"${sub}"`);
  }
  out.push(`\tPRINT AT ${centre('PRESS FIRE', 16)},"PRESS FIRE"`);
  // Wait for release then press, so the button that dismissed the last
  // screen does not dismiss this one too. The second loop compares against
  // zero rather than using NOT, which in CVBasic is a bitwise complement and
  // is non-zero either way.
  out.push('\tWHILE CONT1.BUTTON');
  out.push('\t\tWAIT');
  out.push('\tWEND');
  out.push('\tWHILE CONT1.BUTTON = 0');
  out.push('\t\tWAIT');
  out.push('\tWEND');
  out.push('\tPLAY OFF');
  out.push('\tCLS');
  out.push('\tEND');
  out.push('');

  out.push('do_game_over:\tPROCEDURE');
  out.push('\tGOSUB k_clear_pool');
  out.push('\tGOSUB k_render');
  out.push('\tCLS');
  if ((ir.music || []).includes('gameover')) {
    out.push('\tPLAY music_gameover');
  }
  out.push('\tPRINT AT 365,"GAME OVER"');
  out.push('\tFOR k_lp = 0 TO 90');
  out.push('\t\tWAIT');
  out.push('\tNEXT k_lp');
  out.push('\tFOR k_lp = 0 TO 60');
  out.push('\t\tWAIT');
  out.push('\tNEXT k_lp');
  out.push('\tPLAY OFF');
  ir.globals.forEach((g) => out.push(`\t${g.symbol} = ${g.initial}`));
  out.push('\tgame_state = 0');
  out.push('\tnext_room = 0');
  out.push('\tGOSUB do_title');
  out.push('\tEND');
  return out;
}

/** PRINT AT position that centres a string on a 32-column row. */
function centre(text, row) {
  const col = Math.max(0, Math.floor((32 - text.length) / 2));
  return row * 32 + col;
}

function hasStmts(script) {
  return !!(script && script.stmts && script.stmts.length);
}
