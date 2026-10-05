/**
 * The build pipeline, from the editor's point of view.
 *
 * Owns the Worker, keeps the engine sources to hand, coalesces the rapid
 * rebuilds that come from editing, and — the part that matters most for a
 * no-code tool — turns a compiler error into a highlighted block.
 *
 * A beginner who sees `ERROR: at line 412: Bad syntax` has no recourse
 * whatsoever. The fix is cheap: codegen emits `' @blk:<id>` before each
 * statement group, so walking back from the reported line to the nearest
 * preceding marker names the block that produced it. An error that maps into
 * the engine has no marker above it at all, and that is a tool bug, not a
 * user bug — it is reported as one, with a one-click copy of the generated
 * source.
 */

import {ref, computed} from '@vue/composition-api';

import {buildIR} from '../ir/build-ir.js';
import {lint} from '../ir/lint.js';
import {estimateFrame} from '../ir/budget.js';
import {generateProgram} from '../generators/cvbasic/emit-program.js';
import {blame} from '../generators/blame.js';

// The engine is bundled as text, not baked into the .wasm, so it can be
// versioned with the editor and hot-reloaded in development.
// Every file in engine/ has to be listed here, because the worker writes
// them into the compiler's in-memory filesystem before each build and the
// generated program INCLUDEs them by name. A file missing from this map is
// an undefined-label failure that only shows up in the browser - which is
// exactly what happened when the renderer was split in two and this list was
// not updated. A test asserts it matches the directory.
import engineCore from '!!raw-loader!../../engine/core.bas';
import engineKernel from '!!raw-loader!../../engine/kernel.bas';
import engineTerrain from '!!raw-loader!../../engine/terrain.bas';
import engineRenderSms from '!!raw-loader!../../engine/render_sms.bas';
import engineRenderTms from '!!raw-loader!../../engine/render_tms.bas';

const ENGINE = {
  'core.bas': engineCore,
  'kernel.bas': engineKernel,
  'terrain.bas': engineTerrain,
  'render_sms.bas': engineRenderSms,
  'render_tms.bas': engineRenderTms,
};

let worker = null;
let nextId = 1;
const pending = new Map();

export const building = ref(false);
export const lastBuild = ref(null);
export const buildError = ref(null);

/**
 * Where the compilers live, as an absolute URL.
 *
 * Resolved against the page rather than written as '/wasm/', which would
 * only work when the editor is served from the root of a site - the build is
 * meant to work from any subdirectory, an itch.io page, or a static host.
 */
export function toolchainBase() {
  return new URL('wasm/', document.baseURI).href;
}

/**
 * Run a build in a Worker where possible, on the page where not.
 *
 * The page fallback runs exactly the same code (compiler-core.js); it only
 * gives up the responsiveness. jsdom has no Workers, which is why the
 * end-to-end test exercises the full pipeline through this path.
 */
async function runBuild(message) {
  if (typeof Worker === 'undefined') {
    const {handleBuild} = await import('../workers/compiler-core.js');
    return handleBuild(message);
  }
  return new Promise((resolve) => {
    pending.set(message.id, {resolve});
    getWorker().postMessage(message);
  });
}

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('../workers/compiler.worker.js', import.meta.url));
  worker.onmessage = (ev) => {
    const res = ev.data;
    const entry = pending.get(res.id);
    if (!entry) return;
    pending.delete(res.id);
    entry.resolve(res);
  };
  worker.onerror = (e) => {
    pending.forEach((entry) => entry.resolve({
      ok: false, error: String(e.message || e), stage: 'worker',
    }));
    pending.clear();
    // A worker that has thrown is not worth trusting for the next build.
    worker.terminate();
    worker = null;
  };
  return worker;
}

/**
 * Generate source only. Fast, synchronous, and enough for the "show me the
 * code" panel and for every budget except ROM size.
 */
export function generate(project) {
  const ir = buildIR(project);
  const problems = [...ir.diagnostics, ...lint(ir)];
  const {source, lineMap} = generateProgram(ir, {author: project.meta?.author});
  return {ir, problems, source, lineMap, frame: estimateFrame(ir)};
}

/**
 * Full build. Returns {ok, rom, ...} plus the IR and problems, with any
 * compiler error already mapped back to a block.
 */
export async function build(project, opts = {}) {
  const gen = generate(project);
  const blocking = gen.problems.filter((p) => p.severity === 'error');
  if (blocking.length) {
    const result = {ok: false, blocked: true, ...gen, error: blocking[0].message};
    buildError.value = result;
    return result;
  }

  building.value = true;
  try {
    const id = nextId++;
    const res = await runBuild({
      id, action: 'build',
      source: gen.source,
      engine: ENGINE,
      target: project.target,
      base: opts.base || toolchainBase(),
      wantAsm: !!opts.wantAsm,
      wantDebug: !!opts.wantDebug,
    });

    const result = {...gen, ...res};
    if (!res.ok) {
      result.blame = blame(res, gen.lineMap);
      buildError.value = result;
    } else {
      buildError.value = null;
      lastBuild.value = result;
    }
    return result;
  } finally {
    building.value = false;
  }
}

/** Coalesced background build, for "does it still compile?" while editing. */
let debounceTimer = null;
export function buildSoon(project, delay = 600) {
  clearTimeout(debounceTimer);
  return new Promise((resolve) => {
    debounceTimer = setTimeout(() => resolve(build(project)), delay);
  });
}

/** Everything the budget strip shows, in one place. */
export function budgets(project, gen, lastRom) {
  const ir = gen.ir;
  return computed(() => ({
    sprites: {
      used: ir.layout.worstHw, max: ir.target.hardwareSprites, unit: 'hw',
    },
    vram: {
      used: ir.layout.spriteDefs, max: ir.target.spriteDefBudget, unit: 'defs',
    },
    slots: {
      used: ir.layout.maxEnt, max: ir.target.maxSlots, unit: '',
    },
    ram: {
      // Straight from the compiler when we have it; the IR estimate before
      // the first successful build.
      used: lastRom?.ramUsed ?? ir.layout.ramEstimate,
      max: lastRom?.ramTotal ?? ir.target.ram,
      unit: 'B',
      measured: !!lastRom?.ramUsed,
    },
    rom: {
      used: lastRom?.rom ? Math.round(lastRom.rom.length / 1024) : null,
      max: 32, unit: 'KB',
    },
    frame: {
      used: gen.frame.percent, max: 100, unit: '%',
      parts: gen.frame.parts, advice: gen.frame.advice,
    },
  }));
}

export {ENGINE, blame};
