/**
 * Run a command-line tool compiled to WebAssembly (WASI), in memory.
 *
 * CVBasic and gasm80 are ordinary C programs that read and write files. They
 * are compiled to wasm32-wasi with Zig's bundled clang - see
 * toolchain/Makefile - and this gives them a filesystem made of
 * Uint8Arrays, a command line, and a place to print.
 *
 * Two properties matter more than the rest:
 *
 *   - **A fresh instance every run.** Neither tool resets its globals between
 *     invocations; CVBasic-emscripten reloads a whole iframe per compile to
 *     get round that. Instantiating a new WebAssembly.Instance from an
 *     already-compiled Module gives each run its own linear memory, which is
 *     the same guarantee for a fraction of the cost.
 *   - **No DOM and no Node.** This module is used unchanged by the browser's
 *     compiler Worker and by the test suite, so a test of it is a test of the
 *     code that runs in the editor.
 */

import {
  WASI, File, Directory, OpenFile, ConsoleStdout, PreopenDirectory,
} from '@bjorn3/browser_wasi_shim';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Build a directory tree from a flat map of paths to contents.
 *
 * @param {Object<string, string|Uint8Array>} files e.g. {'engine/core.bas': '...'}
 * @returns {Directory}
 */
export function makeDirectory(files) {
  const root = new Map();
  Object.entries(files || {}).forEach(([path, content]) => {
    const parts = path.split('/').filter(Boolean);
    let dir = root;
    for (let i = 0; i < parts.length - 1; i++) {
      let child = dir.get(parts[i]);
      if (!(child instanceof Directory)) {
        child = new Directory(new Map());
        dir.set(parts[i], child);
      }
      dir = child.contents;
    }
    const bytes = typeof content === 'string' ? encoder.encode(content) : content;
    dir.set(parts[parts.length - 1], new File(bytes));
  });
  return new Directory(root);
}

/** Read a file back out of a directory built by makeDirectory. */
export function readFile(dir, path) {
  let node = dir;
  for (const part of path.split('/').filter(Boolean)) {
    if (!(node instanceof Directory)) return null;
    node = node.contents.get(part);
    if (!node) return null;
  }
  return node instanceof File ? node.data : null;
}

/**
 * Run one tool to completion.
 *
 * The directory is shared, not copied: hand the same one to the next tool
 * and it sees whatever this one wrote. That is how CVBasic's .asm reaches
 * gasm80 without crossing any boundary.
 *
 * @param {WebAssembly.Module} module compiled once, instantiated per run
 * @param {string[]} args argv, including the program name
 * @param {Directory} dir the working directory
 * @returns {{code: number, stdout: string, stderr: string, crashed: string|null}}
 */
export function runTool(module, args, dir) {
  const out = [];
  const err = [];
  const fds = [
    new OpenFile(new File(new Uint8Array(0))), // stdin: empty
    new ConsoleStdout((bytes) => out.push(bytes.slice())),
    new ConsoleStdout((bytes) => err.push(bytes.slice())),
    // Preopened as "." with the shared Map, so relative paths work exactly
    // as they do for the native tools run in an output directory.
    new PreopenDirectory('.', dir.contents),
  ];
  // debug must be explicitly false: this version treats a missing option as
  // on, and logs every file the tools open to the console on every build.
  const wasi = new WASI(args, [], fds, {debug: false});
  const instance = new WebAssembly.Instance(module,
      {wasi_snapshot_preview1: wasi.wasiImport});

  let code = 0;
  let crashed = null;
  try {
    code = wasi.start(instance);
  } catch (e) {
    // A trap - an out-of-bounds access, an `unreachable` - rather than an
    // exit. Reported separately because it is a fault in the tool or in how
    // it was built, never in the user's game.
    crashed = String((e && e.message) || e);
    code = -1;
  }
  return {code, stdout: join(out), stderr: join(err), crashed};
}

function join(chunks) {
  const n = chunks.reduce((s, c) => s + c.length, 0);
  const all = new Uint8Array(n);
  let at = 0;
  chunks.forEach((c) => {
    all.set(c, at);
    at += c.length;
  });
  return decoder.decode(all);
}
