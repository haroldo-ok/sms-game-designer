<template>
  <div class="sprite-editor">
    <div class="canvas-col">
      <canvas
        ref="canvas"
        class="grid"
        :width="cols * zoom"
        :height="rows * zoom"
        @mousedown="startDraw"
        @mousemove="drag"
        @mouseup="endDraw"
        @mouseleave="endDraw"
        @contextmenu.prevent="pickUnderCursor"
      />
      <div class="hint">
        Left to paint, right to pick.
        {{ kind === 'tile' ? '' : 'Colour 0 is transparent.' }}
      </div>
    </div>

    <div class="side">
      <div class="palette">
        <button
          v-for="(c, i) in palette"
          :key="i"
          class="swatch"
          :class="{sel: i === colour, transparent: i === 0 && kind !== 'tile'}"
          :style="{background: css(c)}"
          :title="`Colour ${i}`"
          @click="colour = i"
        />
      </div>

      <div class="row">
        <v-btn x-small text @click="$emit('onion', !onion)">
          {{ onion ? 'Hide' : 'Show' }} previous frame
        </v-btn>
        <v-btn x-small text @click="flipH">Flip</v-btn>
        <v-btn x-small text @click="clearFrame">Clear</v-btn>
      </div>

      <div class="note">
        <template v-if="kind === 'tile'">
          Background tiles use the background palette. Colour 0 is a real
          colour here, not transparency - it is the backdrop.
        </template>
        <template v-else>
          {{ target.perPixelSpriteColour
            ? 'Every pixel can use any of the 16 sprite palette colours.'
            : 'This target gives one colour per sprite; pick it below and the '
              + 'editor will show a monochrome preview.' }}
        </template>
      </div>
    </div>
  </div>
</template>

<script>
/**
 * Frame editor, drawing in the target's colour model rather than in RGB.
 *
 * This matters more than it sounds. On the SMS a sprite pixel picks from a
 * 16-entry palette whose entries are 6-bit 00BBGGRR values, and entry 0 is
 * transparent. On a TMS9918 machine a whole 16x16 sprite has one colour. If
 * the editor lets people paint in free RGB, they get ambushed at export -
 * so it enforces the real model from the first pixel and shows a monochrome
 * preview on the targets that need one.
 */
export default {
  name: 'SpriteEditor',
  props: {
    frame: {type: Object, required: true},
    previous: {type: Object, default: null},
    target: {type: Object, required: true},
    palette: {type: Array, required: true},
    zoom: {type: Number, default: 18},
    onion: {type: Boolean, default: true},
    // 'sprite' or 'tile'. Background tiles have no transparent colour - on
    // the SMS, background colour 0 is drawn like any other - and they are
    // never flattened to one colour, so both differ from sprites.
    kind: {type: String, default: 'sprite'},
  },
  data() {
    return {colour: 1, painting: false, erasing: false};
  },
  computed: {
    rows() {
      return this.frame.pixels.length;
    },
    cols() {
      return this.frame.pixels[0] ? this.frame.pixels[0].length : 0;
    },
  },
  watch: {
    frame: {handler: 'redraw', deep: true},
    previous: 'redraw',
    onion: 'redraw',
  },
  mounted() {
    this.redraw();
  },
  methods: {
    /** 6-bit 00BBGGRR -> CSS. Each channel is two bits, so 0..3 -> 0..255. */
    css(v) {
      const r = (v & 3) * 85;
      const g = ((v >> 2) & 3) * 85;
      const b = ((v >> 4) & 3) * 85;
      return `rgb(${r},${g},${b})`;
    },
    redraw() {
      const ctx = this.$refs.canvas?.getContext('2d');
      if (!ctx) return;
      const z = this.zoom;
      ctx.clearRect(0, 0, this.cols * z, this.rows * z);

      // Checkerboard under transparent pixels, so "transparent" reads as
      // transparent rather than as black.
      for (let y = 0; y < this.rows; y++) {
        for (let x = 0; x < this.cols; x++) {
          ctx.fillStyle = (x + y) % 2 ? '#24262b' : '#2c2f35';
          ctx.fillRect(x * z, y * z, z, z);
        }
      }

      if (this.onion && this.previous) {
        ctx.globalAlpha = 0.3;
        this.paintPixels(ctx, this.previous.pixels);
        ctx.globalAlpha = 1;
      }
      this.paintPixels(ctx, this.frame.pixels);

      // 8x8 guides: actors snap to 8-pixel blocks and a hardware sprite is
      // 8 wide, so the block boundaries are real, not decoration.
      ctx.strokeStyle = 'rgba(255,255,255,.07)';
      for (let x = 0; x <= this.cols; x++) {
        ctx.lineWidth = x % 8 === 0 ? 1.5 : 0.5;
        ctx.strokeStyle = x % 8 === 0 ? 'rgba(255,255,255,.28)' : 'rgba(255,255,255,.07)';
        line(ctx, x * z, 0, x * z, this.rows * z);
      }
      for (let y = 0; y <= this.rows; y++) {
        ctx.lineWidth = y % 8 === 0 ? 1.5 : 0.5;
        ctx.strokeStyle = y % 8 === 0 ? 'rgba(255,255,255,.28)' : 'rgba(255,255,255,.07)';
        line(ctx, 0, y * z, this.cols * z, y * z);
      }
    },
    paintPixels(ctx, pixels) {
      const z = this.zoom;
      const tile = this.kind === 'tile';
      const mono = !tile && !this.target.perPixelSpriteColour;
      for (let y = 0; y < pixels.length; y++) {
        for (let x = 0; x < pixels[y].length; x++) {
          const v = pixels[y][x];
          if (!v && !tile) continue;
          ctx.fillStyle = mono ? this.css(this.palette[1] || 63) : this.css(this.palette[v]);
          ctx.fillRect(x * z, y * z, z, z);
        }
      }
    },
    cell(ev) {
      const r = this.$refs.canvas.getBoundingClientRect();
      return {
        x: Math.floor((ev.clientX - r.left) / this.zoom),
        y: Math.floor((ev.clientY - r.top) / this.zoom),
      };
    },
    startDraw(ev) {
      this.painting = true;
      this.erasing = ev.button === 1 || ev.shiftKey;
      this.paint(ev);
    },
    drag(ev) {
      if (this.painting) this.paint(ev);
    },
    endDraw() {
      this.painting = false;
    },
    paint(ev) {
      const {x, y} = this.cell(ev);
      if (x < 0 || y < 0 || y >= this.rows || x >= this.cols) return;
      this.$set(this.frame.pixels[y], x, this.erasing ? 0 : this.colour);
      this.redraw();
      this.$emit('changed');
    },
    pickUnderCursor(ev) {
      const {x, y} = this.cell(ev);
      if (y >= 0 && y < this.rows && x >= 0 && x < this.cols) {
        this.colour = this.frame.pixels[y][x];
      }
    },
    flipH() {
      this.frame.pixels.forEach((row) => row.reverse());
      this.redraw();
      this.$emit('changed');
    },
    clearFrame() {
      this.frame.pixels.forEach((row) => row.fill(0));
      this.redraw();
      this.$emit('changed');
    },
  },
};

function line(ctx, x1, y1, x2, y2) {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}
</script>

<style scoped>
.sprite-editor { display: flex; gap: 16px; align-items: flex-start; }
.grid { image-rendering: pixelated; cursor: crosshair; border-radius: 4px; }
.hint { font-size: 11px; opacity: .55; margin-top: 6px; }
.side { width: 190px; }
.palette { display: grid; grid-template-columns: repeat(8, 1fr); gap: 3px; }
.swatch {
  aspect-ratio: 1; border-radius: 3px; border: 2px solid transparent;
  cursor: pointer;
}
.swatch.sel { border-color: #fff; }
.swatch.transparent {
  background-image: linear-gradient(45deg, #444 25%, transparent 25%,
    transparent 75%, #444 75%) !important;
  background-size: 8px 8px;
}
.row { display: flex; flex-wrap: wrap; margin-top: 10px; }
.note { font-size: 11px; opacity: .55; margin-top: 10px; line-height: 1.4; }
</style>
