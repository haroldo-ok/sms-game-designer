<template>
  <div v-if="actor" class="actor-editor">
    <div class="header">
      <v-text-field
        v-model="actor.name"
        dense
        hide-details
        label="Name"
        style="max-width: 200px"
      />
      <v-select
        v-model="actor.group"
        :items="groups"
        dense
        hide-details
        label="Group"
        style="max-width: 150px"
      />
      <v-text-field
        v-model.number="actor.max"
        type="number"
        min="1"
        dense
        hide-details
        label="Max instances"
        style="max-width: 130px"
      />
      <v-select
        v-model="size"
        :items="sizes"
        dense
        hide-details
        label="Size"
        style="max-width: 120px"
      />
      <v-checkbox
        :input-value="actor.isPlayer"
        dense
        hide-details
        label="This is the player"
        @change="$emit('set-player', actor.id)"
      />
      <v-checkbox
        v-model="actor.reuseOldest"
        dense
        hide-details
        label="Reuse oldest when full"
      />
    </div>

    <!--
      The per-type cost line. A beginner has no mental model of console
      limits; putting the price next to the choice teaches it without a
      lecture. This is the same idea as the budget strip, scoped to one type.
    -->
    <div class="costs">
      Costs
      <b>{{ spriteDefs }}</b> sprite definitions ·
      <b>{{ actor.max }}</b> slots ·
      <b>{{ ramBytes }}</b> bytes of RAM ·
      <b>{{ hwSprites }}</b> hardware sprites when full
    </div>

    <v-tabs v-model="tab" dense>
      <v-tab>Animations</v-tab>
      <v-tab>Hitbox</v-tab>
      <v-tab>Fields</v-tab>
      <v-tab>Behaviours</v-tab>
      <v-tab>Events</v-tab>
    </v-tabs>

    <v-tabs-items v-model="tab" class="pane">
      <!-- animations -->
      <v-tab-item>
        <div class="anim-bar">
          <v-chip
            v-for="(a, i) in actor.animations"
            :key="i"
            small
            :outlined="i !== animIndex"
            class="mr-1"
            @click="animIndex = i"
          >{{ a.name }} · {{ a.frames.length }}f</v-chip>
          <v-btn x-small text @click="addAnim">+ animation</v-btn>
        </div>

        <div v-if="anim" class="anim-body">
          <div class="anim-props">
            <v-text-field v-model="anim.name" dense hide-details label="Name" />
            <v-text-field
              v-model.number="anim.rate"
              type="number"
              min="1"
              max="255"
              dense
              hide-details
              label="Frames held"
            />
            <v-checkbox v-model="anim.loop" dense hide-details label="Loop" />
            <div class="frames">
              <v-chip
                v-for="(f, i) in anim.frames"
                :key="i"
                x-small
                :outlined="i !== frameIndex"
                class="mr-1 mb-1"
                @click="frameIndex = i"
              >{{ i + 1 }}</v-chip>
              <v-btn x-small text @click="addFrameHere">+ frame</v-btn>
            </div>
          </div>

          <SpriteEditor
            v-if="frame"
            :frame="frame"
            :previous="prevFrame"
            :target="target"
            :palette="palette.sprite"
            :onion="onion"
            @onion="onion = $event"
            @changed="$emit('changed')"
          />
        </div>
      </v-tab-item>

      <!-- hitbox -->
      <v-tab-item>
        <div class="hitbox-row">
          <v-text-field v-model.number="actor.hitbox.w" type="number" dense label="Width" />
          <v-text-field v-model.number="actor.hitbox.h" type="number" dense label="Height" />
          <v-text-field v-model.number="actor.hitbox.ox" type="number" dense label="Offset X" />
          <v-text-field v-model.number="actor.hitbox.oy" type="number" dense label="Offset Y" />
        </div>
        <p class="note">
          The hitbox is what collisions actually test, and it is usually
          smaller than the art. Both halves of a collision pair contribute
          their extents, and those extents are baked into the generated test
          as constants - so a tighter hitbox costs nothing extra.
        </p>
      </v-tab-item>

      <!-- fields -->
      <v-tab-item>
        <div v-for="(f, i) in actor.fields" :key="i" class="field-row">
          <v-text-field v-model="f.name" dense hide-details label="Name" />
          <v-select
            v-model.number="f.width"
            :items="[{text: '8-bit (0-255)', value: 8}, {text: '16-bit', value: 16}]"
            dense
            hide-details
            label="Size"
          />
          <v-text-field
            v-model.number="f.initial"
            type="number"
            dense
            hide-details
            label="Starts at"
          />
          <v-btn icon small @click="actor.fields.splice(i, 1)">
            <v-icon small>mdi-close</v-icon>
          </v-btn>
        </div>
        <v-btn x-small text :disabled="fieldsFull" @click="$emit('add-field')">
          + field
        </v-btn>
        <span class="budget-line">
          {{ fieldsUsed }} of {{ target.userFields }} field slots used
          <template v-if="fieldsFull">
            — a 16-bit field costs two
          </template>
        </span>
      </v-tab-item>

      <!-- behaviours -->
      <v-tab-item>
        <p class="note">
          Behaviours are the fast path: a working game with none of your own
          blocks, then blocks only for the special case that makes it yours.
          They run before <code>on update</code>, so a script can always
          correct one.
        </p>
        <div v-for="(b, i) in actor.behaviours" :key="i" class="behaviour">
          <span class="bname">{{ behaviourLabel(b.kind) }}</span>
          <component
            :is="'div'"
            class="bparams"
          >
            <template v-for="(spec, key) in behaviourParams(b.kind)">
              <v-text-field
                v-if="spec.type === 'number'"
                :key="key"
                v-model.number="b[key]"
                type="number"
                dense
                hide-details
                :label="spec.label"
                style="max-width: 120px"
              />
              <v-select
                v-else-if="spec.type === 'actor'"
                :key="key"
                v-model="b[key]"
                :items="actorItems"
                dense
                hide-details
                :label="spec.label"
                style="max-width: 150px"
              />
              <v-select
                v-else-if="spec.type === 'choice'"
                :key="key"
                v-model="b[key]"
                :items="spec.options"
                dense
                hide-details
                :label="spec.label"
                style="max-width: 150px"
              />
              <v-checkbox
                v-else
                :key="key"
                v-model="b[key]"
                dense
                hide-details
                :label="spec.label"
              />
            </template>
          </component>
          <v-btn icon small @click="actor.behaviours.splice(i, 1)">
            <v-icon small>mdi-close</v-icon>
          </v-btn>
        </div>
        <v-select
          :items="behaviourItems"
          dense
          hide-details
          label="Add a behaviour"
          style="max-width: 240px"
          @change="addBehaviour"
        />
      </v-tab-item>

      <!-- events -->
      <v-tab-item>
        <div class="event-bar">
          <v-chip
            v-for="ev in eventList"
            :key="ev.id"
            small
            :outlined="ev.id !== event"
            :color="hasScript(ev.id) ? 'primary' : undefined"
            class="mr-1 mb-1"
            @click="event = ev.id"
          >{{ ev.label }}</v-chip>
          <v-select
            :items="addableEvents"
            dense
            hide-details
            label="+ event"
            style="max-width: 200px"
            @change="addEvent"
          />
        </div>
        <BlocklyWorkspace
          v-if="event"
          :key="actor.id + ':' + event"
          :script="script"
          :scope="event.startsWith('collide:') ? 'actor-collide' : 'actor'"
          :title="eventLabel(event)"
          :blame="blameFor(event)"
          @changed="$emit('changed')"
        />
      </v-tab-item>
    </v-tabs-items>
  </div>
</template>

<script>
/**
 * One screen per actor type, because the type *is* the unit of authoring.
 *
 * This is the biggest structural difference from `vcs-game-maker`, which has
 * a fixed Player0 tab, a fixed Player1 tab and a fixed Playfield tab because
 * the VCS has exactly five movable objects. Here the number of authored
 * things is open-ended and the number on screen is larger still, so the
 * editor is a list of types rather than a set of tabs.
 */
import SpriteEditor from './SpriteEditor.vue';
import BlocklyWorkspace from './BlocklyWorkspace.vue';
import {GROUPS, EVENTS, ACTOR_SIZES} from '../ir/schema.js';

const BEHAVIOURS = {
  move: {
    label: 'Move in direction',
    params: {
      direction: {type: 'choice', label: 'Direction', options: [
        'up', 'down', 'left', 'right', 'upleft', 'upright', 'downleft', 'downright']},
      speed: {type: 'number', label: 'Speed (px/frame)'},
      atEdge: {type: 'choice', label: 'At the edge', options: [
        {text: 'keep going', value: 'none'},
        {text: 'wrap around', value: 'wrap'},
        {text: 'destroy me', value: 'destroy'}]},
    },
    defaults: {direction: 'down', speed: 2, atEdge: 'destroy', margin: 8},
  },
  control8: {
    label: '8-way control',
    params: {speed: {type: 'number', label: 'Speed'},
      pad: {type: 'number', label: 'Pad (1 or 2)'}},
    defaults: {speed: 2, pad: 1},
  },
  platform: {
    label: 'Platform',
    params: {
      gravity: {type: 'number', label: 'Gravity'},
      jump: {type: 'number', label: 'Jump strength'},
      speed: {type: 'number', label: 'Walk speed'},
    },
    defaults: {gravity: 0.25, jump: 3.5, speed: 2, pad: 1},
  },
  chase: {
    label: 'Chase the player',
    params: {speed: {type: 'number', label: 'Speed'},
      rate: {type: 'number', label: 'Re-aim every N frames'}},
    defaults: {speed: 1, rate: 8},
  },
  patrol: {
    label: 'Patrol',
    params: {speed: {type: 'number', label: 'Speed'},
      turnAtWall: {type: 'bool', label: 'Turn at ledges'}},
    defaults: {speed: 1, turnAtWall: false},
  },
  shoot: {
    label: 'Shoot',
    params: {
      actor: {type: 'actor', label: 'What to fire'},
      interval: {type: 'number', label: 'Cooldown (frames)'},
      onButton: {type: 'bool', label: 'Only when fire is held'},
      randomise: {type: 'number', label: 'Or: 1 in N chance'},
      offsetX: {type: 'number', label: 'Offset X'},
      offsetY: {type: 'number', label: 'Offset Y'},
      aim: {type: 'choice', label: 'Aim', options: [
        {text: 'straight', value: 'none'}, {text: 'at the player', value: 'player'}]},
    },
    defaults: {interval: 12, offsetX: 4, offsetY: 0, aim: 'none'},
  },
  animate: {label: 'Animate', params: {}, defaults: {}},
  destroyOffscreen: {
    label: 'Destroy off-screen',
    params: {margin: {type: 'number', label: 'Margin'}},
    defaults: {margin: 8},
  },
  health: {
    label: 'Health',
    params: {field: {type: 'choice', label: 'Field to watch', options: []}},
    defaults: {field: 'hp'},
  },
};

export default {
  name: 'ActorEditor',
  components: {SpriteEditor, BlocklyWorkspace},
  props: {
    actor: {type: Object, default: null},
    actors: {type: Array, default: () => []},
    target: {type: Object, required: true},
    palette: {type: Object, required: true},
    blame: {type: Object, default: null},
  },
  data() {
    // `onion` lives here rather than in the sprite editor because the
    // editor is re-created whenever the frame changes, and a toggle that
    // resets itself every time you pick a frame is worse than no toggle.
    return {tab: 0, animIndex: 0, frameIndex: 0, event: null, onion: true};
  },
  computed: {
    groups() {
      return GROUPS;
    },
    sizes() {
      return ACTOR_SIZES.map(([w, h]) => ({text: `${w}x${h}`, value: `${w}x${h}`}));
    },
    size: {
      get() {
        return `${this.actor.width}x${this.actor.height}`;
      },
      set(v) {
        const [w, h] = v.split('x').map(Number);
        this.actor.width = w;
        this.actor.height = h;
        // Resizing has to reshape existing art rather than silently leaving
        // frames the wrong size for the renderer.
        this.actor.animations.forEach((a) => a.frames.forEach((f) => {
          f.pixels = Array.from({length: h}, (_, y) =>
            Array.from({length: w}, (_, x) => (f.pixels[y] && f.pixels[y][x]) | 0));
        }));
      },
    },
    anim() {
      return this.actor.animations[this.animIndex] || null;
    },
    frame() {
      return this.anim ? this.anim.frames[this.frameIndex] || null : null;
    },
    prevFrame() {
      return this.anim && this.frameIndex > 0 ?
        this.anim.frames[this.frameIndex - 1] : null;
    },
    spriteDefs() {
      const per = this.actor.width >= 16 ? 2 : 1;
      return this.actor.animations.reduce((n, a) => n + a.frames.length * per, 0);
    },
    hwSprites() {
      return this.actor.max * (this.actor.width >= 16 ? 2 : 1);
    },
    ramBytes() {
      return this.actor.max * this.target.poolArrays.length;
    },
    fieldsUsed() {
      return (this.actor.fields || []).reduce((n, f) => n + (f.width === 16 ? 2 : 1), 0);
    },
    fieldsFull() {
      return this.fieldsUsed >= this.target.userFields;
    },
    actorItems() {
      return this.actors.map((a) => ({text: a.name, value: a.id}));
    },
    behaviourItems() {
      return Object.entries(BEHAVIOURS).map(([k, v]) => ({text: v.label, value: k}));
    },
    eventList() {
      const base = EVENTS.filter((e) => !e.perGroup)
          .map((e) => ({id: e.id, label: e.label}));
      const collides = Object.keys(this.actor.scripts || {})
          .filter((k) => k.startsWith('collide:'))
          .map((k) => ({id: k, label: `on collide with ${k.slice(8)}`}));
      return [...base, ...collides];
    },
    addableEvents() {
      return GROUPS
          .filter((g) => !(this.actor.scripts || {})[`collide:${g}`])
          .map((g) => ({text: `on collide with ${g}`, value: `collide:${g}`}));
    },
    script() {
      if (!this.actor.scripts) this.$set(this.actor, 'scripts', {});
      if (!this.actor.scripts[this.event]) {
        this.$set(this.actor.scripts, this.event, {xml: '', stmts: []});
      }
      return this.actor.scripts[this.event];
    },
  },
  watch: {
    actor() {
      this.animIndex = 0;
      this.frameIndex = 0;
      this.event = 'update';
    },
  },
  created() {
    this.event = 'update';
  },
  methods: {
    behaviourLabel(kind) {
      return BEHAVIOURS[kind]?.label || kind;
    },
    behaviourParams(kind) {
      const spec = BEHAVIOURS[kind];
      if (!spec) return {};
      if (kind === 'health') {
        return {field: {type: 'choice', label: 'Field to watch',
          options: (this.actor.fields || []).map((f) => f.name)}};
      }
      return spec.params;
    },
    addBehaviour(kind) {
      if (!kind) return;
      this.actor.behaviours.push({kind, ...(BEHAVIOURS[kind].defaults || {})});
      this.$emit('changed');
    },
    addAnim() {
      this.$emit('add-animation');
      this.animIndex = this.actor.animations.length - 1;
      this.frameIndex = 0;
    },
    addFrameHere() {
      this.$emit('add-frame', this.anim);
      this.frameIndex = this.anim.frames.length - 1;
    },
    addEvent(id) {
      if (!id) return;
      this.$set(this.actor.scripts, id, {xml: '', stmts: []});
      this.event = id;
    },
    hasScript(id) {
      const s = (this.actor.scripts || {})[id];
      return !!(s && s.stmts && s.stmts.length);
    },
    eventLabel(id) {
      return this.eventList.find((e) => e.id === id)?.label || id;
    },
    blameFor() {
      return this.blame?.blockId || null;
    },
  },
};
</script>

<style scoped>
.actor-editor { display: flex; flex-direction: column; height: 100%; }
.header { display: flex; gap: 14px; align-items: center; flex-wrap: wrap; padding: 4px 0 8px; }
.costs {
  font-size: 12px; opacity: .75; padding: 6px 10px; margin-bottom: 8px;
  background: rgba(255,255,255,.04); border-radius: 4px;
}
.pane { flex: 1; overflow: auto; padding-top: 10px; }
.anim-bar, .event-bar { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
.anim-body { display: flex; gap: 20px; align-items: flex-start; }
.anim-props { width: 200px; }
.frames { margin-top: 12px; }
.hitbox-row, .field-row { display: flex; gap: 12px; align-items: center; max-width: 620px; margin-bottom: 8px; }
.behaviour {
  display: flex; gap: 12px; align-items: center; flex-wrap: wrap;
  padding: 8px 10px; margin-bottom: 8px;
  background: rgba(255,255,255,.04); border-radius: 4px;
}
.bname { width: 150px; font-weight: 600; font-size: 13px; }
.bparams { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; flex: 1; }
.note { font-size: 12px; opacity: .65; max-width: 640px; line-height: 1.5; }
.budget-line { font-size: 12px; opacity: .7; margin-left: 12px; }
</style>
