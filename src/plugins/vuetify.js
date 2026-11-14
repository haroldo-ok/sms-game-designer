import Vue from 'vue';
import Vuetify from 'vuetify/lib/framework';

Vue.use(Vuetify);

/**
 * Icons, as SVG paths compiled into the bundle.
 *
 * Vuetify's default is the Material Design Icons web font, which it expects
 * the page to load and which this page never did - the editor is meant to
 * work offline, from its own folder, so there is no stylesheet link to a
 * font CDN and there should not be one. The result was that every icon in
 * the editor was an invisible, zero-width glyph: the close buttons, the star
 * on the player, and - worst - every checkbox, which Vuetify draws as an
 * icon. "This is the player", "Reuse oldest when full" and "Loop" were
 * labels with no box and no way to see whether they were on.
 *
 * `mdiSvg` makes Vuetify draw its own components' icons (checkboxes, select
 * arrows, clear buttons) from paths it ships with. The few icons the editor
 * names itself are listed here and used as `$name`.
 */
const ICONS = {
  star: 'M12,17.27L18.18,21L16.54,13.97L22,9.24L14.81,8.62L12,2L9.19,8.62' +
    'L2,9.24L7.45,13.97L5.82,21L12,17.27Z',
  undo: 'M12.5,8C9.85,8 7.45,9 5.6,10.6L2,7V16H11L7.38,12.38C8.77,11.22 ' +
    '10.54,10.5 12.5,10.5C16.04,10.5 19.05,12.81 20.1,16L22.47,15.22' +
    'C21.08,11.03 17.15,8 12.5,8Z',
  redo: 'M18.4,10.6C16.55,9 14.15,8 11.5,8C6.85,8 2.92,11.03 1.54,15.22' +
    'L3.9,16C4.95,12.81 7.96,10.5 11.5,10.5C13.45,10.5 15.23,11.22 ' +
    '16.62,12.38L13,16H22V7L18.4,10.6Z',
};

export default new Vuetify({
  icons: {iconfont: 'mdiSvg', values: ICONS},
  theme: {
    dark: true,
    themes: {
      dark: {
        primary: '#57b894',
        secondary: '#4a7ec4',
        accent: '#d8a94a',
      },
    },
  },
});
