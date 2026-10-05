/**
 * Generated CVBasic -> ROM, using the WebAssembly builds of the compilers.
 *
 * The same two steps tools/build.mjs runs natively, with the same rule for
 * judging them: by what they printed, not only by what they returned.
 * CVBasic exits 0 for some errors, and gasm80 exits 0 for an undefined label
 * while still writing a full-size ROM - so an exit code alone would happily
 * hand back a corrupt cartridge.
 *
 * Pure: no DOM, no Worker globals, no Node. The compiler Worker and the
 * tests both call this, so the ROM a test checks is built by the code the
 * editor runs.
 */

import {makeDirectory, readFile, runTool} from './wasi-run.js';

/** Target id -> the flags each tool wants, and the ROM's file extension. */
export const TARGET_FLAGS = {
  sms: {cv: '--sms', asm: ['-sms'], ext: 'sms'},
  sg1000: {cv: '--sg1000', asm: [], ext: 'sg'},
  coleco: {cv: null, asm: [], ext: 'rom'},
  msx: {cv: '--msx', asm: [], ext: 'rom'},
};

/**
 * @param {object} opts
 * @param {WebAssembly.Module} opts.cvbasic
 * @param {WebAssembly.Module} opts.gasm80
 * @param {string} opts.source        the generated .bas
 * @param {Object<string,string>} opts.engine  engine/*.bas by file name
 * @param {Object<string,string>} opts.support CVBasic's prologue/epilogue .asm
 * @param {string} opts.target        a key of TARGET_FLAGS
 * @param {boolean} [opts.wantAsm]
 * @param {boolean} [opts.wantDebug]  also return the listing and symbols
 */
export function buildRom(opts) {
  const flags = TARGET_FLAGS[opts.target] || TARGET_FLAGS.sms;
  const out = {ok: false, stdout: '', stderr: '', warnings: []};

  const files = {'game.bas': opts.source};
  Object.entries(opts.engine || {}).forEach(([name, text]) => {
    files[`engine/${name}`] = text;
  });
  // CVBasic looks for its prologue and epilogue in the working directory
  // unless told otherwise, exactly as the native build arranges.
  Object.assign(files, opts.support || {});
  const dir = makeDirectory(files);

  /* ---- 1. CVBasic: .bas -> .asm ------------------------------------ */

  const cvArgs = flags.cv ?
    ['cvbasic', flags.cv, 'game.bas', 'game.asm'] :
    ['cvbasic', 'game.bas', 'game.asm'];
  const cv = runTool(opts.cvbasic, cvArgs, dir);
  out.stdout += cv.stdout;
  out.stderr += cv.stderr;
  const cvText = cv.stdout + cv.stderr;

  out.warnings = cvText.split('\n').filter((l) => /^warning:/i.test(l));
  const ram = /(\d+) RAM bytes used of (\d+)/.exec(cvText);
  if (ram) {
    out.ramUsed = +ram[1];
    out.ramTotal = +ram[2];
  }

  if (cv.crashed) {
    return fail(out, 'cvbasic', `The compiler stopped unexpectedly (${cv.crashed}).`);
  }
  if (cv.code !== 0 || /^error:/im.test(cvText)) {
    const line = (/^error:.*$/im.exec(cvText) || [])[0];
    return fail(out, 'cvbasic', line || `The compiler exited with code ${cv.code}.`);
  }

  const asmBytes = readFile(dir, 'game.asm');
  if (!asmBytes) return fail(out, 'cvbasic', 'The compiler produced no assembly.');
  if (opts.wantAsm) out.asm = new TextDecoder().decode(asmBytes);

  /* ---- 2. gasm80: .asm -> ROM -------------------------------------- */

  const romName = `game.${flags.ext}`;
  const ga = runTool(opts.gasm80, ['gasm80', 'game.asm', '-o', romName,
    '-l', 'game.lst', '-s', 'game.sym', ...flags.asm], dir);
  out.stdout += ga.stdout;
  out.stderr += ga.stderr;
  const gaText = ga.stdout + ga.stderr;

  if (ga.crashed) {
    return fail(out, 'gasm80', `The assembler stopped unexpectedly (${ga.crashed}).`);
  }
  // gasm80 reports an undefined label, exits 0, and writes a full-size ROM
  // anyway. The text is the only trustworthy signal.
  if (ga.code !== 0 || /error/i.test(gaText)) {
    const line = (/^.*error.*$/im.exec(gaText) || [])[0];
    return fail(out, 'gasm80', line ||
      'The assembler reported an error. This is almost certainly a bug in ' +
      'the code generator rather than a problem with your game.');
  }

  const rom = readFile(dir, romName);
  if (!rom || !rom.length) return fail(out, 'gasm80', 'The assembler produced no ROM.');
  out.rom = rom;
  out.romName = romName;
  if (opts.wantDebug) {
    const lst = readFile(dir, 'game.lst');
    const sym = readFile(dir, 'game.sym');
    if (lst) out.lst = new TextDecoder().decode(lst);
    if (sym) out.sym = new TextDecoder().decode(sym);
  }
  out.ok = true;
  return out;
}

function fail(out, stage, error) {
  return {...out, ok: false, stage, error};
}
