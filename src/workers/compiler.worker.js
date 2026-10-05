/**
 * The compiler Worker.
 *
 * All the work is in compiler-core.js, which the page can also run directly
 * where Workers are unavailable; this file is only the message plumbing.
 * Running in a Worker keeps the editor responsive while a ROM builds, and the
 * ROM comes back as a transferable buffer rather than a copy.
 *
 * The compilers are cvbasic and gasm80 built to WebAssembly with Zig - see
 * toolchain/Makefile. No Emscripten is involved: they are plain WASI
 * programs, run against an in-memory filesystem by wasi-run.js.
 */

import {handleBuild} from './compiler-core.js';

self.onmessage = async (ev) => {
  const msg = ev.data || {};
  if (msg.action !== 'build') return;
  const res = await handleBuild(msg);
  const transfer = res.rom && res.rom.buffer ? [res.rom.buffer] : [];
  self.postMessage(res, transfer);
};
