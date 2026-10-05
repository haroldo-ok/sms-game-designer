/**
 * Toolbox construction, scoped per script.
 *
 * Each workspace is a typed slot and its toolbox is filtered to match.
 * Blocks that need `me` simply do not exist in the global workspaces, and
 * blocks that need `other` only exist inside a collide event. That removes a
 * whole class of confusing errors instead of diagnosing them afterwards:
 * there is no "you can't use this here" message, because there is nothing to
 * drag.
 *
 * Scopes:
 *
 *   actor          an actor event other than a collide event
 *   actor-collide  an actor collide event; adds the `other` blocks
 *   room           a room's "on enter"
 *   global         "on game start" and the per-frame HUD script
 */

const CATEGORY = {
  motion: {name: 'Motion', colour: 230},
  appearance: {name: 'Appearance', colour: 260},
  lifecycle: {name: 'Lifecycle', colour: 20},
  sensing: {name: 'Sensing', colour: 200},
  fields: {name: 'Values', colour: 330},
  control: {name: 'Control', colour: 120},
  game: {name: 'Game', colour: 45},
};

const BLOCKS = {
  motion: {
    actor: ['sms_set_my_pos', 'sms_move_by', 'sms_set_speed', 'sms_my_x', 'sms_my_y'],
  },
  appearance: {
    actor: ['sms_play_anim', 'sms_show', 'sms_hide'],
  },
  lifecycle: {
    'actor': ['sms_spawn_at_me', 'sms_spawn_at', 'sms_destroy_me',
      'sms_set_timer', 'sms_my_timer'],
    'actor-collide': ['sms_destroy_other'],
    'room': ['sms_spawn_at'],
    'global': ['sms_spawn_at'],
  },
  sensing: {
    // "how many are left" is the one cross-instance question a beginner
    // genuinely needs, and it belongs in the global per-frame script most of
    // all - that is where "wave cleared, next level" is written.
    'all': ['sms_count_group'],
    'actor': ['sms_button', 'sms_pad', 'sms_tile_at_feet', 'sms_off_screen',
      'sms_player_pos', 'sms_near_player'],
    'actor-collide': ['sms_other_field'],
    'room': ['sms_button', 'sms_pad'],
    'global': ['sms_button', 'sms_pad', 'sms_player_pos'],
  },
  fields: {
    actor: ['sms_my_field', 'sms_set_my_field', 'sms_change_my_field',
      'sms_global', 'sms_set_global', 'sms_change_global'],
    room: ['sms_global', 'sms_set_global', 'sms_change_global'],
    global: ['sms_global', 'sms_set_global', 'sms_change_global'],
  },
  control: {
    all: ['controls_if', 'logic_compare', 'logic_operation', 'logic_boolean',
      'math_number', 'math_arithmetic', 'sms_repeat', 'sms_random'],
  },
  game: {
    all: ['sms_play_sound', 'sms_play_music', 'sms_stop_music'],
    actor: ['sms_go_room', 'sms_restart_room', 'sms_game_over'],
    room: ['sms_go_room', 'sms_restart_room', 'sms_game_over'],
    global: ['sms_go_room', 'sms_restart_room', 'sms_game_over',
      'sms_print_text', 'sms_print_global'],
  },
};

/**
 * @param {string} scope one of the scopes above
 * @returns {string} toolbox XML
 */
export function toolboxFor(scope) {
  const base = scope === 'actor-collide' ? 'actor' : scope;
  const parts = [];

  Object.keys(BLOCKS).forEach((key) => {
    const spec = BLOCKS[key];
    const list = [
      ...(spec.all || []),
      ...(spec[base] || []),
      ...(scope === 'actor-collide' ? (spec['actor-collide'] || []) : []),
    ];
    if (!list.length) return;
    const cat = CATEGORY[key];
    parts.push(
        `<category name="${cat.name}" colour="${cat.colour}">` +
      list.map(blockXml).join('') +
      '</category>');
  });

  return `<xml>${parts.join('<sep gap="12"/>')}</xml>`;
}

/**
 * A few blocks are much friendlier with a value already plugged in, because
 * an empty socket compiles to 0 and that is rarely what anyone meant.
 */
const SHADOWS = {
  sms_set_my_pos: {X: 0, Y: 0},
  sms_move_by: {DX: 0, DY: 0},
  sms_spawn_at_me: {DX: 0, DY: -8},
  sms_spawn_at: {X: 128, Y: 96},
  sms_set_timer: {N: 30},
  sms_set_my_field: {V: 1},
  sms_change_my_field: {V: -1},
  sms_set_global: {V: 0},
  sms_change_global: {V: 1},
  logic_compare: {A: null, B: 0},
  math_arithmetic: {A: 1, B: 1},
};

function blockXml(type) {
  const shadows = SHADOWS[type];
  if (!shadows) return `<block type="${type}"></block>`;
  const inner = Object.entries(shadows)
      .filter(([, v]) => v !== null)
      .map(([name, v]) =>
        `<value name="${name}"><shadow type="math_number">` +
      `<field name="NUM">${v}</field></shadow></value>`)
      .join('');
  return `<block type="${type}">${inner}</block>`;
}

export {CATEGORY, BLOCKS};
