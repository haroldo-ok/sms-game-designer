<template>
  <div class="budget">
    <div v-for="g in gauges" :key="g.key" class="gauge" :title="g.tip">
      <span class="label">{{ g.label }}</span>
      <span class="bar">
        <span class="fill" :class="level(g)" :style="{width: pct(g) + '%'}" />
      </span>
      <span class="value">{{ g.text }}</span>
    </div>

    <div v-if="advice.length" class="advice">
      <div v-for="(a, i) in advice" :key="i" class="advice-row">
        <span>{{ a.text }}</span>
        <v-btn
          v-if="a.action"
          x-small
          depressed
          color="primary"
          @click="$emit('apply', a.action)"
        >{{ actionLabel(a.action) }}</v-btn>
      </div>
    </div>
  </div>
</template>

<script>
/**
 * The budget meter, always visible next to Play.
 *
 * This is the quiet hero of the whole design. A beginner has no mental model
 * of console limits; showing the price next to the choice teaches it without
 * a lecture, and turns "my game broke" into "I cannot afford twelve of
 * these". On this hardware the limits *are* the design, and a tool that
 * hides them just moves the discovery to the worst possible moment.
 *
 * Everything except ROM size and the measured frame time comes from the IR
 * with no compile, so it updates while the user types. RAM comes straight
 * out of the compiler once there has been a successful build - CVBasic
 * prints "N RAM bytes used of M available" every time, so there is nothing
 * to model.
 *
 * The advice rows are the important part. A user cannot act on "61%". They
 * can act on "enemy vs player_shot is 48 checks a frame; check it every
 * other frame", with a button that writes the change back into the project.
 */
export default {
  name: 'BudgetMeter',
  props: {
    ir: {type: Object, required: true},
    frame: {type: Object, required: true},
    lastBuild: {type: Object, default: null},
  },
  computed: {
    gauges() {
      const ir = this.ir;
      const t = ir.target;
      const b = this.lastBuild;
      return [
        {
          key: 'sprites', label: 'Sprites',
          used: ir.layout.worstHw, max: t.hardwareSprites,
          text: `${ir.layout.worstHw}/${t.hardwareSprites} hw`,
          tip: 'Hardware sprites needed if every slot were full. A 16-pixel ' +
            'wide actor costs two. Over budget, actors flicker rather than ' +
            'one disappearing for good.',
        },
        {
          key: 'vram', label: 'VRAM',
          used: ir.layout.spriteDefs, max: t.spriteDefBudget,
          text: `${ir.layout.spriteDefs}/${t.spriteDefBudget} defs`,
          tip: 'Sprite definitions. Every animation frame of every actor a ' +
            'room can contain is in VRAM the whole time that room runs.',
        },
        {
          key: 'slots', label: 'Slots',
          used: ir.layout.maxEnt, max: t.maxSlots,
          text: `${ir.layout.maxEnt}/${t.maxSlots}`,
          tip: 'The sum of every actor type\'s Max instances.',
        },
        {
          key: 'ram', label: 'RAM',
          used: b?.ramUsed ?? ir.layout.ramEstimate,
          max: b?.ramTotal ?? t.ram,
          text: `${b?.ramUsed ?? ir.layout.ramEstimate}/${b?.ramTotal ?? t.ram} B` +
            (b?.ramUsed ? '' : ' (est)'),
          tip: b?.ramUsed ?
            'Reported by the compiler on the last successful build.' :
            'Estimated. Build once for the compiler\'s own figure.',
        },
        {
          key: 'rom', label: 'ROM',
          used: b?.rom ? b.rom.length : 0, max: t.romBudget,
          text: b?.rom ?
            `${(b.rom.length / 1024).toFixed(0)}/${t.romBudget / 1024} KB` :
            `-/${t.romBudget / 1024} KB`,
          tip: 'From the last successful build. The assembler rounds the ' +
            'image up to a power of two, so this can jump from 8 KB to ' +
            '16 KB in one step.',
        },
        {
          key: 'frame', label: 'Frame',
          used: this.frame.percent, max: 100,
          text: `${this.frame.percent}%`,
          tip: this.frame.parts
              .map((p) => `${p.name} ${p.percent}%`).join(' · ') +
            '\nWorst case: every slot of every type occupied at once.',
        },
      ];
    },
    advice() {
      return this.frame.advice || [];
    },
  },
  methods: {
    pct(g) {
      return Math.min(100, Math.round((g.used / (g.max || 1)) * 100));
    },
    level(g) {
      const r = g.used / (g.max || 1);
      if (r > 1) return 'over';
      if (r > 0.85) return 'tight';
      return 'ok';
    },
    actionLabel(a) {
      if (a.kind === 'timeSlice') return 'Check every other frame';
      if (a.kind === 'lowerMax') return 'Lower Max instances';
      return 'Apply';
    },
  },
};
</script>

<style scoped>
.budget { font-size: 12px; padding: 6px 10px; }
.gauge { display: flex; align-items: center; gap: 8px; line-height: 20px; }
.label { width: 58px; opacity: .75; }
.bar {
  flex: 1; height: 7px; border-radius: 4px;
  background: rgba(255,255,255,.1); overflow: hidden; min-width: 70px;
}
.fill { display: block; height: 100%; border-radius: 4px; }
.fill.ok { background: #57b894; }
.fill.tight { background: #d8a94a; }
.fill.over { background: #d4614f; }
.value { width: 104px; text-align: right; opacity: .85; font-variant-numeric: tabular-nums; }
.advice { margin-top: 8px; border-top: 1px solid rgba(255,255,255,.08); padding-top: 8px; }
.advice-row {
  display: flex; align-items: center; gap: 8px;
  margin-bottom: 6px; opacity: .9;
}
</style>
