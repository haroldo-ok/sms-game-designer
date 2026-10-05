/**
 * Reading gasm80's symbol file and listing.
 *
 * These are what turn the emulator into a debugger. The symbol file maps
 * `ARRAY_E_X` and friends to RAM addresses, so the editor can read the
 * entity pool out of a running game and draw hitboxes over it; the listing
 * maps ROM addresses back to procedures, so a PC sample can be attributed to
 * one actor's update script rather than to "the program".
 *
 * They live here, apart from the Vue hook that uses them, for the same
 * reason `blame.js` does: the hook imports the composition API and cannot be
 * loaded outside a browser build, and these are exactly the parts worth
 * testing. Both were written from an assumption about the format and both
 * matched precisely nothing in a real file - silently, because a parser that
 * finds no symbols looks identical to a game with no symbols.
 */

/**
 * gasm80 writes one symbol per line, as
 *
 *     ARRAY_E_X: equ 0000c1c2h
 *
 * Addresses are hexadecimal with a trailing `h`, zero-padded to eight
 * digits, and every name is upper-cased. The `equ` and the colon are both
 * optional in other assemblers, so both are optional here.
 *
 * @param {string} text contents of the .sym file
 * @returns {Object<string, number>} upper-cased name -> address
 */
export function parseSymbols(text) {
  const map = {};
  String(text || '').split('\n').forEach((line) => {
    const m = /^\s*([A-Za-z_][\w#$.]*)\s*:?\s*(?:equ\s+)?\$?([0-9A-Fa-f]+)h?\s*$/i
        .exec(line);
    if (!m) return;
    const addr = parseInt(m[2], 16);
    if (Number.isFinite(addr)) map[m[1].toUpperCase()] = addr & 0xffff;
  });
  return map;
}

/**
 * Turn the listing into address ranges, one per generated procedure.
 *
 * A listing line is an address, a line number, then the source:
 *
 *     1EBE                    07391 CVB_K_RENDER:
 *
 * Names are upper-cased by the assembler, and CVBasic prefixes everything it
 * generates with `cvb_`. A procedure runs from its own label to the next
 * one, which is close enough for sampling: the few bytes of a fallthrough at
 * the end are attributed to the wrong procedure and nothing else is.
 *
 * @param {string} text contents of the .lst file
 * @returns {Array<{name: string, start: number, end: number}>}
 */
export function buildProcRanges(text) {
  const ranges = [];
  String(text || '').split('\n').forEach((line) => {
    const m = /^([0-9A-Fa-f]{4})\s.*?\bCVB_([A-Z0-9_#$.]+):/i.exec(line);
    if (!m) return;
    const start = parseInt(m[1], 16);
    const prev = ranges[ranges.length - 1];
    // A label at the same address as the previous one is an alias, not a new
    // procedure; keep the first name and move on.
    if (prev && prev.start === start) return;
    if (prev) prev.end = start - 1;
    ranges.push({name: m[2].toLowerCase(), start, end: 0xffff});
  });
  return ranges;
}

/**
 * Bucket PC samples by procedure.
 *
 * This is what turns "collision is expensive" from an estimate into a
 * measurement, and lets it go finer than that: which actor's update script,
 * which collision pair.
 *
 * @param {Array<number>} samples program counter values
 * @param {Array} ranges from buildProcRanges
 */
export function attributeSamples(samples, ranges) {
  const counts = {};
  (samples || []).forEach((pc) => {
    const r = ranges.find((x) => pc >= x.start && pc <= x.end);
    const key = r ? r.name : '(engine)';
    counts[key] = (counts[key] || 0) + 1;
  });
  const total = (samples || []).length || 1;
  return Object.entries(counts)
      .map(([name, n]) => ({name, samples: n,
        percent: Math.round((n / total) * 100)}))
      .sort((a, b) => b.samples - a.samples);
}

/**
 * Read the entity pool out of emulator memory.
 *
 * `readMemory` is supplied by the caller because every emulator core exposes
 * memory differently; this only needs a byte at a time.
 *
 * @returns {null|{live: Array, used: number, total: number,
 *                 droppedSpawns: number|null}}
 */
export function readPool(readMemory, symbols, ir) {
  const at = (name) => {
    const s = symbols || {};
    return s[`ARRAY_${name}`] ?? s[name] ?? null;
  };
  const type = at('E_TYPE');
  const x = at('E_X');
  const y = at('E_Y');
  const flags = at('E_FLAGS');
  if (type == null || x == null || y == null) return null;

  const n = ir.layout.maxEnt;
  const live = [];
  for (let i = 0; i < n; i++) {
    const t = readMemory(type + i);
    if (!t) continue;
    const kind = ir.types.find((k) => k.typeId === t);
    live.push({
      slot: i,
      type: kind ? kind.name : `type ${t}`,
      x: readMemory(x + i),
      y: readMemory(y + i),
      flags: flags == null ? 0 : readMemory(flags + i),
      hitbox: kind ? kind.hitbox : null,
    });
  }

  const dropped = at('DROPPED');
  return {
    live,
    used: live.length,
    total: n,
    // Surfaced in the profiler because a silent failed spawn is otherwise
    // invisible: "37 shots dropped this session, raise Max instances or
    // lower the fire rate" is something a person can act on.
    droppedSpawns: dropped == null ? null : readMemory(dropped),
  };
}
