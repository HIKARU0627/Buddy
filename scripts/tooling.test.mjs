import assert from 'node:assert/strict';
import test from 'node:test';
import { ESLint } from 'eslint';

const eslint = new ESLint();
async function violations(code, filePath) {
  const [result] = await eslint.lintText(code, { filePath });
  return result.messages.filter((message) => message.severity === 2);
}

test('共有層は OS に依存しない TypeScript を受け付ける', async () => {
  assert.deepEqual(
    await violations(
      'export const answer = 42;\n',
      'packages/domain/src/probe.ts',
    ),
    [],
  );
});
test('共有層では node: と bare の両方の Node import を拒否する', async () => {
  for (const specifier of ['node:fs', 'fs', 'fs/promises']) {
    const messages = await violations(
      `export { readFile } from '${specifier}';\n`,
      'packages/domain/src/probe.ts',
    );
    assert.ok(
      messages.some((message) => message.ruleId === 'no-restricted-imports'),
      specifier,
    );
  }
});
test('domain から storage / Core / Electron への直接依存を拒否する', async () => {
  for (const specifier of [
    '@buddy/storage',
    '@buddy/core',
    'electron',
    '../../storage/src/index.js',
  ]) {
    const messages = await violations(
      `export * from '${specifier}';\n`,
      'packages/domain/src/probe.ts',
    );
    assert.ok(
      messages.some((message) => message.ruleId === 'no-restricted-imports'),
      specifier,
    );
  }
});
test('共有層の動的 import で依存検査を回避できない', async () => {
  const messages = await violations(
    "export const load = () => import('node:fs');\n",
    'packages/contracts/src/probe.ts',
  );
  assert.ok(
    messages.some((message) => message.ruleId === 'no-restricted-syntax'),
  );
});
const restrictedImport = (messages) =>
  messages.some((message) => message.ruleId === 'no-restricted-imports');

test('デスクトップの UI レンダラーは Electron・Node・中枢・OS アダプター・main を読み込めない', async () => {
  for (const specifier of [
    'electron',
    'node:fs',
    'fs',
    '@buddy/core',
    '@buddy/platform',
    '@buddy/storage',
    '../main/device-controller.js',
    '../preload/preload.cjs',
    '../../../../packages/domain/src/index.js',
  ])
    assert.ok(
      restrictedImport(
        await violations(
          `export * from '${specifier}';\n`,
          'apps/desktop/src/renderer/probe.tsx',
        ),
      ),
      specifier,
    );
  const dynamic = await violations(
    "export const load = () => import('electron');\n",
    'apps/desktop/src/renderer/probe.ts',
  );
  assert.ok(
    dynamic.some((message) => message.ruleId === 'no-restricted-syntax'),
  );
  assert.deepEqual(
    await violations(
      "import { useState } from 'react';\nimport type { DesktopStatusBar } from '@buddy/contracts';\nexport const probe = (s: DesktopStatusBar) => [useState, s];\n",
      'apps/desktop/src/renderer/probe.tsx',
    ),
    [],
  );
});
test('デスクトップの preload は electron の contextBridge・ipcRenderer だけを読み込める', async () => {
  assert.deepEqual(
    await violations(
      "import { contextBridge, ipcRenderer } from 'electron';\nexport const probe = [contextBridge, ipcRenderer];\n",
      'apps/desktop/src/preload/probe.cts',
    ),
    [],
  );
  for (const code of [
    "import { shell } from 'electron';\nexport const probe = shell;\n",
    "import { readFile } from 'node:fs';\nexport const probe = readFile;\n",
    "import { readFile } from 'fs';\nexport const probe = readFile;\n",
    "import { DESKTOP_IPC_CHANNELS } from '@buddy/domain';\nexport const probe = DESKTOP_IPC_CHANNELS;\n",
    "import { probe as other } from './other.cjs';\nexport const probe = other;\n",
  ])
    assert.ok(
      restrictedImport(
        await violations(code, 'apps/desktop/src/preload/probe.cts'),
      ),
      code,
    );
});
test('デスクトップの main は中枢・OS アダプターを読み込まず、純粋なモジュールは Electron も読み込まない', async () => {
  for (const specifier of [
    '@buddy/core',
    '@buddy/platform',
    '../../renderer/App.js',
    '../../../../../packages/domain/src/desktop.js',
  ])
    assert.ok(
      restrictedImport(
        await violations(
          `export * from '${specifier}';\n`,
          'apps/desktop/src/main/electron/probe.ts',
        ),
      ),
      specifier,
    );
  // Electron のアダプターは electron と Node 組み込みを使える。
  assert.deepEqual(
    await violations(
      "export { app } from 'electron';\nexport { readFile } from 'node:fs/promises';\n",
      'apps/desktop/src/main/electron/probe.ts',
    ),
    [],
  );
  assert.ok(
    restrictedImport(
      await violations(
        "export { app } from 'electron';\n",
        'apps/desktop/src/main/probe.ts',
      ),
    ),
  );
  assert.deepEqual(
    await violations(
      "export { admitDesktopRequest } from '@buddy/domain';\nexport { readFileSync } from 'node:fs';\n",
      'apps/desktop/src/main/probe.ts',
    ),
    [],
  );
});
test('Core の Electron 依存を拒否し Node 組み込みは受け付ける', async () => {
  const forbidden = await violations(
    "export { app } from 'electron';\n",
    'apps/core/src/probe.ts',
  );
  assert.ok(
    forbidden.some((message) => message.ruleId === 'no-restricted-imports'),
  );
  assert.deepEqual(
    await violations(
      "export { readFile } from 'node:fs/promises';\n",
      'apps/core/src/probe.ts',
    ),
    [],
  );
  // 動的 import の @electron/* も拒否する（以前の正規表現は @electron/remote を見逃していた）。
  for (const specifier of ['electron', '@electron/remote'])
    assert.ok(
      (
        await violations(
          `export const load = () => import('${specifier}');\n`,
          'apps/core/src/probe.ts',
        )
      ).some((message) => message.ruleId === 'no-restricted-syntax'),
      specifier,
    );
});
test('共有層から platform への直接依存を拒否する', async () => {
  for (const [filePath, specifiers] of [
    [
      'packages/domain/src/probe.ts',
      [
        '@buddy/platform',
        '@buddy/platform/macos',
        '../../platform/src/index.js',
      ],
    ],
    [
      'packages/contracts/src/probe.ts',
      ['@buddy/platform', '../../platform/src/index.js'],
    ],
  ]) {
    for (const specifier of specifiers) {
      const messages = await violations(
        `export * from '${specifier}';\n`,
        filePath,
      );
      assert.ok(
        messages.some((message) => message.ruleId === 'no-restricted-imports'),
        `${filePath}: ${specifier}`,
      );
    }
  }
  const dynamic = await violations(
    "export const load = () => import('@buddy/platform');\n",
    'packages/domain/src/probe.ts',
  );
  assert.ok(
    dynamic.some((message) => message.ruleId === 'no-restricted-syntax'),
  );
});
test('platform の Electron・Core 依存を拒否し Node 組み込みは受け付ける', async () => {
  for (const specifier of [
    'electron',
    'electron/main',
    '@electron/remote',
    '@buddy/desktop',
    '@buddy/core',
    '../../../apps/core/src/index.js',
  ]) {
    const messages = await violations(
      `export * from '${specifier}';\n`,
      'packages/platform/src/probe.ts',
    );
    assert.ok(
      messages.some((message) => message.ruleId === 'no-restricted-imports'),
      specifier,
    );
  }
  for (const specifier of ['electron', '@electron/remote', '@buddy/core']) {
    const messages = await violations(
      `export const load = () => import('${specifier}');\n`,
      'packages/platform/src/probe.ts',
    );
    assert.ok(
      messages.some((message) => message.ruleId === 'no-restricted-syntax'),
      specifier,
    );
  }
  assert.deepEqual(
    await violations(
      "export { execFile } from 'node:child_process';\nexport const load = () => import('node:fs/promises');\n",
      'packages/platform/src/probe.ts',
    ),
    [],
  );
});
