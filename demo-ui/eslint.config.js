// Lint (Phase 12 CI): correctness rules only — undefined names, unreachable code, duplicate keys, bad comparisons —
// as errors; style is not enforced. The legacy single-file page (index.html) is covered by its own tests.
const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  { ignores: ['node_modules/**', '.next/**', 'public/**', 'legacy/**', 'app/**', 'components/**', 'lib/**', '**/*.ts', '**/*.tsx', 'next-env.d.ts'] },
  {
    files: ['api/**/*.js', 'src/**/*.js', 'scripts/**/*.js', 'tests/**/*.js', 'db/**/*.mjs', '*.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'commonjs', globals: { ...globals.node } },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-useless-escape': 'off',
      'no-control-regex': 'off',
      'no-misleading-character-class': 'off',
      'no-prototype-builtins': 'off',
      'no-async-promise-executor': 'off',
      'no-cond-assign': ['error', 'except-parens'],
    },
  },
  { files: ['db/**/*.mjs', 'scripts/**/*.mjs'], languageOptions: { sourceType: 'module' } },
];
