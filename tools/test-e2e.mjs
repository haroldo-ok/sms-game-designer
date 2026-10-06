#!/usr/bin/env node
/**
 * Drive the built editor the way a person would.
 *
 * Every other test in this repository checks a piece in isolation, and the
 * editor still shipped with a room editor whose actor placement silently did
 * nothing, whose tile painting had no tiles to paint and no way to choose
 * one, and which needed thirty-two clicks to lay a floor. Each piece looked
 * fine on its own; the failures were in how they met.
 *
 * So this loads `dist/` into a jsdom - with real script loading, webpack's
 * own chunk fetching, and a real canvas from the `canvas` package - and walks
 * through the things that were reported broken, in the order a person would
 * meet them.
 *
 *   npm run build && node tools/test-e2e.mjs
 */

import {existsSync, readFileSync} from 'fs';
import {join, resolve, dirname} from 'path';
import {fileURLToPath} from 'url';
import {createRequire} from 'module';
import {installWorker} from './worker-emulator.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(root + '/');
const dist = join(root, 'dist');

if (!existsSync(join(dist, 'index.html'))) {
  console.log('\nend to end\n  skipped (no dist - run `npm run build` first)\n');
  process.exit(0);
}

const {JSDOM, VirtualConsole, requestInterceptor} = require('jsdom');
let haveCanvas = true;
try {
  require.resolve('canvas');
} catch {
  haveCanvas = false;
}

let passed = 0;
let failed = 0;

/**
 * Errors that escape a page asynchronously - thrown from a promise callback
 * inside a script jsdom loaded - land here rather than in the virtual
 * console, and by default they kill the process mid-run. That made this
 * test's result depend on timing. They are now collected, and the last test
 * fails if any arrived, naming them; a crash is a result, not an abort.
 */
const escaped = [];
process.on('uncaughtException', (e) => escaped.push(String((e && e.message) || e)));
process.on('unhandledRejection', (e) => escaped.push(String((e && e.message) || e)));

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

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---- a browser, serving dist/ ----------------------------------------- */

const TYPES = {js: 'application/javascript', css: 'text/css', json: 'application/json'};

/** Answer every request from dist/, so script tags and lazy chunks load. */
/**
 * Serve dist/ as a static server mounted at `prefix` would. Only the
 * editor's own files: anything else - the emulator's CDN, in practice - is
 * unreachable, as it would be offline. Returns null for a 404.
 */
function serveFrom(prefix, opts = {}, log = null) {
  return (url) => {
    if (log) log.push(url.href);
    if (url.hostname !== 'localhost') return null;
    if (!url.pathname.startsWith(prefix)) return null;
    const path = url.pathname.slice(prefix.length);
    if (opts.withoutCompiler && path.startsWith('wasm/')) return null;
    if (opts.withoutEmulator && path.startsWith('emulator/')) return null;
    try {
      return readFileSync(join(dist, path));
    } catch {
      return null;
    }
  };
}

const interceptorFor = (serve) => requestInterceptor((request) => {
  const path = new URL(request.url).pathname;
  const body = serve(new URL(request.url));
  return body
    ? new Response(body, {headers: {'Content-Type': TYPES[path.split('.').pop()] || 'text/plain'}})
    : new Response('not found', {status: 404});
});

/**
 * Open the built editor in a jsdom.
 *
 * jsdom has no fetch and no URL.createObjectURL, both of which every browser
 * has; they are supplied here from dist/, the same way the request
 * interceptor serves script tags. The blobs handed to createObjectURL are
 * kept, because that is where the ROM goes on its way to the emulator - so a
 * test can compare the editor's ROM with the native compilers' byte for byte.
 *
 * Web Workers are emulated by default (see worker-emulator.mjs), so the
 * editor takes the same path it takes in a browser: the real built worker
 * bundle, loading its own chunks by the browser's URL rules. Before that,
 * jsdom's lack of Workers sent every build down the in-page fallback, and a
 * worker that could not load its own code shipped with every test green.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.withoutCompiler] answer 404 for wasm/, as a build
 *   without the compilers would
 * @param {boolean} [opts.withoutEmulator] answer 404 for emulator/, as a
 *   copy of the editor missing its bundled emulator would
 * @param {boolean} [opts.noWorker] leave Worker undefined, to exercise the
 *   in-page fallback deliberately
 * @param {string} [opts.prefix] serve the editor from this path, not '/'
 */
async function openEditor(opts = {}) {
  const problems = [];
  const vc = new VirtualConsole()
      .on('jsdomError', (e) => problems.push(e.message))
      .on('error', (m) => problems.push(String(m)));
  const prefix = opts.prefix || '/';
  const requests = [];
  const serve = serveFrom(prefix, opts, requests);
  let workers = {created: [], errors: []};
  const dom = new JSDOM(readFileSync(join(dist, 'index.html'), 'utf8'), {
    url: `http://localhost${prefix}`,
    beforeParse(win) {
      if (!opts.noWorker) workers = installWorker(win, serve);
    },
    runScripts: 'dangerously',
    resources: {interceptors: [interceptorFor(serve)]},
    pretendToBeVisual: true,
    virtualConsole: vc,
  });
  const w = dom.window;
  const blobs = [];
  w.fetch = async (url) => {
    const b = serve(new URL(url, w.location.href));
    if (!b) return {ok: false, status: 404};
    return {ok: true, status: 200, text: async () => b.toString('utf8'),
      arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.length)};
  };
  w.URL.createObjectURL = (blob) => {
    blobs.push(blob);
    return `blob:http://localhost/${blobs.length}`;
  };
  w.URL.revokeObjectURL = () => {};
  await wait(2500);

  const app = () => w.document.getElementById('app');
  return {
    w,
    problems,
    blobs,
    requests,
    workers: () => workers,
    text: () => app().textContent.replace(/\s+/g, ' '),
    tab: (name) => [...w.document.querySelectorAll('.main-pane > .v-tabs .v-tab')]
        .find((t) => t.textContent.trim().toLowerCase() === name.toLowerCase()),
    button: (label) => [...w.document.querySelectorAll('button')]
        .find((b) => b.textContent.trim() === label),
    /** Room-canvas cells are 16 px; jsdom puts the canvas at the origin. */
    mouse: (el, type, cx, cy, button = 0) => el.dispatchEvent(new w.MouseEvent(type,
        {clientX: cx * 16 + 4, clientY: cy * 16 + 4, button, bubbles: true})),
    saved: async () => {
      await wait(1400);          // the autosave debounce
      return JSON.parse(w.localStorage.getItem('sms-game-designer:project'));
    },
    close: () => w.close(),
  };
}

/* ------------------------------------------------------------------------ */

console.log('\nend to end');
if (!haveCanvas) console.log('  (no canvas package: drawing is not exercised)');

const ed = await openEditor();

await test('the editor boots cleanly', () => {
  assert(/SMS Game Designer/.test(ed.text()), 'the toolbar never rendered');
  assert(!ed.problems.length, ed.problems.slice(0, 3).join('\n'));
});

await test('Rooms explains itself before there is anything to place', async () => {
  // The reported failure started exactly here: opening Rooms before any
  // actor existed fixed the "actor to place" at null for good.
  ed.tab('Rooms').click();
  await wait(400);
  assert(/no actor types yet|Create an actor type/i.test(ed.text()),
      'with no actors, clicking the room does nothing and nothing says why');
});

await test('an actor created afterwards can be placed', async () => {
  ed.tab('Actors').click();
  await wait(300);
  ed.button('Create the first actor type').click();
  await wait(300);
  ed.tab('Rooms').click();
  await wait(500);
  const canvas = ed.w.document.querySelector('.room-canvas');
  ed.mouse(canvas, 'mousedown', 5, 6);
  ed.mouse(canvas, 'mouseup', 5, 6);
  const s = await ed.saved();
  const pl = s.rooms[0].placements;
  assert(pl.length === 1, `${pl.length} placements after one click`);
  assert(pl[0].x === 40 && pl[0].y === 48,
      `placed at ${pl[0].x},${pl[0].y}, expected 40,48`);
});

await test('there are tiles to paint with, and one can be chosen', async () => {
  ed.button('Paint tiles').click();
  await wait(400);
  const swatches = ed.w.document.querySelectorAll('.tile-palette .tile');
  assert(swatches.length >= 4, `${swatches.length} tiles offered`);
  swatches[3].click();
  await wait(200);
  assert(swatches[3].classList.contains('sel'), 'choosing a tile did not select it');
});

await test('one drag paints a whole run of tiles', async () => {
  const canvas = ed.w.document.querySelector('.room-canvas');
  ed.mouse(canvas, 'mousedown', 2, 20);
  for (let x = 3; x <= 12; x++) ed.mouse(canvas, 'mousemove', x, 20);
  ed.mouse(canvas, 'mouseup', 12, 20);
  const s = await ed.saved();
  const row = s.rooms[0].tiles[20].slice(2, 13);
  assert(row.every((t) => t === 3), `row 20 cells 2-12 are ${row.join(',')}`);
});

await test('the painted tiles are actually drawn on the canvas', () => {
  if (!haveCanvas) return;
  // Not the tile index in a data structure: the pixels on the canvas. Cell
  // (5,20) now holds grass, whose top rows are green, where an empty cell is
  // the backdrop colour.
  const canvas = ed.w.document.querySelector('.room-canvas');
  const ctx = canvas.getContext('2d');
  const at = (cx, cy, dx, dy) => [...ctx.getImageData(cx * 16 + dx, cy * 16 + dy, 1, 1).data];
  const painted = at(5, 20, 5, 3);
  const empty = at(5, 10, 5, 3);
  assert(painted.join() !== empty.join(),
      `a painted cell and an empty one look the same: ${painted} vs ${empty}`);
  assert(painted[1] > painted[0] && painted[1] > painted[2],
      `grass should be green on screen, got rgba(${painted})`);
});

await test('right-dragging erases', async () => {
  const canvas = ed.w.document.querySelector('.room-canvas');
  ed.mouse(canvas, 'mousedown', 4, 20, 2);
  ed.mouse(canvas, 'mousemove', 5, 20, 2);
  ed.mouse(canvas, 'mouseup', 5, 20, 2);
  const s = await ed.saved();
  assert(s.rooms[0].tiles[20].slice(2, 8).join(',') === '3,3,0,0,3,3',
      `row 20 is ${s.rooms[0].tiles[20].slice(2, 8).join(',')}`);
});

await test('every step so far ran without an error', () => {
  assert(!ed.problems.length, ed.problems.slice(0, 3).join('\n'));
});

ed.close();

/* ---- examples --------------------------------------------------------- */

const ex = await openEditor();

await test('Open lists the examples', async () => {
  ex.button('Open').click();
  await wait(400);
  const titles = [...ex.w.document.querySelectorAll('.example-item .v-list-item__title')]
      .map((t) => t.textContent.trim().split(/\s{2,}|\n/)[0]);
  ['Bug Blaster', 'Cavern Run', 'Bug Blaster SG'].forEach((t) => {
    assert(titles.some((x) => x.startsWith(t)), `"${t}" is not offered: ${titles}`);
  });
});

await test('an example opens', async () => {
  [...ex.w.document.querySelectorAll('.example-item')][0].click();
  await wait(1500);
  const s = await ex.saved();
  assert(s && s.name === 'Bug Blaster', `opened ${s && s.name}`);
  const listed = [...ex.w.document.querySelectorAll('.actors .item .nm')]
      .map((n) => n.textContent.trim());
  assert(listed.includes('Ship') && listed.includes('Bug'),
      `the actor list shows ${listed.join(', ')}`);
});

await test('its scripts open as blocks, not as an empty workspace', async () => {
  // The examples store programs, not Blockly XML. Opened naively, every
  // script would be an empty workspace, and the first edit would lower that
  // emptiness over the real program.
  [...ex.w.document.querySelectorAll('.actors .item')]
      .find((i) => i.textContent.includes('Ship')).click();
  await wait(400);
  [...ex.w.document.querySelectorAll('.actor-editor .v-tab')]
      .find((t) => t.textContent.trim() === 'Events').click();
  await wait(400);
  [...ex.w.document.querySelectorAll('.event-bar .v-chip')]
      .find((c) => c.textContent.includes('collide with enemy')).click();
  await wait(1200);
  const blocks = ex.w.document.querySelectorAll('.blocklyDraggable').length;
  assert(blocks >= 5, `${blocks} blocks drawn for a five-statement script`);
  const s = await ex.saved();
  const sc = s.actors.find((a) => a.id === 'ship').scripts['collide:enemy'];
  assert(sc.xml && /<block /.test(sc.xml), 'the rebuilt blocks were not kept');
  assert(sc.stmts.length === 3 && sc.stmts[2].op === 'if',
      'opening the script changed the program');
});

await test('opening an example ran without an error', () => {
  assert(!ex.problems.length, ex.problems.slice(0, 3).join('\n'));
});

ex.close();

/* ---- compiling in the browser ---------------------------------------- */

const cp = await openEditor();
const nativeRom = (() => {
  try {
    return readFileSync(join(root, 'out/shmup.sms'));
  } catch {
    return null;
  }
})();

await test('Play builds the open project in the browser', async () => {
  cp.button('Open').click();
  await wait(300);
  [...cp.w.document.querySelectorAll('.example-item')][0].click();
  await wait(1500);
  cp.button('Play').click();
  for (let i = 0; i < 60 && !cp.w.document.querySelector('.play .built'); i++) {
    await wait(250);
  }
  const built = cp.w.document.querySelector('.play .built');
  assert(built, 'Play never produced a ROM');
  assert(/32 KB ROM/.test(built.textContent), `the Play tab says: ${built.textContent}`);
});

/**
 * The editor's own Workers, as opposed to the emulator's.
 *
 * Since the emulator is bundled, it gets far enough to start its own
 * decompression Worker - from a blob: URL, which this harness cannot serve,
 * because jsdom has no real URL.createObjectURL. That failure belongs to the
 * test environment and to EmulatorJS, and it must not be read as the
 * compiler failing; equally, a real compiler failure must never be filtered
 * out with it. The editor's worker is always a script under js/, never a
 * blob, so that is the line.
 */
function editorWorkers(ed) {
  const w = ed.workers();
  return {
    created: w.created.filter((u) => !u.startsWith('blob:')),
    errors: w.errors.filter((e) => !/blob:/.test(e)),
  };
}

await test('the build ran in the Worker, which loaded all of its code', () => {
  // The bug this guards against: the worker asked for js/js/755…js and
  // failed before compiling anything.
  const w = editorWorkers(cp);
  assert(w.created.length >= 1, 'no Worker was started; the in-page fallback built it');
  assert(!w.errors.length, w.errors.join('\n'));
});

await test('the ROM the editor builds is the ROM the native compilers build', async () => {
  // Captured on its way to the emulator. Anything but identical would mean
  // the browser ships a different game from the one the playtests verified.
  assert(cp.blobs.length >= 1, 'no ROM was handed to the emulator');
  const rom = Buffer.from(await cp.blobs[0].arrayBuffer());
  assert(rom.length === 32768, `${rom.length} byte ROM`);
  assert(rom.slice(0x7ff0, 0x7ff8).toString() === 'TMR SEGA', 'no TMR SEGA header');
  if (nativeRom) {
    assert(Buffer.compare(rom, nativeRom) === 0,
        'the editor built a different ROM from out/shmup.sms');
  }
});

await test('the budget meter switches to the compiler\'s own RAM figure', () => {
  const ram = [...cp.w.document.querySelectorAll('.gauge')]
      // startsWith, not includes: "VRAM" contains "RAM".
      .map((g) => g.textContent.replace(/\s+/g, ' ').trim()).find((t) => t.startsWith('RAM'));
  assert(ram && !ram.includes('(est)'), `RAM gauge reads "${ram}"`);
  assert(/518\/79\d\d/.test(ram), `expected the shmup's 518 bytes: "${ram}"`);
});

await test('Play loads the emulator from the editor\'s own folder, and nothing from anywhere else', async () => {
  // EmulatorJS is bundled, trimmed to the Master System core. Two things
  // would undo that silently: a core missing from the bundle, which it
  // quietly fetches from cdn.emulatorjs.org instead, and its update check,
  // which phones the same CDN whenever it runs on localhost. Either works
  // online and is invisible - so assert on the requests themselves.
  await wait(1500);
  // Network requests to anywhere but the server the editor came from. A
  // blob: URL is memory inside the page, not a request, so it is not one.
  const external = cp.requests.filter((u) => {
    const url = new URL(u);
    return /^https?:$/.test(url.protocol) && url.hostname !== 'localhost';
  });
  assert(!external.length, `requests left the machine: ${external.join(', ')}`);
  const emu = cp.requests.filter((u) => u.includes('/emulator/'));
  ['emulator/loader.js', 'emulator/emulator.min.js',
    'emulator/cores/reports/smsplus.json'].forEach((f) => {
    assert(emu.some((u) => u.endsWith(f)), `${f} was never requested`);
  });
  const core = emu.find((u) => /cores\/smsplus(-legacy)?-wasm\.data$/.test(u));
  assert(core, 'the emulator never asked for its core');
  const onDisk = core.replace(/^http:\/\/localhost\//, '');
  assert(existsSync(join(dist, onDisk)),
      `the emulator asked for ${onDisk}, which the bundle does not contain - ` +
    'in a browser it would fetch it from the CDN instead');
});

await test('it gets as far as unpacking the core', () => {
  // The furthest a jsdom can follow it: the core arrives, and EmulatorJS
  // starts the Worker that unpacks it. Running the core itself needs WebGL,
  // which no headless DOM provides, so this is where the test stops.
  const unpacker = cp.requests.some((u) => u.endsWith('emulator/compression/extract7z.js'));
  assert(unpacker, 'the core was never handed to the decompressor');
});

const ne = await openEditor({withoutEmulator: true});

await test('with the emulator missing, the page says so and keeps the ROM', async () => {
  await playFirstExample(ne);
  await wait(800);
  const note = ne.w.document.querySelector('.emu-error');
  assert(note, 'the emulator failed to load and nothing on screen says so');
  assert(/Download ROM/.test(note.textContent), 'the notice does not say how to get the ROM');
  assert(ne.button('Download ROM'), 'no way to get the ROM out');
});

ne.close();

await test('Download ROM hands over the same bytes', async () => {
  const before = cp.blobs.length;
  cp.button('Download ROM').click();
  await wait(300);
  assert(cp.blobs.length === before + 1, 'Download ROM produced nothing');
  const a = Buffer.from(await cp.blobs[0].arrayBuffer());
  const b = Buffer.from(await cp.blobs[before].arrayBuffer());
  assert(Buffer.compare(a, b) === 0, 'the download differs from what was played');
});

await test('compiling ran without an error', () => {
  // Two messages are the harness, not the editor: the emulator's script
  // cannot load because the CDN is deliberately unreachable here, and
  // clicking a download link makes jsdom try to navigate to the blob, which
  // a browser would save as a file instead.
  const real = cp.problems.filter((p) =>
    !/loader\.js|Could not load script|navigation to another Document/.test(p));
  assert(!real.length, real.slice(0, 3).join('\n'));
});

cp.close();

const nc = await openEditor({withoutCompiler: true});

await test('without the compilers, Play explains what is missing', async () => {
  nc.button('Open').click();
  await wait(300);
  [...nc.w.document.querySelectorAll('.example-item')][0].click();
  await wait(1500);
  nc.button('Play').click();
  await wait(1500);
  assert(/No compiler in this build/.test(nc.text()),
      'a missing compiler is reported as something else, or not at all');
  assert(/make -C toolchain wasm/.test(nc.text()), 'it does not say how to fix it');
});

nc.close();

/* ---- other places the editor has to work ---------------------------- */

async function playFirstExample(ed) {
  ed.button('Open').click();
  await wait(300);
  [...ed.w.document.querySelectorAll('.example-item')][0].click();
  await wait(1500);
  ed.button('Play').click();
  for (let i = 0; i < 60 && !ed.w.document.querySelector('.play .built'); i++) {
    await wait(250);
  }
  return !!ed.w.document.querySelector('.play .built');
}

/* ---- playing twice ---------------------------------------------------- */

const twice = await openEditor();

/** Press Play again and wait for a different emulator instance to appear. */
async function playAgain(ed) {
  const before = ed.w.EJS_emulator;
  ed.button('Play').click();
  for (let i = 0; i < 60 && ed.w.EJS_emulator === before; i++) await wait(250);
  await wait(800);
  return ed.w.EJS_emulator;
}

await test('a second Play replaces the first emulator instead of running beside it', async () => {
  // Reported from real use: building and running again opened a second
  // emulator while the first kept going. Stopping used to mean emptying the
  // container - which removes the picture and leaves the program: its main
  // loop, its audio, its 10 ms gamepad poll and its window listeners all
  // carried on, detached from the page.
  await playFirstExample(twice);
  await wait(1500);
  const first = twice.w.EJS_emulator;
  assert(first, 'the first Play never created an emulator');

  const second = await playAgain(twice);
  assert(second && second !== first, 'the second Play did not start a fresh emulator');

  const doc = twice.w.document;
  assert(!doc.contains(first.elements.parent),
      'the first emulator is still in the page');
  assert(doc.querySelectorAll('.ejs_parent').length === 1,
      `${doc.querySelectorAll('.ejs_parent').length} emulators in the page`);

  // The tell-tale of an emulator still running off-screen: its gamepad poll
  // reschedules itself every 10 ms for as long as it lives.
  const t1 = first.gamepad && first.gamepad.timeout;
  await wait(80);
  const t2 = first.gamepad && first.gamepad.timeout;
  assert(t1 === t2, 'the first emulator is still running, polling for gamepads');
});

await test('playing again does not pile up copies of the emulator\'s code', async () => {
  // Every Play re-ran loader.js, and every run loaded emulator.min.js again:
  // another script tag, another stylesheet, and a second evaluation of a
  // file that declares top-level classes, which cannot be declared twice.
  await playAgain(twice);
  const doc = twice.w.document;
  const count = (sel) => doc.querySelectorAll(sel).length;
  assert(count('script[src$="emulator.min.js"]') === 1,
      `${count('script[src$="emulator.min.js"]')} copies of emulator.min.js are loaded`);
  assert(count('link[href$="emulator.min.css"]') <= 1,
      `${count('link[href$="emulator.min.css"]')} copies of the emulator's stylesheet`);
  assert(count('script[src$="loader.js"]') <= 1,
      `${count('script[src$="loader.js"]')} loader scripts left in the page`);
  const redeclared = twice.problems.filter((p) => /already been declared/.test(p));
  assert(!redeclared.length, redeclared[0]);
});

await test('leaving the Play tab stops the emulator', async () => {
  const running = twice.w.EJS_emulator;
  twice.tab('Actors').click();
  await wait(400);
  twice.tab('Play').click();
  await wait(400);
  const t1 = running.gamepad && running.gamepad.timeout;
  await wait(80);
  // Coming back may start it again; what must not happen is the old one
  // still ticking alongside whatever is there now.
  if (twice.w.EJS_emulator !== running) {
    assert(t1 === (running.gamepad && running.gamepad.timeout),
        'an emulator replaced on returning to the tab is still running');
  }
});

twice.close();

const sub = await openEditor({prefix: '/games/sms/designer/'});

await test('it works from a subdirectory, not just the root of a site', async () => {
  // The build is meant to be relocatable. Its public path is worked out at
  // run time from each script's own URL, which is exactly the kind of thing
  // that works at / and breaks one folder down.
  const built = await playFirstExample(sub);
  const w = editorWorkers(sub);
  assert(!w.errors.length, w.errors.join('\n'));
  assert(w.created.every((u) => u.includes('/games/sms/designer/js/')),
      `the worker was loaded from ${w.created.join(', ')}`);
  assert(built, 'nothing was built from a subdirectory');
});

sub.close();

// Without the emulator too: it needs a Worker to unpack its core, so in a
// world with none it can only fail - and this test is about the compiler.
const inPage = await openEditor({noWorker: true, withoutEmulator: true});

await test('without Workers, the page builds the same ROM itself', async () => {
  const built = await playFirstExample(inPage);
  assert(built, 'the in-page fallback built nothing');
  if (nativeRom) {
    const rom = Buffer.from(await inPage.blobs[0].arrayBuffer());
    assert(Buffer.compare(rom, nativeRom) === 0,
        'the in-page fallback built a different ROM');
  }
});

inPage.close();

await test('no error escaped a page while the editor was being driven', () => {
  assert(!escaped.length, escaped.slice(0, 3).join('\n'));
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
