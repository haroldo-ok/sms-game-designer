#!/usr/bin/env node
/**
 * Headless build: project JSON -> IR -> .bas -> .asm -> ROM.
 *
 * This is the M2 harness and it stays useful well past M2. Because
 * IR -> text is a pure function, the whole code generator can be exercised
 * here with no browser, no WASM and no emulator - which is what makes a
 * regression suite that compiles every sample on every change practical.
 *
 *   node tools/build.mjs examples/shmup.json [-o out/] [--asm]
 *
 * If cvbasic and gasm80 are on PATH (or in ./bin), it goes all the way to a
 * ROM and reports the compiler's own RAM accounting.
 */

import {readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, readdirSync} from 'fs';
import {resolve, dirname, join, basename} from 'path';
import {fileURLToPath} from 'url';
import {execFileSync} from 'child_process';

import {migrate} from '../src/ir/schema.js';
import {buildIR} from '../src/ir/build-ir.js';
import {lint} from '../src/ir/lint.js';
import {estimateFrame} from '../src/ir/budget.js';
import {blame} from '../src/generators/blame.js';
import {generateProgram} from '../src/generators/cvbasic/emit-program.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const args = process.argv.slice(2);
const input = args.find((a) => !a.startsWith('-'));
const outDir = resolve(root, argValue('-o') || 'out');
const asmOnly = args.includes('--asm');

if (!input) {
  console.error('usage: node tools/build.mjs <project.json> [-o outdir] [--asm]');
  process.exit(2);
}

function argValue(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
}

/* ---- 1. project -> IR ---------------------------------------------- */

const project = migrate(JSON.parse(readFileSync(resolve(root, input), 'utf8')));
const ir = buildIR(project);
const problems = [...ir.diagnostics, ...lint(ir)];

const errors = problems.filter((p) => p.severity === 'error');
problems.forEach((p) => {
  const tag = {error: 'ERROR', warning: 'warn ', info: 'note '}[p.severity];
  console.log(`  ${tag}  ${p.message}`);
});
if (errors.length) {
  console.error(`\n${errors.length} error(s); not building.`);
  process.exit(1);
}

/* ---- 2. IR -> CVBasic ----------------------------------------------- */

const {source, lineMap} = generateProgram(ir, {author: project.meta?.author});
mkdirSync(outDir, {recursive: true});

const name = basename(input).replace(/\.json$/, '');
const basPath = join(outDir, `${name}.bas`);
writeFileSync(basPath, source);

// The engine is shipped as ordinary files next to the generated source
// rather than being concatenated into it, so kernel line numbers stay
// stable, the kernel can be developed and tested outside the tool, and a
// compiler error inside it is recognisable as a tool bug rather than a user
// one.
const engineOut = join(outDir, 'engine');
mkdirSync(engineOut, {recursive: true});
readdirSync(join(root, 'engine')).forEach((f) => {
  copyFileSync(join(root, 'engine', f), join(engineOut, f));
});

console.log(`\n  ${basPath}  (${source.split('\n').length} lines)`);
console.log(`  ${ir.layout.maxEnt} slots, ${ir.layout.spriteDefs}/` +
  `${ir.target.spriteDefBudget} sprite defs, ` +
  `${ir.stats.effectiveCandidates} collision checks/frame`);

const frame = estimateFrame(ir);
console.log(`  Frame ${frame.percent}% at worst case (` +
  frame.parts.map((p) => `${p.name.toLowerCase()} ${p.percent}%`).join(', ') + ')');
frame.advice.forEach((a) => console.log('    - ' + a.text));

writeFileSync(join(outDir, `${name}.blockmap.json`), JSON.stringify(lineMap, null, 2));

/* ---- 3. CVBasic -> asm -> ROM --------------------------------------- */

const cvbasic = findTool('cvbasic');
const gasm80 = findTool('gasm80');
if (!cvbasic || !gasm80) {
  console.log('\n  cvbasic/gasm80 not found; stopping after source generation.');
  console.log('  Put them on PATH or in ./bin to build a ROM.');
  process.exit(0);
}

// CVBasic needs its prologue/epilogue .asm files in the working directory.
const prologues = resolve(root, 'bin/asm');
if (existsSync(prologues)) {
  readdirSync(prologues).forEach((f) => copyFileSync(join(prologues, f), join(outDir, f)));
}

const asmPath = join(outDir, `${name}.asm`);
const flag = ir.target.cvbasicFlag;
const cvArgs = flag ? [flag, `${name}.bas`, `${name}.asm`] : [`${name}.bas`, `${name}.asm`];

// CVBasic prints its banner, its warnings and its RAM accounting on
// stderr, so both streams have to be captured: the budget meter reads that
// accounting line rather than modelling RAM itself.
let cvOut = '';
let cvFailed = false;
try {
  const r = execFileSync(cvbasic, cvArgs,
      {cwd: outDir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe']});
  cvOut = String(r);
} catch (e) {
  cvOut = (e.stdout || '') + (e.stderr || '');
  cvFailed = true;
}
// execFileSync only hands back stdout on success, so re-read stderr via a
// shell redirect when we need the accounting line.
if (!cvFailed && !/RAM bytes used/.test(cvOut)) {
  cvOut += execFileSync('/bin/sh',
      ['-c', `"${cvbasic}" ${cvArgs.map((a) => `'${a}'`).join(' ')} 2>&1`],
      {cwd: outDir, encoding: 'utf8'});
}

// CVBasic prints "ERROR:" in capitals and "Warning:" in lower case, so the
// match has to ignore case or the summary quietly drops the one line that
// matters most.
cvOut.split('\n').filter((l) => /^(warning|error):/i.test(l))
    .forEach((l) => console.log('  ' + l));

// Neither tool can be trusted to exit non-zero. CVBasic returns 0 for some
// errors, and gasm80 returns 0 for an undefined label *and still writes a
// full-size ROM* - so a link failure would otherwise sail through and ship a
// corrupt cartridge. The output text is the authority.
if (/(^|\\s)error[: ]/i.test(cvOut)) cvFailed = true;

if (cvFailed) {
  console.error(cvOut);
  reportError(cvOut, 'cvbasic');
  process.exit(1);
}

const ram = /(\d+) RAM bytes used of (\d+)/.exec(cvOut);
if (ram) {
  const pct = Math.round((+ram[1] / +ram[2]) * 100);
  console.log(`  RAM ${ram[1]}/${ram[2]} bytes (${pct}%)`);
}

if (asmOnly) process.exit(0);

const romPath = join(outDir, `${name}.${ir.target.romExt}`);
let asmLog = '';
try {
  asmLog = execFileSync('/bin/sh',
      ['-c', `"${gasm80}" '${name}.asm' -o '${basename(romPath)}' ` +
        `-l '${name}.lst' -s '${name}.sym' ` +
        `${ir.target.id === 'sms' ? '-sms' : ''} 2>&1`],
      {cwd: outDir, encoding: 'utf8'});
} catch (e) {
  asmLog = (e.stdout || '') + (e.stderr || '');
}
if (/error/i.test(asmLog)) {
  console.error(asmLog.trim());
  console.error('\n  The assembler failed. It still wrote a ROM file - it ' +
    'always does - but that ROM is not usable.');
  reportError(asmLog, 'gasm80');
  process.exit(1);
}

const rom = readFileSync(romPath);
const kb = (n) => `${(n / 1024).toFixed(n % 1024 ? 1 : 0)} KB`;
console.log(`  ROM ${kb(rom.length)}/${kb(ir.target.romBudget)}  ${romPath}`);
if (rom.length > ir.target.romBudget) {
  console.error(`\n  This is larger than a ${kb(ir.target.romBudget)} ` +
    `cartridge. Remove animation frames, rooms or scripts.`);
  process.exit(1);
}

/* ---- helpers -------------------------------------------------------- */

function findTool(tool) {
  const local = join(root, 'bin', tool);
  if (existsSync(local)) return local;
  try {
    return execFileSync('which', [tool], {encoding: 'utf8'}).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Point at the block that caused a compiler error.
 *
 * The mapping itself lives in src/generators/blame.js, shared with the
 * editor: there is no reason for the headless build and the browser to
 * disagree about which block is at fault, and they did while each had its
 * own copy.
 */
function reportError(text, stage) {
  const where = blame({error: text, stderr: text, stage}, lineMap);
  if (where.internal) {
    console.error(`\n  ${where.message}`);
  } else {
    console.error(`\n  -> nearest block: ${where.blockId} ` +
      `(generated line ${where.line})`);
  }
}

function indent(s) {
  return s.split('\n').map((l) => '  ' + l).join('\n');
}
