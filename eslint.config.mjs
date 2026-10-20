import js from '@eslint/js';
import { builtinModules } from 'node:module';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const nodeImports = [
  ...new Set(
    builtinModules.flatMap((name) => {
      const bare = name.replace(/^node:/u, '');
      return [bare, `node:${bare}`];
    }),
  ),
];
const restricted = (groups, paths = []) => [
  'error',
  {
    paths: paths.map((name) => ({
      name,
      message: '共有層へ Node.js / OS 固有依存を持ち込まないでください。',
    })),
    patterns: groups.map((group) => ({
      group,
      message: 'ワークスペースの依存方向を確認してください。',
    })),
  },
];

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      '.local/**',
      '.pnpm-store/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.mjs'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-require-imports': 'error',
      'no-eval': 'error',
      'no-new-func': 'error',
    },
  },
  {
    files: ['packages/contracts/**/*.ts', 'packages/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': restricted(
        [
          ['node:*', 'electron', 'electron/*', '@electron/*'],
          [
            '@buddy/core',
            '@buddy/core/*',
            '@buddy/storage',
            '@buddy/storage/*',
            '@buddy/desktop',
            '@buddy/desktop/*',
            '@buddy/platform',
            '@buddy/platform/*',
          ],
          [
            '../**/storage/**',
            '../**/platform/**',
            '../**/apps/**',
            '../**/core/**',
            '../**/desktop/**',
          ],
        ],
        nodeImports,
      ),
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ImportExpression',
          message: '共有層の依存は静的 import で明示してください。',
        },
        {
          selector: 'TSImportType',
          message: '共有層の型依存は import type で明示してください。',
        },
      ],
    },
  },
  {
    files: ['packages/contracts/**/*.ts'],
    rules: {
      'no-restricted-imports': restricted(
        [
          [
            'node:*',
            'electron',
            'electron/*',
            '@electron/*',
            '@buddy/*',
            '../**/domain/**',
            '../**/storage/**',
            '../**/platform/**',
            '../**/apps/**',
          ],
        ],
        nodeImports,
      ),
    },
  },
  {
    files: ['apps/core/**/*.ts', 'packages/storage/**/*.ts'],
    languageOptions: { globals: globals.node },
    rules: {
      'no-restricted-imports': restricted([
        [
          'electron',
          'electron/*',
          '@electron/*',
          '@buddy/desktop',
          '@buddy/desktop/*',
          '../**/desktop/**',
        ],
      ]),
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'ImportExpression[source.value=/^(electron|@electron|@buddy\\/desktop)(\\/|$)/]',
          message: 'Core / storage は Electron クライアントへ依存しません。',
        },
      ],
    },
  },
  {
    files: ['packages/platform/**/*.ts'],
    languageOptions: { globals: globals.node },
    rules: {
      'no-restricted-imports': restricted([
        [
          'electron',
          'electron/*',
          '@electron/*',
          '@buddy/desktop',
          '@buddy/desktop/*',
          '@buddy/core',
          '@buddy/core/*',
          '../**/desktop/**',
          '../**/apps/**',
          '../**/core/**',
        ],
      ]),
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'ImportExpression[source.value=/^(electron|@electron|@buddy\\/(desktop|core))(\\/|$)/]',
          message:
            'platform は Electron クライアントと Core へ依存しません（Core が platform を使う）。',
        },
      ],
    },
  },
);
