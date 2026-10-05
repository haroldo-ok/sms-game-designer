<template>
  <v-app dark>
    <v-app-bar dense app flat>
      <v-toolbar-title class="title-text">SMS Game Designer</v-toolbar-title>
      <v-text-field
        v-model="project.name"
        dense
        hide-details
        solo-inverted
        flat
        class="name-field"
      />
      <v-select
        v-model="project.target"
        :items="targetItems"
        dense
        hide-details
        solo-inverted
        flat
        class="target-field"
      />
      <v-spacer />
      <span v-if="dirty" class="saving">saving…</span>
      <v-menu offset-y max-width="380">
        <template #activator="{on}">
          <v-btn text small v-on="on">Open</v-btn>
        </template>
        <v-list dense>
          <v-list-item @click="doImport">
            <v-list-item-content>
              <v-list-item-title>Open a project file&hellip;</v-list-item-title>
            </v-list-item-content>
          </v-list-item>
          <v-divider />
          <v-subheader>Examples</v-subheader>
          <v-list-item
            v-for="ex in examples"
            :key="ex.id"
            class="example-item"
            @click="openExample(ex)"
          >
            <v-list-item-content>
              <v-list-item-title>
                {{ ex.title }}
                <span class="example-console">{{ ex.console }}</span>
              </v-list-item-title>
              <v-list-item-subtitle class="example-blurb">
                {{ ex.blurb }}
              </v-list-item-subtitle>
            </v-list-item-content>
          </v-list-item>
        </v-list>
      </v-menu>
      <v-btn text small @click="exportProject">Save</v-btn>
      <v-menu offset-y>
        <template #activator="{on}">
          <v-btn text small v-on="on">Export</v-btn>
        </template>
        <v-list dense>
          <v-list-item :disabled="!lastRom" @click="downloadRom">
            <v-list-item-title>ROM (.{{ target.romExt }})</v-list-item-title>
          </v-list-item>
          <v-list-item @click="downloadSource">
            <v-list-item-title>CVBasic source + engine</v-list-item-title>
          </v-list-item>
        </v-list>
      </v-menu>
      <v-btn
        color="primary"
        small
        depressed
        :loading="building"
        class="ml-2"
        @click="run"
      >Play</v-btn>
    </v-app-bar>

    <v-main>
      <div class="layout">
        <div class="main-pane">
          <v-tabs v-model="tab" dense>
            <v-tab>Game</v-tab>
            <v-tab>Actors</v-tab>
            <v-tab>Rooms</v-tab>
            <v-tab>Play</v-tab>
            <v-tab>Code</v-tab>
          </v-tabs>

          <v-tabs-items v-model="tab" class="tab-body">
            <v-tab-item><GameView :gen="gen" @changed="regenerate" /></v-tab-item>
            <v-tab-item><ActorsView :blame="blame" @changed="regenerate" /></v-tab-item>
            <v-tab-item><RoomsView @changed="regenerate" /></v-tab-item>
            <v-tab-item>
              <PlayView
                :rom="lastRom"
                :target="target"
                :error="playError"
                :build="lastBuild && lastBuild.ok ? lastBuild : null"
              />
            </v-tab-item>
            <v-tab-item><CodeView :source="gen.source" :problems="gen.problems" /></v-tab-item>
          </v-tabs-items>
        </div>

        <aside class="side-pane">
          <BudgetMeter
            v-if="gen.ir"
            :ir="gen.ir"
            :frame="gen.frame"
            :last-build="lastBuild"
            @apply="applyAdvice"
          />

          <div v-if="gen.problems.length" class="problems">
            <div
              v-for="(p, i) in gen.problems"
              :key="i"
              class="problem"
              :class="p.severity"
            >{{ p.message }}</div>
          </div>

          <!--
            An error that maps into the engine is a bug in the tool, not in
            the user's game, and saying so plainly is the difference between
            a user filing a report and a user concluding they are bad at
            this.
          -->
          <div v-if="lastBuild && lastBuild.missingToolchain" class="internal">
            <b>No compiler in this build</b>
            <p>{{ lastBuild.error }}</p>
          </div>

          <div
            v-if="blame && blame.internal && !(lastBuild && lastBuild.missingToolchain)"
            class="internal"
          >
            <b>Internal error</b>
            <p>{{ blame.message }}</p>
            <v-btn x-small text @click="copySource">Copy the generated source</v-btn>
          </div>
        </aside>
      </div>
    </v-main>

    <input
      ref="file"
      type="file"
      accept=".smsgd,.smsgm,.zip"
      style="display:none"
      @change="onFile"
    >
  </v-app>
</template>

<script>
import {ref, computed, watch, onMounted} from '@vue/composition-api';

import GameView from './views/GameView.vue';
import ActorsView from './views/ActorsView.vue';
import RoomsView from './views/RoomsView.vue';
import PlayView from './views/PlayView.vue';
import CodeView from './views/CodeView.vue';
import BudgetMeter from './components/BudgetMeter.vue';

import {
  project, dirty, exportProject, importProject, exportSource, exportRom,
  openProject,
} from './hooks/project.js';
import {EXAMPLES, loadExample} from './examples/index.js';
import {
  generate, build, building, ENGINE,
} from './hooks/cvbasic-compiler.js';
import {TARGETS} from './ir/schema.js';

export default {
  name: 'App',
  components: {GameView, ActorsView, RoomsView, PlayView, CodeView, BudgetMeter},
  setup() {
    const tab = ref(1);
    const gen = ref({ir: null, problems: [], source: '', frame: {percent: 0, parts: []}});
    const lastBuild = ref(null);
    const lastRom = ref(null);
    const blame = ref(null);
    const playError = ref(null);

    const target = computed(() => TARGETS[project.value.target] || TARGETS.sms);
    const targetItems = computed(() =>
      Object.values(TARGETS).map((t) => ({text: t.label, value: t.id})));

    /**
     * Regeneration is cheap - no compiler, no WASM - so it runs on every
     * edit and keeps every budget except ROM size live. That is the whole
     * point of putting an IR between the project and the code.
     */
    function regenerate() {
      try {
        gen.value = generate(project.value);
      } catch (e) {
        console.error('Code generation failed', e);
        gen.value = {
          ...gen.value,
          problems: [{severity: 'error', code: 'internal', message: String(e.message || e)}],
        };
      }
    }

    watch(project, regenerate, {deep: true, immediate: true});
    onMounted(regenerate);

    async function run() {
      playError.value = null;
      const res = await build(project.value, {wantDebug: true});
      lastBuild.value = res;
      if (res.ok) {
        lastRom.value = res.rom;
        blame.value = null;
        tab.value = 3;
      } else {
        blame.value = res.blame || {internal: true, message: res.error};
        // A build error that traces to a block belongs next to that block,
        // not on a Play screen the user is now staring at uselessly.
        if (res.blame && res.blame.blockId) tab.value = 1;
        else if (res.blocked) tab.value = 1;
      }
    }

    function applyAdvice(action) {
      const p = project.value;
      if (action.kind === 'timeSlice') {
        p.timeSlicedPairs = [...new Set([...(p.timeSlicedPairs || []), action.pair])];
      } else if (action.kind === 'lowerMax') {
        const a = p.actors.find((x) => x.id === action.actor);
        if (a) a.max = Math.max(1, Math.floor(a.max * 0.75));
      }
    }

    return {
      tab, gen, project, dirty, target, targetItems, building,
      lastBuild, lastRom, blame, playError,
      regenerate, run, applyAdvice,
      exportProject,
      downloadRom: () => lastRom.value && exportRom(lastRom.value),
      downloadSource: () => exportSource(gen.value.source, ENGINE),
      copySource: () => navigator.clipboard?.writeText(gen.value.source),
      importProject,
      examples: EXAMPLES,
      openProject,
    };
  },
  methods: {
    /**
     * Open an example. The project autosaves, so opening one replaces
     * whatever is on screen - ask first unless there is nothing to lose.
     */
    async openExample(ex) {
      const p = this.project;
      const hasWork = p.actors.length > 0 ||
        p.rooms.some((r) => (r.placements || []).length || r.tiles);
      if (hasWork && !window.confirm(
          `Open "${ex.title}"? This replaces the project you have open. ` +
          'Use Save first if you want to keep it.')) {
        return;
      }
      try {
        this.openProject(await loadExample(ex));
        this.tab = 1;
      } catch (e) {
        alert(`Could not open that example: ${e.message}`);
      }
    },
    doImport() {
      this.$refs.file.click();
    },
    async onFile(ev) {
      const file = ev.target.files[0];
      if (!file) return;
      try {
        await this.importProject(file);
      } catch (e) {
        alert(`Could not open that project: ${e.message}`);
      }
      ev.target.value = '';
    },
  },
};
</script>

<style>
html, body, #app { height: 100%; }
.title-text { font-size: 15px !important; margin-right: 16px; }
.name-field { max-width: 220px; }
.target-field { max-width: 190px; margin-left: 10px; }
.saving { font-size: 11px; opacity: .5; margin-right: 10px; }
.example-console { font-size: 11px; opacity: .55; margin-left: 6px; }
.example-blurb { white-space: normal !important; line-height: 1.35 !important; }
.example-item { min-height: 56px; }
.layout { display: flex; height: calc(100vh - 48px); }
.main-pane { flex: 1; display: flex; flex-direction: column; min-width: 0; }
/*
 * Vuetify gives .v-tabs `flex: 1 1 auto`, which is right when the tab bar is
 * the only thing in its container and wrong in a column next to the content.
 * There the bar and the content both grow and split the spare height between
 * them, the strip of tabs sits at the top of its half, and the rest of that
 * half is an empty band - a third of the screen, on every tab. The bar should
 * be exactly as tall as its tabs.
 */
.v-tabs { flex: 0 0 auto !important; }
.tab-body { flex: 1; overflow: auto; padding: 10px 14px; }
.side-pane {
  width: 330px; border-left: 1px solid rgba(255,255,255,.08);
  overflow: auto; padding-bottom: 20px;
}
.problems { padding: 8px 10px; }
.problem {
  font-size: 12px; line-height: 1.45; padding: 6px 8px;
  margin-bottom: 6px; border-radius: 4px; border-left: 3px solid;
}
.problem.warning { border-color: #d8a94a; background: rgba(216,169,74,.09); }
.problem.error { border-color: #d4614f; background: rgba(212,97,79,.1); }
/* Notes are facts the user needs in order to design, not problems: how far
   an actor can jump, how much a room costs. They read differently on
   purpose. */
.problem.info { border-color: #4a7ec4; background: rgba(74,126,196,.08); }
.internal {
  margin: 10px; padding: 10px; border-radius: 4px;
  background: rgba(212,97,79,.12); font-size: 12px;
}
.internal p { margin: 6px 0; opacity: .85; }
</style>
