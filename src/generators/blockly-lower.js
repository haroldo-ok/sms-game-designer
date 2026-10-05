/**
 * Blockly workspace -> lowered statement AST.
 *
 * The first of the two lowering levels. `vcs-game-maker` generates batari
 * Basic straight from blocks with Handlebars templates, which is fine at VCS
 * scale; here the middle representation earns its keep because width
 * inference, constant folding and temporary allocation all need to look at a
 * whole expression rather than one block at a time — and because a second
 * backend should not mean rewriting every block.
 *
 * The output of this file is exactly what a project file stores in
 * `script.stmts`, which is why the Node build tool never has to instantiate
 * Blockly.
 */

/**
 * @param {Blockly.Workspace} workspace
 * @returns {Array} statement list
 */
export function lowerWorkspace(workspace) {
  const tops = workspace.getTopBlocks(true)
      .filter((b) => b.previousConnection && !b.previousConnection.targetConnection);
  const out = [];
  tops.forEach((b) => lowerChain(b, out));
  return out;
}

function lowerChain(block, out) {
  let b = block;
  while (b) {
    if (b.isEnabled()) {
      const s = lowerStatement(b);
      if (s) out.push(s);
    }
    b = b.getNextBlock();
  }
}

function statements(block, name) {
  const out = [];
  const first = block.getInputTargetBlock(name);
  if (first) lowerChain(first, out);
  return out;
}

function lowerStatement(b) {
  const id = b.id;
  const input = (name, dflt) => value(b, name, dflt);
  const field = (name) => b.getFieldValue(name);
  const numField = (name) => Number(b.getFieldValue(name)) || 0;

  switch (b.type) {
    case 'sms_set_my_pos':
      return {op: 'setPos', x: input('X', 0), y: input('Y', 0), blockId: id};

    case 'sms_move_by':
      return {op: 'movePos', dx: input('DX', 0), dy: input('DY', 0), blockId: id};

    case 'sms_set_speed':
      // Not num(): that rounds, and this block offers quarter-pixel steps.
      // "Set my speed to 0.5" used to lower to 0 and leave the actor still.
      return {op: 'setVel', vx: exact(numField('VX')), vy: exact(numField('VY')),
        blockId: id};

    case 'sms_play_anim':
      return {op: 'playAnim', anim: field('ANIM'), blockId: id};

    case 'sms_show':
      return {op: 'show', blockId: id};
    case 'sms_hide':
      return {op: 'hide', blockId: id};

    case 'sms_spawn_at_me':
      return {
        op: 'spawn', actor: field('ACTOR'), blockId: id,
        x: add({op: 'myX'}, input('DX', 0)),
        y: add({op: 'myY'}, input('DY', 0)),
      };

    case 'sms_spawn_at':
      return {op: 'spawn', actor: field('ACTOR'), x: input('X', 0), y: input('Y', 0), blockId: id};

    case 'sms_destroy_me':
      return {op: 'destroy', target: 'me', blockId: id};
    case 'sms_destroy_other':
      return {op: 'destroy', target: 'other', blockId: id};

    case 'sms_set_timer':
      return {op: 'setTimer', value: input('N', 30), blockId: id};

    case 'sms_set_my_field':
      return {op: 'setField', field: field('FIELD'), value: input('V', 0), blockId: id};
    case 'sms_change_my_field':
      return {op: 'changeField', field: field('FIELD'), delta: input('V', 1), blockId: id};

    case 'sms_set_global':
      return {op: 'setGlobal', name: field('NAME'), value: input('V', 0), blockId: id};
    case 'sms_change_global':
      return {op: 'changeGlobal', name: field('NAME'), delta: input('V', 1), blockId: id};

    case 'sms_go_room':
      return {op: 'goRoom', room: field('ROOM'), blockId: id};
    case 'sms_restart_room':
      return {op: 'restartRoom', blockId: id};
    case 'sms_game_over':
      return {op: 'gameOver', blockId: id};
    case 'sms_play_sound':
      return {op: 'playSound', sound: field('SFX'), blockId: id};
    case 'sms_play_music':
      return {op: 'playMusic', music: field('TUNE'), blockId: id};
    case 'sms_stop_music':
      return {op: 'stopMusic', blockId: id};

    case 'sms_print_text':
      return {op: 'print', text: field('TEXT'), row: numField('ROW'), col: numField('COL'), blockId: id};
    case 'sms_print_global':
      return {op: 'print', global: field('NAME'), row: numField('ROW'), col: numField('COL'), blockId: id};

    case 'sms_repeat':
      return {op: 'repeat', count: num(numField('N')), body: statements(b, 'BODY'), blockId: id};

    case 'controls_if': {
      // Blockly's if block can have several elseif branches; the AST has only
      // if/else, so they nest. The generated CVBasic comes out the same
      // shape a person would have written.
      const n = (b.elseifCount_ || 0) + 1;
      const branches = [];
      for (let i = 0; i < n; i++) {
        branches.push({
          cond: condition(b, i === 0 ? 'IF0' : `IF${i}`),
          then: statements(b, i === 0 ? 'DO0' : `DO${i}`),
        });
      }
      const elseBody = b.elseCount_ ? statements(b, 'ELSE') : [];
      let node = elseBody;
      for (let i = branches.length - 1; i >= 0; i--) {
        node = [{
          op: 'if', cond: branches[i].cond, then: branches[i].then,
          else: Array.isArray(node) ? node : [node],
          blockId: i === 0 ? id : `${id}_${i}`,
        }];
      }
      return node[0];
    }

    default:
      return null;
  }
}

/* ------------------------------------------------------------------ */
/* expressions                                                         */
/* ------------------------------------------------------------------ */

function value(block, name, dflt) {
  const child = block.getInputTargetBlock(name);
  if (!child) return num(dflt);
  return lowerExpr(child);
}

function lowerExpr(b) {
  const field = (name) => b.getFieldValue(name);
  const numField = (name) => Number(b.getFieldValue(name)) || 0;

  switch (b.type) {
    case 'math_number':
      return num(numField('NUM'));

    case 'math_arithmetic': {
      const opers = {ADD: '+', MINUS: '-', MULTIPLY: '*', DIVIDE: '/'};
      const oper = opers[field('OP')];
      if (!oper) return num(0);
      return fold({
        op: 'binop', oper,
        a: value(b, 'A', 0), b: value(b, 'B', 0),
      });
    }

    case 'sms_my_x': return {op: 'myX'};
    case 'sms_my_y': return {op: 'myY'};
    case 'sms_my_timer': return {op: 'myTimer'};
    case 'sms_my_field': return {op: 'field', field: field('FIELD')};
    case 'sms_other_field': return {op: 'field', field: field('FIELD'), target: 'other'};
    case 'sms_global': return {op: 'global', name: field('NAME')};
    case 'sms_player_pos':
      return field('AXIS') === 'y' ? {op: 'playerY'} : {op: 'playerX'};
    case 'sms_random':
      return {op: 'randomRange', min: numField('LO'), max: numField('HI')};
    case 'sms_count_group':
      return {op: 'countGroup', group: field('GROUP')};

    default:
      // A boolean block used where a number was expected. Rather than
      // producing 0 silently, fall through to the condition lowering so
      // `if my hp = 0` inside an arithmetic slot still means something.
      return condition2expr(b);
  }
}

function condition(block, name) {
  const child = block.getInputTargetBlock(name);
  if (!child) return {op: 'compare', oper: 'ne', a: num(0), b: num(0)};
  return lowerCond(child);
}

function lowerCond(b) {
  const field = (name) => b.getFieldValue(name);

  switch (b.type) {
    case 'sms_button':
      return field('WHICH') === 'BUTTON2' ? {op: 'button2'} : {op: 'button'};
    case 'sms_pad':
      return {op: 'pad', dir: field('DIR')};
    case 'sms_tile_at_feet':
      return {op: 'tileAt', attr: field('ATTR')};
    case 'sms_off_screen':
      return {op: 'offScreen'};
    case 'sms_near_player':
      return {op: 'nearPlayer', distance: Number(field('D')) || 32};

    case 'logic_boolean':
      return {op: 'compare', oper: field('BOOL') === 'TRUE' ? 'eq' : 'ne',
        a: num(0), b: num(0)};

    case 'logic_compare': {
      const opers = {EQ: 'eq', NEQ: 'ne', LT: 'lt', LTE: 'le', GT: 'gt', GTE: 'ge'};
      return {
        op: 'compare', oper: opers[field('OP')] || 'eq',
        a: value(b, 'A', 0), b: value(b, 'B', 0),
      };
    }

    case 'logic_operation':
      return {
        op: field('OP') === 'OR' ? 'or' : 'and',
        a: condition(b, 'A'), b: condition(b, 'B'),
      };

    case 'logic_negate':
      return {op: 'not', a: condition(b, 'BOOL')};

    default:
      // Any value block in a condition socket means "is this non-zero",
      // which is what a beginner expects from `if my hp`.
      return {op: 'compare', oper: 'ne', a: lowerExpr(b), b: num(0)};
  }
}

function condition2expr(b) {
  const c = lowerCond(b);
  return {op: 'cond', cond: c};
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

/** A literal that keeps its fraction - speeds are in pixels per frame. */
function exact(v) {
  return {op: 'num', value: Number(v) || 0};
}

function num(v) {
  return {op: 'num', value: Math.round(Number(v) || 0)};
}

function isNum(e) {
  return e && e.op === 'num';
}

/** Constant folding, which matters most where behaviours meet literals. */
function fold(e) {
  if (e.op !== 'binop' || !isNum(e.a) || !isNum(e.b)) return e;
  const a = e.a.value;
  const b = e.b.value;
  switch (e.oper) {
    case '+': return num(a + b);
    case '-': return num(a - b);
    case '*': return num(a * b);
    case '/': return num(b ? Math.trunc(a / b) : 0);
    default: return e;
  }
}

function add(base, delta) {
  if (isNum(delta) && delta.value === 0) return base;
  return {op: 'binop', oper: '+', a: base, b: delta};
}
