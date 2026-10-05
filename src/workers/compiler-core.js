/**
 * The compile step, independent of where it runs.
 *
 * Normally this runs inside the compiler Worker, so a build never blocks the
 * editor. Where Workers are unavailable it runs on the page instead - the
 * same code, so behaviour cannot drift between the two. That also makes the
 * whole pipeline, from fetching the compilers to returning a ROM, testable in
 * jsdom, which has no Workers.
 *
 * The compilers are fetched and compiled to WebAssembly.Module once, then
 * instantiated afresh for every build - see wasi-run.js for why.
 */

import {buildRom} from './build-rom.js';

const FILES = {
  cvbasic: 'cvbasic.wasm',
  gasm80: 'gasm80.wasm',
  prologue: 'cvbasic_prologue.asm',
  epilogue: 'cvbasic_epilogue.asm',
};

const cache = new Map();

/**
 * Fetch and compile the toolchain, once per base URL.
 *
 * @param {string} base absolute URL of the directory holding the files
 * @param {Function} fetchFn injectable for tests
 */
export function loadTools(base, fetchFn = globalThis.fetch) {
  if (cache.has(base)) return cache.get(base);
  const p = (async () => {
    const get = async (name) => {
      const res = await fetchFn(new URL(name, base).href);
      if (!res.ok) throw new MissingToolchain(name, res.status);
      return res;
    };
    // Compiled from bytes rather than streamed: compileStreaming insists on
    // an application/wasm content type, and not every static server sends
    // one. At 280 KB the difference is not worth a failure mode.
    const [cv, ga, pro, epi] = await Promise.all([
      get(FILES.cvbasic), get(FILES.gasm80), get(FILES.prologue), get(FILES.epilogue),
    ]);
    return {
      cvbasic: await WebAssembly.compile(await cv.arrayBuffer()),
      gasm80: await WebAssembly.compile(await ga.arrayBuffer()),
      support: {
        [FILES.prologue]: await pro.text(),
        [FILES.epilogue]: await epi.text(),
      },
    };
  })();
  cache.set(base, p);
  // A failed load must not be cached, or installing the compilers would
  // need a page reload before the editor noticed.
  p.catch(() => cache.delete(base));
  return p;
}

export class MissingToolchain extends Error {
  constructor(file, status) {
    super(`The compiler is not installed in this copy of the editor ` +
      `(${file} could not be loaded${status ? `, HTTP ${status}` : ''}). ` +
      'Everything else works; to build ROMs, run `make -C toolchain wasm` ' +
      'to produce the compilers in public/wasm, or use `node tools/build.mjs` ' +
      'outside the browser.');
    this.missingToolchain = true;
  }
}

/**
 * Handle one build request.
 *
 * Message in:  {id, source, engine, target, base, wantAsm, wantDebug}
 * Result out:  {id, ok, rom?, asm?, lst?, sym?, stdout, stderr, warnings,
 *               ramUsed, ramTotal, stage?, error?, missingToolchain?, ms}
 */
export async function handleBuild(msg, fetchFn) {
  const t0 = now();
  let res;
  try {
    const tools = await loadTools(msg.base, fetchFn);
    res = buildRom({
      cvbasic: tools.cvbasic,
      gasm80: tools.gasm80,
      support: tools.support,
      source: msg.source,
      engine: msg.engine,
      target: msg.target,
      wantAsm: msg.wantAsm,
      wantDebug: msg.wantDebug,
    });
  } catch (e) {
    res = {
      ok: false,
      stage: e && e.missingToolchain ? 'toolchain' : 'worker',
      error: String((e && e.message) || e),
      missingToolchain: !!(e && e.missingToolchain),
      stdout: '', stderr: '',
    };
  }
  return {id: msg.id, ...res, ms: Math.round(now() - t0)};
}

function now() {
  return (globalThis.performance && performance.now()) || Date.now();
}
