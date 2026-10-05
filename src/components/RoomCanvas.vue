<template>
  <div class="room-canvas-wrap">
    <canvas
      ref="canvas"
      class="room-canvas"
      :class="mode"
      :width="cols * cell"
      :height="rows * cell"
      @mousedown.prevent="down"
      @mousemove="move"
      @mouseup="up"
      @mouseleave="leave"
      @contextmenu.prevent
    />
    <div class="status">
      <template v-if="hover">
        column {{ hover.cx }}, row {{ hover.cy }}
        &middot; x {{ hover.cx * 8 }}, y {{ hover.cy * 8 }}
      </template>
      <template v-else>{{ hint }}</template>
    </div>
  </div>
</template>

<script>
/**
 * The room canvas.
 *
 * Paint mode: hold the left button and drag to paint the selected tile,
 * hold the right button and drag to erase. Place mode: click to place the
 * selected actor, right-click an actor to remove it.
 *
 * The first version only listened for `click`, so painting a floor meant
 * clicking thirty-two times, and it drew every tile as a flat grey square.
 * This one draws the real tile art and the actors' first frames, so what is
 * on the canvas is what will be on the screen.
 *
 * Deliberately has no imports - it is mounted and driven directly by the
 * render tests, which is how the dragging is checked without a browser.
 * Like the other editors it changes the room it is handed rather than
 * emitting every cell upward; it emits `changed` once per stroke, so the
 * budget meter and autosave are not woken thirty times by one drag.
 */
export default {
  name: 'RoomCanvas',
  props: {
    room: {type: Object, required: true},
    tiles: {type: Array, default: () => []},
    actors: {type: Array, default: () => []},
    mode: {type: String, default: 'paint'},
    paintTile: {type: Number, default: 1},
    placeActor: {type: String, default: null},
    cols: {type: Number, default: 32},
    rows: {type: Number, default: 24},
    cell: {type: Number, default: 16},
    bgPalette: {type: Array, default: () => []},
    spritePalette: {type: Array, default: () => []},
  },
  data() {
    return {stroke: null, last: null, hover: null, dirty: false};
  },
  computed: {
    hint() {
      if (this.mode === 'paint') {
        return 'Drag to paint · right-drag to erase';
      }
      if (!this.placeActor) {
        return 'Create an actor type in the Actors tab to place it here';
      }
      return 'Click to place · right-click an actor to remove it';
    },
  },
  watch: {
    'room': 'redraw',
    'tiles': {handler: 'redraw', deep: true},
    'actors': {handler: 'redraw', deep: true},
    'room.placements': {handler: 'redraw', deep: true},
    'room.tiles': {handler: 'redraw', deep: true},
  },
  mounted() {
    // A stroke that ends outside the canvas still has to end.
    window.addEventListener('mouseup', this.up);
    this.redraw();
  },
  beforeDestroy() {
    window.removeEventListener('mouseup', this.up);
  },
  methods: {
    cellAt(ev) {
      const r = this.$refs.canvas.getBoundingClientRect();
      const cx = Math.floor((ev.clientX - r.left) / this.cell);
      const cy = Math.floor((ev.clientY - r.top) / this.cell);
      if (cx < 0 || cy < 0 || cx >= this.cols || cy >= this.rows) return null;
      return {cx, cy};
    },

    down(ev) {
      const at = this.cellAt(ev);
      if (!at) return;
      const erase = ev.button === 2;
      if (this.mode === 'paint') {
        this.stroke = erase ? 'erase' : 'paint';
        this.last = null;
        this.applyStroke(at);
      } else if (erase) {
        this.removeAt(at);
      } else {
        this.placeAt(at);
      }
    },

    move(ev) {
      const at = this.cellAt(ev);
      this.hover = at;
      if (this.stroke && at) this.applyStroke(at);
      else this.redraw();
    },

    up() {
      if (!this.stroke) return;
      this.stroke = null;
      this.last = null;
      if (this.dirty) {
        this.dirty = false;
        this.$emit('changed');
      }
    },

    leave() {
      this.hover = null;
      this.redraw();
    },

    /** Paint or erase one cell, skipping repeats within the same stroke. */
    applyStroke(at) {
      if (this.last && this.last.cx === at.cx && this.last.cy === at.cy) return;
      this.last = at;
      const value = this.stroke === 'erase' ? 0 : this.paintTile;
      this.ensureTiles();
      if (this.room.tiles[at.cy][at.cx] !== value) {
        this.$set(this.room.tiles[at.cy], at.cx, value);
        this.dirty = true;
      }
      this.redraw();
    },

    ensureTiles() {
      if (this.room.tiles) return;
      this.$set(this.room, 'tiles',
          Array.from({length: this.rows}, () => new Array(this.cols).fill(0)));
    },

    placeAt(at) {
      if (!this.placeActor) return;
      // Placed on the 8-pixel grid the hardware actually uses, with the
      // clicked cell as the actor's top-left corner.
      this.room.placements.push({actor: this.placeActor, x: at.cx * 8, y: at.cy * 8});
      this.$emit('changed');
      this.redraw();
    },

    /** Remove the topmost placement under the cursor. */
    removeAt(at) {
      const px = at.cx * 8 + 4;
      const py = at.cy * 8 + 4;
      const list = this.room.placements || [];
      for (let i = list.length - 1; i >= 0; i--) {
        const p = list[i];
        const a = this.actors.find((x) => x.id === p.actor);
        const w = a ? a.width : 16;
        const h = a ? a.height : 16;
        if (px >= p.x && px < p.x + w && py >= p.y && py < p.y + h) {
          list.splice(i, 1);
          this.$emit('changed');
          this.redraw();
          return;
        }
      }
    },

    /* ---- drawing -------------------------------------------------- */

    rgb(v) {
      const n = v | 0;
      return `rgb(${(n & 3) * 85},${((n >> 2) & 3) * 85},${((n >> 4) & 3) * 85})`;
    },

    redraw() {
      this.$nextTick(() => {
        const canvas = this.$refs.canvas;
        const ctx = canvas && canvas.getContext && canvas.getContext('2d');
        if (!ctx) return;
        const c = this.cell;
        const px = c / 8;

        ctx.fillStyle = this.rgb(this.bgPalette[0] || 0);
        ctx.fillRect(0, 0, this.cols * c, this.rows * c);

        const grid = this.room.tiles;
        for (let y = 0; y < this.rows; y++) {
          for (let x = 0; x < this.cols; x++) {
            const t = grid && grid[y] ? grid[y][x] | 0 : 0;
            const def = this.tiles[t];
            if (!def) {
              // A cell pointing past the tile set: make it obvious.
              ctx.fillStyle = '#c0306a';
              ctx.fillRect(x * c, y * c, c, c);
              continue;
            }
            this.drawPixels(ctx, def.pixels, x * c, y * c, px, this.bgPalette, false);
          }
        }

        ctx.strokeStyle = 'rgba(255,255,255,.06)';
        ctx.lineWidth = 1;
        for (let x = 0; x <= this.cols; x++) this.line(ctx, x * c, 0, x * c, this.rows * c);
        for (let y = 0; y <= this.rows; y++) this.line(ctx, 0, y * c, this.cols * c, y * c);

        (this.room.placements || []).forEach((p) => {
          const a = this.actors.find((x) => x.id === p.actor);
          if (!a) return;
          const frame = a.animations && a.animations[0] && a.animations[0].frames[0];
          const ox = (p.x / 8) * c;
          const oy = (p.y / 8) * c;
          if (frame) this.drawPixels(ctx, frame.pixels, ox, oy, px, this.spritePalette, true);
          ctx.strokeStyle = a.isPlayer ? 'rgba(87,184,148,.9)' : 'rgba(120,160,230,.7)';
          ctx.strokeRect(ox + 0.5, oy + 0.5, (a.width / 8) * c - 1, (a.height / 8) * c - 1);
        });

        if (this.hover) {
          ctx.strokeStyle = 'rgba(255,255,255,.7)';
          const w = this.mode === 'place' ? this.placeSize().w : c;
          const h = this.mode === 'place' ? this.placeSize().h : c;
          ctx.strokeRect(this.hover.cx * c + 0.5, this.hover.cy * c + 0.5, w - 1, h - 1);
        }
      });
    },

    placeSize() {
      const a = this.actors.find((x) => x.id === this.placeActor);
      const c = this.cell;
      return {w: a ? (a.width / 8) * c : c * 2, h: a ? (a.height / 8) * c : c * 2};
    },

    /** Background colour 0 is opaque; sprite colour 0 is transparent. */
    drawPixels(ctx, pixels, ox, oy, px, palette, transparentZero) {
      (pixels || []).forEach((row, y) => (row || []).forEach((v, x) => {
        if (!v && transparentZero) return;
        ctx.fillStyle = this.rgb(palette[v | 0] || 0);
        ctx.fillRect(ox + x * px, oy + y * px, px, px);
      }));
    },

    line(ctx, x1, y1, x2, y2) {
      ctx.beginPath();
      ctx.moveTo(x1 + 0.5, y1 + 0.5);
      ctx.lineTo(x2 + 0.5, y2 + 0.5);
      ctx.stroke();
    },
  },
};
</script>

<style scoped>
.room-canvas { border-radius: 4px; image-rendering: pixelated; display: block; }
.room-canvas.paint { cursor: crosshair; }
.room-canvas.place { cursor: copy; }
.status { font-size: 11px; opacity: .6; margin-top: 4px; min-height: 16px; }
</style>
