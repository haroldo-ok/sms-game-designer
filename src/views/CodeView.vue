<template>
  <div class="code-view">
    <p class="note">
      This is the escape hatch. If you outgrow blocks, download the source
      and the engine and keep building with the real compiler — readable,
      commented output is a feature here, not an implementation detail.
      Every <code>' @blk:</code> marker ties a group of lines back to the
      block that produced it, which is also how build errors find their way
      back to your workspace.
    </p>
    <pre class="src">{{ source }}</pre>
  </div>
</template>

<script>
export default {
  name: 'CodeView',
  props: {
    source: {type: String, default: ''},
    problems: {type: Array, default: () => []},
  },
};
</script>

<style scoped>
.code-view { height: 100%; display: flex; flex-direction: column; }
.note { font-size: 12px; opacity: .65; line-height: 1.5; max-width: 780px; }
.src {
  flex: 1; overflow: auto; font-size: 11.5px; line-height: 1.45;
  background: rgba(0,0,0,.28); padding: 12px; border-radius: 4px;
  white-space: pre; tab-size: 4;
}
</style>
