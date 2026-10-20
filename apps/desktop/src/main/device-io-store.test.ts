// io_epoch と停止の範囲の保存・復元（ADR 0015 の決定 2）。一時ディレクトリだけを使う。期待値は手で書く。
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  DEVICE_IO_STATE_FILE,
  loadDeviceIoRecord,
  parseDeviceIoRecord,
  saveDeviceIoRecord,
} from './device-io-store.js';

// 2026-10-20T00:00:00Z の UTC ミリ秒（date コマンドで別に確かめた値）。
const NOW = new Date('2026-10-20T00:00:00.000Z');
const NOW_MS = '1792454400000';

function withDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'buddy-desktop-store-'));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the first start has no file and begins at epoch 0 without a stop', () => {
  withDir((dir) => {
    assert.deepEqual(loadDeviceIoRecord(join(dir, DEVICE_IO_STATE_FILE), NOW), {
      kind: 'missing',
      record: { io_epoch: '0', stop_scope: 'none' },
    });
  });
});

test('a saved record is restored and holds only io_epoch and stop_scope', () => {
  withDir((dir) => {
    const path = join(dir, 'nested', DEVICE_IO_STATE_FILE);
    saveDeviceIoRecord(path, { io_epoch: '7', stop_scope: 'local' });
    assert.equal(
      readFileSync(path, 'utf8'),
      '{"io_epoch":"7","stop_scope":"local"}\n',
    );
    assert.deepEqual(loadDeviceIoRecord(path, NOW), {
      kind: 'loaded',
      record: { io_epoch: '7', stop_scope: 'local' },
    });
    saveDeviceIoRecord(path, { io_epoch: '7', stop_scope: 'none' });
    assert.deepEqual(loadDeviceIoRecord(path, NOW), {
      kind: 'loaded',
      record: { io_epoch: '7', stop_scope: 'none' },
    });
    // 一時ファイルを残さない。
    assert.deepEqual(readdirSync(join(dir, 'nested')), [DEVICE_IO_STATE_FILE]);
  });
});

test('an invalid record is not saved', () => {
  withDir((dir) => {
    const path = join(dir, DEVICE_IO_STATE_FILE);
    assert.throws(
      () => saveDeviceIoRecord(path, { io_epoch: '-1', stop_scope: 'none' }),
      /invalid_epoch/u,
    );
    assert.deepEqual(readdirSync(dir), []);
  });
});

test('a broken file is treated as stopped with an epoch above any saved counter', () => {
  const broken: [string, string | Buffer][] = [
    ['empty', ''],
    ['not JSON', 'io_epoch=3'],
    ['array', '[]'],
    ['extra key', '{"io_epoch":"3","stop_scope":"none","token":"x"}'],
    ['missing key', '{"io_epoch":"3"}'],
    ['guest scope', '{"io_epoch":"3","stop_scope":"guest"}'],
    ['numeric epoch', '{"io_epoch":3,"stop_scope":"none"}'],
    ['leading zero', '{"io_epoch":"03","stop_scope":"none"}'],
    ['invalid UTF-8', Buffer.from([0x7b, 0xff, 0xfe, 0x7d])],
    [
      'too large',
      `{"io_epoch":"3","stop_scope":"none","pad":"${'a'.repeat(5000)}"}`,
    ],
  ];
  for (const [name, content] of broken)
    withDir((dir) => {
      const path = join(dir, DEVICE_IO_STATE_FILE);
      writeFileSync(path, content);
      assert.deepEqual(
        loadDeviceIoRecord(path, NOW),
        { kind: 'corrupt', record: { io_epoch: NOW_MS, stop_scope: 'local' } },
        name,
      );
    });
});

test('a readable epoch in a broken file is never rolled back', () => {
  withDir((dir) => {
    const path = join(dir, DEVICE_IO_STATE_FILE);
    writeFileSync(
      path,
      '{"io_epoch":"99999999999999","stop_scope":"none","extra":true}',
    );
    assert.deepEqual(loadDeviceIoRecord(path, NOW), {
      kind: 'corrupt',
      record: { io_epoch: '100000000000000', stop_scope: 'local' },
    });
  });
});

test('an unreadable path is treated as stopped', () => {
  withDir((dir) => {
    const path = join(dir, DEVICE_IO_STATE_FILE);
    mkdirSync(path);
    assert.deepEqual(loadDeviceIoRecord(path, NOW), {
      kind: 'corrupt',
      record: { io_epoch: NOW_MS, stop_scope: 'local' },
    });
  });
});

test('the parser accepts exactly the two fields', () => {
  assert.deepEqual(
    parseDeviceIoRecord('{"stop_scope":"none","io_epoch":"0"}'),
    {
      io_epoch: '0',
      stop_scope: 'none',
    },
  );
  assert.equal(parseDeviceIoRecord('null'), null);
  assert.equal(
    parseDeviceIoRecord(`{"io_epoch":"${'9'.repeat(31)}","stop_scope":"none"}`),
    null,
  );
});
