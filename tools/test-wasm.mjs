#!/usr/bin/env node
/**
 * The in-browser compiler.
 *
 * cvbasic and gasm80 are built to WebAssembly with Zig (toolchain/Makefile)
 * and run by a small JavaScript WASI runtime. This runs the editor's own
 * compile path - compiler-core.js, build-rom.js, wasi-run.js, unchanged -
 * against every sample, and requires the ROM to be byte-identical to the
 * native compilers' output. Anything less and the browser could ship games
 * that differ from the ones the playtests verified.
 *
 * It also covers the ways a build fails, because that is where this project
 * keeps finding its bugs: a compile error, a link error that gasm80 reports
 * while exiting 0, a missing toolchain, and state leaking between builds.
 *
 *   node tools/test-wasm.mjs
 */

import {readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync, copyFileSync,
  rmSync} from 'fs';
import {join, resolve, dirname} from 'path';
import {fileURLToPath, pathToFileURL} from 'url';
import {execFileSync} from 'child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const wasmDir = join(root, 'public/wasm');

if (!existsSync(join(wasmDir, 'cvbasic.wasm'))) {
  console.log('\nin-browser compiler\n  skipped (no public/wasm - run `make -C toolchain wasm`)\n');
  process.exit(0);
}

const {handleBuild, loadTools} = await import('../src/workers/compiler-core.js');
const {migrate} = await import('../src/ir/schema.js');
const {buildIR} = await import('../src/ir/build-ir.js');
const {generateProgram} = await import('../src/generators/cvbasic/emit-program.js');
const {blame} = await import('../src/generators/blame.js');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
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

/** Serve public/wasm the way a static server would. */
const BASE = pathToFileURL(wasmDir + '/').href;
const fileFetch = async (url) => {
  try {
    const bytes = readFileSync(fileURLToPath(url));
    return {ok: true, status: 200,
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
      text: async () => bytes.toString('utf8')};
  } catch {
    return {ok: false, status: 404};
  }
};

const engine = Object.fromEntries(readdirSync(join(root, 'engine'))
    .map((f) => [f, readFileSync(join(root, 'engine', f), 'utf8')]));

function sourceFor(name) {
  const p = migrate(JSON.parse(readFileSync(join(root, `examples/${name}.json`), 'utf8')));
  const ir = buildIR(p);
  return {project: p, ir, ...generateProgram(ir)};
}

let id = 0;
const build = (source, target, extra = {}) => handleBuild({id: ++id, source, engine,
  target, base: BASE, ...extra}, fileFetch);

/** The native compilers, for comparison. */
const bin = join(root, 'bin');
const haveNative = existsSync(join(bin, 'cvbasic')) && existsSync(join(bin, 'gasm80'));
function nativeRom(name, source, target) {
  const dir = join(root, 'out/wasm-test', name);
  mkdirSync(join(dir, 'engine'), {recursive: true});
  Object.entries(engine).forEach(([f, t]) => writeFileSync(join(dir, 'engine', f), t));
  readdirSync(join(bin, 'asm')).forEach((f) => copyFileSync(join(bin, 'asm', f), join(dir, f)));
  writeFileSync(join(dir, 'game.bas'), source);
  const flag = {sms: '--sms', sg1000: '--sg1000', msx: '--msx'}[target];
  execFileSync(join(bin, 'cvbasic'), flag ? [flag, 'game.bas', 'game.asm'] : ['game.bas', 'game.asm'],
      {cwd: dir, stdio: 'pipe'});
  execFileSync(join(bin, 'gasm80'), ['game.asm', '-o', 'game.rom', ...(target === 'sms' ? ['-sms'] : [])],
      {cwd: dir, stdio: 'pipe'});
  return readFileSync(join(dir, 'game.rom'));
}

console.log('\nin-browser compiler');

for (const name of ['shmup', 'platformer', 'kitchen-sink', 'shmup-sg1000']) {
  await test(`${name}: builds in the browser, identical to the native compilers`, async () => {
    const {project, source} = sourceFor(name);
    const res = await build(source, project.target);
    assert(res.ok, `${res.stage}: ${res.error}`);
    assert(res.rom.length === 32768, `${res.rom.length} byte ROM`);
    assert(String.fromCharCode(...res.rom.slice(0x7ff0, 0x7ff8)) === 'TMR SEGA',
        'no TMR SEGA header');
    assert(res.ramUsed > 0 && res.ramTotal > res.ramUsed,
        `RAM accounting missing: ${res.ramUsed}/${res.ramTotal}`);
    if (haveNative) {
      const native = nativeRom(name, source, project.target);
      assert(Buffer.compare(Buffer.from(res.rom), native) === 0,
          'the browser built a different ROM from the native compilers');
    }
  });
}

await test('builds do not leak into each other', async () => {
  // Neither compiler resets its globals between runs. Every build gets a
  // fresh WebAssembly instance for that reason; prove it holds.
  const a = sourceFor('shmup').source;
  const b = sourceFor('platformer').source;
  const first = await build(a, 'sms');
  await build(b, 'sms');
  const again = await build(a, 'sms');
  assert(first.ok && again.ok, 'a build failed');
  assert(Buffer.compare(Buffer.from(first.rom), Buffer.from(again.rom)) === 0,
      'building something else in between changed the result');
});

await test('the debug outputs come back for the live inspector', async () => {
  const res = await build(sourceFor('shmup').source, 'sms', {wantDebug: true, wantAsm: true});
  assert(res.asm && /cvb_GAME_LOOP|game_loop/i.test(res.asm), 'no assembly');
  assert(res.sym && /ARRAY_E_X/.test(res.sym), 'no symbol table');
  assert(res.lst && /CVB_K_RENDER:/.test(res.lst), 'no listing');
});

await test('a compile error fails the build and names the block', async () => {
  const {source, lineMap} = sourceFor('shmup');
  // Splice a statement CVBasic cannot parse in right after a block marker,
  // as a broken `raw` block would produce.
  const marker = lineMap[3];
  const lines = source.split('\n');
  lines.splice(marker.line, 0, '\tTHIS IS NOT CVBASIC');
  const shifted = lineMap.map((e) => (e.line > marker.line ? {...e, line: e.line + 1} : e));
  const res = await build(lines.join('\n'), 'sms');
  assert(!res.ok, 'the build succeeded with invalid source');
  assert(res.stage === 'cvbasic', `failed at stage ${res.stage}`);
  const where = blame(res, shifted);
  assert(where.blockId === marker.blockId,
      `the error was pinned on ${where.blockId || 'nothing'}, not ${marker.blockId}`);
});

await test('a link error fails the build even though gasm80 exits 0', async () => {
  // PLAY of a tune that does not exist compiles, then assembles to an
  // undefined label - which gasm80 reports, exits 0 for, and writes a
  // full-size ROM despite. Judging by exit code would ship that ROM.
  const src = sourceFor('shmup').source.replace(/^game_loop:/m,
      '\tPLAY no_such_tune\ngame_loop:');
  const res = await build(src, 'sms');
  assert(!res.ok, 'a ROM with an undefined label was accepted');
  assert(res.stage === 'gasm80', `failed at ${res.stage}`);
  assert(!res.rom, 'the corrupt ROM was handed back anyway');
});

await test('a missing compiler says so, rather than failing obscurely', async () => {
  const res = await handleBuild({id: 1, source: 'x', engine, target: 'sms',
    base: pathToFileURL(join(root, 'no-such-dir') + '/').href}, fileFetch);
  assert(!res.ok && res.missingToolchain, 'not recognised as a missing toolchain');
  assert(/make -C toolchain wasm/.test(res.error), `unhelpful message: ${res.error}`);
});

await test('a failed load is not cached', async () => {
  // Otherwise installing the compilers would need a page reload to notice.
  // Unique and emptied first: reusing a scratch directory let a previous
  // run's compilers make the "missing" toolchain present.
  const late = join(root, `out/late-wasm-${process.pid}`);
  rmSync(late, {recursive: true, force: true});
  mkdirSync(late, {recursive: true});
  const base = pathToFileURL(late + '/').href;
  const first = await handleBuild({id: 1, source: sourceFor('shmup').source, engine,
    target: 'sms', base}, fileFetch);
  assert(first.missingToolchain, 'expected the empty directory to fail');
  readdirSync(wasmDir).forEach((f) => copyFileSync(join(wasmDir, f), join(late, f)));
  const second = await handleBuild({id: 2, source: sourceFor('shmup').source, engine,
    target: 'sms', base}, fileFetch);
  assert(second.ok, `still failing after the compilers appeared: ${second.error}`);
  rmSync(late, {recursive: true, force: true});
});

await test('the compilers are compiled once, not on every build', async () => {
  const a = await loadTools(BASE, fileFetch);
  const b = await loadTools(BASE, fileFetch);
  assert(a === b, 'the toolchain was fetched and compiled again');
});

await test('the Worker glue delivers a ROM', async () => {
  // compiler.worker.js is only plumbing, but it is the plumbing the editor
  // uses. Load it with a stand-in `self` and post it a message.
  const posted = [];
  globalThis.self = {postMessage: (m) => posted.push(m)};
  const realFetch = globalThis.fetch;
  globalThis.fetch = fileFetch;
  try {
    await import(`../src/workers/compiler.worker.js?t=${Date.now()}`);
    await globalThis.self.onmessage({data: {action: 'build', id: 77,
      source: sourceFor('shmup').source, engine, target: 'sms', base: BASE}});
  } finally {
    globalThis.fetch = realFetch;
  }
  assert(posted.length === 1, `${posted.length} messages posted`);
  assert(posted[0].id === 77 && posted[0].ok && posted[0].rom.length === 32768,
      `worker replied ${JSON.stringify({id: posted[0].id, ok: posted[0].ok, error: posted[0].error})}`);
});

await test('the editor hands the compiler every engine file', () => {
  // A new engine file the editor does not bundle builds fine natively and
  // fails only in the browser, with an INCLUDE error naming a file the user
  // has never heard of.
  const hook = readFileSync(join(root, 'src/hooks/cvbasic-compiler.js'), 'utf8');
  const bundled = [...hook.matchAll(/'([a-z_]+\.bas)':/g)].map((m) => m[1]).sort();
  const onDisk = readdirSync(join(root, 'engine')).filter((f) => f.endsWith('.bas')).sort();
  assert(JSON.stringify(bundled) === JSON.stringify(onDisk),
      `bundled ${bundled.join(', ')}; engine/ has ${onDisk.join(', ')}`);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
