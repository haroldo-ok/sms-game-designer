<template>
  <div class="play">
    <div v-if="!rom" class="waiting">
      <p>Press <b>Play</b> to build and run.</p>
      <p class="sub">
        The compiler runs in your browser. Nothing is uploaded and nothing is
        installed.
      </p>
    </div>

    <template v-else>
      <div class="built">
        <span class="ok">Built</span>
        {{ sizeKb }} KB ROM
        <template v-if="build && build.ramUsed">
          &middot; {{ build.ramUsed }} of {{ build.ramTotal }} bytes of RAM
        </template>
        <template v-if="build && build.ms != null">
          &middot; {{ build.ms }} ms
        </template>
        <v-spacer />
        <v-btn x-small text @click="restart">Restart</v-btn>
        <v-btn x-small depressed color="primary" @click="download">
          Download ROM
        </v-btn>
      </div>

      <div ref="host" class="screen" />

      <!--
        The emulator is bundled, so this is rare: a copy of the editor
        missing its emulator folder, a console whose core is not bundled, or
        a browser without WebGL. Whatever the cause, the ROM is still good -
        say so, and point at the button that gets it out.
      -->
      <div v-if="emulatorError" class="emu-error">
        {{ emulatorError }}
      </div>
    </template>

    <p v-if="error" class="err">{{ error }}</p>
  </div>
</template>

<script>
/**
 * The Play tab.
 *
 * Shows the result of the last build and runs it in EmulatorJS.
 *
 * It used to offer a "Show hitboxes" checkbox, captioned as reading the
 * entity pool live out of the emulator's memory. Nothing read the checkbox
 * and nothing read the emulator's memory: the pool reader exists
 * (generators/symbols.js) but was never connected to the emulator. A control
 * that does nothing, described as doing something specific, is worse than no
 * control, so it is gone until it is real.
 */
import {play, emulatorError} from '../hooks/emulator.js';
import {exportRom} from '../hooks/project.js';

export default {
  name: 'PlayView',
  props: {
    rom: {type: Uint8Array, default: null},
    target: {type: Object, required: true},
    error: {type: String, default: null},
    build: {type: Object, default: null},
  },
  data() {
    return {stop: null};
  },
  computed: {
    emulatorError: () => emulatorError.value,
    sizeKb() {
      return this.rom ? Math.round(this.rom.length / 1024) : 0;
    },
  },
  watch: {
    rom: {
      immediate: true,
      handler(rom) {
        this.$nextTick(() => this.start(rom));
      },
    },
  },
  beforeDestroy() {
    if (this.stop) this.stop();
  },
  methods: {
    start(rom) {
      if (!rom || !this.$refs.host) return;
      if (this.stop) this.stop();
      this.stop = play(this.$refs.host, rom, this.target.id);
    },
    restart() {
      this.start(this.rom);
    },
    download() {
      exportRom(this.rom);
    },
  },
};
</script>

<style scoped>
.play { display: flex; flex-direction: column; align-items: center; }
.waiting { padding: 60px 20px; text-align: center; opacity: .75; }
.sub { font-size: 12px; opacity: .6; margin-top: 8px; }
.built {
  display: flex; align-items: center; gap: 8px; width: 100%; max-width: 768px;
  font-size: 12px; margin-bottom: 8px;
}
.ok { color: #57b894; font-weight: 600; }
.screen { width: 100%; max-width: 768px; aspect-ratio: 256 / 192; background: #000; }
.emu-error {
  max-width: 768px; margin-top: 10px; padding: 10px; border-radius: 4px;
  font-size: 13px; line-height: 1.5; background: rgba(216,169,74,.12);
}
.err { color: #d4614f; font-size: 13px; margin-top: 12px; }
</style>
