module.exports = {
  root: true,
  env: {node: true, browser: true, es2021: true},
  extends: ['plugin:vue/essential', 'eslint:recommended', 'google'],
  parserOptions: {parser: 'babel-eslint', ecmaVersion: 2021, sourceType: 'module'},
  rules: {
    'max-len': ['warn', {code: 100, ignoreComments: false}],
    'require-jsdoc': 'off',
    'valid-jsdoc': 'off',
    // The editor components are, deliberately, editors for the object they
    // are handed. The project document is the single source of truth and a
    // component like ActorEditor exists to change the actor it is given;
    // threading every text field through an event so the parent can write
    // the same property back would be ceremony with no benefit, and would
    // put the real state in two places.
    'vue/no-mutating-props': 'off',
  },
};
