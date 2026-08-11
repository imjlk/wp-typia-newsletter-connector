import type { ITtscLintConfig } from '@ttsc/lint';
import { configs } from '@wp-typia/ttsc-lint-plugin-wp';

export default {
  extends: configs.wpScriptsRecommended.extends,
  files: [
    'scripts/**/*.cjs',
    'scripts/**/*.cts',
    'scripts/**/*.js',
    'scripts/**/*.jsx',
    'scripts/**/*.mjs',
    'scripts/**/*.mts',
    'scripts/**/*.ts',
    'scripts/**/*.tsx',
  ],
  rules: {
    'no-console': 'off',
  },
} satisfies ITtscLintConfig;
