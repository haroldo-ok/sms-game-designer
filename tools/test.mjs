#!/usr/bin/env node
/**
 * Regression suite.
 *
 * "Generated code hits a CVBasic edge case" is on the risk list in
 * `06-roadmap-and-risks.md`, and the mitigation named there is exactly this:
 * emission templates rather than free-form string building, plus a suite
 * that compiles every generated sample on every change.
 *
 * It also asserts the performance invariants that the measurements bought.
 * They are easy to lose by accident - one `a * b` in a hot path puts the
 * multiply routine back - and nothing else would notice.
 *
 *   node tools/test.mjs
 */

import {readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, copyFileSync} from 'fs';
import {resolve, dirname, join, basename} from 'path';
import {fileURLToPath} from 'url';
import {execFileSync} from 'child_process';

import {migrate, emptyProject, newActor, TARGETS} from '../src/ir/schema.js';
import {buildIR} from '../src/ir/build-ir.js';
import {lint} from '../src/ir/lint.js';
import {estimateFrame} from '../src/ir/budget.js';
// `failed` is the suite's own counter, so the import is renamed.
import {blame, failed as buildFailed} from '../src/generators/blame.js';
import {
  parseSymbols, buildProcRanges, attributeSamples, readPool,
} from '../src/generators/symbols.js';
import {generateProgram} from '../src/generators/cvbasic/emit-program.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = join(root, 'out', 'test');
mkdirSync(tmp, {recursive: true});
mkdirSync(join(tmp, 'engine'), {recursive: true});
readdirSync(join(root, 'engine')).forEach((f) =>
  copyFileSync(join(root, 'engine', f), join(tmp, 'engine', f)));
if (existsSync(join(root, 'bin/asm'))) {
  readdirSync(join(root, 'bin/asm')).forEach((f) =>
    copyFileSync(join(root, 'bin/asm', f), join(tmp, f)));
}

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok    ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${e.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const cvbasic = join(root, 'bin/cvbasic');
const gasm80 = join(root, 'bin/gasm80');
const haveTools = existsSync(cvbasic) && existsSync(gasm80);

/** Compile a project all the way to a ROM; returns compiler output. */
function compile(project, name) {
  const ir = buildIR(project);
  const {source} = generateProgram(ir);
  const bas = join(tmp, `${name}.bas`);
  writeFileSync(bas, source);
  if (!haveTools) return {ir, source, skipped: true};

  const flag = ir.target.cvbasicFlag;
  const args = flag ? [flag, `${name}.bas`, `${name}.asm`] : [`${name}.bas`, `${name}.asm`];
  const log = run(cvbasic, args);
  assert(!/(^|\\s)error[: ]/i.test(log),
      `cvbasic: ${(/^.*error.*$/im.exec(log) || [])[0]}`);

  const asm = readFileSync(join(tmp, `${name}.asm`), 'utf8');
  const romArgs = [`${name}.asm`, '-o', `${name}.rom`,
    '-s', `${name}.sym`, '-l', `${name}.lst`,
    ...(ir.target.id === 'sms' ? ['-sms'] : [])];
  const glog = run(gasm80, romArgs);
  assert(!/error/i.test(glog), `gasm80: ${glog.trim().split('\n')[0]}`);

  const ram = /(\d+) RAM bytes used of (\d+)/.exec(log);
  return {
    ir, source, asm, log,
    ramUsed: ram ? +ram[1] : null,
    ramTotal: ram ? +ram[2] : null,
    rom: readFileSync(join(tmp, `${name}.rom`)),
  };
}

function run(tool, args) {
  try {
    return execFileSync('/bin/sh',
        ['-c', `"${tool}" ${args.map((a) => `'${a}'`).join(' ')} 2>&1`],
        {cwd: tmp, encoding: 'utf8'});
  } catch (e) {
    return (e.stdout || '') + (e.stderr || '');
  }
}

/* ------------------------------------------------------------------ */

console.log('\nsamples');

const samples = readdirSync(join(root, 'examples')).filter((f) => f.endsWith('.json'));
const results = {};

samples.forEach((file) => {
  const name = basename(file, '.json');
  test(`${name}: builds a ROM`, () => {
    const project = migrate(JSON.parse(readFileSync(join(root, 'examples', file), 'utf8')));
    const r = compile(project, name);
    results[name] = r;
    if (r.skipped) return;
    assert(r.rom.length > 0, 'empty ROM');
  });
});

console.log('\nengine invariants');

test('no runtime multiply, divide or modulo in generated code', () => {
  const r = results.shmup;
  if (!r || r.skipped) return;
  const calls = (r.asm.match(/CALL _(mul|div|mod)\d+s?/g) || []);
  assert(calls.length === 0,
      `found ${calls.length}: ${[...new Set(calls)].join(', ')}. ` +
    'Something in a hot path grew a multiply - check the render loop and ' +
    'any RANDOM() bound that is not a power of two.');
});

test('the AABB test stays in 8 bits', () => {
  const r = results.shmup;
  if (!r || r.skipped) return;
  // The correct form leaves a SUB followed by a store and a CP. The broken
  // form promotes to HL: LD L,A / LD H,0 right after the SUB.
  const broken = /SUB B\s*\n\s*LD L,A\s*\n\s*LD H,0/.test(r.asm);
  assert(!broken,
      'a collision test was emitted inline rather than through a byte ' +
    'variable, so the unsigned wrap is gone and half of all overlaps will ' +
    'be missed silently. See docs/MEASUREMENTS.md.');
});

test('a link error is never mistaken for a successful build', () => {
  if (!haveTools) return;
  // gasm80 exits 0 on an undefined label AND still writes a full-size ROM,
  // and CVBasic exits 0 for some errors too. Anything that judges a build by
  // its exit status will happily ship a corrupt cartridge.
  const bad = join(tmp, 'broken.asm');
  writeFileSync(bad, '\tORG $0000\n\tCALL cvb_NO_SUCH_LABEL\n\tHALT\n');
  const log = run(gasm80, ['broken.asm', '-o', 'broken.rom']);
  assert(/error/i.test(log),
      'the assembler did not report the undefined label at all');
  assert(existsSync(join(tmp, 'broken.rom')),
      'expected a ROM to be written despite the error - if this changed, ' +
    'the exit-code workaround can be simplified');
  const buildSrc = readFileSync(join(root, 'tools/build.mjs'), 'utf8');
  assert(/\/error\/i\.test\(asmLog\)/.test(buildSrc),
      'tools/build.mjs no longer checks the assembler output text');
  // The in-browser build moved this check out of the Worker and into
  // build-rom.js, which both the Worker and the page fallback use.
  const buildRomSrc = readFileSync(join(root, 'src/workers/build-rom.js'), 'utf8');
  assert(/error\/i\.test\(gaText\)/.test(buildRomSrc),
      'the in-browser build no longer checks the assembler output text');
});

test('NOT never reaches the generated source', () => {
  // CVBasic's NOT is a bitwise complement, not a logical negation, so
  // `NOT CONT1.BUTTON` compiles to AND 64 / CPL and is non-zero either way -
  // always true. It made the `not` block silently always fire, and it made
  // the game over screen ignore every button press. Comparing against zero
  // is the only form that negates.
  ['shmup', 'platformer', 'kitchen-sink'].forEach((name) => {
    const r = results[name];
    if (!r) return;
    const bad = r.source.split('\n')
        .filter((l) => /\bNOT\b/.test(l) && !/^\s*'/.test(l));
    assert(!bad.length,
        `${name} emits NOT: ${bad[0]}`);
  });
});

test('generated source parks execution before any data', () => {
  const r = results.shmup;
  const lines = r.source.split('\n');
  const park = lines.findIndex((l) => /^\s*GOTO game_loop\s*$/.test(l));
  const firstProc = lines.findIndex((l) => /PROCEDURE\s*$/.test(l));
  const firstBitmap = lines.findIndex((l) => /^\s*BITMAP /.test(l));
  assert(park > 0, 'no GOTO game_loop found');
  assert(firstProc > park,
      'a PROCEDURE appears before execution is parked');
  assert(firstBitmap === -1 || firstBitmap > park,
      'a BITMAP block appears before execution is parked; the CPU would ' +
    'run the sprite data as instructions');
});

test('sprite flicker is left on', () => {
  const r = results.shmup;
  // SPRITE FLICKER OFF selects a path in CVBasic's SMS prologue that copies
  // the X/pattern half of the sprite attribute table from the Y half, so
  // every sprite gets a pattern number equal to its Y coordinate and the
  // whole cast renders as thin vertical slivers. The flicker path is
  // correct; k_render makes it invisible by keeping all 64 attribute entries
  // valid instead of terminating the list. See docs/MEASUREMENTS.md.
  assert(!/SPRITE FLICKER OFF/.test(r.source),
      'the generated program asks for the broken non-flicker upload path');
});

test('the sprite list is parked, not terminated', () => {
  const r = results.shmup;
  // A $d0 terminator cannot survive the flicker permutation: it lands in a
  // different attribute slot every frame and truncates the list at a random
  // point, which is violent flicker even well inside the sprite budget.
  // Both renderers, since the rule is about CVBasic's flicker rotation and
  // that applies to every VDP it supports.
  ['render_sms.bas', 'render_tms.bas'].forEach((f) => {
    const src = readFileSync(join(root, 'engine', f), 'utf8');
    assert(!/SPRITE\s+\w+,\s*SPR_TERMINATE/.test(src),
        `${f} still terminates the sprite list with $d0`);
    assert(/SPRITE k_n, SPR_OFF/.test(src),
        `${f} no longer parks unused hardware sprites`);
  });
});

test('group population counts balance', () => {
  const r = results.shmup;
  // Every type must increment on spawn, and the kernel must decrement once
  // on reap. An unbalanced count makes "how many are left" drift, and a
  // win condition that never fires is invisible until someone plays it.
  const ir = r.ir;
  ir.types.forEach((t) => {
    const re = new RegExp(`spawn_${t.symbol}:[\\s\\S]*?g_count\\(${t.groupIndex}\\) = ` +
      `g_count\\(${t.groupIndex}\\) \\+ 1`);
    assert(re.test(r.source), `${t.name} does not increment its group count on spawn`);
  });
  assert(/t_group:\tDATA BYTE/.test(r.source), 'no type-to-group table emitted');
});

test('game over does something', () => {
  const r = results.shmup;
  assert(/do_game_over:\tPROCEDURE/.test(r.source),
      'the "game over" block set a flag nothing read');
  assert(/IF game_state = 2 THEN GOSUB do_game_over/.test(r.source),
      'nothing ever checks the game over flag');
});

test('every sprite Y goes through the kernel', () => {
  const r = results.shmup;
  // SPRITE FLICKER is a directive, not a sprite write.
  const stray = r.source.split('\n')
      .filter((l) => /^\s*SPRITE\s+(?!FLICKER\b)/.test(l));
  assert(stray.length === 0,
      `${stray.length} SPRITE statements in generated code. Sprite Y needs ` +
    'the y-1 adjustment and only engine/kernel.bas should ever write one.');
});

test('RAM fits the target with room to spare', () => {
  const r = results.shmup;
  if (!r || r.skipped || r.ramUsed == null) return;
  assert(r.ramUsed < r.ramTotal,
      `${r.ramUsed} of ${r.ramTotal} bytes`);
});

console.log('\ncodegen');

test('an empty project generates a program that compiles', () => {
  const p = emptyProject('Empty');
  const r = compile(p, 'empty');
  assert(r.skipped || r.rom.length > 0, 'empty project failed to build');
});

test('a project with one actor and no scripts compiles', () => {
  const p = emptyProject('Minimal');
  const a = newActor('Thing');
  a.id = 'thing';
  a.isPlayer = true;
  a.max = 1;
  p.actors = [a];
  p.rooms[0].id = 'r1';
  p.rooms[0].placements = [{actor: 'thing', x: 100, y: 100}];
  const r = compile(migrate(p), 'minimal');
  assert(r.skipped || r.rom.length > 0, 'minimal project failed to build');
});

test('slot ranges are contiguous and non-overlapping', () => {
  const ir = buildIR(migrate(JSON.parse(
      readFileSync(join(root, 'examples/shmup.json'), 'utf8'))));
  const sorted = [...ir.types].sort((a, b) => a.first - b.first);
  let next = 0;
  sorted.forEach((t) => {
    assert(t.first === next,
        `${t.name} starts at ${t.first}, expected ${next}`);
    assert(t.last === t.first + t.max - 1, `${t.name} range is wrong`);
    next = t.last + 1;
  });
  assert(next === ir.layout.maxEnt, 'pool size does not match the ranges');
});

test('the player type is at slot 0 so the kernel can cache it', () => {
  const ir = buildIR(migrate(JSON.parse(
      readFileSync(join(root, 'examples/shmup.json'), 'utf8'))));
  assert(ir.player, 'no player type');
  assert(ir.player.first === 0,
      `player starts at slot ${ir.player.first}, not 0`);
});

test('sprite definitions do not overlap', () => {
  const ir = buildIR(migrate(JSON.parse(
      readFileSync(join(root, 'examples/shmup.json'), 'utf8'))));
  const sorted = [...ir.anims].sort((a, b) => a.firstDef - b.firstDef);
  let next = 0;
  sorted.forEach((a) => {
    assert(a.firstDef === next,
        `${a.symbol} starts at def ${a.firstDef}, expected ${next}`);
    next += a.defCount;
  });
  assert(next <= ir.target.spriteDefBudget,
      `${next} definitions exceeds the ${ir.target.spriteDefBudget} budget`);
});

test('collision pairs are derived, not enumerated', () => {
  const ir = buildIR(migrate(JSON.parse(
      readFileSync(join(root, 'examples/shmup.json'), 'utf8'))));
  assert(ir.pairs.length === 3,
      `expected 3 pairs from the worked shmup, got ${ir.pairs.length}: ` +
    ir.pairs.map((p) => p.id).join(', '));
  // A pair where only one side has a handler must only call that side.
  ir.pairs.forEach((p) => p.ranges.forEach((r) => {
    assert(r.aHandler || r.bHandler,
        `${p.id} has a range with no handler on either side`);
  }));
});

console.log('\ncoverage');

test('every statement and expression the generator handles is exercised', () => {
  // Three blocks have shipped doing nothing: `game over` set a flag nothing
  // read, `play sound` set a variable nothing read, and `tile below me`
  // tested a scratch variable nobody had filled. All three compiled, and all
  // three were found by someone playing the game.
  //
  // The common factor is that no sample used them. So the kitchen-sink
  // project has to reach every case the emitter can handle, and this test
  // fails when a new case is added without one.
  const src = readFileSync(
      join(root, 'src/generators/cvbasic/emit-stmt.js'), 'utf8');
  const handled = new Set(
      [...src.matchAll(/^\s*case '([a-zA-Z0-9_]+)':/gm)].map((m) => m[1]));

  const project = JSON.parse(
      readFileSync(join(root, 'examples/kitchen-sink.json'), 'utf8'));
  const used = new Set();
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (typeof node.op === 'string') used.add(node.op);
    Object.values(node).forEach(walk);
  };
  walk(project);

  const missing = [...handled].filter((op) => !used.has(op)).sort();
  assert(!missing.length,
      `the kitchen-sink sample never uses: ${missing.join(', ')}. ` +
    'Add them to tools/make-kitchen-sink.mjs, or delete the case if the ' +
    'feature no longer exists.');
});

test('every op a block can produce has an emitter case', () => {
  // The other direction: a block that lowers to an op nobody handles emits
  // a bare "unsupported statement" comment and does nothing at runtime.
  const emit = readFileSync(
      join(root, 'src/generators/cvbasic/emit-stmt.js'), 'utf8');
  const handled = new Set(
      [...emit.matchAll(/^\s*case '([a-zA-Z0-9_]+)':/gm)].map((m) => m[1]));
  const lower = readFileSync(
      join(root, 'src/generators/blockly-lower.js'), 'utf8');
  const produced = new Set(
      [...lower.matchAll(/\{\s*op:\s*'([a-zA-Z0-9_]+)'/g)].map((m) => m[1]));
  const orphans = [...produced].filter((op) => !handled.has(op)).sort();
  assert(!orphans.length,
      `blocks lower to ops with no emitter case: ${orphans.join(', ')}`);
});

console.log('\nthe editor pipeline');

test('the browser build ships every engine file', () => {
  // The worker writes these into the compiler's in-memory filesystem before
  // each build, and the generated program INCLUDEs them by name. When the
  // renderer was split into render_sms.bas and render_tms.bas this list was
  // not updated, so the editor would have failed to compile anything at all
  // with an undefined-label error - while the headless build, which copies
  // the directory, carried on working perfectly.
  const hook = readFileSync(join(root, 'src/hooks/cvbasic-compiler.js'), 'utf8');
  const imported = new Set(
      [...hook.matchAll(/engine\/([\w.]+\.bas)'/g)].map((m) => m[1]));
  const onDisk = new Set(readdirSync(join(root, 'engine')));
  const missing = [...onDisk].filter((f) => !imported.has(f));
  const extra = [...imported].filter((f) => !onDisk.has(f));
  assert(!missing.length, `engine files the editor never ships: ${missing.join(', ')}`);
  assert(!extra.length, `the editor imports files that do not exist: ${extra.join(', ')}`);

  // And they have to reach the map, not just be imported.
  onDisk.forEach((f) => {
    assert(hook.includes(`'${f}':`),
        `${f} is imported but never put in the ENGINE map`);
  });
});

test('a compiler error is traced back to the block that caused it', () => {
  // This is the whole reason codegen emits ' @blk: markers, and it had never
  // been run. Deliberately break one block and check the error lands on it.
  const p = emptyProject('Blame');
  const a = newActor('Thing');
  a.id = 'thing';
  a.isPlayer = true;
  a.max = 1;
  a.scripts = {update: {xml: '', stmts: [
    {op: 'setTimer', value: {op: 'num', value: 10}, blockId: 'good_block'},
    {op: 'raw', code: 'WEND', blockId: 'broken_block'},
  ]}};
  p.actors = [a];
  p.rooms[0].id = 'r1';
  p.rooms[0].placements = [{actor: 'thing', x: 100, y: 100}];

  const ir = buildIR(migrate(p));
  const {source, lineMap} = generateProgram(ir);
  writeFileSync(join(tmp, 'blame.bas'), source);
  if (!haveTools) return;

  const log = run(cvbasic, ['--sms', 'blame.bas', 'blame.asm']);
  assert(/error/i.test(log), 'the deliberately broken block compiled fine');

  const where = blame({error: /^.*error.*$/im.exec(log)[0], stderr: log}, lineMap);
  assert(where.blockId === 'broken_block',
      `the error was blamed on ${where.blockId || '(nothing)'} rather than ` +
    'the block that actually broke');
});

test('an error inside the engine is reported as a tool bug, not a user one', () => {
  // A line with no @blk: marker above it can only be engine or generator
  // output. Saying "this is our bug" is the difference between someone
  // filing a report and someone concluding they are bad at this.
  const where = blame({error: 'Error: something at line 99999', stage: 'cvbasic'},
      [{line: 10, blockId: 'a'}]);
  assert(!where.internal, 'a late line should still find the last marker');

  const early = blame({error: 'Error: something at line 3', stage: 'cvbasic'},
      [{line: 10, blockId: 'a'}]);
  assert(early.internal,
      'a line before every marker must be reported as internal');
  assert(/bug in the tool/.test(early.message),
      'the internal message does not say whose fault it is');

  const noLine = blame({error: 'Error: out of memory', stage: 'gasm80'}, []);
  assert(noLine.internal, 'an error with no line number must be internal');
});

test('build failure is judged on output, not exit status', () => {
  // Both tools can fail and still exit 0.
  assert(buildFailed('gasm80', 0, "Error: undefined label 'X' at line 4042"),
      'an undefined label with a zero exit status was treated as success');
  assert(buildFailed('cvbasic', 0, 'ERROR: Bad nested END IF at line 12 (x.bas)'),
      'CVBasic prints ERROR in capitals; a case-sensitive check misses it');
  assert(!buildFailed('cvbasic', 0, 'Warning: variable X assigned but never read'),
      'a warning was treated as a failure');
  assert(buildFailed('cvbasic', 1, ''), 'a non-zero exit status is always a failure');
});

console.log('\nlive inspection');

// Everything here is what turns the emulator into a debugger: hitboxes drawn
// over the running game, PC samples attributed to one actor's script. Both
// parsers were written from an assumption about gasm80's output and both
// matched nothing at all in a real file - silently, because a parser that
// finds no symbols is indistinguishable from a game with no symbols.

test('the symbol file parses', () => {
  if (!haveTools) return;
  const syms = parseSymbols(readFileSync(join(tmp, 'shmup.sym'), 'utf8'));
  const n = Object.keys(syms).length;
  assert(n > 100, `only ${n} symbols parsed out of a real .sym file`);
  ['ARRAY_E_TYPE', 'ARRAY_E_X', 'ARRAY_E_Y', 'CVB_SELF'].forEach((k) => {
    assert(syms[k] != null, `${k} is missing`);
    assert(syms[k] >= 0xc000 && syms[k] <= 0xdfff,
        `${k} resolved to $${syms[k].toString(16)}, which is not RAM`);
  });
  assert(syms.CVB_K_RENDER < 0x8000,
      'a procedure resolved outside ROM');
});

test('the listing yields procedure ranges', () => {
  if (!haveTools) return;
  const ranges = buildProcRanges(readFileSync(join(tmp, 'shmup.lst'), 'utf8'));
  assert(ranges.length > 20, `only ${ranges.length} procedures found`);
  const render = ranges.find((r) => r.name === 'k_render');
  assert(render, 'k_render is not among them');
  assert(render.end > render.start,
      `k_render spans ${render.start}..${render.end}`);
  // Ranges must not overlap, or a sample would be attributed twice.
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) {
    assert(sorted[i].start > sorted[i - 1].end,
        `${sorted[i - 1].name} and ${sorted[i].name} overlap`);
  }
});

test('the two symbol parsers agree', () => {
  if (!haveTools) return;
  // The Python playtest harness has its own reader, written independently
  // against a real file. If they disagree, one of them is wrong.
  const js = parseSymbols(readFileSync(join(tmp, 'shmup.sym'), 'utf8'));
  const py = readFileSync(join(root, 'tools/playtest.py'), 'utf8');
  const m = /re\.match\(r'([^']+)'/.exec(py);
  assert(m, 'could not find the Python symbol pattern to compare against');
  const pyRe = new RegExp(m[1].replace(/\\s/g, '\\s').replace(/\(\?:/g, '(?:'));
  const lines = readFileSync(join(tmp, 'shmup.sym'), 'utf8').split('\n');
  let agree = 0;
  lines.forEach((l) => {
    const pm = pyRe.exec(l);
    if (!pm) return;
    const name = pm[1].toUpperCase();
    if (js[name] === parseInt(pm[2], 16) % 0x10000) agree++;
  });
  assert(agree > 100,
      `the two parsers agree on only ${agree} symbols, so one of them is ` +
    'reading a different format');
});

test('PC samples are attributed to procedures', () => {
  if (!haveTools) return;
  const ranges = buildProcRanges(readFileSync(join(tmp, 'shmup.lst'), 'utf8'));
  const render = ranges.find((r) => r.name === 'k_render');
  const move = ranges.find((r) => r.name === 'k_move');
  const samples = [
    ...new Array(60).fill(render.start + 4),
    ...new Array(40).fill(move.start + 4),
  ];
  const out = attributeSamples(samples, ranges);
  assert(out[0].name === 'k_render' && out[0].percent === 60,
      `top entry was ${JSON.stringify(out[0])}`);
  assert(out[1].name === 'k_move' && out[1].percent === 40,
      `second entry was ${JSON.stringify(out[1])}`);
});

test('the entity pool can be read back through the symbols', () => {
  if (!haveTools) return;
  const syms = parseSymbols(readFileSync(join(tmp, 'shmup.sym'), 'utf8'));
  const ir = buildIR(migrate(JSON.parse(
      readFileSync(join(root, 'examples/shmup.json'), 'utf8'))));
  // A fake machine with one live player in slot 0.
  const mem = new Uint8Array(0x10000);
  mem[syms.ARRAY_E_TYPE] = ir.player.typeId;
  mem[syms.ARRAY_E_X] = 120;
  mem[syms.ARRAY_E_Y] = 168;
  const pool = readPool((a) => mem[a], syms, ir);
  assert(pool, 'readPool found no symbols to work with');
  assert(pool.used === 1, `${pool.used} entities read, expected 1`);
  assert(pool.live[0].type === ir.player.name,
      `slot 0 came back as ${pool.live[0].type}`);
  assert(pool.live[0].x === 120 && pool.live[0].y === 168,
      'the position did not come through');
  assert(pool.live[0].hitbox, 'no hitbox, so nothing could be drawn');
});

test('readPool says so rather than guessing when symbols are missing', () => {
  const ir = buildIR(migrate(JSON.parse(
      readFileSync(join(root, 'examples/shmup.json'), 'utf8'))));
  assert(readPool(() => 0, {}, ir) === null,
      'readPool invented a pool from an empty symbol table');
});

console.log('\nbudgets');

test('the worked shmup fits inside one frame', () => {
  const ir = buildIR(migrate(JSON.parse(
      readFileSync(join(root, 'examples/shmup.json'), 'utf8'))));
  const f = estimateFrame(ir);
  assert(f.percent <= 100,
      `${f.percent}% of a frame at worst case: ` +
    f.parts.map((p) => `${p.name} ${p.percent}%`).join(', '));
});

test('over-budget projects produce actionable advice', () => {
  const p = migrate(JSON.parse(
      readFileSync(join(root, 'examples/shmup.json'), 'utf8')));
  delete p.timeSlicedPairs;
  p.actors.find((a) => a.id === 'bug').max = 20;
  const f = estimateFrame(buildIR(p));
  assert(f.percent > 100, 'expected this to be over budget');
  assert(f.advice.length > 0, 'no advice offered');
  assert(f.advice.some((a) => a.action),
      'advice with no actionable button: a user cannot act on a number alone');
});

console.log('\nlint');

test('a health behaviour with no matching field is an error', () => {
  const p = emptyProject('Bad');
  const a = newActor('Thing');
  a.id = 'thing';
  a.behaviours = [{kind: 'health', field: 'hp'}];
  p.actors = [a];
  const problems = lint(buildIR(migrate(p)));
  assert(problems.some((x) => x.code === 'health-field'),
      'expected a health-field error');
});

test('Shoot and "on timer" on the same actor is an error', () => {
  const p = emptyProject('Clash');
  const a = newActor('Thing');
  a.id = 'thing';
  const b = newActor('Bullet');
  b.id = 'bullet';
  a.behaviours = [{kind: 'shoot', actor: 'bullet', interval: 10}];
  a.scripts = {timer: {xml: '', stmts: [{op: 'destroy', target: 'me'}]}};
  p.actors = [a, b];
  const problems = lint(buildIR(migrate(p)));
  assert(problems.some((x) => x.code === 'timer-conflict'),
      'expected a timer-conflict error');
});

test('exceeding the pool is caught before compiling', () => {
  const p = emptyProject('Huge');
  p.actors = Array.from({length: 6}, (_, i) => {
    const a = newActor(`A${i}`);
    a.id = `a${i}`;
    a.max = 10;
    return a;
  });
  const ir = buildIR(migrate(p));
  assert(ir.diagnostics.some((d) => d.code === 'pool-overflow'),
      'expected a pool-overflow error for 60 slots on a 40-slot target');
});

test('painted tiles are refused on a target that cannot show them', () => {
  const p = migrate(JSON.parse(
      readFileSync(join(root, 'examples/platformer.json'), 'utf8')));
  p.target = 'sg1000';
  const problems = lint(buildIR(p));
  assert(problems.some((x) => x.code === 'terrain-unsupported'),
      'a tilemap on the SG-1000 would have built into garbage');
});

test('a cell pointing past the tile set is caught', () => {
  const p = migrate(JSON.parse(
      readFileSync(join(root, 'examples/platformer.json'), 'utf8')));
  p.rooms[0].tiles[3][3] = p.tiles.length + 4;
  const problems = lint(buildIR(p));
  assert(problems.some((x) => x.code === 'tile-missing'),
      'a cell referencing a tile that does not exist went unreported');
});

test('a game with no tilemap spends nothing on tile art', () => {
  // Every project now starts with a tile set, but a shooter never draws it.
  const r = results.shmup;
  assert(!/DEFINE CHAR/.test(r.source),
      'tile art is loaded into VRAM by a game with no tilemap');
  assert(!/^tile_data:/m.test(r.source), 'tile art is in the ROM regardless');
});

console.log('\nschema');

test('migration brings a v1 project forward', () => {
  const v1 = {
    schemaVersion: 1, name: 'Old', maxInstances: 6,
    actors: [{id: 'a', name: 'A', group: 'enemy', width: 16, height: 16,
      frames: [{pixels: []}]}],
    rooms: [], globals: [],
  };
  const p = migrate(v1);
  assert(p.schemaVersion === 3, 'schema version not updated');
  assert(p.actors[0].max === 6, 'maxInstances not moved onto the actor');
  assert(p.actors[0].animations?.length === 1, 'frames not wrapped in an animation');
  assert(p.actors[0].hitbox, 'no hitbox filled in');
});

test('every target profile is internally consistent', () => {
  Object.values(TARGETS).forEach((t) => {
    assert(['sms', 'tms'].includes(t.video),
        `${t.id}: no renderer for video backend "${t.video}"`);
    assert(existsSync(join(root, `engine/render_${t.video}.bas`)),
        `${t.id}: engine/render_${t.video}.bas does not exist`);
    assert(t.poolArrays.length > 0, `${t.id}: no pool arrays`);
    const perEntity = t.poolArrays.length;
    assert(t.maxSlots * perEntity < t.ram,
        `${t.id}: a full pool (${t.maxSlots} x ${perEntity}B) does not fit ` +
      `in ${t.ram} bytes of RAM`);
    assert(t.userFields <= 4, `${t.id}: more user fields than the kernel has`);
    assert(t.romBudget >= 8192, `${t.id}: no usable cartridge budget`);
  });
});

/* ---- playtest: actually run the ROM ------------------------------- */
// Everything above this line passed while the shmup was drawing its entire
// cast as thin vertical slivers. Compiling clean is not the same as working,
// and nothing that only reads source can tell the difference.
if (haveTools) {
  console.log('\nplaytest');
  try {
    ['shmup', 'platformer', 'kitchen-sink', 'shmup-sg1000'].forEach((name) => {
      const out = execFileSync('python3',
          [join(root, 'tools/playtest.py'),
            join(tmp, `${name}.rom`), join(tmp, `${name}.sym`)],
          {encoding: 'utf8', cwd: root, stdio: ['pipe', 'pipe', 'pipe']});
      out.split('\n').filter((l) => /^\s{2}(ok|FAIL)/.test(l))
          .forEach((l) => {
            console.log(l);
            if (l.includes('FAIL')) failed++;
            else passed++;
          });
    });
  } catch (e) {
    const out = (e.stdout || '') + (e.stderr || '');
    if (/ModuleNotFoundError|No module named/.test(out)) {
      console.log('  skipped (pip install z80)');
    } else {
      out.split('\n').filter(Boolean).slice(-12).forEach((l) => console.log('  ' + l));
      failed++;
    }
  }
}

/* ---- block layer -------------------------------------------------- */
// Needs node_modules, so it is skipped rather than failed when Blockly is
// not installed - the rest of this suite deliberately has no dependencies.
// The editor's own checks run as separate processes: the block layer needs
// Blockly, and rendering needs a DOM set up before anything else loads.
//
// Every one of them has to end with a verdict. This runner used to collect
// only the `ok`/`FAIL` lines from each, so a suite that crashed while
// loading printed none and contributed nothing - and the total stayed green.
// That is exactly how a version clash between Vue and its template compiler
// went unnoticed: two whole suites failed to start and the run still passed.
// A suite now passes, fails, or says why it skipped. Nothing else counts.
const SUITES = [
  ['tools/test-ui.mjs', 'editor templates'],
  ['tools/test-render.mjs', 'editor rendering'],
  ['tools/test-store.mjs', 'project store'],
  ['tools/test-wasm.mjs', 'in-browser compiler'],
  ['tools/test-emulator.mjs', 'bundled emulator'],
  ['tools/test-site-check.mjs', 'site checker'],
  ['tools/test-boot.mjs', 'built editor boots'],
  ['tools/test-e2e.mjs', 'built editor, end to end'],
];
let skipped = 0;
SUITES.forEach(([script, label]) => {
  console.log(`\n${label}`);
  let out = '';
  let code = 0;
  try {
    out = execFileSync('node', [join(root, script)],
        {encoding: 'utf8', cwd: root, stdio: ['pipe', 'pipe', 'pipe'],
          maxBuffer: 16 * 1024 * 1024});
  } catch (e) {
    out = (e.stdout || '') + (e.stderr || '');
    code = e.status || 1;
  }
  const all = out.split('\n');
  const lines = all.filter((l) => /^\s{2}(ok|FAIL)/.test(l));
  all.forEach((l, i) => {
    if (/^\s{2}(ok|FAIL)/.test(l)) {
      console.log(l);
      if (l.includes('FAIL')) failed++;
      else passed++;
    } else if (/^\s{8}\S/.test(l) && all.slice(0, i).reverse()
        .find((x) => /^\s{2}(ok|FAIL)/.test(x))?.includes('FAIL')) {
      // The reason under a FAIL. Dropping it meant a sub-suite's failure
      // arrived here as a bare name with no explanation.
      console.log(l);
    }
  });
  const skip = /skipped \(([^)]*)\)/.exec(out);
  const verdict = /\d+ passed, \d+ failed/.test(out);
  if (skip && !lines.length) {
    skipped++;
    console.log(`  SKIP  ${skip[1]}`);
  } else if (!verdict || (code && !lines.some((l) => l.includes('FAIL')))) {
    failed++;
    console.log(`  FAIL  ${script} did not finish (exit ${code})`);
    out.trim().split('\n').slice(-6).forEach((l) => console.log(`        ${l}`));
  }
});

if (existsSync(join(root, 'node_modules/blockly'))) {
  console.log('\nblock layer');
  try {
    const out = execFileSync('node', [join(root, 'tools/test-blocks.mjs')],
        {encoding: 'utf8', cwd: root, stdio: ['pipe', 'pipe', 'pipe']});
    out.split('\n').filter((l) => /^\s{2}(ok|FAIL)/.test(l))
        .forEach((l) => {
          console.log(l);
          if (l.includes('FAIL')) failed++;
          else passed++;
        });
  } catch (e) {
    const out = (e.stdout || '') + (e.stderr || '');
    out.split('\n').filter((l) => /^\s{2}(ok|FAIL)/.test(l))
        .forEach((l) => {
          console.log(l);
          if (l.includes('FAIL')) failed++;
          else passed++;
        });
    if (!/\b(ok|FAIL)\b/.test(out)) {
      console.log('  FAIL  the block tests did not run');
      console.log('        ' + out.trim().split('\n').slice(-3).join('\n        '));
      failed++;
    }
  }
} else {
  console.log('\nblock layer\n  skipped (npm install)');
}

console.log(`\n${passed} passed, ${failed} failed` +
  (skipped ? `, ${skipped} suite(s) SKIPPED` : '') + '\n');
process.exit(failed ? 1 : 0);
