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

// デスクトップから読み込まない別ワークスペース（B01 は中枢に接続しない。ADR 0012・0015）。
const desktopMainForbidden = [
  '@buddy/core',
  '@buddy/core/*',
  '@buddy/platform',
  '@buddy/platform/*',
  '@buddy/storage',
  '@buddy/storage/*',
  '@buddy/desktop',
  '@buddy/desktop/*',
];
// 別ワークスペースの src を相対パスで読み込まない（公開出口の @buddy/contracts・@buddy/domain を使う）。
const desktopWorkspaceRelative = [
  '../**/packages/**',
  '../**/apps/core/**',
  '../**/apps/desktop/**',
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
  // デスクトップ（ADR 0015）。main・preload・UI レンダラーで読み込めるものを分ける。
  {
    files: [
      'apps/desktop/**/*.ts',
      'apps/desktop/**/*.tsx',
      'apps/desktop/**/*.cts',
    ],
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-require-imports': 'error',
      'no-eval': 'error',
      'no-new-func': 'error',
    },
  },
  {
    // main: B01 は中枢に接続しない（ADR 0012）。Core・platform・storage と画面のコードを読み込まない。
    files: ['apps/desktop/src/main/**/*.ts'],
    languageOptions: { globals: globals.node },
    rules: {
      'no-restricted-imports': restricted([
        desktopMainForbidden,
        desktopWorkspaceRelative,
        ['../**/renderer/**', '../**/preload/**'],
      ]),
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'ImportExpression[source.value=/^@buddy\\/(core|platform|storage|desktop)(\\/|$)/]',
          message: 'デスクトップの main は中枢・OS アダプターへ依存しません。',
        },
      ],
    },
  },
  {
    // main の純粋なモジュール（electron/ 以外）: Electron を読み込まず、node:test で試験する。
    files: ['apps/desktop/src/main/*.ts'],
    rules: {
      'no-restricted-imports': restricted([
        desktopMainForbidden,
        desktopWorkspaceRelative,
        ['../**/renderer/**', '../**/preload/**'],
        ['electron', 'electron/*', '@electron/*'],
      ]),
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'ImportExpression[source.value=/^(electron|@electron|@buddy\\/(core|platform|storage|desktop))(\\/|$)/]',
          message:
            'main の純粋なモジュールは Electron・中枢・OS アダプターへ依存しません。',
        },
      ],
    },
  },
  {
    // preload: sandbox の中で electron の contextBridge・ipcRenderer だけを使う。
    files: ['apps/desktop/src/preload/**/*.cts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'electron',
              allowImportNames: ['contextBridge', 'ipcRenderer'],
              message:
                'preload は electron の contextBridge・ipcRenderer だけを使います。',
            },
          ],
          patterns: [
            {
              group: ['*', '!electron'],
              message:
                'preload は electron の contextBridge・ipcRenderer だけを使います。',
            },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ImportExpression',
          message: 'preload は動的 import を使いません。',
        },
      ],
    },
  },
  {
    // UI レンダラー: 画面だけを持ち、Electron・Node.js・中枢・OS アダプター・main のコードを読み込まない。
    files: [
      'apps/desktop/src/renderer/**/*.ts',
      'apps/desktop/src/renderer/**/*.tsx',
    ],
    languageOptions: { globals: globals.browser },
    rules: {
      'no-restricted-imports': restricted(
        [
          ['node:*', 'electron', 'electron/*', '@electron/*'],
          desktopMainForbidden,
          desktopWorkspaceRelative,
          ['../**/main/**', '../**/preload/**'],
        ],
        nodeImports,
      ),
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ImportExpression',
          message: 'UI レンダラーの依存は静的 import で明示してください。',
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
