/**
 * Blockly block definitions.
 *
 * The blocks say "set my x", never "set player0's x". That is the single
 * biggest ergonomic difference from the VCS tool and it falls straight out
 * of the actor model: every script is written from the point of view of one
 * instance, implicitly `me`.
 *
 * There are exactly two implicit references and no others:
 *
 *   me     - the instance running the script
 *   other  - the instance we collided with, valid only in a collide event
 *
 * plus one privileged singleton, `the player`. There are deliberately no
 * general object references, no instance handles, and no "for each instance
 * of X" with arbitrary nesting: with a recycled fixed pool a stale handle is
 * a use-after-free, and a beginner has no way to reason about that.
 *
 * Blocks are registered once; which of them a given workspace can *see* is
 * decided by the toolbox (see toolbox.js), because a palette that offers
 * everything everywhere is how block tools become unusable.
 */

const HUE = {
  motion: 230, appearance: 260, lifecycle: 20, sensing: 200,
  fields: 330, control: 120, game: 45,
};

export function defineBlocks(Blockly, ctx = {}) {
  // `ctx` supplies the live project so dropdowns can be populated from it:
  // the actor list, this actor's own fields, its animation names, the
  // project's globals and rooms. This is what makes "my [hp]" a real
  // dropdown rather than a free-typed name the user can misspell.
  const dd = (fn) => () => {
    const items = fn() || [];
    return items.length ? items : [['(none)', '']];
  };

  const actors = dd(() => (ctx.actors?.() || []).map((a) => [a.name, a.id]));
  const fields = dd(() => (ctx.fields?.() || []).map((f) => [f.name, f.name]));
  const anims = dd(() => (ctx.animations?.() || []).map((a) => [a.name, a.name]));
  const globals = dd(() => (ctx.globals?.() || []).map((g) => [g.name, g.name]));
  const rooms = dd(() => (ctx.rooms?.() || []).map((r) => [r.name, r.id]));

  const define = (type, json) => {
    Blockly.Blocks[type] = {init() {
      this.jsonInit(json);
    }};
  };

  /* ---- motion ------------------------------------------------------ */

  define('sms_set_my_pos', {
    message0: 'set my x to %1 y to %2',
    args0: [{type: 'input_value', name: 'X', check: 'Number'},
      {type: 'input_value', name: 'Y', check: 'Number'}],
    inputsInline: true,
    previousStatement: null, nextStatement: null, colour: HUE.motion,
    tooltip: 'Move me straight to a position, ignoring my speed.',
  });

  define('sms_move_by', {
    message0: 'move me by %1 across %2 down',
    args0: [{type: 'input_value', name: 'DX', check: 'Number'},
      {type: 'input_value', name: 'DY', check: 'Number'}],
    inputsInline: true,
    previousStatement: null, nextStatement: null, colour: HUE.motion,
  });

  define('sms_set_speed', {
    message0: 'set my speed to %1 across %2 down',
    args0: [{type: 'field_number', name: 'VX', value: 0, min: -8, max: 7.9,
      precision: 0.25},
    {type: 'field_number', name: 'VY', value: 0, min: -8, max: 7.9,
      precision: 0.25}],
    inputsInline: true,
    previousStatement: null, nextStatement: null, colour: HUE.motion,
    tooltip: 'Pixels per frame. Fractions are allowed but cost more; the ' +
      'budget meter shows the difference.',
  });

  define('sms_my_x', {
    message0: 'my x', output: 'Number', colour: HUE.motion,
  });
  define('sms_my_y', {
    message0: 'my y', output: 'Number', colour: HUE.motion,
  });

  /* ---- appearance --------------------------------------------------- */

  define('sms_play_anim', {
    message0: 'play animation %1',
    args0: [{type: 'field_dropdown', name: 'ANIM', options: anims}],
    previousStatement: null, nextStatement: null, colour: HUE.appearance,
    tooltip: 'Restarts the animation unless it is already playing, so this ' +
      'is safe to use every frame.',
  });

  define('sms_show', {
    message0: 'show me',
    previousStatement: null, nextStatement: null, colour: HUE.appearance,
  });
  define('sms_hide', {
    message0: 'hide me',
    previousStatement: null, nextStatement: null, colour: HUE.appearance,
    tooltip: 'Hidden actors still move and still collide.',
  });

  /* ---- lifecycle ----------------------------------------------------- */

  define('sms_spawn_at_me', {
    message0: 'spawn %1 at my position %2 across %3 down',
    args0: [{type: 'field_dropdown', name: 'ACTOR', options: actors},
      {type: 'input_value', name: 'DX', check: 'Number'},
      {type: 'input_value', name: 'DY', check: 'Number'}],
    inputsInline: true,
    previousStatement: null, nextStatement: null, colour: HUE.lifecycle,
    tooltip: 'Does nothing if that actor is already at its Max instances. ' +
      'The profiler counts dropped spawns.',
  });

  define('sms_spawn_at', {
    message0: 'spawn %1 at x %2 y %3',
    args0: [{type: 'field_dropdown', name: 'ACTOR', options: actors},
      {type: 'input_value', name: 'X', check: 'Number'},
      {type: 'input_value', name: 'Y', check: 'Number'}],
    inputsInline: true,
    previousStatement: null, nextStatement: null, colour: HUE.lifecycle,
  });

  define('sms_destroy_me', {
    message0: 'destroy me',
    previousStatement: null, nextStatement: null, colour: HUE.lifecycle,
    tooltip: 'The rest of this script still runs. The slot is actually ' +
      'freed at the end of the frame, after "on destroy".',
  });

  define('sms_destroy_other', {
    message0: 'destroy the other one',
    previousStatement: null, nextStatement: null, colour: HUE.lifecycle,
  });

  define('sms_set_timer', {
    message0: 'set my timer to %1 frames',
    args0: [{type: 'input_value', name: 'N', check: 'Number'}],
    previousStatement: null, nextStatement: null, colour: HUE.lifecycle,
  });

  define('sms_my_timer', {
    message0: 'my timer', output: 'Number', colour: HUE.lifecycle,
  });

  /* ---- sensing -------------------------------------------------------- */

  define('sms_button', {
    message0: 'button %1 pressed',
    args0: [{type: 'field_dropdown', name: 'WHICH',
      options: [['fire', 'BUTTON'], ['fire 2', 'BUTTON2']]}],
    output: 'Boolean', colour: HUE.sensing,
  });

  define('sms_pad', {
    message0: 'pad %1 held',
    args0: [{type: 'field_dropdown', name: 'DIR',
      options: [['up', 'UP'], ['down', 'DOWN'], ['left', 'LEFT'],
        ['right', 'RIGHT']]}],
    output: 'Boolean', colour: HUE.sensing,
  });

  define('sms_tile_at_feet', {
    message0: 'tile below me is %1',
    args0: [{type: 'field_dropdown', name: 'ATTR',
      options: [['solid', 'solid'], ['hazard', 'hazard'],
        ['ladder', 'ladder'], ['breakable', 'breakable'],
        ['platform', 'platform']]}],
    output: 'Boolean', colour: HUE.sensing,
  });

  define('sms_off_screen', {
    message0: 'am I off screen', output: 'Boolean', colour: HUE.sensing,
  });

  define('sms_player_pos', {
    message0: 'the player\'s %1',
    args0: [{type: 'field_dropdown', name: 'AXIS',
      options: [['x', 'x'], ['y', 'y']]}],
    output: 'Number', colour: HUE.sensing,
  });

  define('sms_count_group', {
    message0: 'how many %1 are left',
    args0: [{type: 'field_dropdown', name: 'GROUP', options: () =>
      (ctx.groups?.() || ['enemy']).map((g) => [g, g])}],
    output: 'Number', colour: HUE.sensing,
    tooltip: 'The number alive right now. This is how you check whether a ' +
      'wave has been cleared.',
  });

  define('sms_near_player', {
    message0: 'the player is within %1 pixels',
    args0: [{type: 'field_number', name: 'D', value: 32, min: 1, max: 127}],
    output: 'Boolean', colour: HUE.sensing,
    tooltip: 'A box, not a circle - a true distance needs a multiply per ' +
      'axis and this runs for every instance every frame.',
  });

  define('sms_other_field', {
    message0: 'the other one\'s %1',
    args0: [{type: 'field_dropdown', name: 'FIELD', options: fields}],
    output: 'Number', colour: HUE.sensing,
  });

  /* ---- fields and globals ---------------------------------------------- */

  define('sms_my_field', {
    message0: 'my %1',
    args0: [{type: 'field_dropdown', name: 'FIELD', options: fields}],
    output: 'Number', colour: HUE.fields,
  });

  define('sms_set_my_field', {
    message0: 'set my %1 to %2',
    args0: [{type: 'field_dropdown', name: 'FIELD', options: fields},
      {type: 'input_value', name: 'V', check: 'Number'}],
    previousStatement: null, nextStatement: null, colour: HUE.fields,
  });

  define('sms_change_my_field', {
    message0: 'change my %1 by %2',
    args0: [{type: 'field_dropdown', name: 'FIELD', options: fields},
      {type: 'input_value', name: 'V', check: 'Number'}],
    previousStatement: null, nextStatement: null, colour: HUE.fields,
  });

  define('sms_global', {
    message0: '%1',
    args0: [{type: 'field_dropdown', name: 'NAME', options: globals}],
    output: 'Number', colour: HUE.fields,
  });

  define('sms_set_global', {
    message0: 'set %1 to %2',
    args0: [{type: 'field_dropdown', name: 'NAME', options: globals},
      {type: 'input_value', name: 'V', check: 'Number'}],
    previousStatement: null, nextStatement: null, colour: HUE.fields,
  });

  define('sms_change_global', {
    message0: 'change %1 by %2',
    args0: [{type: 'field_dropdown', name: 'NAME', options: globals},
      {type: 'input_value', name: 'V', check: 'Number'}],
    previousStatement: null, nextStatement: null, colour: HUE.fields,
  });

  /* ---- control ---------------------------------------------------------- */

  define('sms_repeat', {
    message0: 'repeat %1 times %2 %3',
    args0: [{type: 'field_number', name: 'N', value: 4, min: 1, max: 255,
      precision: 1},
    {type: 'input_dummy'},
    {type: 'input_statement', name: 'BODY'}],
    previousStatement: null, nextStatement: null, colour: HUE.control,
    tooltip: 'A constant count only. An unbounded loop inside a per-frame ' +
      'script stalls every other actor in the game.',
  });

  define('sms_random', {
    message0: 'random %1 to %2',
    args0: [{type: 'field_number', name: 'LO', value: 0, precision: 1},
      {type: 'field_number', name: 'HI', value: 7, precision: 1}],
    inputsInline: true, output: 'Number', colour: HUE.control,
  });

  /* ---- game ------------------------------------------------------------- */

  define('sms_play_sound', {
    message0: 'play sound %1',
    args0: [{type: 'field_dropdown', name: 'SFX', options: [
      ['shoot', 'shoot'], ['pickup', 'pickup'], ['explosion', 'explode'],
      ['jump', 'jump'], ['hurt', 'hurt']]}],
    previousStatement: null, nextStatement: null, colour: HUE.game,
    tooltip: 'Plays on the two PSG channels the music player does not use, ' +
      'so it never cuts the music off.',
  });

  define('sms_play_music', {
    message0: 'play music %1',
    args0: [{type: 'field_dropdown', name: 'TUNE', options: [
      ['title theme', 'title'], ['action theme', 'action'],
      ['game over sting', 'gameover']]}],
    previousStatement: null, nextStatement: null, colour: HUE.game,
    tooltip: 'Uses two of the four sound channels, so sound effects still ' +
      'play over it.',
  });

  define('sms_stop_music', {
    message0: 'stop the music',
    previousStatement: null, nextStatement: null, colour: HUE.game,
  });

  define('sms_go_room', {
    message0: 'go to room %1',
    args0: [{type: 'field_dropdown', name: 'ROOM', options: rooms}],
    previousStatement: null, colour: HUE.game,
    tooltip: 'Takes effect at the end of the frame.',
  });

  define('sms_restart_room', {
    message0: 'restart this room',
    previousStatement: null, colour: HUE.game,
  });

  define('sms_game_over', {
    message0: 'game over',
    previousStatement: null, colour: HUE.game,
  });

  define('sms_print_text', {
    message0: 'print %1 at row %2 column %3',
    args0: [{type: 'field_input', name: 'TEXT', text: 'SCORE'},
      {type: 'field_number', name: 'ROW', value: 0, min: 0, max: 27},
      {type: 'field_number', name: 'COL', value: 0, min: 0, max: 31}],
    previousStatement: null, nextStatement: null, colour: HUE.game,
  });

  define('sms_print_global', {
    message0: 'print %1 at row %2 column %3',
    args0: [{type: 'field_dropdown', name: 'NAME', options: globals},
      {type: 'field_number', name: 'ROW', value: 0, min: 0, max: 27},
      {type: 'field_number', name: 'COL', value: 0, min: 0, max: 31}],
    previousStatement: null, nextStatement: null, colour: HUE.game,
  });
}

export {HUE};
