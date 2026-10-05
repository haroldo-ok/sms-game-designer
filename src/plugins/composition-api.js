/**
 * Install the composition API before anything uses it.
 *
 * This has to be its own module. Written inline in main.js as
 *
 *     import Vue from 'vue';
 *     import VueCompositionApi from '@vue/composition-api';
 *     Vue.use(VueCompositionApi);
 *     import App from './App.vue';
 *
 * it looks correct and is not: ES modules evaluate every import before any
 * statement in the body, so App.vue - and through it hooks/project.js, which
 * calls ref() at module scope - runs before the Vue.use ever does. The
 * plugin then cannot find Vue, `Vue.observable` is undefined, and the whole
 * app fails to boot with an error that names neither file.
 *
 * Imports are evaluated in source order, so importing this module first is
 * what actually guarantees the ordering.
 */
import Vue from 'vue';
import VueCompositionApi from '@vue/composition-api';

Vue.use(VueCompositionApi);

export default Vue;
