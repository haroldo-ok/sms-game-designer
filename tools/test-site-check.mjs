#!/usr/bin/env node
/**
 * Tests for tools/check-site.mjs, against a real build with each kind of
 * breakage introduced on purpose.
 *
 * The checker exists because the published site broke silently: a deploy
 * committed with `git commit -a` rewrote index.html to point at a newly named
 * bundle and never added the bundle. It was also run against every real
 * deployment of the site, and called each one correctly; this keeps it
 * calling them correctly.
 *
 *   npm run build && node tools/test-site-check.mjs
 */

import {existsSync, cpSync, rmSync, readdirSync, readFileSync, writeFileSync,
  mkdtempSync} from 'fs';
import {join, resolve, dirname} from 'path';
import {tmpdir} from 'os';
import {fileURLToPath} from 'url';
import {spawnSync, execFileSync} from 'child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const checker = join(root, 'tools/check-site.mjs');

if (!existsSync(join(dist, 'index.html'))) {
  console.log('\nsite checker\n  skipped (no dist - run `npm run build` first)\n');
  process.exit(0);
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

/** A fresh copy of the build to break, outside any git work tree. */
function copy() {
  const d = join(mkdtempSync(join(tmpdir(), 'site-')), 'docs');
  cpSync(dist, d, {recursive: true});
  return d;
}

function check(dir, ...flags) {
  const r = spawnSync('node', [checker, dir, ...flags], {encoding: 'utf8'});
  return {code: r.status, out: r.stdout + r.stderr};
}

const appBundle = readdirSync(join(dist, 'js')).find((f) => /^app\..*\.js$/.test(f));

console.log('\nsite checker');

test('a complete build passes', () => {
  const r = check(copy(), '--no-git');
  assert(r.code === 0, r.out);
  assert(/is complete/.test(r.out), r.out);
});

test('a missing app bundle fails, by name', () => {
  // What actually happened to the published site.
  const d = copy();
  rmSync(join(d, 'js', appBundle));
  const r = check(d, '--no-git');
  assert(r.code === 1, 'passed with the app bundle missing');
  assert(r.out.includes(`missing js/${appBundle}`), r.out);
});

test('a missing on-demand chunk fails, though index.html never names it', () => {
  // The compiler Worker and the examples are only listed in the chunk table
  // inside the app bundle. Checking index.html alone would miss them.
  const d = copy();
  const worker = readFileSync(join(d, 'js', appBundle), 'utf8')
      .match(/new Worker\(new URL\(\w\.p\+\w\.u\((\d+)\)/);
  assert(worker, 'could not find the Worker chunk to remove');
  const file = readdirSync(join(d, 'js'))
      .find((f) => f.startsWith(`${worker[1]}.`) && f.endsWith('.js'));
  rmSync(join(d, 'js', file));
  const r = check(d, '--no-git');
  assert(r.code === 1 && r.out.includes(`missing js/${file}`), r.out);
  assert(/loads on demand/.test(r.out), r.out);
});

test('a missing compiler fails', () => {
  const d = copy();
  rmSync(join(d, 'wasm/gasm80.wasm'));
  const r = check(d, '--no-git');
  assert(r.code === 1 && r.out.includes('missing wasm/gasm80.wasm'), r.out);
});

test('an emulator file that changed fails', () => {
  const d = copy();
  writeFileSync(join(d, 'emulator/loader.js'), '// tampered\n');
  const r = check(d, '--no-git');
  assert(r.code === 1 && /emulator\/loader\.js differs/.test(r.out), r.out);
});

test('a line-ending-only difference is a note, not a failure', () => {
  // Git's autocrlf did this to a translation file in the real repository.
  const d = copy();
  const p = join(d, 'emulator/localization/en-US.json');
  writeFileSync(p, readFileSync(p, 'utf8').replace(/\n/g, '\r\n'));
  const r = check(d, '--no-git');
  assert(r.code === 0, r.out);
  assert(/only in line endings/.test(r.out), r.out);
});

test('an asset referenced from the root of the domain fails', () => {
  // A GitHub Pages project site lives in a subdirectory.
  const d = copy();
  const p = join(d, 'index.html');
  writeFileSync(p, readFileSync(p, 'utf8').replace('src="js/', 'src="/js/'));
  const r = check(d, '--no-git');
  assert(r.code === 1 && /root of the domain/.test(r.out), r.out);
});

test('new files that git does not know about fail, with the fix', () => {
  // The trap itself: commit a deploy, rebuild, and the new bundle is
  // untracked - exactly what `git commit -a` leaves behind.
  const repo = mkdtempSync(join(tmpdir(), 'repo-'));
  const git = (...a) => execFileSync('git', a, {cwd: repo, stdio: 'pipe'});
  git('init', '-q');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  cpSync(dist, join(repo, 'docs'), {recursive: true});
  git('add', '-A', 'docs');
  git('commit', '-qm', 'deploy');
  const renamed = appBundle.replace(/\.[0-9a-f]+\.js$/, '.00000000.js');
  const html = join(repo, 'docs/index.html');
  writeFileSync(html, readFileSync(html, 'utf8').replace(appBundle, renamed));
  cpSync(join(repo, 'docs/js', appBundle), join(repo, 'docs/js', renamed));
  rmSync(join(repo, 'docs/js', appBundle));

  const before = check(join(repo, 'docs'));
  assert(before.code === 1, 'an untracked bundle was not noticed');
  assert(before.out.includes(`docs/js/${renamed}`), before.out);
  assert(before.out.includes('git add -A'), 'it does not say how to fix it');

  git('add', '-A', 'docs');
  const after = check(join(repo, 'docs'));
  assert(after.code === 0, `still failing after git add -A: ${after.out}`);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
