// 音声の世代・入出力の停止・Live の制御の状態の保存（0009、ADR 0046）。
// DB は一時ディレクトリに作って消す。期待値は手で書いた値で、保存の実装から生成していない。端末・予約は合成の値。

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  applyMigrations,
  executeVoiceOp,
  loadMigrations,
  openWriteConnection,
} from './index.js';
import type {
  LiveControlValues,
  SqliteDatabase,
  VoiceOp,
  VoiceOpResult,
} from './index.js';

const DEV_A = '00000000-0000-4000-8000-00000000000a';
const DEV_B = '00000000-0000-4000-8000-00000000000b';
const DEV_R = '00000000-0000-4000-8000-00000000000c';
const LIVE_1 = '00000000-0000-4000-8000-000000000101';
const LIVE_2 = '00000000-0000-4000-8000-000000000102';
const RES_1 = '00000000-0000-4000-8000-000000000201';
const RES_2 = '00000000-0000-4000-8000-000000000202';

function withDb(
  run: (db: SqliteDatabase) => void,
  migrations = loadMigrations(),
): void {
  const dir = mkdtempSync(join(tmpdir(), 'buddy-voice-'));
  const db = openWriteConnection(join(dir, 'buddy.sqlite'), {
    platform: 'macos',
  });
  try {
    applyMigrations(db, migrations);
    run(db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function addDevice(
  db: SqliteDatabase,
  id: string,
  fill: string,
  revoked = false,
) {
  db.prepare(
    `INSERT INTO devices VALUES (?, '合成の端末', 'macos', 0, X'${fill.repeat(64)}', 1000, NULL, ?)`,
  ).run(id, revoked ? 2000 : null);
}

function addReservation(db: SqliteDatabase, id: string, request: string) {
  db.prepare(
    "INSERT INTO budget_reservations (reservation_id, request_id, profile_id, pool_id, requested_pool_id, origin, budget_month, currency, price_version, reserved_amount, max_liability, status, reservation_revision, created_at) VALUES (?, ?, 'live.synthetic.v1', 'voice', 'voice', 'owner_request', '2030-10', 'XTS', 'price-1', 195, 195, 'reserved', 1, 1000)",
  ).run(id, request);
}

const run = (db: SqliteDatabase, op: VoiceOp): VoiceOpResult =>
  executeVoiceOp(db, op, { platform: 'macos', halted: false }).result;

function ok<T>(result: VoiceOpResult): T {
  assert.equal(result.ok, true, JSON.stringify(result));
  return (result as unknown as { value: T }).value;
}

const CONNECTING: LiveControlValues = {
  control_state: 'connecting',
  control_epoch: '0',
  closure: 'open',
  usage_seconds: null,
};

test('0009 は版 8 の DB の端末に世代の行（全部 0・停止なし）を作り、Live の行に世代 0 の列を足す', () => {
  const all = loadMigrations();
  withDb(
    (db) => {
      addDevice(db, DEV_A, 'a');
      addReservation(db, RES_1, 'q-1');
      db.prepare(
        "INSERT INTO live_sessions VALUES (?, ?, NULL, 'conversation', 'ready', 3, 'open', NULL, ?, 1100, NULL, NULL)",
      ).run(LIVE_1, DEV_A, RES_1);
      assert.deepEqual(applyMigrations(db, all), {
        from: 8,
        to: 9,
        applied: [9],
      });
      assert.deepEqual(db.prepare('SELECT * FROM device_epochs').all(), [
        {
          device_id: DEV_A,
          io_epoch: 0,
          output_epoch: 0,
          audio_epoch: 0,
          session_epoch: 0,
          local_stop: 0,
          updated_at: 1000,
        },
      ]);
      assert.deepEqual(db.prepare('SELECT * FROM io_stop_state').all(), [
        { stop_id: 1, guest_mode: 0, global_stop: 0, updated_at: 0 },
      ]);
      assert.deepEqual(
        db
          .prepare(
            'SELECT control_state, control_epoch, audio_epoch, session_epoch FROM live_sessions',
          )
          .all(),
        [
          {
            control_state: 'ready',
            control_epoch: 3,
            audio_epoch: 0,
            session_epoch: 0,
          },
        ],
      );
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    },
    all.slice(0, 8),
  );
});

test('世代は戻せず、行も消せない（trigger）', () => {
  withDb((db) => {
    addDevice(db, DEV_A, 'a');
    db.exec(
      `INSERT INTO device_epochs (device_id, io_epoch, output_epoch, audio_epoch, session_epoch, updated_at) VALUES ('${DEV_A}', 5, 5, 5, 5, 1)`,
    );
    for (const column of [
      'io_epoch',
      'output_epoch',
      'audio_epoch',
      'session_epoch',
    ])
      assert.throws(
        () => db.exec(`UPDATE device_epochs SET ${column} = 4`),
        /device_epoch_regressed/u,
        column,
      );
    // 同じ値・進める更新は通る。
    db.exec('UPDATE device_epochs SET io_epoch = 5, audio_epoch = 6');
    assert.throws(
      () => db.exec('DELETE FROM device_epochs'),
      /device_epochs_permanent/u,
    );
    assert.throws(
      () => db.exec('DELETE FROM io_stop_state'),
      /io_stop_state_permanent/u,
    );
    assert.throws(
      () => db.exec('INSERT INTO io_stop_state VALUES (2, 0, 0, 0)'),
      /CHECK/u,
    );
    // INSERT OR REPLACE（消してから入れ直す）で、戻さない・消さない trigger をすり抜けない。
    assert.throws(
      () =>
        db.exec(
          `INSERT OR REPLACE INTO device_epochs (device_id, io_epoch, output_epoch, audio_epoch, session_epoch, updated_at) VALUES ('${DEV_A}', 0, 0, 0, 0, 1)`,
        ),
      /device_epochs_permanent/u,
    );
    assert.throws(
      () => db.exec('INSERT OR REPLACE INTO io_stop_state VALUES (1, 0, 0, 9)'),
      /io_stop_state_permanent/u,
    );
    assert.deepEqual(
      db.prepare('SELECT io_epoch, audio_epoch FROM device_epochs').get(),
      { io_epoch: 5, audio_epoch: 6 },
    );
  });
});

test('Live の行は control_epoch を戻さず、lost・closing・closed から ready へ戻らず、確認済みの使用秒数を変えない', () => {
  withDb((db) => {
    addDevice(db, DEV_A, 'a');
    addReservation(db, RES_1, 'q-1');
    db.prepare(
      "INSERT INTO live_sessions (live_session_id, device_id, session_id, purpose, control_state, control_epoch, closure, usage_seconds, reservation_id, started_at, audio_epoch, session_epoch) VALUES (?, ?, NULL, 'conversation', 'ready', 2, 'open', NULL, ?, 1000, 4, 4)",
    ).run(LIVE_1, DEV_A, RES_1);
    assert.throws(
      () => db.exec('UPDATE live_sessions SET control_epoch = 1'),
      /live_control_epoch_regressed/u,
    );
    assert.throws(
      () => db.exec("UPDATE live_sessions SET control_state = 'connecting'"),
      /live_control_state_regressed/u,
    );
    assert.throws(
      () => db.exec('UPDATE live_sessions SET audio_epoch = 5'),
      /live_session_issued_fixed/u,
    );
    assert.throws(
      () =>
        db
          .prepare(
            "INSERT OR REPLACE INTO live_sessions (live_session_id, device_id, session_id, purpose, control_state, control_epoch, closure, usage_seconds, reservation_id, started_at, audio_epoch, session_epoch) VALUES (?, ?, NULL, 'conversation', 'connecting', 0, 'open', NULL, ?, 1000, 0, 0)",
          )
          .run(LIVE_1, DEV_A, RES_1),
      /live_session_issued_fixed/u,
    );
    db.exec(
      "UPDATE live_sessions SET control_state = 'lost', control_epoch = 3",
    );
    assert.throws(
      () => db.exec("UPDATE live_sessions SET control_state = 'ready'"),
      /live_control_state_regressed/u,
    );
    db.exec(
      "UPDATE live_sessions SET control_state = 'closed', closure = 'close_confirmed', usage_seconds = 12",
    );
    assert.throws(
      () => db.exec("UPDATE live_sessions SET control_state = 'closing'"),
      /live_control_state_regressed/u,
    );
    assert.throws(
      () => db.exec('UPDATE live_sessions SET usage_seconds = 0'),
      /live_close_confirmed_final/u,
    );
  });
});

test('停止: local は要求した端末だけ、global は失効していない全端末の io・output を 1 つ進め、再起動しても残る', () => {
  withDb((db) => {
    addDevice(db, DEV_A, 'a');
    addDevice(db, DEV_B, 'b');
    addDevice(db, DEV_R, 'c', true);
    const local = ok<{
      scope: string;
      devices: { device_id: string; io_epoch: string; local_stop: boolean }[];
    }>(
      run(db, {
        kind: 'voice.stop',
        scope: 'local',
        device_id: DEV_A,
        now: 3000,
      }),
    );
    assert.deepEqual(
      local.devices.map((d) => [d.device_id, d.io_epoch, d.local_stop]),
      [[DEV_A, '1', true]],
    );
    const global = ok<{
      devices: {
        device_id: string;
        io_epoch: string;
        output_epoch: string;
        global_stop: boolean;
      }[];
    }>(
      run(db, {
        kind: 'voice.stop',
        scope: 'global',
        device_id: DEV_B,
        now: 4000,
      }),
    );
    assert.deepEqual(
      global.devices.map((d) => [
        d.device_id,
        d.io_epoch,
        d.output_epoch,
        d.global_stop,
      ]),
      [
        [DEV_A, '2', '2', true],
        [DEV_B, '1', '1', true],
      ],
    );
    // 失効した端末は対象にせず、停止も要求できない。
    assert.deepEqual(
      run(db, {
        kind: 'voice.stop',
        scope: 'local',
        device_id: DEV_R,
        now: 5000,
      }),
      { ok: false, outcome: 'rejected', reasons: ['device_revoked'] },
    );
    assert.deepEqual(
      db
        .prepare('SELECT device_id FROM device_epochs ORDER BY device_id')
        .pluck()
        .all(),
      [DEV_A, DEV_B],
    );
  });
});

test('再開: 版が一致しなければ拒否し、一致すればその範囲の印だけ外す（世代は進めない）', () => {
  withDb((db) => {
    addDevice(db, DEV_A, 'a');
    run(db, {
      kind: 'voice.stop',
      scope: 'local',
      device_id: DEV_A,
      now: 3000,
    });
    run(db, {
      kind: 'voice.stop',
      scope: 'global',
      device_id: DEV_A,
      now: 3100,
    });
    // 最初の停止の版（1）では再開しない（その後の全体停止を見ていない）。
    assert.deepEqual(
      run(db, {
        kind: 'voice.resume',
        scope: 'local',
        device_id: DEV_A,
        expected_io_epoch: '1',
        now: 4000,
      }),
      { ok: false, outcome: 'rejected', reasons: ['io_epoch_mismatch'] },
    );
    const local = ok<{
      io_epoch: string;
      local_stop: boolean;
      global_stop: boolean;
    }>(
      run(db, {
        kind: 'voice.resume',
        scope: 'local',
        device_id: DEV_A,
        expected_io_epoch: '2',
        now: 4100,
      }),
    );
    // 端末の停止は外れたが、全体停止は残る。
    assert.deepEqual(
      [local.io_epoch, local.local_stop, local.global_stop],
      ['2', false, true],
    );
    const global = ok<{ io_epoch: string; global_stop: boolean }>(
      run(db, {
        kind: 'voice.resume',
        scope: 'global',
        device_id: DEV_A,
        expected_io_epoch: '2',
        now: 4200,
      }),
    );
    assert.deepEqual([global.io_epoch, global.global_stop], ['2', false]);
  });
});

test('Live の開始: 世代が expected と一致するときだけ発行し、古い expected（同時の開始）は拒否して行を作らない', () => {
  withDb((db) => {
    addDevice(db, DEV_A, 'a');
    addReservation(db, RES_1, 'q-1');
    addReservation(db, RES_2, 'q-2');
    const opened = ok<{
      control_state: string;
      control_epoch: string;
      audio_epoch: string;
      session_epoch: string;
      closure: string;
    }>(
      run(db, {
        kind: 'voice.live_open',
        live_session_id: LIVE_1,
        device_id: DEV_A,
        session_id: null,
        purpose: 'conversation',
        reservation_id: RES_1,
        expected: { audio_epoch: '0', session_epoch: '0' },
        next: { audio_epoch: '1', session_epoch: '1' },
        started_at: 5000,
      }),
    );
    assert.deepEqual(
      [
        opened.control_state,
        opened.control_epoch,
        opened.closure,
        opened.audio_epoch,
        opened.session_epoch,
      ],
      ['connecting', '0', 'open', '1', '1'],
    );
    assert.deepEqual(
      run(db, {
        kind: 'voice.live_open',
        live_session_id: LIVE_2,
        device_id: DEV_A,
        session_id: null,
        purpose: 'conversation',
        reservation_id: RES_2,
        expected: { audio_epoch: '0', session_epoch: '0' },
        next: { audio_epoch: '1', session_epoch: '1' },
        started_at: 5001,
      }),
      { ok: false, outcome: 'rejected', reasons: ['epoch_conflict'] },
    );
    assert.equal(
      ok<unknown>(run(db, { kind: 'voice.live_get', live_session_id: LIVE_2 })),
      null,
    );
  });
});

test('Live の更新: 今の値が expected のときだけ書き、戻す更新は trigger の理由で拒否する', () => {
  withDb((db) => {
    addDevice(db, DEV_A, 'a');
    addReservation(db, RES_1, 'q-1');
    run(db, {
      kind: 'voice.live_open',
      live_session_id: LIVE_1,
      device_id: DEV_A,
      session_id: null,
      purpose: 'conversation',
      reservation_id: RES_1,
      expected: { audio_epoch: '0', session_epoch: '0' },
      next: { audio_epoch: '1', session_epoch: '1' },
      started_at: 5000,
    });
    const lost: LiveControlValues = {
      control_state: 'lost',
      control_epoch: '1',
      closure: 'open',
      usage_seconds: null,
    };
    ok(
      run(db, {
        kind: 'voice.live_update',
        live_session_id: LIVE_1,
        expected: CONNECTING,
        next: lost,
        ended_at: null,
        end_reason: null,
      }),
    );
    // 古い expected（connecting）での更新は、競合として拒否する。
    assert.deepEqual(
      run(db, {
        kind: 'voice.live_update',
        live_session_id: LIVE_1,
        expected: CONNECTING,
        next: { ...CONNECTING, control_state: 'ready' },
        ended_at: null,
        end_reason: null,
      }),
      { ok: false, outcome: 'rejected', reasons: ['live_state_conflict'] },
    );
    // lost から ready へは、expected が合っていても trigger が拒否する。
    assert.deepEqual(
      run(db, {
        kind: 'voice.live_update',
        live_session_id: LIVE_1,
        expected: lost,
        next: { ...lost, control_state: 'ready' },
        ended_at: null,
        end_reason: null,
      }),
      {
        ok: false,
        outcome: 'rejected',
        reasons: ['live_control_state_regressed'],
      },
    );
    const closed = ok<{ ended_at: number; end_reason: string }>(
      run(db, {
        kind: 'voice.live_update',
        live_session_id: LIVE_1,
        expected: lost,
        next: {
          control_state: 'closed',
          control_epoch: '1',
          closure: 'close_unconfirmed',
          usage_seconds: null,
        },
        ended_at: 9000,
        end_reason: 'sideband_lost',
      }),
    );
    assert.deepEqual(
      [closed.ended_at, closed.end_reason],
      [9000, 'sideband_lost'],
    );
    assert.deepEqual(
      ok<unknown[]>(run(db, { kind: 'voice.live_unfinished' })),
      [],
    );
    assert.deepEqual(
      run(db, {
        kind: 'voice.live_update',
        live_session_id: LIVE_2,
        expected: CONNECTING,
        next: lost,
        ended_at: null,
        end_reason: null,
      }),
      { ok: false, outcome: 'rejected', reasons: ['live_session_not_found'] },
    );
  });
});

test('形の検査: 不正な世代・範囲・ID は書かずに拒否する', () => {
  withDb((db) => {
    addDevice(db, DEV_A, 'a');
    assert.deepEqual(
      run(db, {
        kind: 'voice.resume',
        scope: 'local',
        device_id: DEV_A,
        expected_io_epoch: '01',
        now: 1,
      }),
      {
        ok: false,
        outcome: 'rejected',
        reasons: ['expected_io_epoch_invalid'],
      },
    );
    assert.deepEqual(
      run(db, {
        kind: 'voice.stop',
        scope: 'room' as 'local',
        device_id: 'x',
        now: -1,
      }),
      {
        ok: false,
        outcome: 'rejected',
        reasons: ['scope_invalid', 'device_id_invalid', 'now_invalid'],
      },
    );
    // 書込みを止めた worker は書かない。照会は続ける。
    assert.deepEqual(
      executeVoiceOp(
        db,
        { kind: 'voice.stop', scope: 'local', device_id: DEV_A, now: 1 },
        { platform: 'macos', halted: true },
      ).result,
      { ok: false, outcome: 'rejected', reasons: ['worker_halted'] },
    );
    assert.equal(
      ok<{ io_epoch: string }>(
        run(db, { kind: 'voice.device_state', device_id: DEV_A }),
      ).io_epoch,
      '0',
    );
  });
});
