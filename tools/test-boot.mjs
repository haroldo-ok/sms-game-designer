#!/usr/bin/env node
/**
 * Boot the built editor and check it comes up.
 *
 * `npm run build` succeeding only means webpack was happy. The first time
 * this bundle was actually loaded it threw before rendering anything: main.js
 * had
 *
 *     import Vue from 'vue';
 *     import VueCompositionApi from '@vue/composition-api';
 *     Vue.use(VueCompositionApi);
 *     import App from './App.vue';
 *
 * which looks correct and is not. ES modules evaluate every import before any
 * statement in the body, so App.vue - and through it hooks/project.js, which
 * calls ref() at module scope - ran before the Vue.use did. The plugin could
 * not find Vue, `Vue.observable` was undefined, and the editor failed to boot
 * with an error naming neither file.
 *
 * Nothing else in the suite could have caught that. The components are
 * mounted individually elsewhere, which bypasses main.js entirely.
 *
 *   npm run build && node tools/test-boot.mjs
 */

import {existsSync, readFileSync, readdirSync} from 'fs';
import {join, resolve, dirname} from 'path';
import {fileURLToPath} from 'url';
import {createRequire} from 'module';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(root + '/');
const dist = join(root, 'dist');

if (!existsSync(join(dist, 'index.html'))) {
  console.log('\nboot\n  skipped (no dist - run `npm run build` first)\n');
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

const {JSDOM, VirtualConsole} = require('jsdom');

const problems = [];
const vc = new VirtualConsole()
    .on('jsdomError', (e) => problems.push(`jsdomError: ${e.message}`))
    .on('error', (m) => problems.push(`error: ${m}`));

const dom = new JSDOM(readFileSync(join(dist, 'index.html'), 'utf8'), {
  runScripts: 'dangerously',
  url: 'http://localhost/',
  // Without this there is no requestAnimationFrame, and Vuetify's ripple
  // directive fills the log with failures that are jsdom's, not ours.
  pretendToBeVisual: true,
  virtualConsole: vc,
});

// jsdom will not fetch the bundles over http here, so run them directly in
// document order - which is also what exercises the webpack runtime.
for (const s of dom.window.document.querySelectorAll('script[src]')) {
  const src = s.getAttribute('src');
  try {
    dom.window.eval(readFileSync(join(dist, src), 'utf8'));
  } catch (e) {
    problems.push(`eval ${src}: ${e.message}`);
  }
}

await new Promise((r) => setTimeout(r, 1500));

/** jsdom's own failures to fetch the files we just evaluated by hand. */
const ours = problems.filter((p) => !/Could not load (script|link)/.test(p));
const app = dom.window.document.getElementById('app');
const text = (app ? app.textContent : '').replace(/\s+/g, ' ');

console.log('\nboot');

test('the bundle runs without throwing', () => {
  assert(!ours.length, ours.slice(0, 4).join('\n'));
});

test('the app mounts', () => {
  assert(app, 'there is no #app element');
  assert(app.children.length > 0,
      'the app element is empty, so Vue never rendered');
});

test('the shell is on screen', () => {
  ['SMS Game Designer', 'Play', 'Export'].forEach((s) => {
    assert(text.includes(s), `"${s}" is missing from the toolbar`);
  });
});

test('every tab is present', () => {
  ['Game', 'Actors', 'Rooms', 'Code'].forEach((s) => {
    assert(text.includes(s), `the ${s} tab is missing`);
  });
});

test('a new project lands on something that explains itself', () => {
  // This is the first screen anyone sees, and the one chance to explain the
  // single idea the whole tool rests on.
  assert(/Author kinds of thing/.test(text),
      `the empty state is missing: ${text.slice(0, 160)}`);
  assert(/actor type/.test(text), 'the empty state never says "actor type"');
});

test('the target selector offers the consoles', () => {
  assert(/Sega Master System/.test(text),
      'no target is shown in the toolbar');
});

test('the build is relocatable', () => {
  // publicPath is '' so the bundle works from a file:// copy or any
  // subdirectory - which is how it gets shared.
  const html = readFileSync(join(dist, 'index.html'), 'utf8');
  assert(!/(src|href)="\//.test(html),
      'index.html references assets from the site root, so the build only ' +
    'works when deployed at the top level');
});

test('nothing in the bundle needs a server', () => {
  const files = readdirSync(join(dist, 'js'));
  assert(files.length > 0, 'no javascript was emitted');
  const total = files.reduce((n, f) =>
    n + readFileSync(join(dist, 'js', f)).length, 0);
  assert(total > 100000, `only ${total} bytes of javascript emitted`);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
