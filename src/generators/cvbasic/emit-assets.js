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
 * Sound effect envelopes.
 *
 * Built in rather than authored, at least for now: a beginner needs a shot,
 * a pickup and an explosion long before they need an envelope editor, and
 * five good defaults get a game feeling alive in the first ten minutes.
 *
 * Three bytes per step - frequency low, frequency high, volume - with bit 7
 * of the volume byte selecting the noise channel and 255 ending the effect.
 * The PSG divider for a tone is 3579545 / 32 / frequency.
 */
export const SFX = {
  shoot: sweep(1400, 400, 6, 12),
  pickup: steps([[880, 10], [1320, 11], [1760, 12], [1760, 6]]),
  explode: noise([14, 13, 12, 10, 9, 7, 6, 4, 3, 2, 1]),
  jump: sweep(300, 900, 5, 8),
  hurt: sweep(500, 90, 7, 16),
};

export const SFX_ORDER = ['shoot', 'pickup', 'explode', 'jump', 'hurt'];

function divider(hz) {
  return Math.max(1, Math.min(1023, Math.round(3579545 / 32 / hz)));
}

/** A glide from one pitch to another, fading out. */
function sweep(from, to, vol, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const hz = from + ((to - from) * i) / (n - 1);
    const d = divider(hz);
    out.push([d & 255, d >> 8, Math.max(0, Math.round(vol * (1 - i / n)))]);
  }
  return out;
}

/** Explicit pitch/volume steps. */
function steps(list) {
  return list.map(([hz, vol]) => {
    const d = divider(hz);
    return [d & 255, d >> 8, vol];
  });
}

/** White noise on channel 3, fading. Control 4 is periodic white noise. */
function noise(vols) {
  return vols.map((v) => [4, 0, 128 | v]);
}

export function emitSfxData() {
  const out = ['\t\''];
  out.push('\t\' Sound effects: three bytes a step, 255 volume ends one.');
  out.push('\t\' Tones go to PSG channel 2 and noise to channel 3, leaving');
  out.push('\t\' channels 0 and 1 for the music player.');
  out.push('\t\'');
  const offsets = [];
  const bytes = [];
  SFX_ORDER.forEach((name) => {
    offsets.push(bytes.length);
    SFX[name].forEach((step) => bytes.push(...step));
    bytes.push(0, 0, 255);
  });
  if (bytes.length > 255) {
    throw new Error('sound effect data exceeds 255 bytes; sfx_ofs needs a ' +
      '16-bit index');
  }
  out.push(`sfx_ofs:\tDATA BYTE ${offsets.join(',')}`);
  for (let i = 0; i < bytes.length; i += 15) {
    out.push(`${i === 0 ? 'sfx_data:' : ''}\tDATA BYTE ${bytes.slice(i, i + 15).join(',')}`);
  }
  return out;
}

/**
 * Built-in tunes.
 *
 * A tracker is the right long-term answer, but a game with no music at all
 * feels dead, and nobody's first ten minutes should be spent entering notes.
 * These three cover the shape of a game: a title loop, something to play
 * under the action, and a short sting when you lose.
 *
 * Each voice is a space-separated list of tokens in CVBasic's own notation -
 * `C4` for a note, `S` to sustain the previous one, `-` for silence - so the
 * generated source stays readable and a user who outgrows this can edit it
 * by hand. Instrument letters (W piano, X clarinet, Y flute, Z bass) carry
 * over within a channel until changed.
 *
 * Two voices, not three: PLAY SIMPLE NO DRUMS leaves channel 2 and the noise
 * channel free, which is exactly what the sound effect player uses. Music and
 * effects therefore never cut each other off.
 */
export const TUNES = {
  title: {
    tempo: 9,
    loop: true,
    lead: 'C4W S E4 S G4 S C5 S G4 S E4 S F4 S A4 S ' +
      'G4 S E4 S C4 S - - - -',
    bass: 'C3Z S S S G3 S S S C3 S S S F3 S S S ' +
      'C3 S S S G3 S S S C3 S S S - -',
  },
  action: {
    tempo: 6,
    loop: true,
    lead: 'A4X S C5 S E5 S C5 S A4 S C5 S D5 S C5 S ' +
      'G4 S B4 S D5 S B4 S G4 S B4 S C5 S B4 S',
    bass: 'A2Z S S S A2 S S S F2 S S S F2 S S S ' +
      'G2 S S S G2 S S S E2 S S S E2 S S S',
  },
  gameover: {
    tempo: 12,
    loop: false,
    lead: 'G4W S S F4 S S D4# S S C4 S S S S',
    bass: 'C3Z S S A2# S S G2# S S C2 S S S S',
  },
};

export const TUNE_ORDER = Object.keys(TUNES);

export function emitMusicData(ir) {
  const out = [];
  const used = ir.music || [];
  if (!used.length) return out;
  out.push('\t\'');
  out.push('\t\' Music. Two voices, so channel 2 and the noise channel stay');
  out.push('\t\' free for sound effects. Tempo is ticks per note at 50 Hz.');
  out.push('\t\'');
  used.forEach((name) => {
    const tune = TUNES[name];
    if (!tune) return;
    const lead = tune.lead.trim().split(/\s+/);
    const bass = tune.bass.trim().split(/\s+/);
    const rows = Math.max(lead.length, bass.length);
    out.push(`music_${name}:`);
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
