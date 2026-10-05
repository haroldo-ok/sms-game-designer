// Must come first: it installs the composition API, which hooks/project.js
// needs at module-evaluation time. See the note in that file.
import Vue from './plugins/composition-api.js';

import App from './App.vue';
import vuetify from './plugins/vuetify';

Vue.config.productionTip = false;
// Blockly injects raw XML-ish tags that Vue would otherwise warn about.
Vue.config.ignoredElements = ['field', 'block', 'category', 'xml', 'mutation',
  'value', 'sep', 'shadow'];

new Vue({vuetify, render: (h) => h(App)}).$mount('#app');
