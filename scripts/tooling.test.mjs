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
test('UI レンダラーの試験は node:test・node:assert だけを足せて、Electron・Node の他の API・main は読み込めない', async () => {
  assert.deepEqual(
    await violations(
      "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { Button } from '@heroui/react';\nexport const probe = [assert, test, Button];\n",
      'apps/desktop/src/renderer/probe.test.tsx',
    ),
    [],
  );
  // 画面と同じく、接続の状態機械（@buddy/client）・ws・OS アダプター（自宅の指紋の出口を含む）も読み込めない
  // （レビューの指摘 L1: 試験の設定が main の拒否の一覧を使い、これらを通していた）。
  for (const specifier of [
    'electron',
    'node:fs',
    'fs',
    'assert',
    '@buddy/core',
    '../main/device-controller.js',
    '@buddy/client',
    'ws',
    '@buddy/platform',
    '@buddy/platform/home-fingerprint',
  ])
    assert.ok(
      restrictedImport(
        await violations(
          `export * from '${specifier}';\n`,
          'apps/desktop/src/renderer/probe.test.ts',
        ),
      ),
      specifier,
    );
  // 試験でない画面のファイルは node:test も読み込めない。
  assert.ok(
    restrictedImport(
      await violations(
        "export { test } from 'node:test';\n",
        'apps/desktop/src/renderer/probe.tsx',
      ),
    ),
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
test('模擬 provider の試験用の出口は、Core の製品コードとアダプターから静的にも動的にも読めない（ADR 0028）', async () => {
  const specifiers = ['@buddy/connectors/testing'];
  // Core の製品コード: 静的 import は no-restricted-imports、動的 import は no-restricted-syntax で拒否する。
  for (const specifier of specifiers) {
    const staticImport = await violations(
      `export * from '${specifier}';\n`,
      'apps/core/src/probe.ts',
    );
    assert.ok(
      staticImport.some((m) => m.ruleId === 'no-restricted-imports'),
      specifier,
    );
    const dynamicImport = await violations(
      `export const load = () => import('${specifier}');\n`,
      'apps/core/src/probe.ts',
    );
    assert.ok(
      dynamicImport.some((m) => m.ruleId === 'no-restricted-syntax'),
      specifier,
    );
  }
  // Core の試験と試験の道具だけは読める。
  for (const filePath of [
    'apps/core/src/probe.test.ts',
    'apps/core/src/probe-test-support.ts',
  ])
    assert.deepEqual(
      await violations(
        "export * from '@buddy/connectors/testing';\nexport const load = () => import('@buddy/connectors/testing');\n",
        filePath,
      ),
      [],
      filePath,
    );
  // 試験の道具を経由した抜け道を塞ぐ: 製品コードは *-test-support を読み込めず、
  // 試験の例外は公開の出口 @buddy/connectors/testing に限る（connectors の内部の src は読めない）。
  assert.ok(
    (
      await violations(
        "export * from './probe-test-support.js';\n",
        'apps/core/src/probe.ts',
      )
    ).some((m) => m.ruleId === 'no-restricted-imports'),
    'product -> test-support',
  );
  for (const specifier of [
    '@buddy/connectors/dist/provider/server.js',
    '../../../packages/connectors/src/provider/server.js',
  ])
    assert.ok(
      (
        await violations(
          `export * from '${specifier}';\n`,
          'apps/core/src/probe.test.ts',
        )
      ).some((m) => m.ruleId === 'no-restricted-imports'),
      specifier,
    );
  // 製品コードは、文字列の動的 import でも、試験ファイル・crash-child を経由する再 export でも、試験の道具を読めない。
  for (const specifier of [
    './probe-test-support.js',
    './probe.test.js',
    './crash-child.js',
  ]) {
    assert.ok(
      (
        await violations(
          `export * from '${specifier}';\n`,
          'apps/core/src/probe.ts',
        )
      ).some((m) => m.ruleId === 'no-restricted-imports'),
      `static ${specifier}`,
    );
    assert.ok(
      (
        await violations(
          `export const load = () => import('${specifier}');\n`,
          'apps/core/src/probe.ts',
        )
      ).some((m) => m.ruleId === 'no-restricted-syntax'),
      `dynamic ${specifier}`,
    );
  }
  // アダプターと公開出口: 静的 import・動的 import のどちらも拒否する。
  for (const filePath of [
    'packages/connectors/src/adapter/probe.ts',
    'packages/connectors/src/index.ts',
  ]) {
    assert.ok(
      (
        await violations("export * from '../provider/server.js';\n", filePath)
      ).some((m) => m.ruleId === 'no-restricted-imports'),
      filePath,
    );
    assert.ok(
      (
        await violations(
          "export const load = () => import('../testing.js');\n",
          filePath,
        )
      ).some((m) => m.ruleId === 'no-restricted-syntax'),
      filePath,
    );
  }
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

test('端末側の接続（packages/client）は Node・Electron・中枢・OS アダプターを読み込めず、試験だけが Node を使える', async () => {
  for (const specifier of [
    'node:fs',
    'fs',
    'node:tls',
    'electron',
    'ws',
    '@buddy/core',
    '@buddy/platform',
    '@buddy/storage',
    '@buddy/desktop',
    '../../domain/src/index.js',
  ])
    assert.ok(
      restrictedImport(
        await violations(
          `export * from '${specifier}';\n`,
          'packages/client/src/probe.ts',
        ),
      ),
      specifier,
    );
  const dynamic = await violations(
    "export const load = () => import('@buddy/domain');\n",
    'packages/client/src/probe.ts',
  );
  assert.ok(
    dynamic.some((message) => message.ruleId === 'no-restricted-syntax'),
  );
  assert.deepEqual(
    await violations(
      "import { applyEvents } from '@buddy/domain';\nimport type { Bootstrap } from '@buddy/contracts';\nexport const probe = (b: Bootstrap) => [applyEvents, b];\n",
      'packages/client/src/probe.ts',
    ),
    [],
  );
  assert.deepEqual(
    await violations(
      "import test from 'node:test';\nimport { readFileSync } from 'node:fs';\nexport const probe = [test, readFileSync];\n",
      'packages/client/src/probe.test.ts',
    ),
    [],
  );
  assert.ok(
    restrictedImport(
      await violations(
        "export * from '@buddy/core';\n",
        'packages/client/src/probe.test.ts',
      ),
    ),
  );
});

test('デスクトップの main は接続の状態機械・ws・自宅の指紋の収集だけを読み込め、試験だけが中枢を起動できる（ADR 0025）', async () => {
  for (const file of [
    'apps/desktop/src/main/probe.ts',
    'apps/desktop/src/main/electron/probe.ts',
  ]) {
    assert.deepEqual(
      await violations(
        "export { ClientConnection } from '@buddy/client';\nexport { WebSocket } from 'ws';\nexport { createHomeFingerprintCollector } from '@buddy/platform/home-fingerprint';\n",
        file,
      ),
      [],
      file,
    );
    for (const specifier of [
      '@buddy/platform',
      '@buddy/platform/key-store',
      '@buddy/core',
      '@buddy/storage',
    ])
      assert.ok(
        restrictedImport(
          await violations(`export * from '${specifier}';\n`, file),
        ),
        `${file}: ${specifier}`,
      );
  }
  // 試験と試験の道具は同じプロセスの中枢・保存・模擬の KeyStore を使える（Electron は使えない）。
  for (const file of [
    'apps/desktop/src/main/probe.test.ts',
    'apps/desktop/src/main/hub-test-support.ts',
  ]) {
    assert.deepEqual(
      await violations(
        "export { startCore } from '@buddy/core';\nexport { createMockKeyStore } from '@buddy/platform';\nexport { sealOperationIntent } from '@buddy/storage';\n",
        file,
      ),
      [],
      file,
    );
    assert.ok(
      restrictedImport(
        await violations("export { app } from 'electron';\n", file),
      ),
      file,
    );
  }
  // UI レンダラーは接続の状態機械・ws・指紋の収集を読み込めない。
  for (const specifier of [
    '@buddy/client',
    'ws',
    '@buddy/platform/home-fingerprint',
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
});
