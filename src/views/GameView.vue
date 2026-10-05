<template>
  <div class="game-view">
    <section>
      <h4>Globals</h4>
      <p class="note">
        Score, lives, level. These are a handful of bytes, not per-instance,
        so there is no tight budget here — unlike an actor's fields.
        Whether a global is 8- or 16-bit is decided for you and applied
        consistently, so you never meet CVBasic's <code>score</code> versus
        <code>#score</code> distinction.
      </p>
      <div v-for="(g, i) in project.globals" :key="i" class="row">
        <v-text-field v-model="g.name" dense hide-details label="Name" />
        <v-select
          v-model.number="g.width"
          :items="[{text: '0-255', value: 8}, {text: 'large', value: 16}]"
          dense
          hide-details
          label="Range"
        />
        <v-text-field
          v-model.number="g.initial"
          type="number"
          dense
          hide-details
          label="Starts at"
        />
        <v-btn icon small @click="project.globals.splice(i, 1)">
          <v-icon small>mdi-close</v-icon>
        </v-btn>
      </div>
      <v-btn x-small text @click="addGlobal">+ global</v-btn>
    </section>

    <section>
      <h4>When the game starts</h4>
      <BlocklyWorkspace
        :script="script('gameStart')"
        scope="global"
        title="on game start"
        @changed="$emit('changed')"
      />
    </section>

    <section>
      <h4>Every frame</h4>
      <p class="note">
        The HUD and room flow live here. This runs after everything else has
        moved and drawn, so anything it prints is this frame's value.
      </p>
      <BlocklyWorkspace
        :script="script('frame')"
        scope="global"
        title="on frame"
        @changed="$emit('changed')"
      />
    </section>
  </div>
</template>

<script>
import BlocklyWorkspace from '../components/BlocklyWorkspace.vue';
import {project, scriptFor} from '../hooks/project.js';

export default {
  name: 'GameView',
  components: {BlocklyWorkspace},
  props: {gen: {type: Object, required: true}},
  setup() {
    return {
      project,
      script: (name) => scriptFor(project.value, name),
      addGlobal: () => project.value.globals.push(
          {name: `value${project.value.globals.length}`, width: 8, initial: 0}),
    };
  },
};
</script>

<style scoped>
.game-view section { margin-bottom: 26px; }
h4 { margin-bottom: 6px; }
.note { font-size: 12px; opacity: .65; line-height: 1.5; max-width: 700px; margin-bottom: 10px; }
.row { display: flex; gap: 12px; align-items: center; max-width: 620px; margin-bottom: 8px; }
</style>
