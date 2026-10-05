#!/usr/bin/env node
/**
 * Headless Blockly tests.
 *
 * Until now the block layer was the one part of this project that had never
 * been run at all. Every test fed the generator hand-written `stmts` arrays,
 * which is exactly the shape `blockly-lower.js` is supposed to produce - so
 * the generator was well covered and the thing that feeds it was not covered
 * at all. A misspelled field name, a toolbox referring to a block that does
 * not exist, or a lowering case that never fires would all have shipped
 * silently and shown up as "that block does nothing", which is a failure
 * mode this project has already had three times.
 *
 * Blockly runs perfectly well without a DOM as long as you never inject a
 * workspace into a page: `new Blockly.Workspace()` plus `newBlock` gives a
 * real block tree with real fields and real connections.
 *
 *   node tools/test-blocks.mjs
 */

import {readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync,
  copyFileSync} from 'fs';
import {dirname, resolve, join} from 'path';
import {fileURLToPath} from 'url';
import {execFileSync} from 'child_process';

// The Node build rather than the browser entry points: `blockly/core` is a
// directory that only a bundler can resolve.
import Blockly from 'blockly';

import {defineBlocks} from '../src/blocks/index.js';
import {toolboxFor, BLOCKS} from '../src/blocks/toolbox.js';
import {lowerWorkspace} from '../src/generators/blockly-lower.js';
import {migrate} from '../src/ir/schema.js';
import {buildIR} from '../src/ir/build-ir.js';
import {generateProgram} from '../src/generators/cvbasic/emit-program.js';

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
    console.log(`        ${e.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

/* ---- a project for the dropdowns to draw on ------------------------ */

const project = migrate(JSON.parse(
    readFileSync(join(root, 'examples/shmup.json'), 'utf8')));
const actor = project.actors.find((a) => a.id === 'bug');
actor.fields = [{name: 'hp', width: 8, initial: 2}];

const ctx = {
  actors: () => project.actors,
  globals: () => project.globals,
  rooms: () => project.rooms,
  fields: () => actor.fields,
  animations: () => actor.animations,
  groups: () => [...new Set(project.actors.map((a) => a.group))],
};
defineBlocks(Blockly, ctx);

/* ---- every block the toolbox offers must exist ---------------------- */

console.log('\nblock definitions');

const scopes = ['actor', 'actor-collide', 'room', 'global'];
const referenced = new Set();
Object.values(BLOCKS).forEach((spec) =>
  Object.values(spec).forEach((list) => list.forEach((t) => referenced.add(t))));

test('every block a toolbox offers is defined', () => {
  const missing = [...referenced].filter((t) => !Blockly.Blocks[t]).sort();
  assert(!missing.length,
      `the toolbox offers blocks that do not exist: ${missing.join(', ')}`);
});

test('every defined sms_ block appears in some toolbox', () => {
  const defined = Object.keys(Blockly.Blocks).filter((t) => t.startsWith('sms_'));
  const orphans = defined.filter((t) => !referenced.has(t)).sort();
  assert(!orphans.length,
      `defined but unreachable from any palette: ${orphans.join(', ')}`);
});

test('every block can actually be constructed', () => {
  const ws = new Blockly.Workspace();
  const broken = [];
  [...referenced].forEach((type) => {
    try {
      ws.newBlock(type);
    } catch (e) {
      broken.push(`${type}: ${e.message}`);
    }
  });
  ws.dispose();
  assert(!broken.length, broken.join('; '));
});

test('each toolbox scope produces parseable XML', () => {
  scopes.forEach((scope) => {
    const xml = toolboxFor(scope);
    assert(xml.startsWith('<xml>') && xml.endsWith('</xml>'),
        `${scope}: not wrapped in <xml>`);
    const types = [...xml.matchAll(/<block type="([^"]+)"/g)].map((m) => m[1]);
    assert(types.length > 0, `${scope}: no blocks at all`);
    const missing = types.filter((t) => !Blockly.Blocks[t]);
    assert(!missing.length, `${scope}: undefined blocks ${missing.join(', ')}`);
  });
});

test('scoping actually removes blocks that need an instance', () => {
  // A block that needs `me` must not exist in the global palette, and one
  // that needs `other` must exist only inside a collide event. This is the
  // difference between a palette that teaches and one that has to be
  // policed with error messages.
  const global = toolboxFor('global');
  const actorScope = toolboxFor('actor');
  const collide = toolboxFor('actor-collide');
  assert(!global.includes('sms_set_my_pos'),
      '"set my x" is offered in the global scripts, where there is no "me"');
  assert(!actorScope.includes('sms_other_field'),
      '"the other one\'s field" is offered outside a collide event');
  assert(collide.includes('sms_other_field'),
      '"the other one\'s field" is missing from the collide palette');
  assert(collide.includes('sms_set_my_pos'),
      'the collide palette lost the ordinary actor blocks');
});

test('the editor only calls Blockly APIs that exist', () => {
  // This is the test that would have caught the real bug here:
  // `Blockly.Xml.textToDom` was removed in Blockly 10 and moved to
  // `Blockly.utils.xml`. The editor called it inside a try/catch, so every
  // script reload silently produced an empty workspace - which to the person
  // using it looks exactly like losing their work.
  //
  // Anything reachable from a plain Workspace is checked here; methods that
  // only exist on the injected WorkspaceSvg (updateToolbox, centerOnBlock)
  // are listed as known-good rather than resolved, since there is no DOM.
  const svgOnly = new Set(['updateToolbox', 'centerOnBlock', 'inject']);
  const sources = ['src/components/BlocklyWorkspace.vue'];
  const missing = [];

  sources.forEach((file) => {
    const src = readFileSync(join(root, file), 'utf8');
    const calls = [...src.matchAll(/\bBlockly((?:\.[A-Za-z_$][\w$]*)+)\s*\(/g)]
        .map((m) => m[1].slice(1));
    [...new Set(calls)].forEach((path) => {
      const leaf = path.split('.').pop();
      if (svgOnly.has(leaf)) return;
      let node = Blockly;
      for (const part of path.split('.')) {
        node = node ? node[part] : undefined;
      }
      if (typeof node !== 'function') {
        missing.push(`${file}: Blockly.${path} is ${typeof node}`);
      }
    });
  });

  assert(!missing.length,
      `the editor calls Blockly APIs that do not exist in the installed ` +
    `version:\n        ${missing.join('\n        ')}`);
});

test('the installed Blockly matches what package.json asks for', () => {
  const want = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
      .dependencies.blockly;
  const have = JSON.parse(readFileSync(
      join(root, 'node_modules/blockly/package.json'), 'utf8')).version;
  const major = (v) => v.replace(/^[^0-9]*/, '').split('.')[0];
  assert(major(want) === major(have),
      `package.json asks for ${want} but ${have} is installed - the block ` +
    `tests would be proving something about the wrong version`);
});

/* ---- lowering ------------------------------------------------------- */

console.log('\nlowering');

/** Build a workspace holding one statement block and lower it. */
function lowerOne(type, setup) {
  const ws = new Blockly.Workspace();
  const block = ws.newBlock(type);
  if (setup) setup(block, ws);
  const stmts = lowerWorkspace(ws);
  ws.dispose();
  return stmts;
}

const STATEMENTS = [...referenced].filter((t) => {
  const ws = new Blockly.Workspace();
  const b = ws.newBlock(t);
  const isStatement = !!b.previousConnection;
  ws.dispose();
  return isStatement && t.startsWith('sms_');
});

test('every statement block lowers to something', () => {
  const dead = [];
  STATEMENTS.forEach((type) => {
    const stmts = lowerOne(type);
    if (!stmts.length || !stmts[0].op) dead.push(type);
  });
  assert(!dead.length,
      `these blocks lower to nothing, so they would compile and do ` +
    `absolutely nothing at runtime: ${dead.join(', ')}`);
});

test('every lowered op is one the generator handles', () => {
  const emit = readFileSync(
      join(root, 'src/generators/cvbasic/emit-stmt.js'), 'utf8');
  const handled = new Set(
      [...emit.matchAll(/^\s*case '([a-zA-Z0-9_]+)':/gm)].map((m) => m[1]));
  const orphans = [];
  STATEMENTS.forEach((type) => {
    const op = lowerOne(type)[0]?.op;
    if (op && !handled.has(op)) orphans.push(`${type} -> ${op}`);
  });
  assert(!orphans.length, orphans.join(', '));
});

test('every lowered statement carries its block id', () => {
  // The id is what maps a compiler error back to the block that caused it.
  // Without it, a build failure shows a line number in a file the user has
  // never opened.
  const anonymous = [];
  STATEMENTS.forEach((type) => {
    const s = lowerOne(type)[0];
    if (s && !s.blockId) anonymous.push(type);
  });
  assert(!anonymous.length,
      `no block id, so errors in these cannot be traced back: ` +
    anonymous.join(', '));
});

test('dropdown fields lower to real values, not blanks', () => {
  // A dropdown whose options come back empty silently lowers to '' and the
  // generator then quietly drops the statement.
  const checks = [
    ['sms_play_anim', (s) => s.anim],
    ['sms_spawn_at', (s) => s.actor],
    ['sms_set_my_field', (s) => s.field],
    ['sms_set_global', (s) => s.name],
    ['sms_go_room', (s) => s.room],
    ['sms_play_sound', (s) => s.sound],
    ['sms_play_music', (s) => s.music],
  ];
  checks.forEach(([type, get]) => {
    const s = lowerOne(type)[0];
    assert(s, `${type} lowered to nothing`);
    const v = get(s);
    assert(v !== undefined && v !== null && v !== '',
        `${type} lowered with an empty dropdown value`);
  });
});

test('value blocks lower through their sockets', () => {
  const ws = new Blockly.Workspace();
  const host = ws.newBlock('sms_set_my_pos');
  const myX = ws.newBlock('sms_my_x');
  host.getInput('X').connection.connect(myX.outputConnection);
  const stmts = lowerWorkspace(ws);
  ws.dispose();
  assert(stmts[0].x && stmts[0].x.op === 'myX',
      `expected the X socket to lower to myX, got ${JSON.stringify(stmts[0].x)}`);
});

test('conditions lower through an if block', () => {
  const ws = new Blockly.Workspace();
  const iff = ws.newBlock('controls_if');
  const pad = ws.newBlock('sms_pad');
  iff.getInput('IF0').connection.connect(pad.outputConnection);
  const body = ws.newBlock('sms_destroy_me');
  iff.getInput('DO0').connection.connect(body.previousConnection);
  const stmts = lowerWorkspace(ws);
  ws.dispose();
  assert(stmts[0].op === 'if', `expected an if, got ${stmts[0].op}`);
  assert(stmts[0].cond.op === 'pad',
      `expected a pad condition, got ${stmts[0].cond.op}`);
  assert(stmts[0].then[0].op === 'destroy', 'the if body did not lower');
});

test('a chain of statements lowers in order', () => {
  const ws = new Blockly.Workspace();
  const a = ws.newBlock('sms_show');
  const b = ws.newBlock('sms_hide');
  const c = ws.newBlock('sms_destroy_me');
  a.nextConnection.connect(b.previousConnection);
  b.nextConnection.connect(c.previousConnection);
  const stmts = lowerWorkspace(ws);
  ws.dispose();
  assert(stmts.map((s) => s.op).join(',') === 'show,hide,destroy',
      `got ${stmts.map((s) => s.op).join(',')}`);
});

test('a disabled block is left out', () => {
  const ws = new Blockly.Workspace();
  const a = ws.newBlock('sms_show');
  const b = ws.newBlock('sms_hide');
  a.nextConnection.connect(b.previousConnection);
  b.setEnabled(false);
  const stmts = lowerWorkspace(ws);
  ws.dispose();
  assert(stmts.length === 1 && stmts[0].op === 'show',
      `disabled blocks should not be generated; got ${stmts.map((s) => s.op)}`);
});

test('repeat lowers its body, not just its count', () => {
  const ws = new Blockly.Workspace();
  const rep = ws.newBlock('sms_repeat');
  rep.setFieldValue('3', 'N');
  const body = ws.newBlock('sms_hide');
  rep.getInput('BODY').connection.connect(body.previousConnection);
  const stmts = lowerWorkspace(ws);
  ws.dispose();
  assert(stmts[0].op === 'repeat', `got ${stmts[0].op}`);
  assert(stmts[0].count.value === 3, `count lowered as ${JSON.stringify(stmts[0].count)}`);
  assert(stmts[0].body.length === 1 && stmts[0].body[0].op === 'hide',
      'the repeat body did not lower');
});

test('if / else if / else nests correctly', () => {
  // The lowering reads Blockly's mutator counts to flatten elseif chains
  // into nested if/else. Those are internal fields, so this is exactly the
  // kind of thing that breaks silently on a library upgrade.
  const ws = new Blockly.Workspace();
  const iff = ws.newBlock('controls_if');
  iff.loadExtraState ?
    iff.loadExtraState({elseIfCount: 1, hasElse: true}) :
    iff.domToMutation(Blockly.utils.xml.textToDom(
        '<mutation elseif="1" else="1"></mutation>'));

  const c0 = ws.newBlock('sms_button');
  iff.getInput('IF0').connection.connect(c0.outputConnection);
  const c1 = ws.newBlock('sms_off_screen');
  iff.getInput('IF1').connection.connect(c1.outputConnection);

  const d0 = ws.newBlock('sms_show');
  iff.getInput('DO0').connection.connect(d0.previousConnection);
  const d1 = ws.newBlock('sms_hide');
  iff.getInput('DO1').connection.connect(d1.previousConnection);
  const de = ws.newBlock('sms_destroy_me');
  iff.getInput('ELSE').connection.connect(de.previousConnection);

  const stmts = lowerWorkspace(ws);
  ws.dispose();

  const outer = stmts[0];
  assert(outer.op === 'if' && outer.cond.op === 'button',
      `outer condition lowered as ${JSON.stringify(outer.cond)}`);
  assert(outer.then[0].op === 'show', 'first branch body wrong');
  const inner = outer.else[0];
  assert(inner && inner.op === 'if' && inner.cond.op === 'offScreen',
      'the else-if branch did not become a nested if');
  assert(inner.then[0].op === 'hide', 'else-if body wrong');
  assert(inner.else[0].op === 'destroy', 'final else body wrong');
});

test('and / or / not lower as conditions', () => {
  const ws = new Blockly.Workspace();
  const iff = ws.newBlock('controls_if');
  const op = ws.newBlock('logic_operation');
  op.setFieldValue('OR', 'OP');
  const a = ws.newBlock('sms_button');
  const neg = ws.newBlock('logic_negate');
  const b = ws.newBlock('sms_off_screen');
  neg.getInput('BOOL').connection.connect(b.outputConnection);
  op.getInput('A').connection.connect(a.outputConnection);
  op.getInput('B').connection.connect(neg.outputConnection);
  iff.getInput('IF0').connection.connect(op.outputConnection);
  iff.getInput('DO0').connection.connect(ws.newBlock('sms_show').previousConnection);
  const stmts = lowerWorkspace(ws);
  ws.dispose();
  const c = stmts[0].cond;
  assert(c.op === 'or', `got ${c.op}`);
  assert(c.a.op === 'button', `left side ${c.a.op}`);
  assert(c.b.op === 'not' && c.b.a.op === 'offScreen',
      `right side ${JSON.stringify(c.b)}`);
});

test('arithmetic folds constants and keeps variables', () => {
  const ws = new Blockly.Workspace();
  const host = ws.newBlock('sms_set_my_pos');
  const add = ws.newBlock('math_arithmetic');
  add.setFieldValue('ADD', 'OP');
  const n1 = ws.newBlock('math_number');
  n1.setFieldValue('10', 'NUM');
  const n2 = ws.newBlock('math_number');
  n2.setFieldValue('5', 'NUM');
  add.getInput('A').connection.connect(n1.outputConnection);
  add.getInput('B').connection.connect(n2.outputConnection);
  host.getInput('X').connection.connect(add.outputConnection);

  const mul = ws.newBlock('math_arithmetic');
  mul.setFieldValue('MULTIPLY', 'OP');
  const myY = ws.newBlock('sms_my_y');
  const n3 = ws.newBlock('math_number');
  n3.setFieldValue('2', 'NUM');
  mul.getInput('A').connection.connect(myY.outputConnection);
  mul.getInput('B').connection.connect(n3.outputConnection);
  host.getInput('Y').connection.connect(mul.outputConnection);

  const s = lowerWorkspace(ws)[0];
  ws.dispose();
  assert(s.x.op === 'num' && s.x.value === 15,
      `10 + 5 should fold to 15, got ${JSON.stringify(s.x)}`);
  assert(s.y.op === 'binop' && s.y.oper === '*',
      `my y * 2 should stay a binop, got ${JSON.stringify(s.y)}`);
});

test('a workspace survives a save and reload', () => {
  // This is what the editor does every time you switch scripts: serialise to
  // XML, and rebuild from it later. If a block does not round-trip, the user
  // loses work and the only symptom is a script that quietly empties.
  const ws = new Blockly.Workspace();
  const iff = ws.newBlock('controls_if');
  const near = ws.newBlock('sms_near_player');
  near.setFieldValue('48', 'D');
  iff.getInput('IF0').connection.connect(near.outputConnection);
  const anim = ws.newBlock('sms_play_anim');
  iff.getInput('DO0').connection.connect(anim.previousConnection);
  const before = JSON.stringify(stripIds(lowerWorkspace(ws)));
  const xml = Blockly.Xml.domToText(Blockly.Xml.workspaceToDom(ws));
  ws.dispose();

  const ws2 = new Blockly.Workspace();
  Blockly.Xml.domToWorkspace(Blockly.utils.xml.textToDom(xml), ws2);
  const after = JSON.stringify(stripIds(lowerWorkspace(ws2)));
  ws2.dispose();
  assert(before === after,
      `a round-trip through XML changed the program:\n  ${before}\n  ${after}`);
});

function stripIds(node) {
  if (Array.isArray(node)) return node.map(stripIds);
  if (!node || typeof node !== 'object') return node;
  const out = {};
  Object.keys(node).sort().forEach((k) => {
    if (k !== 'blockId') out[k] = stripIds(node[k]);
  });
  return out;
}

/* ---- the whole way: blocks to ROM ----------------------------------- */

console.log('\nblocks to ROM');

test('a script built from real blocks compiles to a working ROM', () => {
  const ws = new Blockly.Workspace();

  // on update: if the fire button is held, spawn a Shot at my position and
  // add 1 to the score.
  const iff = ws.newBlock('controls_if');
  const btn = ws.newBlock('sms_button');
  iff.getInput('IF0').connection.connect(btn.outputConnection);

  const spawn = ws.newBlock('sms_spawn_at_me');
  spawn.setFieldValue('shot', 'ACTOR');
  const dx = ws.newBlock('math_number');
  dx.setFieldValue('4', 'NUM');
  spawn.getInput('DX').connection.connect(dx.outputConnection);

  const score = ws.newBlock('sms_change_global');
  score.setFieldValue('score', 'NAME');
  const one = ws.newBlock('math_number');
  one.setFieldValue('1', 'NUM');
  score.getInput('V').connection.connect(one.outputConnection);

  spawn.nextConnection.connect(score.previousConnection);
  iff.getInput('DO0').connection.connect(spawn.previousConnection);

  const stmts = lowerWorkspace(ws);
  const xml = Blockly.Xml.domToText(Blockly.Xml.workspaceToDom(ws));
  ws.dispose();

  assert(stmts.length === 1 && stmts[0].op === 'if', 'the script did not lower');

  const p = JSON.parse(JSON.stringify(project));
  const bug = p.actors.find((a) => a.id === 'bug');
  bug.scripts.update = {xml, stmts};

  const ir = buildIR(migrate(p));
  const errors = ir.diagnostics.filter((d) => d.severity === 'error');
  assert(!errors.length, `IR errors: ${errors.map((e) => e.message).join('; ')}`);

  const {source, lineMap} = generateProgram(ir);
  assert(/GOSUB spawn_shot/.test(source),
      'the spawn block produced no spawn call');
  assert(/#score = #score \+ 1/.test(source),
      'the change-global block produced no score change');
  assert(lineMap.some((e) => e.blockId === spawn.id),
      'the generated source has no marker for the spawn block, so a ' +
    'compiler error there could not be traced back to it');

  // And it has to actually build.
  const cvbasic = join(root, 'bin/cvbasic');
  const gasm80 = join(root, 'bin/gasm80');
  if (!existsSync(cvbasic) || !existsSync(gasm80)) return;

  const tmp = join(root, 'out', 'blocktest');
  mkdirSync(join(tmp, 'engine'), {recursive: true});
  readdirSync(join(root, 'engine')).forEach((f) =>
    copyFileSync(join(root, 'engine', f), join(tmp, 'engine', f)));
  readdirSync(join(root, 'bin/asm')).forEach((f) =>
    copyFileSync(join(root, 'bin/asm', f), join(tmp, f)));
  writeFileSync(join(tmp, 'blocks.bas'), source);

  const run = (tool, args) => {
    try {
      return execFileSync('/bin/sh',
          ['-c', `"${tool}" ${args.map((a) => `'${a}'`).join(' ')} 2>&1`],
          {cwd: tmp, encoding: 'utf8'});
    } catch (e) {
      return (e.stdout || '') + (e.stderr || '');
    }
  };
  const cvLog = run(cvbasic, ['--sms', 'blocks.bas', 'blocks.asm']);
  assert(!/(^|\\s)error[: ]/i.test(cvLog),
      `cvbasic: ${(/^.*error.*$/im.exec(cvLog) || [])[0]}`);
  const asmLog = run(gasm80, ['blocks.asm', '-o', 'blocks.sms', '-sms']);
  assert(!/error/i.test(asmLog), `gasm80: ${asmLog.trim().split('\n')[0]}`);
  assert(readFileSync(join(tmp, 'blocks.sms')).length === 32768, 'bad ROM size');
});

console.log('\nraising: AST back to blocks');

{
  const {raiseScript} = await import('../src/generators/blockly-raise.js');
  const {readFileSync: rf} = await import('fs');

  /**
   * Load a project's dropdown contents into the block definitions, the way
   * the editor does from its live project. Field and animation dropdowns are
   * per actor, so the actor whose script is loading is set before each load
   * - otherwise Blockly rejects the stored value and quietly keeps the first
   * option, which turns "spawn Boom" into "spawn Ship" with no warning.
   */
  function useProject(project) {
    let current = null;
    defineBlocks(Blockly, {
      actors: () => project.actors,
      globals: () => project.globals,
      rooms: () => project.rooms,
      fields: () => (current && current.fields) || [],
      animations: () => (current && current.animations) || [],
      groups: () => [...new Set(project.actors.map((a) => a.group))],
    });
    return (actor) => {
      current = actor;
    };
  }

  /**
   * JSON with keys sorted at every level. The lowering builds objects in
   * its own key order, so a plain stringify would report "blockId moved to
   * the end" as a difference when the program is identical.
   */
  function canonical(v) {
    if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
    if (v && typeof v === 'object') {
      return `{${Object.keys(v).sort()
          .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
    }
    return JSON.stringify(v);
  }

  function roundTrip(stmts) {
    const {xml, lossy} = raiseScript(stmts);
    const ws = new Blockly.Workspace();
    Blockly.Xml.domToWorkspace(Blockly.utils.xml.textToDom(xml), ws);
    const back = lowerWorkspace(ws);
    ws.dispose();
    return {back, lossy, xml};
  }

  /** Everything in a project that holds a script, labelled. */
  function scriptsOf(project) {
    const out = [];
    Object.entries(project.scripts || {}).forEach(([k, sc]) =>
      out.push({where: `game ${k}`, actor: null, sc}));
    (project.rooms || []).forEach((r) =>
      Object.entries(r.scripts || {}).forEach(([k, sc]) =>
        out.push({where: `${r.name} ${k}`, actor: null, sc})));
    (project.actors || []).forEach((a) =>
      Object.entries(a.scripts || {}).forEach(([k, sc]) =>
        out.push({where: `${a.name} ${k}`, actor: a, sc})));
    return out.filter((x) => x.sc && x.sc.stmts && x.sc.stmts.length);
  }

  // Every example offered from the editor's Open menu. If one of these does
  // not survive the trip, opening it in the editor would show something
  // other than the game - or, worse, rewrite it on the first edit.
  const offered = ['shmup', 'platformer', 'shmup-sg1000'];

  offered.forEach((name) => {
    test(`${name}: every script survives AST -> blocks -> AST exactly`, () => {
      const project = JSON.parse(rf(join(root, `examples/${name}.json`), 'utf8'));
      const setActor = useProject(project);
      const scripts = scriptsOf(project);
      assert(scripts.length > 0, 'the example has no scripts to check');
      const broken = [];
      scripts.forEach(({where, actor, sc}) => {
        setActor(actor);
        const {back, lossy} = roundTrip(sc.stmts);
        if (lossy.length) {
          broken.push(`${where}: no block for ${lossy.join(', ')}`);
          return;
        }
        const a = canonical(sc.stmts);
        const b = canonical(back);
        if (a !== b) broken.push(`${where}:\n  was  ${a}\n  now  ${b}`);
      });
      assert(!broken.length, broken.join('\n'));
    });
  });

  test('the kitchen sink reports what it cannot show, instead of dropping it', () => {
    // It uses raw source, the frame counter and the second pad on purpose:
    // none of them has a block. The raiser must say so, so the editor can
    // refuse to overwrite a script it could only partly display.
    const project = JSON.parse(rf(join(root, 'examples/kitchen-sink.json'), 'utf8'));
    const all = scriptsOf(project).flatMap(({sc}) => raiseScript(sc.stmts).lossy);
    ['raw', 'frameCounter', 'pad2'].forEach((op) => {
      assert(all.includes(op), `"${op}" was dropped without being reported`);
    });
  });

  test('block ids survive, so errors still point at the right block', () => {
    const project = JSON.parse(rf(join(root, 'examples/shmup.json'), 'utf8'));
    const setActor = useProject(project);
    const bug = project.actors.find((a) => a.id === 'bug');
    setActor(bug);
    const {back} = roundTrip(bug.scripts.destroy.stmts);
    const ids = JSON.stringify(back).match(/"blockId":"[^"]+"/g) || [];
    const want = JSON.stringify(bug.scripts.destroy.stmts).match(/"blockId":"[^"]+"/g);
    assert(JSON.stringify(ids) === JSON.stringify(want),
        `ids came back as ${ids.join(' ')}`);
  });

  test('a dropdown value the project does not have is caught', () => {
    // The failure the per-actor context exists to prevent: with the wrong
    // actor current, a field dropdown cannot accept "hp" and Blockly keeps
    // its first option instead. The round trip must notice.
    const project = JSON.parse(rf(join(root, 'examples/shmup.json'), 'utf8'));
    const setActor = useProject(project);
    const bug = project.actors.find((a) => a.id === 'bug');
    setActor(project.actors.find((a) => a.id === 'ship'));
    const {back} = roundTrip(bug.scripts['collide:player_shot'].stmts);
    assert(canonical(back) !== canonical(bug.scripts['collide:player_shot'].stmts),
        'a field the current actor does not have round-tripped anyway, so ' +
      'this check cannot tell the difference');
  });

  // Restore the stand-in project the rest of the file was written against.
  defineBlocks(Blockly, ctx);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
