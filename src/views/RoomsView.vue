<template>
  <div class="rooms">
    <div class="list">
      <div
        v-for="r in project.rooms"
        :key="r.id"
        class="item"
        :class="{sel: r.id === selectedRoom}"
        @click="selectedRoom = r.id"
      >{{ r.name }}</div>
      <v-btn small text block @click="addRoom()">+ room</v-btn>
      <v-btn
        v-if="project.rooms.length > 1"
        small
        text
        block
        color="error"
        @click="removeRoom(selectedRoom)"
      >delete</v-btn>
    </div>

    <div v-if="room" class="editor">
      <div class="head">
        <v-text-field
          v-model="room.name"
          dense
          hide-details
          label="Name"
          style="max-width:180px"
        />
        <v-btn-toggle v-model="mode" dense mandatory>
          <v-btn small value="place">Place actors</v-btn>
          <v-btn small value="paint">Paint tiles</v-btn>
        </v-btn-toggle>
        <v-btn
          v-if="mode === 'place'"
          x-small
          text
          @click="clearPlacements"
        >Clear actors</v-btn>
        <v-btn
          v-else
          x-small
          text
          @click="clearTiles"
        >Clear tiles</v-btn>
      </div>

      <div class="work">
        <RoomCanvas
          :room="room"
          :tiles="project.tiles"
          :actors="project.actors"
          :mode="mode"
          :paint-tile="activeTile"
          :place-actor="activeActor"
          :cols="target.screenCols"
          :rows="target.screenRows"
          :bg-palette="project.palette.background"
          :sprite-palette="project.palette.sprite"
          @changed="$emit('changed')"
        />

        <div class="side">
          <!-- what to paint -->
          <template v-if="mode === 'paint'">
            <p v-if="!tilesSupported" class="warn">
              {{ target.label }} cannot show painted tiles yet, so a room with
              tiles will not build for it. Switch the target to the Master
              System to use them.
            </p>
            <TilePalette
              :tiles="project.tiles"
              :selected="activeTile"
              :palette="project.palette.background"
              @select="paintTile = $event"
              @add="addTileFrom"
              @remove="deleteTile"
              @changed="$emit('changed')"
            />
            <div v-if="activeTile > 0 && project.tiles[activeTile]" class="tile-edit">
              <h5>Draw tile {{ activeTile }}</h5>
              <SpriteEditor
                :key="`tile-${activeTile}`"
                kind="tile"
                :frame="project.tiles[activeTile]"
                :previous="null"
                :onion="false"
                :target="target"
                :palette="project.palette.background"
                :zoom="18"
                @changed="$emit('changed')"
              />
            </div>
          </template>

          <!-- what to place -->
          <template v-else>
            <p v-if="!project.actors.length" class="warn">
              There are no actor types yet. Create one in the Actors tab, then
              come back here to place it.
            </p>
            <div v-else class="actor-pick">
              <div
                v-for="a in project.actors"
                :key="a.id"
                class="pick"
                :class="{sel: a.id === activeActor}"
                @click="placeActor = a.id"
              >
                <span class="nm">{{ a.name }}</span>
                <span class="meta">
                  {{ countFor(a.id) }}/{{ a.max }}
                  <template v-if="a.isPlayer">&middot; player</template>
                </span>
              </div>
              <p class="note">
                A placement uses one of that actor's slots when the room
                starts, so you can place up to its Max instances.
              </p>
            </div>
          </template>
        </div>
      </div>

      <p class="note">
        Terrain is tiles, never actors. A wall built out of actors would cost
        a pool slot each and turn floor collision into a pairwise search;
        painted tiles are a single lookup per entity per axis, which is what
        makes a platformer affordable at all.
      </p>

      <h4>When this room starts</h4>
      <BlocklyWorkspace
        :key="room.id"
        :script="enterScript"
        scope="room"
        title="on enter"
        @changed="$emit('changed')"
      />
    </div>
  </div>
</template>

<script>
/**
 * Room editor.
 *
 * A room is a tilemap plus a set of placed instances plus an `on enter`
 * script. The work is split three ways: RoomCanvas does the painting and
 * placing, TilePalette chooses and labels tiles, and the pixel editor draws
 * them. This view only decides what is selected - and that is where the
 * first version went wrong.
 *
 * It picked the actor to place once, when the tab first mounted. Open Rooms
 * before creating any actor - the natural way to explore - and the choice
 * was null forever, every click was silently ignored, and nothing said why.
 * The selected actor and tile are now derived: whatever was chosen if it
 * still exists, otherwise the first one available.
 */
import BlocklyWorkspace from '../components/BlocklyWorkspace.vue';
import RoomCanvas from '../components/RoomCanvas.vue';
import TilePalette from '../components/TilePalette.vue';
import SpriteEditor from '../components/SpriteEditor.vue';
import {
  project, selectedRoom, currentRoom, addRoom, removeRoom, scriptFor,
  addTile, removeTile,
} from '../hooks/project.js';
import {TARGETS} from '../ir/schema.js';

export default {
  name: 'RoomsView',
  components: {BlocklyWorkspace, RoomCanvas, TilePalette, SpriteEditor},
  data() {
    return {mode: 'place', placeActor: null, paintTile: 1};
  },
  computed: {
    project: () => project.value,
    selectedRoom: {
      get: () => selectedRoom.value,
      set: (v) => {
        selectedRoom.value = v;
      },
    },
    room() {
      return currentRoom.value;
    },
    target() {
      return TARGETS[project.value.target] || TARGETS.sms;
    },
    tilesSupported() {
      return this.target.video === 'sms';
    },
    /** The chosen actor if it still exists, else the first one. */
    activeActor() {
      const actors = project.value.actors;
      if (actors.some((a) => a.id === this.placeActor)) return this.placeActor;
      return actors.length ? actors[0].id : null;
    },
    /** The chosen tile if it still exists, else the first solid-ish one. */
    activeTile() {
      const n = project.value.tiles.length;
      if (this.paintTile >= 0 && this.paintTile < n) return this.paintTile;
      return n > 1 ? 1 : 0;
    },
    enterScript() {
      return scriptFor(this.room, 'enter');
    },
  },
  methods: {
    addRoom, removeRoom,
    countFor(id) {
      return (this.room.placements || []).filter((p) => p.actor === id).length;
    },
    addTileFrom(from) {
      this.paintTile = addTile(from);
      this.$emit('changed');
    },
    deleteTile(index) {
      if (removeTile(index)) {
        this.paintTile = Math.min(index, project.value.tiles.length - 1);
        this.$emit('changed');
      }
    },
    clearPlacements() {
      this.room.placements.splice(0);
      this.$emit('changed');
    },
    clearTiles() {
      // Back to "no tilemap", so the room costs nothing for terrain.
      this.room.tiles = null;
      this.$emit('changed');
    },
  },
};
</script>

<style scoped>
.rooms { display: flex; gap: 14px; }
.list { width: 150px; flex-shrink: 0; }
.item { padding: 6px 8px; border-radius: 4px; cursor: pointer; font-size: 13px; }
.item:hover { background: rgba(255,255,255,.05); }
.item.sel { background: rgba(87,184,148,.16); }
.editor { flex: 1; min-width: 0; }
.head { display: flex; gap: 14px; align-items: center; margin-bottom: 10px; flex-wrap: wrap; }
.work { display: flex; gap: 16px; align-items: flex-start; flex-wrap: wrap; }
.side { width: 360px; flex-shrink: 0; }
.tile-edit { margin-top: 12px; }
.tile-edit h5 { margin-bottom: 6px; }
.actor-pick .pick {
  display: flex; justify-content: space-between; padding: 6px 8px;
  border-radius: 4px; cursor: pointer; font-size: 13px;
}
.actor-pick .pick:hover { background: rgba(255,255,255,.05); }
.actor-pick .pick.sel { background: rgba(87,184,148,.16); }
.meta { opacity: .55; font-size: 11px; }
.warn {
  font-size: 12px; padding: 8px; border-radius: 4px;
  background: rgba(216,169,74,.12); line-height: 1.45;
}
.note { font-size: 12px; opacity: .6; max-width: 640px; line-height: 1.5; margin-top: 8px; }
h4 { margin-top: 14px; }
</style>
