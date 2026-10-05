#!/usr/bin/env node
/**
 * Static checks on the editor's Vue components.
 *
 * The whole front end is the one part of this project that has never been
 * executed: building it needs a WASM toolchain that is not available here,
 * so `npm run serve` has never been run. That makes it the largest
 * unverified surface left, and the failures it can have are the quiet kind -
 * a template referencing a name the script does not define renders blank or
 * throws at runtime, and nothing upstream notices.
 *
 * Actually rendering them is worth more and happens in test-render.mjs, in
 * its own process. This file does the two things that need no DOM at all:
 *
 *   - compile every template, which catches syntax errors, bad directives
 *     and malformed expressions outright;
 *   - cross-reference every name a template uses against what its script
 *     actually declares - props, data, computed, methods, setup returns,
 *     components.
 *
 * The second is heuristic: it reads the script rather than running it. So
 * anything it cannot resolve is reported as a warning to look at, and only
 * names it is confident about fail the run.
 *
 *   node tools/test-ui.mjs
 */

import {readFileSync, readdirSync, statSync} from 'fs';
import {join, resolve, dirname, relative} from 'path';
import {fileURLToPath} from 'url';
import {createRequire} from 'module';

const require = createRequire(import.meta.url);
const compiler = require('vue-template-compiler');

// A DOM, so the self-contained components can actually be rendered rather
// than only parsed. jsdom plus Vue's own test utilities is enough for
// anything that does not reach for Blockly or a canvas context.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

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
    e.message.split('\n').forEach((l) => console.log(`        ${l}`));
    if (process.env.UI_DEBUG) console.log(e.stack);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function findVue(dir, out = []) {
  readdirSync(dir).forEach((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) findVue(p, out);
    else if (f.endsWith('.vue')) out.push(p);
  });
  return out;
}

const files = findVue(join(root, 'src'));

/**
 * Names Vue itself provides on the instance, plus the ones our templates
 * legitimately use from Vuetify's slot props.
 */
const BUILTIN = new Set([
  '$emit', '$refs', '$attrs', '$listeners', '$slots', '$scopedSlots',
  '$props', '$data', '$el', '$root', '$parent', '$children', '$nextTick',
  '$set', '$delete', '$watch', '$forceUpdate', '$destroy', '$on', '$once',
  '$off', '$mount', '$vnode', '$createElement', '_self', '_c', '_v', '_s',
  '_e', '_l', '_u', '_b', '_g', '_t', '_m', '_q', '_i', '_k', '_n', '_o',
  '_f', '_d', '_p', '_j', 'on', 'attrs', 'props', 'item', 'index',
  'Math', 'Number', 'String', 'Object', 'Array', 'JSON', 'Boolean', 'Date',
  'undefined', 'null', 'true', 'false', 'NaN', 'Infinity', 'console',
]);

/** Everything the script block appears to put on the instance. */
function declaredNames(script) {
  const names = new Set();
  const add = (s) => s && names.add(s);

  // props: {a: ..., b: ...} or props: ['a','b']
  const props = /props:\s*\{([\s\S]*?)\n  \}/.exec(script);
  if (props) {
    [...props[1].matchAll(/^\s{4}(\w+)\s*:/gm)].forEach((m) => add(m[1]));
  }
  const propsArr = /props:\s*\[([^\]]*)\]/.exec(script);
  if (propsArr) {
    [...propsArr[1].matchAll(/'([^']+)'/g)].forEach((m) => add(m[1]));
  }

  // data() { return { ... } }
  const data = /data\(\)\s*\{\s*return\s*\{([\s\S]*?)\};?\s*\n  \}/.exec(script);
  if (data) {
    [...data[1].matchAll(/(\w+)\s*:/g)].forEach((m) => add(m[1]));
  }

  // computed / methods / components blocks, and setup()'s return object
  ['computed', 'methods', 'components'].forEach((key) => {
    const re = new RegExp(key + ':\\s*\\{([\\s\\S]*?)\\n  \\},?\\n', 'm');
    const block = re.exec(script);
    if (block) {
      [...block[1].matchAll(/^\s{4}(?:async\s+)?(\w+)\s*[:(]/gm)]
          .forEach((m) => add(m[1]));
      // shorthand `Foo,` entries in components
      [...block[1].matchAll(/^\s{4}(\w+),\s*$/gm)].forEach((m) => add(m[1]));
    }
  });

  // setup() { ... return { a, b, c: ... } }
  const setup = /return\s*\{([\s\S]*?)\};\s*\n\s{2}\}/g;
  let m;
  while ((m = setup.exec(script))) {
    [...m[1].matchAll(/(?:^|[\s,{])(\w+)\s*[,:}]/g)].forEach((x) => add(x[1]));
  }

  // imported components registered by name
  [...script.matchAll(/^import\s+(\w+)\s+from\s+'[^']*\.vue'/gm)]
      .forEach((x) => add(x[1]));

  return names;
}

/** Every instance property the compiled render function reaches for. */
function templateNames(render) {
  const used = new Set();
  [...render.matchAll(/_vm\.([A-Za-z_$][\w$]*)/g)].forEach((m) => used.add(m[1]));
  return used;
}

console.log('\ntemplates');

const compiled = new Map();

files.forEach((file) => {
  const rel = relative(root, file);
  test(`${rel}: template compiles`, () => {
    const sfc = compiler.parseComponent(readFileSync(file, 'utf8'));
    assert(sfc.template, 'no <template> block');
    assert(sfc.script, 'no <script> block');
    const res = compiler.compile(sfc.template.content, {outputSourceRange: true});
    assert(!res.errors.length,
        res.errors.map((e) => (e.msg || e)).join('\n'));
    compiled.set(file, {sfc, render: res.render});
  });
});

console.log('\ntemplate bindings');

const suspects = [];

files.forEach((file) => {
  const rel = relative(root, file);
  const entry = compiled.get(file);
  if (!entry) return;
  test(`${rel}: every name the template uses is declared`, () => {
    const declared = declaredNames(entry.sfc.script.content);
    const used = templateNames(entry.render);
    const missing = [...used].filter((n) =>
      !declared.has(n) && !BUILTIN.has(n) && !n.startsWith('$'));
    if (missing.length) {
      // The script is read rather than run, so an unresolved name is a
      // suspect rather than a verdict. Record it and let the caller judge.
      suspects.push({rel, missing});
    }
    assert(!missing.length,
        `template uses names the script does not appear to define: ` +
      missing.join(', '));
  });
});

console.log('\nwiring');

test('every component imported by a view exists', () => {
  const broken = [];
  files.forEach((file) => {
    const src = readFileSync(file, 'utf8');
    [...src.matchAll(/from\s+'(\.[^']*\.vue)'/g)].forEach((m) => {
      const target = resolve(dirname(file), m[1]);
      try {
        statSync(target);
      } catch {
        broken.push(`${relative(root, file)} -> ${m[1]}`);
      }
    });
  });
  assert(!broken.length, broken.join('\n'));
});

test('every module a component imports exists', () => {
  const broken = [];
  files.forEach((file) => {
    const src = readFileSync(file, 'utf8');
    [...src.matchAll(/from\s+'(\.[^']*\.js)'/g)].forEach((m) => {
      const target = resolve(dirname(file), m[1]);
      try {
        statSync(target);
      } catch {
        broken.push(`${relative(root, file)} -> ${m[1]}`);
      }
    });
  });
  assert(!broken.length, broken.join('\n'));
});

test('components emit only events their parent listens for', () => {
  // A mismatched event name is silent: the child fires, nothing happens.
  const emitted = new Map();
  files.forEach((file) => {
    const src = readFileSync(file, 'utf8');
    const evs = new Set(
        [...src.matchAll(/\$emit\('([^']+)'/g)].map((m) => m[1]));
    if (evs.size) emitted.set(relative(root, file), evs);
  });
  const listened = new Set();
  files.forEach((file) => {
    const sfc = compiler.parseComponent(readFileSync(file, 'utf8'));
    if (!sfc.template) return;
    [...sfc.template.content.matchAll(/@([a-z-]+)=/g)]
        .forEach((m) => listened.add(m[1]));
  });
  const orphans = [];
  emitted.forEach((evs, f) => {
    evs.forEach((e) => {
      if (!listened.has(e)) orphans.push(`${f} emits "${e}" - nobody listens`);
    });
  });
  assert(!orphans.length, orphans.join('\n'));
});

test('the tab bar does not grow to fill the screen', () => {
  // Vuetify gives .v-tabs `flex: 1 1 auto`. In a column next to the tab
  // content, the bar and the content split the spare height between them,
  // leaving a third of the screen as an empty band under the tabs on every
  // page. jsdom does no layout, so this pins the override that fixes it.
  const app = readFileSync(join(root, 'src/App.vue'), 'utf8');
  const style = compiler.parseComponent(app).styles.find((x) => !x.scoped);
  assert(style, 'App.vue has no global style block for the override to live in');
  assert(/\.v-tabs\s*\{[^}]*flex:\s*0 0 auto/.test(style.content),
      'the .v-tabs flex override is gone');
  // And it must be global: a scoped rule would not reach the v-tabs inside
  // ActorEditor, which has the same layout.
  const editor = readFileSync(join(root, 'src/components/ActorEditor.vue'), 'utf8');
  assert(/<v-tabs[\s>]/.test(editor),
      'ActorEditor no longer uses v-tabs; this check can be narrowed');
});

if (suspects.length) {
  console.log('\nunresolved names (the script is read, not run):');
  suspects.forEach((s) => console.log(`  ${s.rel}: ${s.missing.join(', ')}`));
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
