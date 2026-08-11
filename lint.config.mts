import { fileURLToPath } from 'node:url';

import type { ITtscLintConfig } from '@ttsc/lint';
import { configs } from '@wp-typia/ttsc-lint-plugin-wp';

export default {
  ...configs.wpScriptsRecommended,
  extends: fileURLToPath(
    new URL('./lint.config.scripts.mts', import.meta.url),
  ),
  ignores: ['build/**', 'node_modules/**'],
  format: {
    severity: 'off',
    printWidth: 80,
    tabWidth: 2,
    useTabs: false,
    semi: true,
    singleQuote: true,
    trailingComma: 'all',
    endOfLine: 'lf',
    sortImports: false,
    jsDoc: false,
  },
  rules: {
    'no-var': 'error',
    'prefer-const': 'error',
    eqeqeq: 'error',
    'wordpress/i18n-text-domain': [
      'error',
      { allowedTextDomain: 'wp-typia-newsletter-connector' },
    ],
  },
} satisfies ITtscLintConfig;
