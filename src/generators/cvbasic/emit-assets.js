/**
 * Art and tables -> CVBasic data blocks.
 *
 * Everything this file emits is read-only, so it all goes in ROM: sprite
 * bitmaps, background characters, the palette, and the six per-animation
 * tables the kernel's renderer indexes. Putting the animation tables in ROM
 * rather than declaring them with DIM matters more than it sounds - at four
 * animations per actor and a dozen actors they would be a few hundred bytes
 * of RAM spent on values that never change.
 *
 * Two SMS-specific formats, both confirmed against the compiler rather than
 * assumed:
 *
 *   - A sprite is 8x16. Sixteen BITMAP lines of 8 hex digits produce exactly
 *     one 64-byte definition; sixteen lines of 16 digits produce two, which
 *     is how a 16x16 actor is built.
 *   - A background character is 8x8 and 32 bytes, written as eight BITMAP
 *     lines of 8 digits - not the eight bytes a TMS9918 character takes,
 *     because the SMS definition carries its own colour.
 *
 * Colour index 0 is transparent for sprites and is written as ".".
 */

import {
  BUILTIN_SFX, BUILTIN_TUNES, SFX_ORDER, TUNE_ORDER, sfxList, sfxBytes,
  tuneList, voiceTokens,
} from '../../ir/sound.js';
import {tmsTileRows} from '../../ir/tms.js';

const HEX = '0123456789ABCDEF';

export function emitSpriteData(ir) {
  const out = [];
  const tms = ir.target.video === 'tms';
  out.push('\t\'');
  out.push('\t\' Sprite definitions, in the order the IR allocated them, so a');
  out.push('\t\' single DEFINE SPRITE loads the lot.');
  if (tms) {
    out.push('\t\'');
    out.push('\t\' A TMS9918 sprite is one colour throughout, so the art is a');
    out.push('\t\' one-bit mask: any non-transparent pixel is set. The colour');
    out.push('\t\' itself is in a_col, one entry per animation.');
  }
  out.push('\t\'');
  out.push('sprite_data:');
  if (!ir.anims.length) {
    out.push('\t\' no actors yet');
    out.push('\tDATA BYTE 0,0,0,0');
    return out;
  }

  // Walk animations in allocation order so the ROM layout matches the
  // definition numbers baked into a_fbase.
  const ordered = [...ir.anims].sort((a, b) => a.firstDef - b.firstDef);
  ordered.forEach((anim) => {
    out.push(`\t' ${anim.symbol} (${anim.len} frame${anim.len === 1 ? '' : 's'}, def ${anim.firstDef})`);
    for (let f = 0; f < anim.len; f++) {
      const frame = anim.frames[f] || {pixels: []};
      emitFrame(frame, anim.width, anim.height, out, tms);
    }
  });
  return out;
}

function emitFrame(frame, width, height, out, tms) {
  const px = frame.pixels || [];
  for (let y = 0; y < height; y++) {
    const row = px[y] || [];
    let line = '';
    for (let x = 0; x < width; x++) {
      const v = row[x] | 0;
      line += v === 0 ? '.' : (tms ? '1' : HEX[v & 15]);
    }
    // A TMS9918 sprite is always 16 wide; an 8-wide actor is padded rather
    // than costing a different number of definitions.
    if (tms && width < 16) line += '.'.repeat(16 - width);
    out.push(`\tBITMAP "${line}"`);
  }
}

export function emitTileData(ir) {
  const out = [];
  if (!ir.tiles.length) return out;
  if (ir.target.video === 'tms') return emitTmsTileData(ir);
  out.push('\t\'');
  out.push('\t\' Background characters. 8x8, 32 bytes each on the SMS.');
  out.push('\t\'');
  out.push('tile_data:');
  ir.tiles.forEach((tile, i) => {
    out.push(`\t' tile ${i}${tile.name ? ' - ' + tile.name : ''}`);
    const px = tile.pixels || [];
    for (let y = 0; y < 8; y++) {
      const row = px[y] || [];
      let line = '';
      for (let x = 0; x < 8; x++) {
        const v = row[x] | 0;
        line += v === 0 ? '.' : HEX[v & 15];
      }
      out.push(`\tBITMAP "${line}"`);
    }
  });
  return out;
}

/**
 * Background characters for the TMS9918: one bit per pixel, plus a colour
 * table giving each row of each tile its two colours. See ir/tms.js for how
 * sixteen-colour art becomes that.
 */
function emitTmsTileData(ir) {
  const out = [];
  const colour = [];
  const pal = (ir.palette && ir.palette.background) || [];
  out.push('\t\'');
  out.push('\t\' Background characters. 8x8, one bit per pixel; tile_colour');
  out.push('\t\' gives each row its foreground and background colour.');
  out.push('\t\'');
  out.push('tile_data:');
  ir.tiles.forEach((tile, i) => {
    const rows = tmsTileRows(tile, pal);
    out.push(`\t' tile ${i}${tile.name ? ' - ' + tile.name : ''}`);
    rows.forEach((r) => {
      out.push(`\tBITMAP "${r.bits.map((b) => (b ? 'X' : '.')).join('')}"`);
    });
    colour.push(`\tDATA BYTE ${rows.map((r) =>
      '$' + ((r.fg << 4) | r.bg).toString(16).padStart(2, '0')).join(',')}`);
  });
  out.push('');
  out.push('tile_colour:');
  colour.forEach((l) => out.push(l));
  return out;
}

export function emitPalette(ir) {
  const pal = ir.palette || {};
  const bg = pad16(pal.background);
  const spr = pad16(pal.sprite);
  return [
    '\t\'',
    '\t\' 32 palette registers: 0-15 background, 16-31 sprites.',
    '\t\' Each byte is 00BBGGRR, two bits per channel.',
    '\t\'',
    'palette_data:',
    `\tDATA BYTE ${bg.map(hex).join(',')}`,
    `\tDATA BYTE ${spr.map(hex).join(',')}`,
  ];
}

/**
 * The six tables k_render and k_animate index by animation id. One entry per
 * animation, in id order.
 */
export function emitAnimTables(ir) {
  const out = [];
  // The kernel references these tables unconditionally, so a project with no
  // actors yet - which is every project for its first few minutes - still
  // needs them to exist. One dummy entry is cheaper than making the kernel
  // conditional, and it keeps a brand new project buildable, which matters:
  // "press Play and see a black screen" should work before you have drawn
  // anything.
  const a = ir.anims.length ? ir.anims :
    [{len: 1, rate: 8, loop: 1, fbase: 0, fstep: 2, wide: 0}];

  // Flat per-frame table. Entry (a_fofs(anim) + frame) is that frame's
  // SPRITE "f" value with bit 0 set when the actor is 16 pixels wide - see
  // the note in engine/kernel.bas for why this is flat rather than computed
  // from a base and a stride.
  const fdata = [];
  const fofs = [];
  a.forEach((anim) => {
    fofs.push(fdata.length);
    for (let i = 0; i < anim.len; i++) {
      fdata.push((anim.fbase + i * anim.fstep) | anim.wide);
    }
  });

  out.push('\t\'');
  out.push('\t\' Per-animation tables, indexed by e_anim. See engine/kernel.bas.');
  out.push('\t\'');
  out.push(`a_fofs:\tDATA BYTE ${fofs.join(',')}`);
  out.push(`a_len:\tDATA BYTE ${a.map((x) => x.len).join(',')}`);
  out.push(`a_rate:\tDATA BYTE ${a.map((x) => x.rate).join(',')}`);
  out.push(`a_loop:\tDATA BYTE ${a.map((x) => x.loop).join(',')}`);
  if (ir.target.video === 'tms') {
    out.push('\t\' One colour per sprite on this VDP - see dominantColour.');
    out.push(`a_col:\tDATA BYTE ${a.map((x) => x.colour == null ? 15 : x.colour).join(',')}`);
  }
  out.push('\t\' Flat frame table: f value in bits 1-7, "16 wide" in bit 0.');
  for (let i = 0; i < fdata.length; i += 16) {
    out.push(`${i === 0 ? 'af_data:' : ''}\tDATA BYTE ${fdata.slice(i, i + 16).join(',')}`);
  }
  if (fdata.length > 255) {
    throw new Error('more than 255 animation frames; af_data needs a 16-bit index');
  }
  return out;
}

/**
 * Sound effect envelopes: the five built-ins, then the project's own.
 *
 * Three bytes per step - frequency low, frequency high, volume - with bit 7
 * of the volume byte selecting the noise channel and 255 ending the effect.
 * The definitions and the byte layout live in ir/sound.js, because the
 * editor previews from the same description.
 */
export function emitSfxData(ir) {
  const out = ['\t\''];
  out.push('\t\' Sound effects: three bytes a step, 255 volume ends one.');
  if (ir && ir.target.sound === 'ay') {
    out.push('\t\' They play on AY channel C, leaving A and B for the music');
    out.push('\t\' player.');
  } else {
    out.push('\t\' Tones go to PSG channel 2 and noise to channel 3, leaving');
    out.push('\t\' channels 0 and 1 for the music player.');
  }
  out.push('\t\'');
  const sounds = (ir && ir.sounds) || sfxList(null);
  const offsets = [];
  const bytes = [];
  const starts = [];
  sounds.forEach((sfx) => {
    offsets.push(bytes.length);
    starts.push({at: bytes.length, name: sfx.name});
    bytes.push(...sfxBytes(sfx));
  });
  // 16-bit offsets (a label starting with # is a word table in CVBasic).
  // Byte offsets ran out at 255 bytes, which is the five built-ins plus
  // about two effects of the project's own.
  out.push(`#sfx_ofs:\tDATA ${offsets.join(',')}`);
  let first = true;
  starts.forEach((start, n) => {
    const end = n + 1 < starts.length ? starts[n + 1].at : bytes.length;
    out.push(`\t' ${n}: ${String(start.name).replace(/[^\x20-\x7e]/g, '?')}`);
    for (let i = start.at; i < end; i += 15) {
      out.push(`${first ? 'sfx_data:' : ''}\tDATA BYTE ` +
        bytes.slice(i, Math.min(end, i + 15)).join(','));
      first = false;
    }
  });
  return out;
}

/**
 * An effect's index in the table, by key. An effect that no longer exists -
 * deleted while a block still names it - plays the first one rather than
 * indexing off the end of the table; the lint reports it.
 */
export function sfxIndex(ir, key) {
  const sounds = (ir && ir.sounds) || sfxList(null);
  const i = sounds.findIndex((s) => s.key === key);
  return i < 0 ? 0 : i;
}

// Kept for anything that imported them from here before sound moved.
export const SFX = BUILTIN_SFX;
export const TUNES = BUILTIN_TUNES;
export {SFX_ORDER, TUNE_ORDER};

/**
 * Tunes: only the ones this project plays, built-in or its own.
 *
 * Two voices, not three: PLAY SIMPLE NO DRUMS leaves the third tone channel
 * and the noise channel free, which is exactly what the sound effect player
 * uses. Music and effects therefore never cut each other off.
 */
export function emitMusicData(ir) {
  const out = [];
  const used = ir.music || [];
  if (!used.length) return out;
  out.push('\t\'');
  out.push('\t\' Music. Two voices, so the third tone channel and the noise');
  out.push('\t\' channel stay free for sound effects. Tempo is ticks per note');
  out.push('\t\' at 50 Hz.');
  out.push('\t\'');
  const tunes = ir.tunes || tuneList(null);
  used.forEach((key) => {
    const tune = tunes.find((t) => t.key === key);
    if (!tune) return;
    const lead = voiceTokens(tune.lead);
    const bass = voiceTokens(tune.bass);
    const rows = Math.max(lead.length, bass.length);
    if (!tune.builtin) {
      out.push(`\t' ${String(tune.name).replace(/[^\x20-\x7e]/g, '?')}`);
    }
    out.push(`music_${key}:`);
    out.push(`\tDATA BYTE ${tune.tempo}`);
    for (let i = 0; i < rows; i++) {
      out.push(`\tMUSIC ${lead[i] || '-'},${bass[i] || '-'}`);
    }
    out.push(`\tMUSIC ${tune.loop ? 'REPEAT' : 'STOP'}`);
    out.push('');
  });
  return out;
}

function pad16(arr) {
  const a = Array.isArray(arr) ? arr.slice(0, 16) : [];
  while (a.length < 16) a.push(0);
  return a;
}

function hex(v) {
  return '$' + (v & 63).toString(16).padStart(2, '0');
}
