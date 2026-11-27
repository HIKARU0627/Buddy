// B06 の統合のケース（B06-09、Issue #145）。保存期限の掃除（apps/core の RetentionSweeper）・記憶と忘却の命令（DB worker）・
// 忘却の Core の経路（ForgetService。公開ゲートは製品では閉じたままで、ここでは試験の組み立てで開いた関数を渡す）・
// バックアップと復元（startCore・runBackupSetup・runRestoreRun）・記録しない会話（製品の Core の HTTPS の流れの経路と
// 保存境界の保持者、音声の制御の模擬の組み立て）をつなぎ、行・知らせ・台帳と、合成の目印の平文・暗号文を探した結果を
// 手書きの期待値（b06-expectations.json）と突き合わせる。
//
// 期待値は設計 03・ADR 0043・0044・0047・0053・0054・0058・0059・0060・0180 の規則から手で導いた値で、実装の関数から作らない。
// 鍵・目印・時刻はすべて合成の値。実機の Mac mini・実際のバックアップの置き場所・実 API・実請求は使わない。
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  decryptBackupPayload,
  manifestPayloadKey,
  openWriteConnection,
  readBackupFileHeader,
  readBackupPayload,
  restoreSourceHmac,
  storagePlatform,
  unwrapBackupKey,
} from '../../packages/storage/dist/index.js';
import { decodeRecoveryCode } from '../../packages/domain/dist/index.js';
import {
  createMockBackupKeyStore,
  createMockKeyStore,
  createMockTlsKeyStore,
} from '../../packages/platform/dist/index.js';
import {
  ManualClock,
  withBudgetStore,
} from '../../apps/core/dist/budget-test-support.js';
import { createForgetService } from '../../apps/core/dist/forget-service.js';
import { RecordingNoticeSink } from '../../apps/core/dist/notice-sink.js';
import {
  RetentionSweeper,
  createRetentionSweepPort,
} from '../../apps/core/dist/retention-sweeper.js';
import {
  createClockStateFile,
  parseClockState,
} from '../../apps/core/dist/clock-state.js';
import { startCore } from '../../apps/core/dist/core.js';
import {
  CLOCK_STATE_FILE,
  DB_FILE,
  FORGET_LEDGER_FILE,
} from '../../apps/core/dist/paths.js';
import { BACKUP_CONFIG_FILE } from '../../apps/core/dist/backup-config.js';
import {
  inspectBackupSetup,
  recordBackupSetup,
  runBackupSetup,
} from '../../apps/core/dist/backup-setup.js';
import { runRestoreRun } from '../../apps/core/dist/restore-run.js';
import { createApiContract } from '../../apps/core/dist/api-contract.js';
import {
  insertDevice,
  pinnedRequest,
} from '../../apps/core/dist/api-test-support.js';
import { TLS_CERTIFICATE_FILE } from '../../apps/core/dist/tls-identity.js';
import {
  A as VOICE_DEVICE,
  liveBody,
  renew,
  withRig,
} from '../../apps/core/dist/voice-rig-test-support.js';
import {
  DATA_KEY,
  DAY,
  HOUR,
  edge,
  filesUnder,
  findResidue,
  insertSession,
  insertTurn,
  marker,
  memorySaveOp,
  openRow,
  residueLabels,
  saveOutcome,
  setSummary,
  shuffled,
  specification,
  storeHmac,
  textSource,
} from './b06-support.mjs';

const contract = createApiContract();
// 保存期限の世界の基準時刻（2031-01-01T00:00:00Z）。
const B = Date.parse('2031-01-01T00:00:00.000Z');
const DEVICE = 'f6000000-0000-4000-8000-000000000001';
const id = (prefix, n) =>
  `${prefix}000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const S = id('a6', 1);
const S2 = id('a6', 2);
const T_DUE = id('b6', 1);
const T_LIVE = id('b6', 2);
const T_SRC = id('b6', 3);
const T_OTHER = id('b6', 4);
const T_S2 = id('b6', 5);
const T_LATE = id('b6', 6);
const M = id('c6', 1);
const L1 = id('c6', 2);
const L2 = id('c6', 3);
const M_OTHER = id('c6', 4);
const M_REVIEW = id('c6', 5);
const M_CONTINUE = id('c6', 6);
const LABELS = new Map([
  [M, 'M'],
  [L1, 'L1'],
  [L2, 'L2'],
  [M_OTHER, 'M_OTHER'],
  [M_REVIEW, 'M_REVIEW'],
  [M_CONTINUE, 'M_CONTINUE'],
  [T_DUE, 'T_DUE'],
  [T_LIVE, 'T_LIVE'],
  [T_SRC, 'T_SRC'],
  [T_OTHER, 'T_OTHER'],
  [T_S2, 'T_S2'],
  [T_LATE, 'T_LATE'],
  [S, 'S'],
  [S2, 'S2'],
]);
const label = (value) => LABELS.get(value) ?? `?${value}`;
const labels = (values) => values.map(label).sort();

const rows = (db, sql, ...args) =>
  db
    .prepare(sql)
    .pluck()
    .all(...args);

// 店の世界（DB worker と一時ディレクトリの DB）。ログは配列に集め、文字列にして目印を探す。
async function withStoreWorld(start, body) {
  await withBudgetStore(
    async (harness) => {
      const logs = [];
      const log = (message) => logs.push(String(message));
      const files = () => ({
        db: join(harness.dir, 'buddy.sqlite'),
        wal: join(harness.dir, 'buddy.sqlite-wal'),
        ledger: join(harness.dir, FORGET_LEDGER_FILE),
        clock: join(harness.dir, CLOCK_STATE_FILE),
      });
      await body({ harness, logs, log, files });
    },
    { start },
  );
}

const dbFiles = (files) => ({ db: files.db, wal: files.wal });

// 記憶の一覧を開いて、見える本文の目印のラベルを返す（陽性の対照）。
async function visibleMemoryMarkers(store, markers, now) {
  const listed = await store.memory({ kind: 'memory.list', limit: 100, now });
  assert.equal(listed.ok, true, JSON.stringify(listed));
  const seen = [];
  for (const row of listed.value.rows) {
    const text = openRow(row.text, 'memories', row.memory_id, 'memory_text');
    for (const [name, value] of Object.entries(markers))
      if (text === value) seen.push(name);
  }
  return seen.sort();
}

function noticeSummary(sink) {
  return sink.notices.map((notice) => ({
    reason: notice.reason,
    items: notice.items.map(
      (item) => `${item.item_kind}:${label(item.item_id)}`,
    ),
  }));
}

// --- 1. 期限の境界と再要約（X16・T06） ---

async function retentionBoundary(seed, round) {
  const text = {
    T_DUE: marker('turn-due', seed, round),
    T_LIVE: marker('turn-live', seed, round),
    T_S2: marker('turn-s2', seed, round),
    SUM_S: marker('summary-s', seed, round),
    SUM_S2: marker('resummary-s2', seed, round),
  };
  const checked = {};
  await withStoreWorld(B, async ({ harness, logs, log, files }) => {
    const ct = {};
    harness.sql((db) => {
      insertSession(db, S, B);
      insertSession(db, S2, B, 'extended');
      ct.T_DUE = insertTurn(db, {
        turnId: T_DUE,
        sessionId: S,
        text: text.T_DUE,
        createdAt: B,
        expiresAt: B + 7 * DAY,
      }).ciphertext;
      ct.T_LIVE = insertTurn(db, {
        turnId: T_LIVE,
        sessionId: S,
        text: text.T_LIVE,
        createdAt: B + 1,
        expiresAt: B + 7 * DAY + 1,
      }).ciphertext;
      // 会話 S2 は延長の保存（30 日）の発言を持つ。
      ct.T_S2 = insertTurn(db, {
        turnId: T_S2,
        sessionId: S2,
        text: text.T_S2,
        createdAt: B + 6 * DAY,
        expiresAt: B + 36 * DAY,
      }).ciphertext;
      // S の要約は T_DUE から。S2 の要約は 6 日目に作り直した再要約で、S の要約と T_S2 から作った（最も早い由来は T_DUE）。
      ct.SUM_S = setSummary(db, S, text.SUM_S, B + HOUR).ciphertext;
      edge(db, 'session_summary', S, 'turn', T_DUE, B + HOUR);
      ct.SUM_S2 = setSummary(db, S2, text.SUM_S2, B + 6 * DAY).ciphertext;
      edge(db, 'session_summary', S2, 'session_summary', S, B + 6 * DAY);
      edge(db, 'session_summary', S2, 'turn', T_S2, B + 6 * DAY);
    });
    const clock = new ManualClock(B);
    const sink = new RecordingNoticeSink();
    const job = new RetentionSweeper({
      port: createRetentionSweepPort(harness.store),
      epoch: randomUUID(),
      now: clock.now,
      notices: sink,
      log,
      vacuumIntervalMs: 0,
    });
    const state = () =>
      harness.sql((db) => ({
        turns: labels(rows(db, 'SELECT turn_id FROM turns')),
        summaries: labels(
          rows(
            db,
            'SELECT session_id FROM sessions WHERE summary_blob_id IS NOT NULL',
          ),
        ),
        // 期限の値は書き換えない（延長しない）。
        live_turn_expires_at: rows(
          db,
          'SELECT expires_at FROM turns WHERE turn_id = ?',
          T_LIVE,
        ).map((value) => new Date(value).toISOString()),
      }));
    const steps = [];
    for (const [name, at] of [
      ['one_ms_before_deadline', B + 7 * DAY - 1],
      ['at_deadline', B + 7 * DAY],
      ['one_ms_after_deadline', B + 7 * DAY + 1],
    ]) {
      clock.set(at);
      const record = await job.runOnce(true);
      await job.drain();
      steps.push({
        step: name,
        status: record.status,
        ...state(),
        ciphertext_in_db_files: residueLabels(
          findResidue(dbFiles(files()), ct),
        ),
      });
    }
    job.close();
    // 知らせは発言だけを見る（要約は知らせの種類にない。ADR 0058）。
    const turnNotices = noticeSummary(sink)
      .map((notice) => ({
        reason: notice.reason,
        items: notice.items.filter((item) => item.startsWith('turn:')),
      }))
      .filter((notice) => notice.items.length > 0);
    checked.steps = steps;
    checked.turn_notices = turnNotices;
    checked.plaintext_found = findResidue(
      {
        ...files(),
        logs: textSource(logs.join('\n')),
        notices: textSource(sink.notices),
      },
      text,
    );
    checked.db_version = String(harness.store.schemaVersion);
  });
  return {
    checked,
    final_state: `turns=${checked.steps.at(-1).turns.join(',')};summaries=${checked.steps.at(-1).summaries.join(',')}`,
  };
}

// --- 2. 時計の巻き戻り（X16・T06） ---

async function clockRollback(seed, round) {
  const text = {
    T_LIVE: marker('turn-live', seed, round),
    T_LATE: marker('turn-late', seed, round),
  };
  const checked = {};
  // 最終確認時刻 L は 7 日と 12 時間。巻き戻った時計は 6 日。
  const L = B + 7 * DAY + 12 * HOUR;
  await withStoreWorld(B, async ({ harness, logs, log, files }) => {
    const ct = {};
    harness.sql((db) => {
      insertSession(db, S, B);
      ct.T_LIVE = insertTurn(db, {
        turnId: T_LIVE,
        sessionId: S,
        text: text.T_LIVE,
        createdAt: B + DAY,
        expiresAt: B + 8 * DAY,
      }).ciphertext;
    });
    const clock = new ManualClock(L);
    const first = new RetentionSweeper({
      port: createRetentionSweepPort(harness.store),
      epoch: randomUUID(),
      now: clock.now,
      clock: createClockStateFile(harness.dir),
      freshClockState: true,
      log,
      vacuumIntervalMs: 0,
    });
    await first.runOnce(true);
    await first.drain();
    first.close();
    // 掃除の後に、L の時点で期限（7 日）を過ぎている発言が見つかった（次の掃除の前に時計が戻る）。
    harness.sql((db) => {
      ct.T_LATE = insertTurn(db, {
        turnId: T_LATE,
        sessionId: S,
        text: text.T_LATE,
        createdAt: B,
        expiresAt: B + 7 * DAY,
      }).ciphertext;
    });
    const readClock = async () =>
      parseClockState(await readFile(files().clock, 'utf8'))?.last_checked_at;
    const turns = () =>
      harness.sql((db) => ({
        turns: labels(rows(db, 'SELECT turn_id FROM turns')),
        expires_at: rows(
          db,
          'SELECT expires_at FROM turns ORDER BY turn_id',
        ).map((value) => new Date(value).toISOString()),
      }));
    // 再起動。時計は 1.5 日戻っている。
    clock.set(B + 6 * DAY);
    const second = new RetentionSweeper({
      port: createRetentionSweepPort(harness.store),
      epoch: randomUUID(),
      now: clock.now,
      clock: createClockStateFile(harness.dir),
      log,
      vacuumIntervalMs: 0,
    });
    await second.runOnce(true);
    await second.drain();
    const rolledBack = {
      gate_reasons: [...second.gate().reasons],
      ...turns(),
      last_checked_at: await readClock(),
      ciphertext_in_db_files: residueLabels(findResidue(dbFiles(files()), ct)),
    };
    // 時計が T_LIVE の期限（8 日）に届く。
    clock.set(B + 8 * DAY);
    await second.runOnce(true);
    await second.drain();
    second.close();
    const reached = {
      ...turns(),
      ciphertext_in_db_files: residueLabels(findResidue(dbFiles(files()), ct)),
    };
    checked.rolled_back = rolledBack;
    checked.reached_deadline = reached;
    checked.plaintext_found = findResidue(
      { ...files(), logs: textSource(logs.join('\n')) },
      text,
    );
    checked.db_version = String(harness.store.schemaVersion);
  });
  return {
    checked,
    final_state: `turns=${checked.reached_deadline.turns.join(',') || 'none'}`,
  };
}

// --- 3. 記憶の見直しと削除（X44・T06） ---

async function memoryReview(seed, round) {
  const text = {
    M_REVIEW: marker('memory-review', seed, round),
    M_CONTINUE: marker('memory-continue', seed, round),
  };
  const checked = {};
  await withStoreWorld(B, async ({ harness, logs, log, files }) => {
    harness.sql((db) => {
      insertSession(db, S, B);
      insertTurn(db, {
        turnId: T_SRC,
        sessionId: S,
        text: marker('turn-src', seed, round),
        createdAt: B,
        expiresAt: B + 7 * DAY,
      });
    });
    const hmac = storeHmac();
    const ct = {};
    for (const [memoryId, name, n] of [
      [M_REVIEW, 'M_REVIEW', 1],
      [M_CONTINUE, 'M_CONTINUE', 2],
    ]) {
      const { op, sealed } = memorySaveOp({
        memoryId,
        text: text[name],
        sources: [{ source_kind: 'turn', source_id: T_SRC }],
        hmac,
        generation: '0',
        now: B,
        n,
        origin: 'explicit_request',
      });
      ct[name] = sealed.ciphertext;
      const saved = await harness.store.memory(op);
      assert.equal(saved.ok, true, JSON.stringify(saved));
    }
    const clock = new ManualClock(B);
    const sink = new RecordingNoticeSink();
    const job = new RetentionSweeper({
      port: createRetentionSweepPort(harness.store),
      epoch: randomUUID(),
      now: clock.now,
      notices: sink,
      log,
      vacuumIntervalMs: 0,
    });
    const memories = () =>
      harness.sql((db) =>
        db
          .prepare(
            'SELECT memory_id, status, review_at, delete_at FROM memories ORDER BY memory_id',
          )
          .all()
          .map((row) => ({
            memory: label(row.memory_id),
            status: row.status,
            review_at: new Date(row.review_at).toISOString(),
            delete_at:
              row.delete_at === null
                ? null
                : new Date(row.delete_at).toISOString(),
          })),
      );
    const steps = [];
    const sweepAt = async (name, at) => {
      clock.set(at);
      await job.runOnce(true);
      await job.drain();
      steps.push({
        step: name,
        memories: memories(),
        ciphertext_in_db_files: residueLabels(
          findResidue(dbFiles(files()), ct),
        ),
      });
    };
    await sweepAt('review_one_ms_before', B + 90 * DAY - 1);
    await sweepAt('review_at', B + 90 * DAY);
    // 本人が M_CONTINUE を続ける（続けた時点から次の 90 日）。
    const continued = await harness.store.memory({
      kind: 'memory.continue',
      memory_id: M_CONTINUE,
      now: B + 100 * DAY,
    });
    assert.equal(continued.ok, true, JSON.stringify(continued));
    await sweepAt('delete_one_ms_before', B + 120 * DAY - 1);
    await sweepAt('delete_at', B + 120 * DAY);
    job.close();
    checked.steps = steps;
    checked.memory_notices = noticeSummary(sink).filter((notice) =>
      notice.items.some((item) => item.startsWith('memory:')),
    );
    checked.plaintext_found = findResidue(
      {
        ...files(),
        logs: textSource(logs.join('\n')),
        notices: textSource(sink.notices),
      },
      text,
    );
    checked.db_version = String(harness.store.schemaVersion);
  });
  return {
    checked,
    final_state: `memories=${checked.steps
      .at(-1)
      .memories.map((m) => `${m.memory}:${m.status}`)
      .join(',')}`,
  };
}

// --- 4. 忘却と遅着の順序の入れ替え（X15・QA34・T06） ---

export const FORGET_EVENTS = [
  'late_from_forgotten_source',
  'late_from_unrelated_source',
  'execute',
];

async function forgetLateOrder(seed, round) {
  const order = shuffled(FORGET_EVENTS, seed + round * 7919);
  const variant =
    order.indexOf('late_from_forgotten_source') < order.indexOf('execute')
      ? 'late_source_before_execute'
      : 'late_source_after_execute';
  const text = {
    M: marker('memory-m', seed, round),
    L1: marker('late-forgotten-source', seed, round),
    L2: marker('late-unrelated-source', seed, round),
    M_OTHER: marker('memory-other', seed, round),
    T_SRC: marker('turn-src', seed, round),
    T_OTHER: marker('turn-other', seed, round),
  };
  const checked = {};
  await withStoreWorld(B, async ({ harness, logs, log, files }) => {
    const ct = {};
    harness.sql((db) => {
      insertSession(db, S, B);
      insertSession(db, S2, B);
      ct.T_SRC = insertTurn(db, {
        turnId: T_SRC,
        sessionId: S,
        text: text.T_SRC,
        createdAt: B,
        expiresAt: B + 7 * DAY,
      }).ciphertext;
      ct.T_OTHER = insertTurn(db, {
        turnId: T_OTHER,
        sessionId: S2,
        text: text.T_OTHER,
        createdAt: B,
        expiresAt: B + 7 * DAY,
      }).ciphertext;
    });
    const hmac = storeHmac();
    const now = B + DAY;
    // record: 暗号文を目印に加える（拒否を確かめるだけの保存は加えない）。
    const save = async (
      memoryId,
      name,
      source,
      generation,
      n,
      record = true,
    ) => {
      const { op, sealed } = memorySaveOp({
        memoryId,
        text: text[name],
        sources: [{ source_kind: 'turn', source_id: source }],
        hmac,
        generation,
        now,
        n,
      });
      if (record) ct[name] = sealed.ciphertext;
      return saveOutcome(await harness.store.memory(op));
    };
    assert.deepEqual(await save(M, 'M', T_SRC, '0', 1), {
      saved: true,
      status: 'active',
    });
    assert.deepEqual(await save(M_OTHER, 'M_OTHER', T_OTHER, '0', 4), {
      saved: true,
      status: 'active',
    });
    const sink = new RecordingNoticeSink();
    // 忘却の COMMIT の後の WAL の切り詰めは、製品の core.ts と同じく掃除の job に頼む（U440、ADR 0186）。
    const job = new RetentionSweeper({
      port: createRetentionSweepPort(harness.store),
      epoch: randomUUID(),
      now: () => now,
      log,
    });
    // 忘却の公開ゲートを開いた試験の組み立て（製品の FORGET_PUBLIC_GATE_OPEN は false のまま）。
    const service = createForgetService({
      store: harness.store,
      ledgerPath: files().ledger,
      gate: () => true,
      sourceHmac: async () => hmac,
      truncateLog: () => job.truncateLogAfterForget(),
      notices: sink,
      now: () => now,
      log,
    });
    const responses = [];
    const before = residueLabels(findResidue(dbFiles(files()), ct));
    const plan = async () => {
      const planned = await service.plan({ device_id: DEVICE, memory_id: M });
      responses.push(planned);
      assert.equal(planned.ok, true, JSON.stringify(planned));
      return planned.view;
    };
    let view = await plan();
    const plans = [labels(view.removed.memory_ids)];
    const events = {};
    for (const event of order) {
      if (event === 'late_from_forgotten_source')
        // 忘却より前（世代 0）に始めた抽出が、忘れる記憶の元の発言から届く。
        events[event] = await save(L1, 'L1', T_SRC, '0', 2);
      else if (event === 'late_from_unrelated_source')
        // 関係のない発言から、同じく世代 0 で始めた抽出が届く（QA34: 関係のない忘却では止めない）。
        events[event] = await save(L2, 'L2', T_OTHER, '0', 3);
      else {
        const attempts = [];
        for (;;) {
          const executed = await service.execute({
            device_id: DEVICE,
            plan_id: view.plan_id,
            forgetting_generation: view.forgetting_generation,
          });
          responses.push(executed);
          attempts.push(
            executed.ok
              ? { ok: true, generation: executed.result.forgetting_generation }
              : {
                  ok: false,
                  reason: executed.reason,
                  reasons: executed.reasons,
                },
          );
          if (executed.ok || executed.reason !== 'replan_required') break;
          assert(attempts.length < 3, '計画の取り直しが続く');
          // 本人が取り直した計画を確かめてから実行する。
          view = await plan();
          plans.push(labels(view.removed.memory_ids));
        }
        events[event] = { attempts, plans };
      }
    }
    const state = () =>
      harness.sql((db) => ({
        memories: labels(rows(db, 'SELECT memory_id FROM memories')),
        turns: labels(rows(db, 'SELECT turn_id FROM turns')),
        ledger_generation: String(
          rows(
            db,
            'SELECT COALESCE(MAX(forgetting_generation), 0) FROM forget_ledger',
          )[0],
        ),
      }));
    // 忘却の直後（DB worker は開いたまま）。忘却の経路が COMMIT の後に WAL を切り詰めるので、消した行の暗号文は
    // DB にも WAL にもない（U440、ADR 0186。消したページは secure_delete で 0 になっている）。
    const afterForget = residueLabels(findResidue(dbFiles(files()), ct));
    job.close();
    const ledgerFile = JSON.parse(await readFile(files().ledger, 'utf8'));
    const visible = await visibleMemoryMarkers(harness.store, text, now);
    const final = state();
    // Core の再起動に当たる（DB worker を閉じて開き直す。最後の接続を閉じると WAL は書き戻されて消える）。
    await harness.restart();
    const afterRestart = residueLabels(findResidue(dbFiles(files()), ct));
    // 忘却の後（世代 1）に始めた抽出も、再起動を越えて台帳の照合で拒否される。
    const lateAfterRestart = {
      forgotten_source: await save(
        id('c6', 0x21),
        'M',
        T_SRC,
        '1',
        0x21,
        false,
      ),
    };
    checked.variant = variant;
    checked.events = events;
    checked.final = {
      ...final,
      ledger_file_generation: ledgerFile.head.forgetting_generation,
      visible_memory_markers: visible,
      notices: noticeSummary(sink),
      ledger_notices: sink.ledgerNotices.length,
    };
    checked.late_after_restart = lateAfterRestart;
    checked.ciphertext_in_db_files = {
      before_forget: before,
      after_forget: afterForget,
      after_restart: afterRestart,
    };
    checked.plaintext_found = findResidue(
      {
        ...files(),
        logs: textSource(logs.join('\n')),
        notices: textSource([...sink.notices, ...sink.ledgerNotices]),
        responses: textSource(responses),
      },
      text,
    );
    checked.db_version = String(harness.store.schemaVersion);
  });
  return {
    checked,
    variant,
    order,
    final_state: `memories=${checked.final.memories.join(',')};generation=${checked.final.ledger_generation}`,
  };
}

// --- 5. 古いバックアップからの復元（X16・X15・T06） ---

const BACKUP_T0 = Date.parse('2031-03-01T00:00:00.000Z');

async function openBackupDatabase(path, code) {
  const header = await readBackupFileHeader(path);
  assert.ok(header.ok);
  const manifest = header.manifest;
  const recoveryKey = decodeRecoveryCode(code);
  assert.ok(recoveryKey !== null);
  const wrap = manifest.key_wraps.find(
    (entry) => entry.purpose === 'backup_file',
  );
  const key = unwrapBackupKey(Buffer.from(recoveryKey), wrap);
  assert.ok(key !== null);
  const payload = await readBackupPayload(
    path,
    header.payload_offset,
    manifest.payload.bytes,
  );
  const keyInfo = manifestPayloadKey(manifest);
  const database = decryptBackupPayload(
    { key, keyId: keyInfo.keyId, fields: keyInfo.fields },
    payload,
  );
  assert.ok(database !== null);
  return { manifest, database };
}

async function oldBackupRestore(seed, round) {
  const text = {
    M: marker('memory-m', seed, round),
    M_OTHER: marker('memory-other', seed, round),
    T_SRC: marker('turn-src', seed, round),
    T_OTHER: marker('turn-other', seed, round),
  };
  const checked = {};
  const base = await mkdtemp(join(tmpdir(), 'buddy-b06-backup-'));
  const dataDir = join(base, 'data');
  const backupDir = join(base, 'backups');
  const keptDir = join(base, 'kept-elsewhere');
  const logs = [];
  const log = (message) => logs.push(String(message));
  const clock = { value: BACKUP_T0 };
  const backupKeys = createMockBackupKeyStore();
  const dataKeys = () =>
    createMockKeyStore({ stored: DATA_KEY.key.toString('base64') });
  const start = () =>
    startCore({
      dataDir,
      keyStore: dataKeys(),
      shutdownGraceMs: 200,
      probeTimeoutMs: 300,
      now: () => new Date(clock.value),
      log,
      backup: { keyStore: backupKeys },
    });
  let handle = null;
  try {
    await mkdir(backupDir, { recursive: true });
    await mkdir(keptDir, { recursive: true });
    handle = await start();
    await handle.stop('test');
    handle = null;
    const ct = {};
    {
      // 停止中に発言を置く（Core の DB worker と同じ DB）。
      const db = openWriteConnection(join(dataDir, DB_FILE), {
        platform: storagePlatform(process.platform),
      });
      try {
        insertSession(db, S, BACKUP_T0);
        insertSession(db, S2, BACKUP_T0);
        ct.T_SRC = insertTurn(db, {
          turnId: T_SRC,
          sessionId: S,
          text: text.T_SRC,
          createdAt: BACKUP_T0,
          expiresAt: BACKUP_T0 + 7 * DAY,
        }).ciphertext;
        ct.T_OTHER = insertTurn(db, {
          turnId: T_OTHER,
          sessionId: S2,
          text: text.T_OTHER,
          createdAt: BACKUP_T0,
          expiresAt: BACKUP_T0 + 7 * DAY,
        }).ciphertext;
      } finally {
        db.close();
      }
    }
    clock.value = BACKUP_T0 + 1000;
    handle = await start();
    await writeFile(
      join(dataDir, BACKUP_CONFIG_FILE),
      JSON.stringify({
        schema: 'buddy.backup-config.v1',
        directory: backupDir,
        keep_generations: 7,
      }),
      { mode: 0o600 },
    );
    const displayed = [];
    const current = handle;
    const setup = await runBackupSetup({
      dataDir,
      contract,
      dataKeys: dataKeys(),
      backupKeys,
      now: () => new Date(clock.value),
      inspect: () => inspectBackupSetup(current.store),
      record: (ledgerHmacKeyId) =>
        recordBackupSetup({
          dataDir,
          contract,
          store: current.store,
          backupKeys,
          ledgerHmacKeyId,
        }),
      display: (shown) => displayed.push(shown.recovery_code),
    });
    assert.ok(setup.ok, JSON.stringify(setup));
    const code = displayed.at(-1);
    // Core と同じ求め方の台帳の HMAC（バックアップの設定で記録した台帳の鍵）。
    const ledgerHmac = async (store) => {
      const facts = await store.memory({ kind: 'backup.facts' });
      assert.ok(facts.ok && facts.value.recorded_ledger_key_id !== null);
      const key = await backupKeys.read(
        'ledger_hmac_key',
        facts.value.recorded_ledger_key_id,
      );
      assert.ok(key.ok);
      return restoreSourceHmac(key.key.key);
    };
    const hmac = await ledgerHmac(handle.store);
    // record: 暗号文を目印に加える（復元の後の遅着の確かめの保存は加えない）。
    const save = async (
      store,
      memoryId,
      name,
      source,
      generation,
      n,
      record = true,
    ) => {
      const { op, sealed } = memorySaveOp({
        memoryId,
        text: text[name],
        sources: [{ source_kind: 'turn', source_id: source }],
        hmac,
        generation,
        now: clock.value,
        n,
      });
      if (record) ct[name] = sealed.ciphertext;
      return saveOutcome(await store.memory(op));
    };
    clock.value = BACKUP_T0 + 2000;
    assert.equal((await save(handle.store, M, 'M', T_SRC, '0', 1)).saved, true);
    assert.equal(
      (await save(handle.store, M_OTHER, 'M_OTHER', T_OTHER, '0', 4)).saved,
      true,
    );
    // 忘却の前のバックアップ（世代 0）。本人が別の場所にも写しを残していた、という古いバックアップ。
    clock.value = BACKUP_T0 + 3000;
    const first = await handle.backup.run();
    assert.ok(first.ok, JSON.stringify(first));
    const firstName = `buddy-${first.backup_id}.buddybackup`;
    const oldCopy = join(keptDir, firstName);
    await copyFile(join(backupDir, firstName), oldCopy);
    const oldOpened = await openBackupDatabase(oldCopy, code);
    // 忘却（公開ゲートを開いた試験の組み立て。製品のゲートは閉じたまま）。
    clock.value = BACKUP_T0 + 4000;
    const sink = new RecordingNoticeSink();
    const store = handle.store;
    const service = createForgetService({
      store,
      ledgerPath: join(dataDir, FORGET_LEDGER_FILE),
      gate: () => true,
      sourceHmac: () => ledgerHmac(store),
      notices: sink,
      now: () => clock.value,
      log,
    });
    const planned = await service.plan({ device_id: DEVICE, memory_id: M });
    assert.equal(planned.ok, true, JSON.stringify(planned));
    const executed = await service.execute({
      device_id: DEVICE,
      plan_id: planned.view.plan_id,
      forgetting_generation: planned.view.forgetting_generation,
    });
    assert.equal(executed.ok, true, JSON.stringify(executed));
    // 新しいバックアップの前の掃除: 古い世代は残し、取り直しを求める。
    const sweptBefore = await handle.backup.sweep();
    assert.ok(sweptBefore.ok);
    clock.value = BACKUP_T0 + 5000;
    const second = await handle.backup.run();
    assert.ok(second.ok, JSON.stringify(second));
    const inBackupDir = (await readdir(backupDir)).filter((name) =>
      name.endsWith('.buddybackup'),
    );
    const decryptedInDir = {};
    for (const name of inBackupDir)
      decryptedInDir[`backups/${name === firstName ? 'first' : 'second'}`] = (
        await openBackupDatabase(join(backupDir, name), code)
      ).database;
    await handle.stop('test');
    handle = null;

    // 古いバックアップ（忘却の前）から復元する。
    clock.value = BACKUP_T0 + 6000;
    const report = await runRestoreRun({
      dataDir,
      contract,
      backupPath: oldCopy,
      recoveryKey: Buffer.from(decodeRecoveryCode(code)),
      dataKeys: dataKeys(),
      backupKeys,
      now: () => new Date(clock.value),
      lock: true,
      log,
    });
    assert.equal(report.outcome, 'restored', JSON.stringify(report));
    const restoredFiles = filesUnder(dataDir, 'data');
    const restoredResidue = residueLabels(
      findResidue(
        Object.fromEntries(
          Object.entries(restoredFiles).filter(([name]) =>
            /buddy\.sqlite(-wal)?$/u.test(name),
          ),
        ),
        ct,
      ),
    );
    // 復元した中枢を起動し直す。
    clock.value = BACKUP_T0 + 7000;
    handle = await start();
    const visible = await visibleMemoryMarkers(handle.store, text, clock.value);
    const exported = await handle.store.memory({
      kind: 'forget.ledger_export',
    });
    assert.ok(exported.ok);
    // 忘却より前（世代 0）に始めた抽出が、忘れた記憶の元の発言から届く。台帳は復元を越えて効く。
    const lateForgotten = await save(
      handle.store,
      L1,
      'M',
      T_SRC,
      '0',
      2,
      false,
    );
    const lateUnrelated = await save(
      handle.store,
      L2,
      'M_OTHER',
      T_OTHER,
      '0',
      3,
      false,
    );
    const dbVersion = String(handle.store.schemaVersion);
    await handle.stop('test');
    handle = null;
    checked.first_backup_generation = first.forgetting_generation;
    checked.old_backup_ciphertext = residueLabels(
      findResidue({ old: oldOpened.database }, ct),
    );
    checked.forget = {
      plan: labels(planned.view.removed.memory_ids),
      generation: executed.result.forgetting_generation,
    };
    checked.sweep_before_new_backup = {
      deleted: sweptBefore.deleted.length,
      needs_new_backup: sweptBefore.needs_new_backup,
    };
    checked.second_backup = {
      generation: second.forgetting_generation,
      deleted_first:
        second.sweep.ok && second.sweep.deleted.includes(first.backup_id),
      files_in_backup_dir: inBackupDir.map((name) =>
        name === firstName ? 'first' : 'second',
      ),
      ciphertext: residueLabels(findResidue(decryptedInDir, ct)),
    };
    checked.restore = {
      outcome: report.outcome,
      forgotten_applied_count:
        report.result.after_restore.forgotten_applied_count,
      approvals_revoked_count:
        report.result.after_restore.approvals_revoked_count,
      ciphertext_in_db_files: restoredResidue,
    };
    checked.after_restart = {
      visible_memory_markers: visible,
      ledger_generation: exported.value.head.forgetting_generation,
      late_from_forgotten_source: lateForgotten,
      late_from_unrelated_source: lateUnrelated,
    };
    // 平文の目印は、データディレクトリ・バックアップの置き場所・残した写し・ログのどこにも出ない。
    checked.plaintext_found = findResidue(
      {
        ...filesUnder(dataDir, 'data'),
        ...filesUnder(backupDir, 'backups'),
        ...filesUnder(keptDir, 'kept'),
        decrypted_old: oldOpened.database,
        ...decryptedInDir,
        logs: textSource(logs.join('\n')),
        notices: textSource([...sink.notices, ...sink.ledgerNotices]),
      },
      text,
    );
    checked.db_version = dbVersion;
  } finally {
    if (handle !== null) await handle.stop('test').catch(() => undefined);
    await rm(base, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    });
  }
  return {
    checked,
    final_state: `restored;memories=${checked.after_restart.visible_memory_markers.join(',')};generation=${checked.after_restart.ledger_generation}`,
  };
}

// --- 6. 記録しない会話（X17・T06） ---

const PRIVATE_CLOCK = new Date('2026-10-05T09:00:00+09:00');
const ACCOUNT = 'acct-b06-synthetic';

function mockProvider() {
  return {
    connection: () =>
      Promise.resolve({
        provider: 'mock',
        account_id: ACCOUNT,
        account_label: '合成の口座',
        status: 'active',
        access: 'read_write',
      }),
    readPermission: (accountId) =>
      Promise.resolve(
        accountId === ACCOUNT
          ? {
              account_id: ACCOUNT,
              permission_revision: '1',
              scopes: ['mail.read', 'mail.labels'],
            }
          : null,
      ),
    readTarget: () => Promise.resolve(null),
    listEvents: () => Promise.resolve([]),
  };
}

async function privateConversation(seed, round) {
  const text = {
    NORMAL_1: marker('normal-1', seed, round),
    PRIVATE: marker('private', seed, round),
    NORMAL_2: marker('normal-2', seed, round),
  };
  const checked = {};
  const base = await mkdtemp(join(tmpdir(), 'buddy-b06-private-'));
  const dataDir = join(base, 'data');
  const logs = [];
  let handle = null;
  let live = null;
  try {
    handle = await startCore({
      dataDir,
      keyStore: createMockKeyStore({ stored: DATA_KEY.key.toString('base64') }),
      shutdownGraceMs: 200,
      probeTimeoutMs: 300,
      now: () => PRIVATE_CLOCK,
      log: (message) => logs.push(String(message)),
      https: {
        host: '127.0.0.1',
        port: 0,
        tlsKeyStore: createMockTlsKeyStore(),
        environment: {
          homeNetwork: () => true,
          lockState: () => 'unlocked',
          hubLocal: () => true,
          audioOwner: () => 'self',
          claimSecretMatches: () => false,
        },
        turns: {
          provider: mockProvider(),
          utcOffset: '+09:00',
        },
      },
    });
    await handle.retention.idle();
    const target = {
      host: handle.https.host,
      port: handle.https.port,
      certificatePem: await readFile(
        join(dataDir, TLS_CERTIFICATE_FILE),
        'utf8',
      ),
      fingerprint: handle.https.certificateFingerprint,
    };
    const device = await insertDevice(handle.store);
    const headers = {
      authorization: `Bearer ${device.token}`,
      'content-type': 'application/json',
    };
    const boot = await pinnedRequest(target, {
      method: 'GET',
      path: '/v1/bootstrap',
      headers,
    });
    assert.equal(boot.status, 200, boot.text);
    const scope = String(boot.json?.['command_scope_id']);
    const responses = [];
    const post = async (path, body, extraHeaders = {}) => {
      const response = await pinnedRequest(target, {
        method: 'POST',
        path,
        headers: { ...headers, ...extraHeaders },
        body: JSON.stringify(body),
      });
      responses.push(response.text);
      return response;
    };
    const turn = (value) =>
      post('/v1/stream/turns', {
        request_id: randomUUID(),
        command_scope_id: scope,
        text: `今日の用事を見せて ${value}`,
        input_kind: 'text',
        expected_canvas_revision: '0',
      });
    // 保存モードの切り替えは本人の画面操作だけ（UI-05 の段階 6、ADR 0189）。
    const mode = (storageMode) =>
      post(
        '/v1/stream/storage-mode',
        {
          request_id: randomUUID(),
          command_scope_id: scope,
          storage_mode: storageMode,
        },
        { 'buddy-input-origin': 'screen' },
      );
    const turnCount = async () => {
      const db = openWriteConnection(join(dataDir, DB_FILE), {
        platform: storagePlatform(process.platform),
      });
      try {
        return Number(rows(db, 'SELECT count(*) FROM turns')[0]);
      } finally {
        db.close();
      }
    };
    const boundary = async () =>
      parseClockState(await readFile(join(dataDir, CLOCK_STATE_FILE), 'utf8'))
        ?.storage_boundary ?? null;
    const steps = [];
    const normal1 = await turn(text.NORMAL_1);
    steps.push({
      step: 'normal_turn',
      status: normal1.status,
      turns: await turnCount(),
    });
    const entered = await mode('private');
    steps.push({
      step: 'enter_private',
      status: entered.status,
      boundary: await boundary(),
      private_conversation: handle.storage.privateConversation(),
    });
    const privateTurn = await turn(text.PRIVATE);
    steps.push({
      step: 'private_turn',
      status: privateTurn.status,
      turns: await turnCount(),
    });
    // 音声の制御（模擬の Live の provider と予算の門の組み立て）に、本物の保存境界の保持者の値をつなぐ。
    const gate = handle.storage;
    await withRig(
      async (rig) => {
        const lease = await renew(rig, VOICE_DEVICE, {
          lease_id: randomUUID(),
          nonce: 'n1',
          previous_nonce: null,
          at: 10,
        });
        assert.equal(lease.body['result'], 'renewed');
        const refused = await rig.voice.createLiveSession(
          VOICE_DEVICE,
          liveBody(),
        );
        live = {
          status: refused.status,
          code: refused.body['code'] ?? null,
          provider_created: rig.provider.created.length,
          budget_calls: rig.budget.calls.length,
        };
      },
      { privateConversation: () => gate.privateConversation() },
    );
    steps.push({ step: 'live_while_private', ...live });
    const exited = await mode('normal');
    steps.push({
      step: 'exit_private',
      status: exited.status,
      boundary: await boundary(),
      private_conversation: handle.storage.privateConversation(),
    });
    const normal2 = await turn(text.NORMAL_2);
    steps.push({
      step: 'normal_turn_after',
      status: normal2.status,
      turns: await turnCount(),
    });
    const dbVersion = String(handle.store.schemaVersion);
    await handle.stop('test');
    handle = null;
    // 停止の後のデータディレクトリ。保存した発言の本文を開いて、見える目印を数える（陽性の対照）。
    const db = openWriteConnection(join(dataDir, DB_FILE), {
      platform: storagePlatform(process.platform),
    });
    let visible;
    try {
      visible = db
        .prepare(
          'SELECT t.turn_id, b.format_version, b.key_id, b.nonce, b.ciphertext, b.tag FROM turns t JOIN sealed_blobs b ON b.blob_id = t.text_blob_id',
        )
        .all()
        .map((row) => openRow(row, 'turns', row.turn_id, 'turn_text') ?? '')
        .flatMap((opened) =>
          Object.entries(text)
            .filter(([, value]) => opened.includes(value))
            .map(([name]) => name),
        )
        .sort();
    } finally {
      db.close();
    }
    checked.steps = steps;
    checked.visible_turn_markers = visible;
    // 平文の目印は、データディレクトリ（DB・WAL・時計の状態ファイルなど）とログのどこにも出ない。応答は本人の画面への
    // 返事なので、記録しない会話の目印だけを探す。
    checked.plaintext_found = [
      ...findResidue(
        { ...filesUnder(dataDir, 'data'), logs: textSource(logs.join('\n')) },
        text,
      ),
      ...findResidue(
        { responses: textSource(responses.join('\n')) },
        { PRIVATE: text.PRIVATE },
      ),
    ];
    checked.db_version = dbVersion;
  } finally {
    if (handle !== null) await handle.stop('test').catch(() => undefined);
    await rm(base, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    });
  }
  return {
    checked,
    provider_requests: live.provider_created,
    final_state: `turns=${checked.steps.at(-1).turns};private_turn=${checked.steps[2].status};live=${live.status}`,
  };
}

const CASES = {
  'X16-retention-deadline-and-resummary': retentionBoundary,
  'X16-clock-rollback-no-extension': clockRollback,
  'X44-memory-review-deadline': memoryReview,
  'X15-forget-and-late-result-order': forgetLateOrder,
  'X16-old-backup-restore-applies-ledger': oldBackupRestore,
  'X17-private-conversation-not-saved': privateConversation,
};

export const caseIds = () => Object.keys(CASES);

// 期待値を選ぶ（順序で分かれるケースは variant で選ぶ）。
export function expectedFor(spec, variant) {
  if (spec.expected.variants === undefined) return spec.expected;
  const chosen = spec.expected.variants[variant];
  assert(chosen !== undefined, `${spec.id}: ${variant}`);
  return chosen;
}

export async function runCase(spec, seed, round) {
  const run = CASES[spec.id];
  assert(run, `未登録のケース ${spec.id}`);
  const observed = await run(seed, round);
  const { db_version: dbVersion, ...checked } = observed.checked;
  const variant = observed.variant ?? null;
  assert.deepEqual(checked, expectedFor(spec, variant), spec.id);
  if (dbVersion !== undefined)
    assert.equal(dbVersion, specification.db_version, '手書きの DB の版');
  return {
    checked,
    variant,
    // 忘却と遅着の順序（seed で並べ替えた出来事の順）。順序のないケースは null。
    event_order: observed.order ?? null,
    db_version: specification.db_version,
    provider_requests: observed.provider_requests ?? 0,
    provider_state_changes: 0,
    approvals: 0,
    final_state: observed.final_state,
  };
}
