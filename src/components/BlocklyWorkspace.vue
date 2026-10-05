<template>
  <div class="blockly-wrap">
    <div class="blockly-head">
      <span class="blockly-title">{{ title }}</span>
      <span v-if="scope === 'actor-collide'" class="blockly-hint">
        <code>other</code> is the thing you hit
      </span>
      <span v-if="lossy" class="blockly-error">
        This script uses things that have no block ({{ lossy.join(', ') }}),
        so only part of it is shown here and changes cannot be saved from
        this view. Edit it in the generated source instead.
      </span>
      <span v-if="loadError" class="blockly-error">
        This script could not be reopened ({{ loadError }}). Nothing has been
        overwritten - the saved copy is still there.
      </span>
      <v-spacer />
      <v-btn small text @click="clear">Clear</v-btn>
    </div>
    <div ref="host" class="blockly-host" />
  </div>
</template>

<script>
/**
 * One Blockly workspace, bound to one script.
 *
 * Workspaces here are per-event and deliberately small. One giant workspace
 * is the usual failure mode of block-based tools; the actor model naturally
 * shreds a program into dozens of five-to-twenty block scripts, and that is
 * the real ergonomic win - not the blocks themselves.
 *
 * The toolbox is rebuilt whenever the scope or the project's dropdown
 * contents change, because "my [hp]" has to offer this actor's fields and
 * nobody else's.
 */
import * as Blockly from 'blockly/core';
import 'blockly/blocks';
import {defineBlocks} from '../blocks/index.js';
import {toolboxFor} from '../blocks/toolbox.js';
import {lowerWorkspace} from '../generators/blockly-lower.js';
import {raiseScript} from '../generators/blockly-raise.js';
import {project, currentActor} from '../hooks/project.js';

let blocksDefined = false;

export default {
  name: 'BlocklyWorkspace',
  props: {
    // The script object: {xml, stmts}. Mutated in place on change.
    script: {type: Object, required: true},
    scope: {type: String, default: 'actor'},
    title: {type: String, default: ''},
    // A block id to highlight, from a failed build.
    blame: {type: String, default: null},
  },
  data() {
    return {workspace: null, loadError: null, lossy: null};
  },
  watch: {
    script() {
      this.reload();
    },
    scope() {
      this.rebuildToolbox();
    },
    blame(id) {
      this.highlight(id);
    },
  },
  mounted() {
    if (!blocksDefined) {
      defineBlocks(Blockly, {
        actors: () => project.value.actors,
        globals: () => project.value.globals,
        rooms: () => project.value.rooms,
        fields: () => currentActor.value?.fields || [],
        animations: () => currentActor.value?.animations || [],
        groups: () => [...new Set(project.value.actors.map((a) => a.group))],
      });
      blocksDefined = true;
    }

    this.workspace = Blockly.inject(this.$refs.host, {
      toolbox: toolboxFor(this.scope),
      renderer: 'zelos',
      trashcan: true,
      zoom: {controls: true, wheel: true, startScale: 0.85},
      grid: {spacing: 24, length: 3, colour: '#2a2a2a', snap: true},
      move: {scrollbars: true, drag: true, wheel: true},
    });

    this.reload();
    this.workspace.addChangeListener(this.onChange);
  },
  beforeDestroy() {
    if (this.workspace) this.workspace.dispose();
  },
  methods: {
    onChange(ev) {
      // UI-only events (scroll, click, selection) do not change the program.
      if (ev.isUiEvent || !this.workspace) return;
      // A script that uses something with no block was only partly shown.
      // Lowering what is on screen would silently delete the rest, so edits
      // to it are not written back.
      if (this.lossy) return;
      this.script.xml = Blockly.Xml.domToText(
          Blockly.Xml.workspaceToDom(this.workspace));
      // Lowering on every edit is what makes the budget meter live: the IR
      // is rebuildable from here without a compile.
      this.script.stmts = lowerWorkspace(this.workspace);
      this.$emit('changed');
    },
    reload() {
      if (!this.workspace) return;
      this.loadError = null;
      this.lossy = null;
      this.workspace.removeChangeListener(this.onChange);

      // A script that exists only as a lowered program - every bundled
      // example, and anything produced by a tool rather than the editor -
      // has no XML to load. Rebuild the blocks from the program instead.
      // Opening it as an empty workspace would show nothing, and the first
      // edit would then lower that nothing over the real script.
      if (!this.script.xml && this.script.stmts && this.script.stmts.length) {
        const raised = raiseScript(this.script.stmts);
        if (raised.lossy.length) {
          this.lossy = raised.lossy;
        } else {
          // Lossless, so keep it: from now on this script loads like any
          // other, and the program it produces is unchanged.
          this.script.xml = raised.xml;
        }
        this.workspace.clear();
        Blockly.Xml.domToWorkspace(
            Blockly.utils.xml.textToDom(raised.xml), this.workspace);
        this.workspace.addChangeListener(this.onChange);
        this.highlight(this.blame);
        return;
      }

      if (this.script.xml) {
        let dom = null;
        try {
          // textToDom lives on Blockly.utils.xml; Blockly.Xml.textToDom was
          // removed. Getting this wrong silently hands the user an empty
          // workspace every time they switch scripts, which looks exactly
          // like losing their work - so the parse happens BEFORE the clear,
          // and a failure leaves what is already on screen alone.
          dom = Blockly.utils.xml.textToDom(this.script.xml);
        } catch (e) {
          // Shown in this workspace's own header rather than emitted
          // upward: every parent would have to thread it through, and the
          // one place it means anything is next to the script that failed.
          console.error('Could not restore this script', e);
          this.loadError = String((e && e.message) || e);
          this.workspace.addChangeListener(this.onChange);
          return;
        }
        this.workspace.clear();
        Blockly.Xml.domToWorkspace(dom, this.workspace);
      } else {
        this.workspace.clear();
      }
      this.workspace.addChangeListener(this.onChange);
      this.highlight(this.blame);
    },
    rebuildToolbox() {
      if (this.workspace) this.workspace.updateToolbox(toolboxFor(this.scope));
    },
    /**
     * Highlight the block a failed build was traced to. Without this the
     * user sees a line number in a file they have never opened.
     */
    highlight(id) {
      if (!this.workspace) return;
      this.workspace.getAllBlocks(false).forEach((b) => b.setWarningText(null));
      if (!id) return;
      const block = this.workspace.getBlockById(id);
      if (block) {
        block.setWarningText(this.$attrs.blameMessage || 'This block did not compile.');
        block.select();
        this.workspace.centerOnBlock(id);
      }
    },
    clear() {
      this.workspace.clear();
      this.onChange({isUiEvent: false});
    },
  },
};
</script>

<style scoped>
.blockly-wrap { display: flex; flex-direction: column; height: 100%; }
.blockly-head {
  display: flex; align-items: center; gap: 12px;
  padding: 4px 8px; border-bottom: 1px solid rgba(255,255,255,.08);
}
.blockly-title { font-weight: 600; }
.blockly-hint { opacity: .6; font-size: 12px; }
.blockly-error { font-size: 12px; color: #d4614f; }
.blockly-host { flex: 1; min-height: 320px; }
</style>
