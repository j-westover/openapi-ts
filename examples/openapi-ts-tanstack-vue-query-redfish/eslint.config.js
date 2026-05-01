import js from '@eslint/js';
import vueTsConfig from '@vue/eslint-config-typescript';
import vue from 'eslint-plugin-vue';
import globals from 'globals';

export default [
  js.configs.recommended,
  ...vue.configs['flat/essential'],
  ...vueTsConfig(),
  {
    languageOptions: {
      ecmaVersion: 'latest',
      globals: {
        ...globals.browser,
        ...globals.node,
      },
      sourceType: 'module',
    },
  },
  {
    files: ['**/*.vue'],
    rules: {
      // Formatting is handled by oxfmt; turn off vue's stylistic rules so
      // they don't fight each other.
      'vue/html-self-closing': 'off',
      'vue/max-attributes-per-line': 'off',
      'vue/multi-word-component-names': 'off',
      'vue/singleline-html-element-content-newline': 'off',
    },
  },
  {
    ignores: ['dist/**', 'node_modules/**', 'src/client/**', 'src/client.full/**'],
  },
];
