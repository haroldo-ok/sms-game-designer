<template>
  <div class="tile-palette">
    <div class="tiles">
      <button
        v-for="(t, i) in tiles"
        :key="i"
        class="tile"
        :class="{sel: i === selected}"
        :title="`${i}: ${t.name || 'tile'}`"
        @click="$emit('select', i)"
      >
        <canvas
          :ref="`t${i}`"
          width="24"
          height="24"
        />
        <span class="idx">{{ i }}</span>
      </button>
    </div>

    <div class="actions">
      <v-btn x-small text @click="$emit('add', selected)">Duplicate</v-btn>
      <v-btn x-small text @click="$emit('add', null)">New blank</v-btn>
      <v-btn
        x-small
        text
        color="error"
        :disabled="selected === 0"
        @click="$emit('remove', selected)"
      >Delete</v-btn>
    </div>

    <div v-if="current" class="props">
      <label class="name">
        Name
        <input v-model="current.name" type="text" :disabled="selected === 0">
      </label>

      <!--
        Tile 0 is what every unpainted cell holds. Making it solid would
        make the whole room solid, so its attributes are locked.
      -->
      <div class="attrs" :class="{locked: selected === 0}">
        <label
          v-for="a in attrs"
          :key="a.key"
          :title="a.tip"
        >
          <input
            type="checkbox"
            :checked="(current.attr & a.bit) !== 0"
            :disabled="selected === 0"
            @change="toggle(a.bit, $event.target.checked)"
          >
          {{ a.label }}
        </label>
      </div>
      <p v-if="selected === 0" class="note">
        Tile 0 is the empty cell every room starts filled with. You can redraw
        it as a backdrop, but it is always walk-through.
      </p>
      <p v-else class="note">
        Solid is what Platform and Patrol obey. The others are flags your own
        scripts can test with "tile below me is&hellip;".
      </p>
    </div>
  </div>
</template>

<script>
/**
 * The tile set for the room editor.
 *
 * A tile is 8x8 pixels in the background palette plus a byte of attribute
 * flags. The flags are what turn a picture into terrain: the code generator
 * copies them into a RAM shadow of the room, and collision reads that one
 * byte per cell instead of looking at the art. So "solid" here is the
 * difference between a wall and a painting of a wall.
 *
 * Deleting is emitted rather than done here, because removing a tile shifts
 * every later index down by one and every room has to be remapped to match -
 * which is the store's job, not a palette's.
 */
export default {
  name: 'TilePalette',
  props: {
    tiles: {type: Array, required: true},
    selected: {type: Number, default: 1},
    palette: {type: Array, default: () => []},
  },
  data() {
    return {
      attrs: [
        {key: 'solid', bit: 1, label: 'Solid',
          tip: 'Actors stand on it and cannot walk through it.'},
        {key: 'hazard', bit: 2, label: 'Hazard',
          tip: 'Test it with "tile below me is hazard".'},
        {key: 'ladder', bit: 4, label: 'Ladder',
          tip: 'A flag for your scripts to test.'},
        {key: 'breakable', bit: 8, label: 'Breakable',
          tip: 'A flag for your scripts to test.'},
        {key: 'platform', bit: 16, label: 'Platform',
          tip: 'A flag for your scripts to test.'},
      ],
    };
  },
  computed: {
    current() {
      return this.tiles[this.selected] || null;
    },
  },
  watch: {
    tiles: {handler: 'drawAll', deep: true},
    palette: 'drawAll',
  },
  mounted() {
    this.drawAll();
  },
  methods: {
    toggle(bit, on) {
      if (!this.current || this.selected === 0) return;
      this.current.attr = on ? (this.current.attr | bit) : (this.current.attr & ~bit);
      this.$emit('changed');
    },
    rgb(v) {
      const n = v | 0;
      return `rgb(${(n & 3) * 85},${((n >> 2) & 3) * 85},${((n >> 4) & 3) * 85})`;
    },
    drawAll() {
      this.$nextTick(() => {
        this.tiles.forEach((t, i) => {
          const ref = this.$refs[`t${i}`];
          const canvas = Array.isArray(ref) ? ref[0] : ref;
          const ctx = canvas && canvas.getContext && canvas.getContext('2d');
          if (!ctx) return;
          (t.pixels || []).forEach((row, y) => (row || []).forEach((v, x) => {
            ctx.fillStyle = this.rgb(this.palette[v | 0] || 0);
            ctx.fillRect(x * 3, y * 3, 3, 3);
          }));
        });
      });
    },
  },
};
</script>

<style scoped>
.tiles { display: flex; flex-wrap: wrap; gap: 4px; }
.tile {
  position: relative; padding: 2px; border-radius: 3px;
  border: 2px solid transparent; background: rgba(255,255,255,.04);
  cursor: pointer; line-height: 0;
}
.tile.sel { border-color: #57b894; }
.tile canvas { image-rendering: pixelated; }
.idx {
  position: absolute; right: 2px; bottom: 1px; font-size: 9px; line-height: 1;
  opacity: .7; text-shadow: 0 0 2px #000;
}
.actions { margin: 6px 0; }
.props { font-size: 12px; }
.name { display: block; margin-bottom: 6px; }
.name input {
  margin-left: 6px; width: 110px; background: rgba(255,255,255,.06);
  color: inherit; border: 0; border-radius: 3px; padding: 2px 4px;
}
.attrs { display: flex; flex-wrap: wrap; gap: 4px 12px; }
.attrs.locked { opacity: .5; }
.attrs label { cursor: pointer; white-space: nowrap; }
.note { opacity: .6; margin-top: 6px; line-height: 1.4; }
</style>
