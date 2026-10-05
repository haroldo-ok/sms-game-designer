/**
 * Lowered statement AST -> Blockly XML. The inverse of blockly-lower.js.
 *
 * Projects store both forms of every script: the Blockly XML the editor
 * reloads, and the lowered AST the code generator reads. Anything authored
 * in the editor has both. Anything authored as data - the bundled examples,
 * a project produced by a script, an import from another tool - may have
 * only the AST.
 *
 * Without this, such a script opened as an empty workspace, and the moment
 * anyone touched it the editor lowered that empty workspace and overwrote
 * the real program. Opening an example would have shown you nothing and
 * then quietly deleted the game.
 *
 * The contract is exact: lowering the XML this produces must give back the
 * AST it was given, field for field and id for id. The block ids matter as
 * much as the logic, because they are what maps a compiler error back to the
 * block that caused it. A test holds every shipped example to that.
 *
 * Some AST forms have no block - `raw` source, the frame counter, a second
 * pad - because the language deliberately does not offer them. Those are
 * reported in `lossy` rather than dropped, so the editor can refuse to
 * overwrite a script it could only partly show.
 */

const COMPARE = {eq: 'EQ', ne: 'NEQ', lt: 'LT', le: 'LTE', gt: 'GT', ge: 'GTE'};
const ARITH = {'+': 'ADD', '-': 'MINUS', '*': 'MULTIPLY', '/': 'DIVIDE'};

/**
 * @param {Array} stmts lowered statements
 * @returns {{xml: string, lossy: string[]}}
 */
export function raiseScript(stmts) {
  const lossy = [];
  const chain = raiseChain(stmts || [], lossy);
  const body = chain ?
    chain.replace(/^<block /, '<block x="20" y="20" ') :
    '';
  return {
    xml: `<xml xmlns="https://developers.google.com/blockly/xml">${body}</xml>`,
    lossy: [...new Set(lossy)],
  };
}

/** A sequence of statements as one block chained through <next>. */
function raiseChain(stmts, lossy) {
  const blocks = stmts.map((s) => raiseStatement(s, lossy)).filter(Boolean);
  if (!blocks.length) return '';
  // Build from the end: each block's <next> holds the rest of the chain.
  let out = '';
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    out = out ? b.replace(/<\/block>$/, `<next>${out}</next></block>`) : b;
  }
  return out;
}

function raiseStatement(s, lossy) {
  if (!s || !s.op) return null;
  const id = s.blockId;
  const make = (type, inner = '') => block(type, id, inner);

  switch (s.op) {
    case 'setPos':
      return make('sms_set_my_pos', value('X', s.x, lossy) + value('Y', s.y, lossy));
    case 'movePos':
      return make('sms_move_by', value('DX', s.dx, lossy) + value('DY', s.dy, lossy));
    case 'setVel':
      return make('sms_set_speed', field('VX', literal(s.vx)) + field('VY', literal(s.vy)));
    case 'playAnim':
      return make('sms_play_anim', field('ANIM', s.anim));
    case 'show':
      return make('sms_show');
    case 'hide':
      return make('sms_hide');

    case 'spawn': {
      // Lowering turns "spawn at my position, dx across, dy down" into
      // x = myX (+ dx), y = myY (+ dy). Recognise that shape and give the
      // friendlier block back; anything else is "spawn at x, y".
      const dx = offsetFrom(s.x, 'myX');
      const dy = offsetFrom(s.y, 'myY');
      if (dx !== undefined && dy !== undefined) {
        return make('sms_spawn_at_me', field('ACTOR', s.actor) +
          value('DX', dx, lossy) + value('DY', dy, lossy));
      }
      return make('sms_spawn_at', field('ACTOR', s.actor) +
        value('X', s.x, lossy) + value('Y', s.y, lossy));
    }

    case 'destroy':
      return make(s.target === 'other' ? 'sms_destroy_other' : 'sms_destroy_me');
    case 'setTimer':
      return make('sms_set_timer', value('N', s.value, lossy));

    case 'setField':
    case 'changeField':
      if (s.target === 'other') {
        lossy.push(`${s.op} on the other one`);
        return null;
      }
      return make(s.op === 'setField' ? 'sms_set_my_field' : 'sms_change_my_field',
          field('FIELD', s.field) +
        value('V', s.op === 'setField' ? s.value : s.delta, lossy));

    case 'setGlobal':
      return make('sms_set_global', field('NAME', s.name) + value('V', s.value, lossy));
    case 'changeGlobal':
      return make('sms_change_global', field('NAME', s.name) + value('V', s.delta, lossy));

    case 'goRoom':
      return make('sms_go_room', field('ROOM', s.room));
    case 'restartRoom':
      return make('sms_restart_room');
    case 'gameOver':
      return make('sms_game_over');
    case 'playSound':
      return make('sms_play_sound', field('SFX', s.sound));
    case 'playMusic':
      return make('sms_play_music', field('TUNE', s.music));
    case 'stopMusic':
      return make('sms_stop_music');

    case 'print': {
      const pos = field('ROW', s.row | 0) + field('COL', s.col | 0);
      if (s.text != null) return make('sms_print_text', field('TEXT', s.text) + pos);
      return make('sms_print_global', field('NAME', s.global) + pos);
    }

    case 'repeat':
      return make('sms_repeat', field('N', literal(s.count)) +
        statements('BODY', s.body, lossy));

    case 'if': {
      const hasElse = s.else && s.else.length;
      const mutation = hasElse ? '<mutation else="1"></mutation>' : '';
      return make('controls_if', mutation +
        condValue('IF0', s.cond, lossy) +
        statements('DO0', s.then, lossy) +
        (hasElse ? statements('ELSE', s.else, lossy) : ''));
    }

    default:
      lossy.push(s.op);
      return null;
  }
}

/* ------------------------------------------------------------------ */
/* expressions and conditions                                          */
/* ------------------------------------------------------------------ */

function raiseExpr(e, lossy) {
  if (e == null) return null;
  if (typeof e === 'number') return numberBlock(e);
  switch (e.op) {
    case 'num': return numberBlock(e.value);
    case 'myX': return block('sms_my_x');
    case 'myY': return block('sms_my_y');
    case 'myTimer': return block('sms_my_timer');
    case 'field':
      return block(e.target === 'other' ? 'sms_other_field' : 'sms_my_field', null,
          field('FIELD', e.field));
    case 'global': return block('sms_global', null, field('NAME', e.name));
    case 'playerX': return block('sms_player_pos', null, field('AXIS', 'x'));
    case 'playerY': return block('sms_player_pos', null, field('AXIS', 'y'));
    case 'randomRange':
      return block('sms_random', null, field('LO', e.min | 0) + field('HI', e.max | 0));
    case 'countGroup':
      return block('sms_count_group', null, field('GROUP', e.group));
    case 'binop': {
      const op = ARITH[e.oper];
      if (!op) {
        lossy.push(`arithmetic "${e.oper}"`);
        return null;
      }
      return block('math_arithmetic', null, field('OP', op) +
        value('A', e.a, lossy) + value('B', e.b, lossy));
    }
    case 'cond':
      // A yes/no block sitting in a number socket.
      return raiseCond(e.cond, lossy);
    default:
      lossy.push(e.op);
      return null;
  }
}

function raiseCond(c, lossy) {
  if (!c) return null;
  switch (c.op) {
    case 'button': return block('sms_button', null, field('WHICH', 'BUTTON'));
    case 'button2': return block('sms_button', null, field('WHICH', 'BUTTON2'));
    case 'pad': return block('sms_pad', null, field('DIR', c.dir || 'UP'));
    case 'tileAt': return block('sms_tile_at_feet', null, field('ATTR', c.attr));
    case 'offScreen': return block('sms_off_screen');
    case 'nearPlayer':
      return block('sms_near_player', null, field('D', c.distance | 0));
    case 'compare':
      return block('logic_compare', null, field('OP', COMPARE[c.oper] || 'EQ') +
        value('A', c.a, lossy) + value('B', c.b, lossy));
    case 'and':
    case 'or':
      return block('logic_operation', null, field('OP', c.op.toUpperCase()) +
        condValue('A', c.a, lossy) + condValue('B', c.b, lossy));
    case 'not':
      return block('logic_negate', null, condValue('BOOL', c.a, lossy));
    default:
      lossy.push(c.op);
      return null;
  }
}

/* ------------------------------------------------------------------ */
/* XML helpers                                                         */
/* ------------------------------------------------------------------ */

function block(type, id, inner = '') {
  const idAttr = id ? ` id="${esc(id)}"` : '';
  return `<block type="${type}"${idAttr}>${inner}</block>`;
}

function field(name, v) {
  return `<field name="${name}">${esc(v == null ? '' : String(v))}</field>`;
}

function value(name, e, lossy) {
  const inner = raiseExpr(e, lossy);
  return inner ? `<value name="${name}">${inner}</value>` : '';
}

function condValue(name, c, lossy) {
  const inner = raiseCond(c, lossy);
  return inner ? `<value name="${name}">${inner}</value>` : '';
}

function statements(name, list, lossy) {
  const inner = raiseChain(list || [], lossy);
  return inner ? `<statement name="${name}">${inner}</statement>` : '';
}

function numberBlock(v) {
  return block('math_number', null, field('NUM', Number(v) || 0));
}

function literal(v) {
  if (typeof v === 'number') return v;
  if (v && v.op === 'num') return v.value;
  return 0;
}

/**
 * If `e` is `base` or `base + offset`, return the offset expression (a zero
 * literal for the bare case). Otherwise undefined.
 */
function offsetFrom(e, base) {
  if (!e) return undefined;
  if (e.op === base) return {op: 'num', value: 0};
  if (e.op === 'binop' && e.oper === '+' && e.a && e.a.op === base) return e.b;
  return undefined;
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
