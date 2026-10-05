import Vue from 'vue';
import Vuetify from 'vuetify/lib/framework';

Vue.use(Vuetify);

export default new Vuetify({
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
