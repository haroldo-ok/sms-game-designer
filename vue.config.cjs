const {defineConfig} = require('@vue/cli-service');

module.exports = defineConfig({
  transpileDependencies: ['vuetify'],
  // GitHub Pages serves the app from a repository subpath. Use a relative base
  // for production builds so the app still works when opened as a static site.
  publicPath: process.env.NODE_ENV === 'production' ? './' : '/',
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
