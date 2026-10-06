#!/usr/bin/env node
/**
 * The bundled emulator.
 *
 * public/emulator/ is EmulatorJS trimmed to the Master System core by
 * tools/vendor-emulator.py. Three things would quietly undo it, and all
 * three work perfectly online, which is why they need a test:
 *
 *   - a file edited or lost after vendoring;
 *   - the update check coming back, phoning cdn.emulatorjs.org on every Play;
 *   - a console offered for in-editor play whose cartridges the bundled core
 *     cannot load, which EmulatorJS would answer by fetching another core
 *     from its CDN.
 *
 *   node tools/test-emulator.mjs
 */

import {readFileSync, readdirSync, statSync, existsSync} from 'fs';
import {createHash} from 'crypto';
import {join, resolve, dirname, relative} from 'path';
import {fileURLToPath} from 'url';
import {execFileSync} from 'child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const emu = join(root, 'public/emulator');

if (!existsSync(join(emu, 'MANIFEST.txt'))) {
  console.log('\nbundled emulator\n  skipped (no public/emulator - run tools/vendor-emulator.py)\n');
  process.exit(0);
}

const {TARGETS} = await import('../src/ir/schema.js');

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

function walk(dir, out = []) {
  readdirSync(dir).forEach((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  });
  return out;
}

const manifest = readFileSync(join(emu, 'MANIFEST.txt'), 'utf8').split('\n');
const listed = new Map(manifest
    .map((l) => /^([0-9a-f]{64})  (.+)$/.exec(l))
    .filter(Boolean)
    .map((m) => [m[2], m[1]]));

console.log('\nbundled emulator');

test('every file matches the manifest, byte for byte', () => {
  const bad = [];
  listed.forEach((hash, rel) => {
    const p = join(emu, rel);
    if (!existsSync(p)) {
      bad.push(`${rel} is missing`);
      return;
    }
    const actual = createHash('sha256').update(readFileSync(p)).digest('hex');
    if (actual !== hash) bad.push(`${rel} has changed since it was vendored`);
  });
  assert(!bad.length, bad.join('\n'));
});

test('nothing is in the bundle that the manifest does not account for', () => {
  const extra = walk(emu)
      .map((p) => relative(emu, p).split('\\').join('/'))
      .filter((rel) => rel !== 'MANIFEST.txt' && !listed.has(rel));
  assert(!extra.length, `unaccounted for: ${extra.join(', ')}`);
});

test('the bundle is small', () => {
  // A full release is 303 MB. Something pulling in more cores would show
  // up here before it showed up in a download.
  const bytes = walk(emu).reduce((n, p) => n + statSync(p).size, 0);
  assert(bytes < 4e6, `the emulator bundle is ${(bytes / 1e6).toFixed(1)} MB`);
});

test('the update check stays disabled', () => {
  const js = readFileSync(join(emu, 'emulator.min.js'), 'utf8');
  assert(!/this\.checkForUpdates\(\)/.test(js),
      'emulator.min.js calls checkForUpdates again, which fetches ' +
    'cdn.emulatorjs.org whenever the editor runs on localhost');
  assert(/update check disabled/.test(js), 'the vendoring patch marker is gone');
});

test('the version is pinned, and the manifest agrees with it', () => {
  const v = JSON.parse(readFileSync(join(emu, 'version.json'), 'utf8')).version;
  assert(/^\d+\.\d+\.\d+$/.test(v), `version.json says "${v}"`);
  assert(manifest[0].includes(`EmulatorJS ${v}`),
      `the manifest describes "${manifest[0]}", the files say ${v}`);
});

test('the editor loads the emulator locally, never from a CDN', () => {
  const hook = readFileSync(join(root, 'src/hooks/emulator.js'), 'utf8');
  const code = hook.split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n');
  assert(!/https?:\/\//.test(code),
      'src/hooks/emulator.js contains a URL outside its comments');
  assert(/new URL\('emulator\/', document\.baseURI\)/.test(code),
      'the emulator path is no longer resolved against the page');
});

test('every console offered for in-editor play is one the core can load', () => {
  // EmulatorJS picks a core by system and the core picks a mode by file
  // extension. A console whose cartridges the bundled core cannot load
  // would send EmulatorJS to its CDN for another one.
  const bundled = Object.values(TARGETS).filter((t) => t.bundledEmulator);
  assert(bundled.length >= 1, 'no console is marked for in-editor play');
  let extensions;
  try {
    const out = execFileSync('python3', ['-c', `
import py7zr, json, sys, tempfile, os
d = tempfile.mkdtemp()
with py7zr.SevenZipFile(sys.argv[1]) as z:
    z.extractall(path=d)
print(json.dumps(json.load(open(os.path.join(d, 'core.json')))['extensions']))
`, join(emu, 'cores/smsplus-legacy-wasm.data')], {encoding: 'utf8'});
    extensions = JSON.parse(out);
  } catch (e) {
    // Without py7zr the archive cannot be opened here; vendor-emulator.py
    // makes the same check when the bundle is built.
    console.log('        (py7zr not installed: checked at vendoring time only)');
    return;
  }
  const unsupported = bundled.filter((t) => !extensions.includes(t.romExt));
  assert(!unsupported.length,
      `the core cannot load .${unsupported.map((t) => t.romExt).join(', .')}`);
  bundled.forEach((t) => {
    assert(t.emulatorCore === 'segaMS',
        `${t.id} asks EmulatorJS for "${t.emulatorCore}", which is not the bundled core's system`);
  });
});

test('consoles without a bundled core say so instead of reaching for the CDN', () => {
  const hook = readFileSync(join(root, 'src/hooks/emulator.js'), 'utf8');
  assert(/if \(!target\.bundledEmulator\)/.test(hook),
      'play() no longer stops for consoles whose core is not bundled');
  const unbundled = Object.values(TARGETS).filter((t) => !t.bundledEmulator);
  assert(unbundled.every((t) => t.id === 'coleco' || t.id === 'msx'),
      `unexpected consoles without in-editor play: ${unbundled.map((t) => t.id)}`);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
