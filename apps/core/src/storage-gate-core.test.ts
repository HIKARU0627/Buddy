// B06-07a-2: 実 Core の起動で、保存境界の保持者が時計の状態ファイルの世代を引き継ぎ、再起動の後に記録しない会話の終了を
// 知らせること（Q7、ADR 0059）。鍵は模擬の KeyStore、DB とファイルは一時ディレクトリ。実機・実 API は使わない。

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createMockKeyStore } from '@buddy/platform';
import { createApiContract } from './api-contract.js';
import { onCleanup } from './api-test-support.js';
import { parseClockState } from './clock-state.js';
import { startCore } from './core.js';
import type { CoreHandle } from './core.js';
import { RecordingNoticeSink } from './notice-sink.js';
import { CLOCK_STATE_FILE } from './paths.js';

const KEY = Buffer.alloc(32, 0x41);

async function tempDataDir(t: test.TestContext): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), 'buddy-sgc-'));
  onCleanup(t, () =>
    rm(base, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    }).catch(() => undefined),
  );
  return join(base, 'data');
}

async function start(
  t: test.TestContext,
  dataDir: string,
  notices?: RecordingNoticeSink,
): Promise<CoreHandle> {
  const handle = await startCore({
    dataDir,
    keyStore: createMockKeyStore({ stored: KEY.toString('base64') }),
    shutdownGraceMs: 200,
    probeTimeoutMs: 300,
    ...(notices === undefined ? {} : { retention: { notices } }),
  });
  onCleanup(t, async () => {
    await handle.stop('test').catch(() => undefined);
  });
  return handle;
}

const readBoundary = async (dataDir: string) =>
  parseClockState(await readFile(join(dataDir, CLOCK_STATE_FILE), 'utf8'))
    ?.storage_boundary;

test('core: a private segment is left open at stop — the next start returns to a normal segment, announces it, and keeps rejecting the old private origin', async (t) => {
  const dataDir = await tempDataDir(t);
  const first = await start(t, dataDir);
  // 初めての起動のファイルは最初の掃除が作る。済んでから入る。
  await first.retention.idle();
  assert.equal(first.storage.mode, 'normal');
  assert.equal(await readBoundary(dataDir), null);
  const entered = await first.storage.enterPrivate();
  assert.equal(entered.ok, true);
  assert.equal(first.storage.privateConversation(), true);
  const privateOrigin = entered.ok ? entered.origin : null;
  assert.equal(privateOrigin?.segment_generation, '2');
  assert.deepEqual(await readBoundary(dataDir), {
    segment_generation: '2',
    private_open: true,
  });
  const clockBefore = parseClockState(
    await readFile(join(dataDir, CLOCK_STATE_FILE), 'utf8'),
  );
  await first.stop('test');

  const sink = new RecordingNoticeSink();
  const second = await start(t, dataDir, sink);
  assert.equal(second.storage.mode, 'normal');
  assert.equal(second.storage.privateConversation(), false);
  // 世代は戻らない（2 の次の 3）。古い記録しない由来は、世代・区切りの ID のどちらでも拒否する。
  assert.equal(second.storage.origin().segment_generation, '3');
  assert.equal(second.storage.originRejection(privateOrigin), 'origin_private');
  assert.deepEqual(await readBoundary(dataDir), {
    segment_generation: '3',
    private_open: false,
  });
  assert.equal(sink.boundaryNotices.length, 1);
  const notice = sink.boundaryNotices[0];
  assert.equal(notice?.ended_generation, '2');
  assert.equal(notice?.segment_generation, '3');
  assert.equal(notice?.segment_id, second.storage.origin().segment_id);
  assert.equal(
    createApiContract().valid('StorageBoundaryNotice', notice),
    true,
  );
  // 時計の判定に使う欄は世代の書き込みで動かない（掃除は起動ごとに自分の欄を更新する）。
  const clockAfter = parseClockState(
    await readFile(join(dataDir, CLOCK_STATE_FILE), 'utf8'),
  );
  assert.equal(clockAfter?.rechecks.length, clockBefore?.rechecks.length);
  await second.stop('test');
  // 3 回目の起動は通常の区切りの継続なので、知らせない（世代は 4）。
  const third = await start(t, dataDir, sink);
  assert.equal(third.storage.origin().segment_generation, '4');
  assert.equal(sink.boundaryNotices.length, 1);
});

test('core: entering a private segment is refused while the clock file is missing (nowhere to put the generation), and nothing is created', async (t) => {
  const dataDir = await tempDataDir(t);
  const first = await start(t, dataDir);
  await first.retention.idle();
  await first.stop('test');
  await rm(join(dataDir, CLOCK_STATE_FILE));
  const second = await start(t, dataDir);
  await second.retention.idle();
  assert.deepEqual(await second.storage.enterPrivate(), {
    ok: false,
    reason: 'persist_unavailable',
  });
  assert.equal(second.storage.privateConversation(), false);
  await assert.rejects(readFile(join(dataDir, CLOCK_STATE_FILE)), /ENOENT/u);
});

test('core: the sweeper keeps writing its clock fields without dropping the generation', async (t) => {
  const dataDir = await tempDataDir(t);
  const first = await start(t, dataDir);
  await first.retention.idle();
  assert.equal((await first.storage.enterPrivate()).ok, true);
  // 掃除をもう一度動かす（最終確認時刻の更新はファイルへ書く）。世代の欄は残る。
  await first.retention.runOnce(true);
  await first.retention.idle();
  assert.deepEqual(await readBoundary(dataDir), {
    segment_generation: '2',
    private_open: true,
  });
});
