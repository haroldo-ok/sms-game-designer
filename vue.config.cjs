const {defineConfig} = require('@vue/cli-service');

module.exports = defineConfig({
  transpileDependencies: ['vuetify'],
  // 'auto': every script works out where the site root is from its own URL.
  //
  // This used to be '' (plain relative paths), which is right for the page
  // and wrong for a Web Worker. A chunk URL was just "js/755.hash.js",
  // resolved against whoever asked - and the compiler Worker's own file
  // already lives in js/, so it requested js/js/755…js, got a 404, and every
  // build failed with "importScripts … failed to load". With 'auto' the page
  // works it out from the document and the worker from its own location, so
  // both land on the right folder - and it is still relative to wherever the
  // editor is hosted, so the build stays relocatable.
  publicPath: 'auto',
  configureWebpack: {
    // The compiler Worker is constructed with `new Worker(new URL(...))`,
    // which webpack 5 understands natively.
    experiments: {topLevelAwait: true},
  },
  chainWebpack: (config) => {
    // Engine kernel sources are imported as text so a kernel change does not
    // require a compiler rebuild - see the note in
    // src/hooks/cvbasic-compiler.js.
    config.module.rule('bas')
        .test(/\.bas$/)
        .use('raw-loader').loader('raw-loader');
  },
});
