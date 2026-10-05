<template>
  <div class="actors">
    <div class="list">
      <div
        v-for="a in project.actors"
        :key="a.id"
        class="item"
        :class="{sel: a.id === selectedActor}"
        @click="selectedActor = a.id"
      >
        <span class="nm">{{ a.name }}</span>
        <span class="meta">{{ a.group }} · {{ a.max }}</span>
        <v-icon v-if="a.isPlayer" x-small class="star">mdi-star</v-icon>
      </div>
      <v-btn small text block @click="addActor()">+ actor type</v-btn>
      <v-btn
        v-if="currentActor"
        small
        text
        block
        color="error"
        @click="removeActor(selectedActor)"
      >delete</v-btn>
    </div>

    <div class="editor">
      <ActorEditor
        v-if="currentActor"
        :key="currentActor.id"
        :actor="currentActor"
        :actors="project.actors"
        :target="target"
        :palette="project.palette"
        :blame="blame"
        @changed="$emit('changed')"
        @set-player="setPlayer"
        @add-field="addField(currentActor)"
        @add-animation="addAnimation(currentActor)"
        @add-frame="(anim) => addFrame(currentActor, anim)"
      />
      <!--
        The empty state matters: this is the screen a brand new user lands
        on, and it is the one chance to explain the single idea the whole
        tool rests on.
      -->
      <div v-else class="empty">
        <h3>Author kinds of thing, not individual things.</h3>
        <p>
          An <b>actor type</b> is a kind of thing in your game — a ship, a
          bug, a bullet. You draw it once, give it behaviours once, and say
          how many can exist at a time. The game creates and destroys the
          individual copies for you.
        </p>
        <p>
          You never name an individual copy. Scripts are written from the
          point of view of one of them, so blocks say <i>set my x</i> rather
          than naming anything, and collisions are declared between
          <b>groups</b> — <i>enemy</i>, <i>player_shot</i> — not between
          individuals.
        </p>
        <v-btn color="primary" depressed @click="addActor()">
          Create the first actor type
        </v-btn>
      </div>
    </div>
  </div>
</template>

<script>
import ActorEditor from '../components/ActorEditor.vue';
import {
  project, selectedActor, currentActor, addActor, removeActor, setPlayer,
  addField, addAnimation, addFrame,
} from '../hooks/project.js';
import {TARGETS} from '../ir/schema.js';
import {computed} from '@vue/composition-api';

export default {
  name: 'ActorsView',
  components: {ActorEditor},
  props: {blame: {type: Object, default: null}},
  setup() {
    return {
      project, selectedActor, currentActor,
      addActor, removeActor, setPlayer, addField, addAnimation, addFrame,
      target: computed(() => TARGETS[project.value.target] || TARGETS.sms),
    };
  },
};
</script>

<style scoped>
.actors { display: flex; gap: 14px; height: 100%; }
.list { width: 190px; flex-shrink: 0; }
.item {
  padding: 6px 8px; border-radius: 4px; cursor: pointer;
  display: flex; align-items: center; gap: 6px;
}
.item:hover { background: rgba(255,255,255,.05); }
.item.sel { background: rgba(87,184,148,.16); }
.nm { flex: 1; font-size: 13px; }
.meta { font-size: 11px; opacity: .5; }
.star { opacity: .8; }
.editor { flex: 1; min-width: 0; }
.empty { max-width: 520px; padding: 40px 10px; opacity: .9; line-height: 1.6; }
.empty h3 { margin-bottom: 14px; }
.empty p { margin-bottom: 14px; font-size: 14px; opacity: .8; }
</style>
