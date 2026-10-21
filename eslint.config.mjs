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
    paths: paths.map((entry) =>
      typeof entry === 'string'
        ? {
            name: entry,
            message: '共有層へ Node.js / OS 固有依存を持ち込まないでください。',
          }
        : entry,
    ),
    patterns: groups.map((group) => ({
      group,
      message: 'ワークスペースの依存方向を確認してください。',
    })),
  },
];

// デスクトップの main から読み込まない別ワークスペース（ADR 0012・0015）。中枢（Core）・保存には HTTPS / WSS
// でだけ接続し、コードを読み込まない。OS アダプターは自宅の指紋の収集の出口
// （@buddy/platform/home-fingerprint）だけを読み込める（B03-05、ADR 0025）。
// gitignore の形式では親（@buddy/platform）を除外すると子を戻せないため、パッケージの入口そのものは
// desktopMainForbiddenPaths で拒否する。
const desktopMainForbiddenPaths = [
  {
    name: '@buddy/platform',
    message:
      'デスクトップの main は @buddy/platform/home-fingerprint だけを読み込めます。',
  },
];
const desktopMainForbidden = [
  '@buddy/core',
  '@buddy/core/*',
  '@buddy/platform/*',
  '!@buddy/platform/home-fingerprint',
  '@buddy/storage',
  '@buddy/storage/*',
  '@buddy/desktop',
  '@buddy/desktop/*',
];
// UI レンダラーは画面だけ。中枢・OS アダプター・接続の状態機械（@buddy/client）・ws を読み込まない。
const desktopRendererForbidden = [
  '@buddy/core',
  '@buddy/core/*',
  '@buddy/platform',
  '@buddy/platform/*',
  '@buddy/storage',
  '@buddy/storage/*',
  '@buddy/desktop',
  '@buddy/desktop/*',
  '@buddy/client',
  '@buddy/client/*',
  'ws',
  'ws/*',
];
// main の試験と試験の道具だけは、同じプロセスで中枢（startCore）・保存（操作の命令）・OS アダプターの模擬
// （模擬の KeyStore）を起動して 2 クライアントの統合試験を行う（B03-05、ADR 0025）。製品のコードからは読み込めない。
const desktopMainTestFiles = [
  'apps/desktop/src/main/*.test.ts',
  'apps/desktop/src/main/hub-test-support.ts',
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
  // 端末側の接続の純粋な部分（B03-05、ADR 0025）。Node・DOM・Electron・中枢・OS アダプターを読み込まない。
  // 公開出口の @buddy/domain・@buddy/contracts だけを使う。
  {
    files: ['packages/client/**/*.ts'],
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
            '@buddy/client',
            '@buddy/client/*',
          ],
          [
            '../**/packages/**',
            '../**/apps/**',
            '../**/contracts/**',
            '../**/domain/**',
            '../**/storage/**',
            '../**/platform/**',
            '../**/core/**',
            '../**/desktop/**',
          ],
          ['ws', 'ws/*'],
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
    // client の試験と模擬だけは Node の test runner・assert・fs と Ajv を使う（製品のコードからは読み込めない）。
    files: [
      'packages/client/src/**/*.test.ts',
      'packages/client/src/test-support.ts',
    ],
    languageOptions: { globals: globals.node },
    rules: {
      'no-restricted-imports': restricted([
        ['electron', 'electron/*', '@electron/*'],
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
          '../**/packages/**',
          '../**/apps/**',
          '../**/contracts/**',
          '../**/domain/**',
          '../**/storage/**',
          '../**/platform/**',
          '../**/core/**',
          '../**/desktop/**',
        ],
      ]),
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
      'no-restricted-imports': restricted(
        [
          desktopMainForbidden,
          desktopWorkspaceRelative,
          ['../**/renderer/**', '../**/preload/**'],
        ],
        desktopMainForbiddenPaths,
      ),
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
      'no-restricted-imports': restricted(
        [
          desktopMainForbidden,
          desktopWorkspaceRelative,
          ['../**/renderer/**', '../**/preload/**'],
          ['electron', 'electron/*', '@electron/*'],
        ],
        desktopMainForbiddenPaths,
      ),
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
    files: desktopMainTestFiles,
    rules: {
      'no-restricted-imports': restricted([
        ['@buddy/desktop', '@buddy/desktop/*'],
        desktopWorkspaceRelative,
        ['../**/renderer/**', '../**/preload/**'],
        ['electron', 'electron/*', '@electron/*'],
      ]),
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'ImportExpression[source.value=/^(electron|@electron)(\\/|$)/]',
          message: 'main の試験は Electron へ依存しません。',
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
          desktopRendererForbidden,
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
