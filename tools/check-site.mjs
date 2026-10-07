#!/usr/bin/env node
/**
 * Check that a built copy of the editor is complete - and, in a git work
 * tree, that all of it is actually going to be committed.
 *
 *   node tools/check-site.mjs docs           # before committing a deploy
 *   node tools/check-site.mjs docs --no-git  # in CI, on a checked-out tree
 *
 * Written after the published site broke without anyone being told. Each
 * deployment after the first rewrote index.html to point at a newly named
 * app bundle, deleted the old bundle, and never added the new one - the
 * signature of `git commit -a` (or `git add -u`, or an editor's "commit
 * tracked files"), which stage changes and deletions of files git already
 * knows but never add new ones. Webpack names the bundle after a hash of its
 * contents, so it is a new file on every build that changes it, and the
 * page 404s on its own code.
 *
 * Nothing about that is visible until someone opens the site. So this
 * follows everything the editor will ask for and fails, by name, on
 * anything missing:
 *
 *   - every script and stylesheet index.html references;
 *   - every chunk the webpack runtime can load later - the examples, the
 *     compiler Worker - read from the chunk table inside each bundle, and
 *     followed into further chunks;
 *   - the in-browser compilers in wasm/;
 *   - the bundled emulator, file by file against its own manifest.
 *
 * And, unless --no-git, it lists any file under the directory that git does
 * not know about, with the command that fixes it.
 *
 * No dependencies, so a CI job can run it with nothing but Node.
 */

import {readFileSync, existsSync, readdirSync, statSync} from 'fs';
import {createHash} from 'crypto';
import {join, resolve, relative, dirname} from 'path';
import {execFileSync} from 'child_process';

const args = process.argv.slice(2);
const dirArg = args.find((a) => !a.startsWith('--'));
const useGit = !args.includes('--no-git');

if (!dirArg) {
  console.error('usage: node tools/check-site.mjs <built-site-dir> [--no-git]');
  process.exit(2);
}

const site = resolve(dirArg);
const problems = [];
const notes = [];
const checked = new Set();

const rel = (p) => relative(site, p).split('\\').join('/');
const need = (path, why) => {
  checked.add(path);
  if (!existsSync(join(site, path))) problems.push(`missing ${path}  (${why})`);
};

/* ---- 1. what index.html loads ----------------------------------------- */

const indexPath = join(site, 'index.html');
if (!existsSync(indexPath)) {
  console.error(`check-site: ${dirArg}/index.html does not exist`);
  process.exit(1);
}
const html = readFileSync(indexPath, 'utf8');
const refs = [...html.matchAll(/\s(?:src|href)="([^"]+)"/g)].map((m) => m[1]);

refs.forEach((r) => {
  if (/^(data:|https?:|#|mailto:)/.test(r)) return;
  if (r.startsWith('/')) {
    // An absolute path only works when the site is served from the root of
    // a domain - and a GitHub Pages project site never is.
    problems.push(`${r} is referenced from the root of the domain; the site ` +
      'lives in a subdirectory, so it will not be found');
    return;
  }
  need(r.split(/[?#]/)[0], 'referenced by index.html');
});

/* ---- 2. what the bundles load later ----------------------------------- */

/**
 * Webpack 5 writes the name of every lazily loaded chunk into the runtime:
 *
 *   s.u=function(e){return "js/"+({105:"example-shmup"}[e]||e)+"."+
 *                                {105:"13058454",755:"6eb77b9c"}[e]+".js"}
 *
 * The first table gives names to the chunks that have them, the second
 * gives every chunk's hash.
 */
function chunkFiles(js) {
  const files = [];
  const re = /\.u=function\(\w\)\{return\s*"([^"]*)"\+\((\{[^}]*\})\[\w\]\|\|\w\)\+"\."\+(\{[^}]*\})\[\w\]\+"([^"]*)"\}/g;
  let m;
  while ((m = re.exec(js))) {
    const [, prefix, namesSrc, hashesSrc, suffix] = m;
    const parse = (src) => Object.fromEntries([...src.matchAll(/(\w+):"([^"]*)"/g)]
        .map((x) => [x[1], x[2]]));
    const names = parse(namesSrc);
    const hashes = parse(hashesSrc);
    Object.entries(hashes).forEach(([id, hash]) => {
      files.push(`${prefix}${names[id] || id}.${hash}${suffix}`);
    });
  }
  return files;
}

const queue = refs.filter((r) => /\.js$/.test(r) && !/^(data:|https?:)/.test(r));
const seenJs = new Set();
while (queue.length) {
  const file = queue.shift();
  if (seenJs.has(file)) continue;
  seenJs.add(file);
  const path = join(site, file);
  if (!existsSync(path)) {
    // Its chunk table is inside it, so whatever it would load on demand
    // cannot be checked until it is there.
    notes.push(`${file} is missing, so the chunks it loads on demand could not be checked`);
    continue;
  }
  chunkFiles(readFileSync(path, 'utf8')).forEach((chunk) => {
    need(chunk, `a chunk ${file} loads on demand`);
    queue.push(chunk);
  });
}

const bundleText = [...seenJs].filter((f) => existsSync(join(site, f)))
    .map((f) => readFileSync(join(site, f), 'utf8')).join('\n');

/* ---- 3. the in-browser compilers -------------------------------------- */

if (/cvbasic\.wasm/.test(bundleText)) {
  ['cvbasic.wasm', 'gasm80.wasm', 'cvbasic_prologue.asm', 'cvbasic_epilogue.asm']
      .forEach((f) => need(`wasm/${f}`, 'the in-browser compiler fetches it on Play'));
}

/* ---- 4. the bundled emulator ------------------------------------------ */

if (/emulator\//.test(bundleText) || existsSync(join(site, 'emulator'))) {
  const manifestPath = join(site, 'emulator/MANIFEST.txt');
  if (!existsSync(manifestPath)) {
    problems.push('missing emulator/MANIFEST.txt  (the bundled emulator is incomplete or absent)');
  } else {
    checked.add('emulator/MANIFEST.txt');
    readFileSync(manifestPath, 'utf8').split('\n').forEach((line) => {
      const m = /^([0-9a-f]{64})  (.+)$/.exec(line);
      if (!m) return;
      const path = `emulator/${m[2]}`;
      need(path, 'part of the bundled emulator');
      const full = join(site, path);
      if (!existsSync(full)) return;
      const bytes = readFileSync(full);
      const sha = (b) => createHash('sha256').update(b).digest('hex');
      if (sha(bytes) === m[1]) return;
      // Git's line-ending conversion rewrites text files on commit in some
      // setups. That changes the hash and nothing else - not a failure.
      const lf = Buffer.from(bytes.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
      const crlf = Buffer.from(lf.toString('latin1').replace(/\n/g, '\r\n'), 'latin1');
      if (sha(lf) === m[1] || sha(crlf) === m[1]) {
        notes.push(`${path} differs from the manifest only in line endings (harmless)`);
      } else {
        problems.push(`${path} differs from the emulator manifest`);
      }
    });
  }
}

/* ---- 5. is all of it going to be committed? --------------------------- */

let untracked = [];
let inGit = false;
if (useGit) {
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'],
        {cwd: site, stdio: 'pipe'});
    inGit = true;
  } catch {
    // Not a work tree - nothing to check.
  }
  if (inGit) {
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'],
        {cwd: site, encoding: 'utf8'}).trim();
    untracked = execFileSync('git',
        ['ls-files', '--others', '--exclude-standard', '--', site],
        {cwd: top, encoding: 'utf8'}).split('\n').filter(Boolean);
  }
}

/* ---- report ----------------------------------------------------------- */

const files = (function walk(d, out = []) {
  readdirSync(d).forEach((f) => {
    const p = join(d, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  });
  return out;
})(site);

const showNotes = () => notes.forEach((n) => console.log(`  note: ${n}`));

if (!problems.length && !untracked.length) {
  showNotes();
  console.log(`check-site: ${dirArg} is complete - ${checked.size} required ` +
    `files present, ${files.length} files in all` +
    (inGit ? ', all known to git.' : '.'));
  process.exit(0);
}

if (problems.length) {
  console.log(`check-site: ${dirArg} is NOT complete. Opened in a browser, ` +
    'the editor would fail to load these:\n');
  problems.forEach((p) => console.log(`  ${p}`));
  showNotes();
  console.log('');
}
if (untracked.length) {
  const shown = untracked.slice(0, 12);
  console.log(`check-site: ${untracked.length} file(s) under ${dirArg} are not ` +
    'added to git, so a commit will leave them out and the published site ' +
    'will 404 on them:\n');
  shown.forEach((f) => console.log(`  ${f}`));
  if (untracked.length > shown.length) {
    console.log(`  ... and ${untracked.length - shown.length} more`);
  }
  console.log(`\nAdd everything, including new files and removals:\n\n` +
    `  git add -A ${dirArg}\n\n` +
    '(`git commit -a` and `git add -u` only stage files git already knows ' +
    'about, and every build gives the app bundle a new name.)');
}
process.exit(1);
