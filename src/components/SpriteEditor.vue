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
        Left to {{ tool === 'fill' ? 'fill' : 'paint' }}, right to pick,
        Shift to erase.
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
        <v-btn
          x-small
          text
          class="edit-colour"
          :disabled="colour === 0 && kind !== 'tile'"
          @click="picking = !picking"
        >{{ picking ? 'Done' : 'Change this colour' }}</v-btn>
      </div>
      <!--
        The console has 64 colours and a palette holds 16 of them. Changing
        an entry recolours everything drawn with it, everywhere - which is
        what a palette is, and worth saying where the change is made.
      -->
      <div v-if="picking" class="picker">
        <button
          v-for="v in 64"
          :key="v"
          class="pick"
          :class="{sel: palette[colour] === v - 1}"
          :style="{background: css(v - 1)}"
          :title="`Colour ${v - 1}`"
          @click="setPaletteEntry(v - 1)"
        />
        <div class="note">
          This changes colour {{ colour }} of the
          {{ kind === 'tile' ? 'background' : 'sprite' }} palette, for
          everything that uses it.
        </div>
      </div>

      <div class="row tools">
        <v-btn-toggle v-model="tool" dense mandatory>
          <v-btn x-small value="pen" class="tool-pen">Pen</v-btn>
          <v-btn x-small value="fill" class="tool-fill">Fill</v-btn>
        </v-btn-toggle>
      </div>
      <div class="row">
        <v-btn x-small text class="flip-h" title="Mirror left to right" @click="flipH">
          Flip ↔
        </v-btn>
        <v-btn x-small text class="flip-v" title="Mirror top to bottom" @click="flipV">
          Flip ↕
        </v-btn>
        <v-btn x-small text class="clear" @click="clearFrame">Clear</v-btn>
      </div>
      <div class="row nudge">
        <span>Nudge</span>
        <v-btn x-small icon class="nudge-left" title="Left" @click="nudge(-1, 0)">←</v-btn>
        <v-btn x-small icon class="nudge-up" title="Up" @click="nudge(0, -1)">↑</v-btn>
        <v-btn x-small icon class="nudge-down" title="Down" @click="nudge(0, 1)">↓</v-btn>
        <v-btn x-small icon class="nudge-right" title="Right" @click="nudge(1, 0)">→</v-btn>
      </div>
      <div class="row">
        <v-btn x-small text class="copy" @click="copyFrame">Copy</v-btn>
        <v-btn x-small text class="paste" :disabled="!clipboard.pixels" @click="pasteFrame">
          Paste
        </v-btn>
        <v-btn v-if="kind !== 'tile'" x-small text @click="$emit('onion', !onion)">
          {{ onion ? 'Hide' : 'Show' }} previous frame
        </v-btn>
      </div>

      <div class="note">
        <template v-if="kind === 'tile'">
          Background tiles use the background palette. Colour 0 is a real
          colour here, not transparency - it is the backdrop.
          <template v-if="target.video === 'tms'">
            This is how the {{ target.label }} will show it: two colours on
            each row, from the console's fixed palette.
          </template>
        </template>
        <template v-else>
          {{ target.perPixelSpriteColour
            ? 'Every pixel can use any of the 16 sprite palette colours.'
            : 'This console gives a sprite one colour: the one it uses most, '
              + 'matched to the nearest of the console\'s fixed colours. The '
              + 'preview shows the result.' }}
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
import {
  flipH, flipV, shift, floodFill, cleared, fitTo, dominantIndex,
} from '../ir/pixels.js';
import {
  tmsTileRows, nearestTms, sixBitToRgb, TMS_PALETTE,
} from '../ir/tms.js';

// One clipboard for every pixel editor on the page, so a frame can be
// copied from one actor - or one tile - and pasted into another.
const clipboard = {pixels: null};

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
    return {
      colour: 1, painting: false, erasing: false, tool: 'pen',
      picking: false, clipboard,
    };
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
    palette: {handler: 'redraw', deep: true},
    target: 'redraw',
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
      const tms = this.target.video === 'tms';
      const rgb = (c) => `rgb(${TMS_PALETTE[c].join(',')})`;
      if (tile && tms) {
        // What the console will show, not what was drawn: two colours a
        // row. Drawing with a third and seeing it snap to one of the two is
        // the whole lesson, and better learnt here than on the Play tab.
        tmsTileRows({pixels}, this.palette).forEach((row, y) => {
          row.bits.forEach((on, x) => {
            ctx.fillStyle = rgb(on ? row.fg : row.bg);
            ctx.fillRect(x * z, y * z, z, z);
          });
        });
        return;
      }
      // One colour for the whole sprite on these consoles: the one it uses
      // most, as the generator chooses it. This used to preview in palette
      // entry 1 whatever was drawn, so a green bug previewed white.
      const mono = !tile && !this.target.perPixelSpriteColour;
      const monoColour = mono ? rgb(nearestTms(sixBitToRgb(
          this.palette[dominantIndex(pixels)] | 0))) : null;
      for (let y = 0; y < pixels.length; y++) {
        for (let x = 0; x < pixels[y].length; x++) {
          const v = pixels[y][x];
          if (!v && !tile) continue;
          ctx.fillStyle = mono ? monoColour : this.css(this.palette[v]);
          ctx.fillRect(x * z, y * z, z, z);
        }
      }
    },
    /**
     * Replace the frame's pixels with a new grid, through splice so Vue
     * sees it. `Array.prototype.fill` is not one of the methods Vue 2
     * watches: Clear used to blank the canvas without the project noticing,
     * so the cleared frame was not autosaved until something else changed.
     */
    apply(next) {
      const px = this.frame.pixels;
      next.forEach((row, y) => {
        if (px[y]) px[y].splice(0, px[y].length, ...row);
      });
      this.redraw();
      this.$emit('changed');
    },
    cell(ev) {
      const r = this.$refs.canvas.getBoundingClientRect();
      return {
        x: Math.floor((ev.clientX - r.left) / this.zoom),
        y: Math.floor((ev.clientY - r.top) / this.zoom),
      };
    },
    startDraw(ev) {
      // The right button picks a colour (see pickUnderCursor). It used to
      // paint as well, because mousedown fires for every button: a right
      // click drew a pixel in the current colour and then picked that.
      if (ev.button === 2) return;
      this.erasing = ev.button === 1 || ev.shiftKey;
      if (this.tool === 'fill') {
        const {x, y} = this.cell(ev);
        this.apply(floodFill(this.frame.pixels, x, y,
            this.erasing ? 0 : this.colour));
        return;
      }
      this.painting = true;
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
      this.apply(flipH(this.frame.pixels));
    },
    flipV() {
      this.apply(flipV(this.frame.pixels));
    },
    nudge(dx, dy) {
      this.apply(shift(this.frame.pixels, dx, dy));
    },
    clearFrame() {
      this.apply(cleared(this.frame.pixels));
    },
    copyFrame() {
      clipboard.pixels = this.frame.pixels.map((row) => [...row]);
    },
    pasteFrame() {
      if (!clipboard.pixels) return;
      this.apply(fitTo(clipboard.pixels, this.cols, this.rows));
    },
    setPaletteEntry(value) {
      this.$set(this.palette, this.colour, value);
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
.row { display: flex; flex-wrap: wrap; align-items: center; margin-top: 10px; }
.nudge span { font-size: 11px; opacity: .55; margin-right: 4px; }
.picker {
  display: grid; grid-template-columns: repeat(8, 1fr); gap: 2px;
  margin-top: 8px;
}
.picker .pick {
  aspect-ratio: 1; border-radius: 2px; border: 2px solid transparent;
  cursor: pointer;
}
.picker .pick.sel { border-color: #fff; }
.picker .note { grid-column: 1 / -1; margin-top: 6px; }
.note { font-size: 11px; opacity: .55; margin-top: 10px; line-height: 1.4; }
</style>
