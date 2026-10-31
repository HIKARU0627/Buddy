// B06-07a-1: Core の起動の順序（台帳のファイルの同期 → 掃除 → ゲートが開く）と、時計の状態ファイル・制御チャネルの
// 採り直し（ADR 0058）。鍵は模擬の KeyStore、DB とファイルは一時ディレクトリ。実機・実 API は使わない。

import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createMockKeyStore } from '@buddy/platform';
import { openWriteConnection, storagePlatform } from '@buddy/storage';
import { onCleanup } from './api-test-support.js';
import { parseClockState } from './clock-state.js';
import { callControl } from './control-channel.js';
import { CoreStartError, startCore } from './core.js';
import type { CoreHandle } from './core.js';
import { RecordingNoticeSink } from './notice-sink.js';
import { CLOCK_STATE_FILE, DB_FILE, FORGET_LEDGER_FILE } from './paths.js';

const KEY = Buffer.alloc(32, 0x41);

async function tempDataDir(t: test.TestContext): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), 'buddy-retention-'));
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

const readClock = async (dataDir: string) =>
  parseClockState(await readFile(join(dataDir, CLOCK_STATE_FILE), 'utf8'));

// 2001 年の発言（とっくに期限切れ）を DB に直接足す。Core は止めてから呼ぶ。
function insertExpiredTurn(dataDir: string): string {
  const turnId = randomUUID();
  const db = openWriteConnection(join(dataDir, DB_FILE), {
    platform: storagePlatform(),
  });
  try {
    const sessionId = randomUUID();
    db.prepare(
      "INSERT INTO sessions (session_id, storage_mode, display_device_id, route_revision, summary_blob_id, created_at, ended_at) VALUES (?, 'normal', NULL, 0, NULL, 1000000000000, NULL)",
    ).run(sessionId);
    const blobId = randomUUID();
    db.prepare(
      "INSERT INTO sealed_blobs (blob_id, purpose, owner_table, owner_id, owner_version, format_version, key_id, nonce, ciphertext, tag, created_at, delete_at) VALUES (?, 'turn_text', 'turns', ?, 0, 1, 'k-test', ?, ?, ?, 1000, NULL)",
    ).run(blobId, turnId, randomBytes(12), randomBytes(24), randomBytes(16));
    db.prepare(
      "INSERT INTO turns (turn_id, session_id, role, input_kind, text_blob_id, created_at, expires_at) VALUES (?, ?, 'user', 'text', ?, 1000000000000, 1000604800000)",
    ).run(turnId, sessionId, blobId);
  } finally {
    db.close();
  }
  return turnId;
}

function turnCount(dataDir: string): number {
  const db = openWriteConnection(join(dataDir, DB_FILE), {
    platform: storagePlatform(),
  });
  try {
    return db.prepare('SELECT count(*) FROM turns').pluck().get() as number;
  } finally {
    db.close();
  }
}

test('startup: the first start creates the clock file and opens the gate only after the first sweep; a restart keeps it', async (t) => {
  const dataDir = await tempDataDir(t);
  const first = await start(t, dataDir);
  // 起動の直後（掃除が済む前）は閉じている可能性があるので、済むまで待ってから確かめる。
  await first.retention.idle();
  await first.retention.drain();
  assert.deepEqual(first.retention.gate().reasons, []);
  const created = await readClock(dataDir);
  assert.equal((created?.revision ?? 0) >= 1, true);
  assert.equal(created?.epoch, first.coreInstanceId);
  await first.stop('test');
  const second = await start(t, dataDir);
  await second.retention.idle();
  assert.deepEqual(second.retention.gate().reasons, []);
  const again = await readClock(dataDir);
  assert.equal(again?.epoch, second.coreInstanceId);
  assert.equal((again?.revision ?? 0) >= (created?.revision ?? 0), true);
  await second.stop('test');
});

test('startup: the ledger file is synced before the first sweep — a ledger refusal means no sweep ran at all', async (t) => {
  const dataDir = await tempDataDir(t);
  const first = await start(t, dataDir);
  await first.retention.idle();
  await first.stop('test');
  const before = await readClock(dataDir);
  const turnId = insertExpiredTurn(dataDir);
  assert.ok(turnId);
  // 壊れた台帳のファイル。起動は台帳の同期で止まり、掃除は一度も動かない。
  await writeFile(join(dataDir, FORGET_LEDGER_FILE), '{"schema":');
  await assert.rejects(start(t, dataDir), (error: unknown) => {
    assert(error instanceof CoreStartError);
    assert.deepEqual(error.reasons, [
      'forget_ledger_file',
      'ledger_file_invalid',
    ]);
    return true;
  });
  assert.equal(turnCount(dataDir), 1);
  const stillBefore = await readClock(dataDir);
  assert.deepEqual(stillBefore, before);
  // 台帳のファイルを直すと、同じ起動で台帳の同期の後に掃除が動き、期限切れの発言が消えてゲートが開く。
  await rm(join(dataDir, FORGET_LEDGER_FILE));
  const sink = new RecordingNoticeSink();
  const ok = await start(t, dataDir, sink);
  await ok.retention.idle();
  assert.equal(turnCount(dataDir), 0);
  assert.deepEqual(ok.retention.gate().reasons, []);
  assert.equal(sink.notices.length, 1);
  assert.equal(sink.notices[0]?.reason, 'retention_due');
  assert.deepEqual(sink.notices[0]?.items, [
    { item_kind: 'turn', item_id: turnId },
  ]);
  await ok.stop('test');
});

test('startup: before the first sweep ends the gate is closed for search, send and auto use', async (t) => {
  const dataDir = await tempDataDir(t);
  const handle = await start(t, dataDir);
  // idle() を待たずに見ると、掃除の記録が済むまで閉じている（済んでいれば開いている）。閉じているときの理由は
  // 掃除が済んでいないことだけ。
  const early = handle.retention.gate();
  if (!early.search) {
    assert.ok(
      early.reasons.every(
        (reason) =>
          reason === 'sweep_not_started' || reason === 'sweep_running',
      ),
      early.reasons.join(),
    );
    assert.equal(early.cloud_send, false);
    assert.equal(early.auto_use, false);
  }
  await handle.retention.idle();
  assert.equal(handle.retention.gate().search, true);
  await handle.stop('test');
});

test('control: a deleted clock file stops auto use, and the person re-takes it through the local control channel', async (t) => {
  const dataDir = await tempDataDir(t);
  const first = await start(t, dataDir);
  await first.retention.idle();
  await first.stop('test');
  await rm(join(dataDir, CLOCK_STATE_FILE));
  const handle = await start(t, dataDir);
  await handle.retention.idle();
  assert.deepEqual(handle.retention.gate().reasons, ['clock_state_missing']);
  assert.equal(handle.retention.gate().search, false);
  // 判定できない間もファイルを作らない。
  await assert.rejects(readFile(join(dataDir, CLOCK_STATE_FILE)));

  const status = await callControl(handle.endpoint, 'clock_status', 5000);
  assert.equal(status.kind, 'response');
  if (status.kind !== 'response') return;
  const clock = status.body['clock'] as {
    state: string;
    revision: string;
    last_checked_at: string | null;
    now: string;
    needs_recheck: boolean;
  };
  assert.equal(clock.state, 'missing');
  assert.equal(clock.revision, 'missing');
  assert.equal(clock.last_checked_at, null);
  assert.equal(clock.needs_recheck, true);

  // 見た値と違う版は拒否される。
  const wrong = await callControl(handle.endpoint, 'clock_recheck', 5000, {
    revision: '7',
    observed_last_checked_at: null,
    observed_now: clock.now,
  });
  assert.equal(wrong.kind, 'response');
  if (wrong.kind === 'response')
    assert.deepEqual(wrong.body['reason'], 'revision_mismatch');
  await assert.rejects(readFile(join(dataDir, CLOCK_STATE_FILE)));

  const done = await callControl(handle.endpoint, 'clock_recheck', 5000, {
    revision: clock.revision,
    observed_last_checked_at: null,
    observed_now: clock.now,
  });
  assert.equal(done.kind, 'response');
  if (done.kind === 'response') assert.equal(done.body['ok'], true);
  await handle.retention.drain();
  await handle.retention.idle();
  assert.deepEqual(handle.retention.gate().reasons, []);
  const written = await readClock(dataDir);
  assert.equal(written?.rechecks.length, 1);
  assert.equal(written?.rechecks[0]?.from_last_checked_at, null);
  await handle.stop('test');
});

test('control: malformed clock requests are refused before they reach the sweep', async (t) => {
  const dataDir = await tempDataDir(t);
  const handle = await start(t, dataDir);
  await handle.retention.idle();
  for (const fields of [
    // 版の形が違う。
    {
      revision: '01',
      observed_last_checked_at: null,
      observed_now: '2031-06-01T00:00:00Z',
    },
    // 時刻の形が違う（タイムゾーン付き）。
    {
      revision: '1',
      observed_last_checked_at: null,
      observed_now: '2031-06-01T09:00:00+09:00',
    },
    // 暦にない日付。
    {
      revision: '1',
      observed_last_checked_at: '2031-02-30T00:00:00Z',
      observed_now: '2031-06-01T00:00:00Z',
    },
  ]) {
    const result = await callControl(
      handle.endpoint,
      'clock_recheck',
      5000,
      fields,
    );
    assert.equal(result.kind, 'response');
    if (result.kind === 'response') {
      assert.equal(result.body['ok'], false);
      assert.equal(result.body['error'], 'invalid_request');
    }
  }
  await handle.stop('test');
});
