const {defineConfig} = require('@vue/cli-service');

module.exports = defineConfig({
  transpileDependencies: ['vuetify'],
  // Everything runs client-side, so the build has to be relocatable: the
  // whole thing is meant to work from a file:// copy or an itch.io page.
  publicPath: '',
  configureWebpack: {
    // The compiler Worker is constructed with `new Worker(new URL(...))`,
    // which webpack 5 understands natively.
    experiments: {topLevelAwait: true},
  },
  chainWebpack: (config) => {
    // Engine kernel sources are imported as text so a kernel change does not
    // require an Emscripten rebuild - see the note in
    // src/hooks/cvbasic-compiler.js.
    config.module.rule('bas')
        .test(/\.bas$/)
        .use('raw-loader').loader('raw-loader');
  },
});
