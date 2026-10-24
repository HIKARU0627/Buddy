// Live の会話の予算（B05-04、ADR 0049）の模擬試験。DB worker（一時ディレクトリ）・予算の門（本番と同じ createLiveBudget）・
// 模擬の Live の provider・手で進める時計。追加予約・予算到達の閉じ方・精算（秒数）・二重の精算の拒否・結果不明の保持・
// 終了後の照合・孤児のセッション・時計の逆行を確かめる。金額は合成の XTS（1 秒 1 単位・最低 15 秒）、期待値は手で書いた値。
// 実際の音声・実 API・実機・実請求は使わない（未実施）。

import assert from 'node:assert/strict';
import test from 'node:test';
import { uuid } from './budget-test-support.js';
import {
  A,
  CORE_2,
  DEV_A,
  SCOPE_A,
  TIMEOUT,
  actualGross,
  audioControls,
  bodyOf,
  liveBody,
  openLive,
  renew,
  reservationStatus,
  waitUntil,
  withRig,
} from './voice-rig-test-support.js';
import type { Rig } from './voice-rig-test-support.js';
import { LIVE_RECONCILE_INTERVAL_MS } from './voice-control.js';

const LEASE = uuid(0x1a);

async function flushOnly(): Promise<void> {
  for (let i = 0; i < 3; i += 1)
    await new Promise<void>((resolve) => setImmediate(resolve));
}

// 端末の音声リースの更新と、サイドバンドの pong（2 秒ごと）を続けながら時間を進める。
interface Heartbeat {
  n: number;
}
async function beat(rig: Rig, hb: Heartbeat, ms: number): Promise<void> {
  for (let done = 0; done < ms; done += 2000) {
    await rig.clock.advance(Math.min(2000, ms - done));
    hb.n += 1;
    rig.provider.sidebands[0]?.pong();
    const renewed = await renew(rig, A, {
      lease_id: LEASE,
      nonce: `n${hb.n}`,
      previous_nonce: `n${hb.n - 1}`,
      at: 10 + 2000 * (hb.n - 1),
    });
    assert.equal(bodyOf(renewed)['result'], 'renewed', JSON.stringify(renewed));
  }
}

interface ReservationRow {
  status: string;
  reserved_amount: number;
  max_liability: number;
  reservation_revision: number;
  actual_gross: number | null;
}

function voiceRows(rig: Rig): ReservationRow[] {
  return rig.harness.sql(
    (db) =>
      db
        .prepare(
          "SELECT status, reserved_amount, max_liability, reservation_revision, actual_gross FROM budget_reservations WHERE pool_id = 'voice' ORDER BY created_at, reservation_id",
        )
        .all() as ReservationRow[],
  );
}

const nonVoiceReservations = (rig: Rig): number =>
  rig.harness.sql(
    (db) =>
      db
        .prepare(
          "SELECT count(*) FROM budget_reservations WHERE pool_id <> 'voice'",
        )
        .pluck()
        .get() as number,
  );

const reservationIdOf = (rig: Rig): string =>
  rig.harness.sql(
    (db) =>
      db
        .prepare(
          "SELECT reservation_id FROM budget_reservations WHERE pool_id = 'voice' ORDER BY created_at LIMIT 1",
        )
        .pluck()
        .get() as string,
  );

// 音声の枠の上限 250（合成）。開始の予約 195 は通り、最初の追加予約 60（合計 255）は上限を超えて拒否される。
const LIMIT_250 = '250';

async function untilFirstTopUp(
  rig: Rig,
  hb: Heartbeat,
  live: string,
): Promise<void> {
  await beat(rig, hb, 58000);
  await rig.clock.advance(1999);
  // 59 999 ms ではまだ追加予約しない。
  assert.deepEqual(rig.budget.calls, ['reserve:195', 'dispatch']);
  assert.equal(rig.voice.liveRecord(live)?.closure, 'open');
  await rig.clock.advance(1);
  await rig.wait();
}

// 閉じ始めた Live のリースは取り直し（lease_rotation_required）になるので、新しい lease_id で更新を続ける。
async function beatWithRotation(
  rig: Rig,
  hb: Heartbeat,
  ms: number,
): Promise<void> {
  let leaseId = LEASE;
  let previousNonce: string | null = `n${hb.n}`;
  let rotations = 0;
  for (let done = 0; done < ms; done += 2000) {
    await rig.clock.advance(Math.min(2000, ms - done));
    hb.n += 1;
    const nonce = `n${hb.n}`;
    rig.provider.sidebands[0]?.pong();
    const renewed = bodyOf(
      await renew(rig, A, {
        lease_id: leaseId,
        nonce,
        previous_nonce: previousNonce,
        at: 10 + 2000 * (hb.n - 1),
      }),
    );
    if (renewed['result'] === 'renewed') {
      previousNonce = nonce;
      continue;
    }
    assert.deepEqual(renewed['reasons'], ['lease_rotation_required']);
    rotations += 1;
    leaseId = uuid(0x2f00 + rotations);
    const rotatedNonce = `r${rotations}`;
    const rotated = bodyOf(
      await renew(rig, A, {
        lease_id: leaseId,
        nonce: rotatedNonce,
        previous_nonce: null,
        at: 11 + 2000 * (hb.n - 1),
      }),
    );
    assert.equal(rotated['result'], 'renewed');
    previousNonce = rotatedNonce;
  }
}

// ---- 追加予約（60 秒ごとに 60 秒分） ----------------------------------------------------------------------------------

test(
  '追加予約: 開始の 195 秒のあと、60 秒ごとに 60 秒分を同じ予約へ足す（59 999 ms では足さない）。LLM・検索の枠は使わない',
  TIMEOUT,
  async () => {
    await withRig(async (rig) => {
      const live = await openLive(rig);
      const hb: Heartbeat = { n: 1 };
      assert.deepEqual(voiceRows(rig), [
        {
          status: 'reserved',
          reserved_amount: 195,
          max_liability: 195,
          reservation_revision: 1,
          actual_gross: null,
        },
      ]);
      await untilFirstTopUp(rig, hb, live);
      assert.deepEqual(rig.budget.calls, [
        'reserve:195',
        'dispatch',
        'topup:60',
      ]);
      assert.deepEqual(
        voiceRows(rig).map((row) => [
          row.reserved_amount,
          row.max_liability,
          row.reservation_revision,
        ]),
        [[255, 255, 2]],
      );
      // 2 回目は予約を取ってから 120 秒（ちょうど）。版は 3、合計は 315。
      await beat(rig, hb, 60000);
      await rig.wait();
      assert.deepEqual(
        voiceRows(rig).map((row) => [
          row.reserved_amount,
          row.max_liability,
          row.reservation_revision,
        ]),
        [[315, 315, 3]],
      );
      assert.equal(rig.voice.liveRecord(live)?.closure, 'open');
      assert.equal(nonVoiceReservations(rig), 0);
      // 閉じた後の追加予約はしない。使用 125 秒（最低課金 15 秒より長い）で精算する。
      await rig.voice.closeLiveSession(A, live, {
        request_id: uuid(0x93),
        command_scope_id: SCOPE_A,
        reason: 'conversation_ended',
        audio_epoch: '1',
      });
      rig.provider.sidebands[0]?.closed(125);
      await rig.wait();
      await rig.clock.advance(120000);
      assert.deepEqual(rig.budget.calls, [
        'reserve:195',
        'dispatch',
        'topup:60',
        'topup:60',
        'settle:125',
      ]);
      assert.deepEqual(actualGross(rig), [125]);
      assert.deepEqual(reservationStatus(rig), ['settled']);
    });
  },
);

// ---- 予算に達したとき（追加予約の失敗） ----------------------------------------------------------------------------------

test(
  '予算到達: 追加予約が音声の枠の上限で拒否されたら、一言伝える指示を送り、10 秒（ちょうど）で閉じる。LLM・検索の枠から補わず、次の接続は 422',
  TIMEOUT,
  async () => {
    await withRig(
      async (rig) => {
        const live = await openLive(rig);
        const hb: Heartbeat = { n: 1 };
        await untilFirstTopUp(rig, hb, live);
        assert.deepEqual(rig.budget.calls, [
          'reserve:195',
          'dispatch',
          'topup:60',
        ]);
        // 予約は増えていない（195 のまま）。サイドバンドが使えるので指示を 1 回送り、まだ閉じない。
        assert.deepEqual(
          voiceRows(rig).map((row) => [row.reserved_amount, row.status]),
          [[195, 'reserved']],
        );
        assert.deepEqual(rig.provider.sidebands[0]?.instructions, [
          'budget_reached',
        ]);
        assert.equal(rig.voice.liveRecord(live)?.closure, 'open');
        await beat(rig, hb, 8000);
        await rig.clock.advance(1999);
        assert.equal(rig.voice.liveRecord(live)?.closure, 'open');
        assert.equal(rig.provider.sidebands[0]?.closes, 0);
        await rig.clock.advance(1);
        await rig.wait();
        const record = rig.voice.liveRecord(live);
        assert.deepEqual(
          [record?.closure, record?.control_state, record?.end_reason],
          ['close_requested', 'closing', 'budget_reached'],
        );
        assert.equal(rig.provider.sidebands[0]?.closes, 1);
        assert.deepEqual(audioControls(rig, DEV_A), [
          ['close_voice_session', 'budget_reached', '0'],
        ]);
        // 追加予約は 1 回だけ試した（結果が拒否のとき送り直さない）。
        assert.equal(
          rig.budget.calls.filter((call) => call === 'topup:60').length,
          1,
        );
        // 使用 61 秒で精算（実費 61）。LLM・検索の枠は使っていない。
        rig.provider.sidebands[0]?.closed(61);
        await rig.wait();
        assert.deepEqual(actualGross(rig), [61]);
        assert.equal(nonVoiceReservations(rig), 0);
        // 次の接続は、予約（195）が上限（250）に収まらないので 422（予算の保留）。音声の枠は他の枠から補わない。
        const lease = await renew(rig, A, {
          lease_id: uuid(0x1b),
          nonce: 'm1',
          previous_nonce: null,
          at: 900_000,
        });
        assert.equal(bodyOf(lease)['result'], 'renewed');
        const again = await rig.voice.createLiveSession(A, liveBody());
        assert.deepEqual(
          [again.status, bodyOf(again)['code']],
          [422, 'budget_held'],
        );
        assert.equal(rig.provider.created.length, 1);
        assert.equal(nonVoiceReservations(rig), 0);
        assert.equal(voiceRows(rig).length, 1);
      },
      {},
      LIMIT_250,
    );
  },
);

test(
  '予算到達: モデルの発話の終わりが 10 秒より早ければ、そこで閉じる。指示より前の発話の終わりは数えない',
  TIMEOUT,
  async () => {
    await withRig(
      async (rig) => {
        const live = await openLive(rig);
        const hb: Heartbeat = { n: 1 };
        // 予算に達する前の発話の終わりは何も起こさない。
        await beat(rig, hb, 30000);
        rig.provider.sidebands[0]?.utteranceEnded();
        await rig.wait();
        assert.equal(rig.voice.liveRecord(live)?.closure, 'open');
        await beat(rig, hb, 28000);
        await rig.clock.advance(1999);
        await rig.clock.advance(1);
        await rig.wait();
        assert.deepEqual(rig.provider.sidebands[0]?.instructions, [
          'budget_reached',
        ]);
        await beat(rig, hb, 2000);
        assert.equal(rig.voice.liveRecord(live)?.closure, 'open');
        rig.provider.sidebands[0]?.utteranceEnded();
        await rig.wait();
        // 指示の 2 秒後（10 秒より早い）に閉じた。
        const record = rig.voice.liveRecord(live);
        assert.deepEqual(
          [record?.closure, record?.end_reason],
          ['close_requested', 'budget_reached'],
        );
        assert.equal(rig.provider.sidebands[0]?.closes, 1);
        // 2 回目の発話の終わり・10 秒の timer では、もう一度閉じない。
        rig.provider.sidebands[0]?.utteranceEnded();
        await rig.clock.advance(10000);
        assert.equal(rig.provider.sidebands[0]?.closes, 1);
      },
      {},
      LIMIT_250,
    );
  },
);

test(
  '予算到達: 指示を送れないサイドバンドでは、伝える相手がいないので待たずに閉じる',
  TIMEOUT,
  async () => {
    await withRig(
      async (rig) => {
        const live = await openLive(rig);
        const hb: Heartbeat = { n: 1 };
        const sideband = rig.provider.sidebands[0];
        assert(sideband !== undefined);
        sideband.canInstruct = false;
        await untilFirstTopUp(rig, hb, live);
        assert.deepEqual(sideband.instructions, []);
        const record = rig.voice.liveRecord(live);
        assert.deepEqual(
          [record?.closure, record?.end_reason],
          ['close_requested', 'budget_reached'],
        );
        assert.equal(sideband.closes, 1);
        assert.deepEqual(audioControls(rig, DEV_A), [
          ['close_voice_session', 'budget_reached', '0'],
        ]);
      },
      {},
      LIMIT_250,
    );
  },
);

// ---- 追加予約の結果不明・例外 ---------------------------------------------------------------------------------------------

test(
  '追加予約が 5 秒の期限までに返らなければ結果不明として予算到達の手順に入り、送り直さない',
  TIMEOUT,
  async () => {
    await withRig(async (rig) => {
      const live = await openLive(rig);
      const hb: Heartbeat = { n: 1 };
      (rig.budget as { topUp: unknown }).topUp = () => {
        rig.budget.calls.push('topup:60');
        return new Promise(() => undefined);
      };
      // 返らない予算の門の呼び出しがある間は、idle（予算の呼び出しの完了待ち）を待たずに時間を進める。
      const settle = rig.clock.settle;
      rig.clock.settle = flushOnly;
      await beat(rig, hb, 60000);
      assert.deepEqual(rig.budget.calls, [
        'reserve:195',
        'dispatch',
        'topup:60',
      ]);
      assert.deepEqual(rig.provider.sidebands[0]?.instructions, []);
      await beat(rig, hb, 6000);
      rig.clock.settle = settle;
      await rig.wait();
      // 60 秒 + 5 秒で結果不明になり、指示を送った。
      assert.deepEqual(rig.provider.sidebands[0]?.instructions, [
        'budget_reached',
      ]);
      assert.equal(rig.voice.liveRecord(live)?.closure, 'open');
      // 指示（65 秒）から 10 秒（75 秒）で閉じる。
      await beat(rig, hb, 8000);
      await rig.clock.advance(1000);
      await rig.wait();
      assert.equal(rig.voice.liveRecord(live)?.closure, 'close_requested');
      assert.equal(rig.provider.sidebands[0]?.closes, 1);
      // 追加予約は 1 回しか呼んでいない。券は古い版のままだが、精算は予約の ID と照合 ID で行う。
      rig.provider.sidebands[0]?.closed(76);
      await rig.wait();
      assert.deepEqual(
        rig.budget.calls.filter((call) => call.startsWith('topup')),
        ['topup:60'],
      );
      assert.deepEqual(actualGross(rig), [76]);
      assert.deepEqual(reservationStatus(rig), ['settled']);
    });
  },
);

test(
  '追加予約が例外で終わったときも予算到達の手順に入る（予約は増えない・精算は使用秒数のまま）',
  TIMEOUT,
  async () => {
    await withRig(async (rig) => {
      const live = await openLive(rig);
      const hb: Heartbeat = { n: 1 };
      rig.budget.failTopUps = 'throw';
      await untilFirstTopUp(rig, hb, live);
      assert.deepEqual(rig.provider.sidebands[0]?.instructions, [
        'budget_reached',
      ]);
      assert.deepEqual(
        voiceRows(rig).map((row) => row.reserved_amount),
        [195],
      );
      rig.provider.sidebands[0]?.utteranceEnded();
      await rig.wait();
      assert.equal(rig.voice.liveRecord(live)?.closure, 'close_requested');
    });
  },
);

test(
  '予算到達: 指示の送信が例外で終わっても、待たずに閉じる（例外で閉じる手順を止めない。P1）',
  TIMEOUT,
  async () => {
    await withRig(
      async (rig) => {
        const live = await openLive(rig);
        const hb: Heartbeat = { n: 1 };
        const sideband = rig.provider.sidebands[0];
        assert(sideband !== undefined);
        let instructionCalls = 0;
        sideband.appendInstructions = () => {
          instructionCalls += 1;
          throw new Error('synthetic');
        };
        // 60 秒の最初の追加予約は上限 250 で拒否される。指示は 1 回だけ試し、例外でも直ちに閉じる。
        await untilFirstTopUp(rig, hb, live);
        assert.equal(instructionCalls, 1);
        assert.equal(sideband.closes, 1);
        assert.notEqual(rig.voice.liveRecord(live)?.closure, 'open');
        assert.deepEqual(audioControls(rig, DEV_A), [
          ['close_voice_session', 'budget_reached', '0'],
        ]);
        // 320 秒まで pong とリースの更新を続けても、閉じたまま（予約を超えて話し続けない）。
        await beatWithRotation(rig, hb, 260000);
        assert.notEqual(rig.voice.liveRecord(live)?.closure, 'open');
        assert.equal(sideband.closes, 1);
        assert.equal(instructionCalls, 1);
        assert.deepEqual(reservationStatus(rig), ['usage_unknown']);
      },
      {},
      LIMIT_250,
    );
  },
);

test(
  '予算到達: 承認に固定された予約の追加予約が拒否されても、予算到達の手順に入る',
  TIMEOUT,
  async () => {
    await withRig(async (rig) => {
      const live = await openLive(rig);
      const hb: Heartbeat = { n: 1 };
      // 超過の承認に固定された予約は、追加予約で M を増やせない（DB の拒否の理由）。
      (rig.budget as { topUp: unknown }).topUp = () => {
        rig.budget.calls.push('topup:60');
        return Promise.resolve({
          ok: false,
          reasons: ['approval_fixes_max_liability'],
        });
      };
      await untilFirstTopUp(rig, hb, live);
      assert.deepEqual(rig.provider.sidebands[0]?.instructions, [
        'budget_reached',
      ]);
      assert.deepEqual(
        voiceRows(rig).map((row) => [row.reserved_amount, row.status]),
        [[195, 'reserved']],
      );
      assert.equal(rig.voice.liveRecord(live)?.closure, 'open');
      // 指示への発話の終わりで閉じ、端末へ予算到達を伝える。
      rig.provider.sidebands[0]?.utteranceEnded();
      await rig.wait();
      const record = rig.voice.liveRecord(live);
      assert.deepEqual(
        [record?.closure, record?.end_reason],
        ['close_requested', 'budget_reached'],
      );
      assert.equal(rig.provider.sidebands[0]?.closes, 1);
      assert.deepEqual(audioControls(rig, DEV_A), [
        ['close_voice_session', 'budget_reached', '0'],
      ]);
    });
  },
);

// ---- 時計の逆行 ----------------------------------------------------------------------------------------------------------------

test(
  '時計の逆行: 予算の上限の指示の後に時計が戻ったら、10 秒を数えられないので待たずに閉じる',
  TIMEOUT,
  async () => {
    await withRig(
      async (rig) => {
        const live = await openLive(rig);
        const hb: Heartbeat = { n: 1 };
        await untilFirstTopUp(rig, hb, live);
        assert.deepEqual(rig.provider.sidebands[0]?.instructions, [
          'budget_reached',
        ]);
        rig.clock.rewind(1000);
        rig.provider.sidebands[0]?.utteranceEnded();
        await rig.wait();
        const record = rig.voice.liveRecord(live);
        assert.deepEqual(
          [record?.closure, record?.end_reason],
          ['close_requested', 'budget_reached'],
        );
      },
      {},
      LIMIT_250,
    );
  },
);

test(
  '時計の逆行: 会話中に時計が戻ったら、会話の長さを数えられないので指示を送らず閉じる（端末へ budget_reached）',
  TIMEOUT,
  async () => {
    await withRig(async (rig) => {
      const live = await openLive(rig);
      const hb: Heartbeat = { n: 1 };
      await beat(rig, hb, 10000);
      rig.clock.rewind(1000);
      rig.provider.sidebands[0]?.pong();
      await rig.wait();
      const record = rig.voice.liveRecord(live);
      assert.deepEqual(
        [record?.closure, record?.end_reason],
        ['close_requested', 'budget_reached'],
      );
      assert.deepEqual(rig.provider.sidebands[0]?.instructions, []);
      assert.deepEqual(audioControls(rig, DEV_A), [
        ['close_voice_session', 'budget_reached', '0'],
      ]);
      rig.provider.sidebands[0]?.closed(10);
      await rig.wait();
      assert.deepEqual(actualGross(rig), [15]);
    });
  },
);

// ---- 精算 --------------------------------------------------------------------------------------------------------------------------

test(
  '精算: 15 秒と使用秒数の大きい方（5 秒→15、15 秒→15、16 秒→16）。確認した使用秒数が来るまで精算しない',
  TIMEOUT,
  async () => {
    for (const [usage, billed] of [
      [5, 15],
      [15, 15],
      [16, 16],
    ] as const)
      await withRig(async (rig) => {
        const live = await openLive(rig);
        // 端末の close の通知だけでは精算しない（使用量が確認できない）。
        await rig.voice.closeLiveSession(A, live, {
          request_id: uuid(0x93),
          command_scope_id: SCOPE_A,
          reason: 'conversation_ended',
          audio_epoch: '1',
        });
        await rig.wait();
        assert.deepEqual(reservationStatus(rig), ['reserved']);
        assert(!rig.budget.calls.some((call) => call.startsWith('settle')));
        rig.provider.sidebands[0]?.closed(usage);
        await rig.wait();
        assert.deepEqual(actualGross(rig), [billed]);
        assert.deepEqual(reservationStatus(rig), ['settled']);
      });
  },
);

test(
  '二重の精算の拒否: 同じ session.closed の再送・違う秒数の session.closed は精算を増やさず、予算の門も同じ照合 ID の違う金額を拒否する',
  TIMEOUT,
  async () => {
    await withRig(async (rig) => {
      const live = await openLive(rig);
      const sideband = rig.provider.sidebands[0];
      assert(sideband !== undefined);
      sideband.closed(20);
      await rig.wait();
      sideband.closed(20);
      sideband.closed(99);
      await rig.wait();
      assert.deepEqual(
        rig.budget.calls.filter((call) => call.startsWith('settle')),
        ['settle:20'],
      );
      const record = rig.voice.liveRecord(live);
      assert.deepEqual(
        [record?.closure, record?.usage_seconds],
        ['close_confirmed', 20],
      );
      assert.deepEqual(actualGross(rig), [20]);
      // 予算の門: 同じ Live・同じ金額は変化なし、違う金額・別の Live の ID は settlement_conflict。
      const ticket = await rig.budget.ticketOf(reservationIdOf(rig));
      assert.deepEqual(
        await rig.budget.settle(ticket, {
          live_session_id: live,
          usage_seconds: 20,
        }),
        { ok: true, duplicate: true },
      );
      assert.deepEqual(
        await rig.budget.settle(ticket, {
          live_session_id: live,
          usage_seconds: 30,
        }),
        { ok: false, reasons: ['settlement_conflict'] },
      );
      assert.deepEqual(
        await rig.budget.settle(ticket, {
          live_session_id: uuid(0x77),
          usage_seconds: 20,
        }),
        { ok: false, reasons: ['settlement_conflict'] },
      );
      assert.deepEqual(actualGross(rig), [20]);
    });
  },
);

test(
  '精算: 使用秒数が予約を超えても全額を記録し（実費 300）、最大負担の超過の確認が済むまで次の接続は 422',
  TIMEOUT,
  async () => {
    await withRig(async (rig) => {
      await openLive(rig);
      rig.provider.sidebands[0]?.closed(300);
      await rig.wait();
      assert.deepEqual(actualGross(rig), [300]);
      assert.deepEqual(reservationStatus(rig), ['settled']);
      const lease = await renew(rig, A, {
        lease_id: uuid(0x1b),
        nonce: 'm1',
        previous_nonce: null,
        at: 900_000,
      });
      assert.equal(bodyOf(lease)['result'], 'renewed');
      const again = await rig.voice.createLiveSession(A, liveBody());
      assert.deepEqual(
        [again.status, bodyOf(again)['code']],
        [422, 'budget_held'],
      );
    });
  },
);

test(
  '精算の失敗は同じ照合 ID で 3 回まで試し、尽きたら予約を保持する（別の金額を作らない）',
  TIMEOUT,
  async () => {
    await withRig(async (rig) => {
      await openLive(rig);
      rig.budget.failSettles = 1;
      rig.provider.sidebands[0]?.closed(20);
      await rig.wait();
      assert.deepEqual(reservationStatus(rig), ['reserved']);
      await rig.clock.advance(1000);
      await rig.wait();
      assert.deepEqual(reservationStatus(rig), ['settled']);
      assert.deepEqual(actualGross(rig), [20]);
      assert.deepEqual(
        rig.budget.calls.filter((call) => call.startsWith('settle')),
        ['settle:20', 'settle:20'],
      );
    });
    await withRig(async (rig) => {
      await openLive(rig);
      rig.budget.failSettles = 3;
      rig.provider.sidebands[0]?.closed(20);
      await rig.wait();
      await rig.clock.advance(1000);
      await rig.wait();
      await rig.clock.advance(1000);
      await rig.wait();
      assert.deepEqual(rig.budget.calls.slice(2), [
        'settle:20',
        'settle:20',
        'settle:20',
        'hold',
      ]);
      assert.deepEqual(reservationStatus(rig), ['usage_unknown']);
      assert.deepEqual(actualGross(rig), [null as unknown as number]);
    });
  },
);

test(
  '精算が 5 秒の期限までに返らなければ、同じ照合 ID で 3 回まで試し直し、尽きたら予約を保持する（P2-2）',
  TIMEOUT,
  async () => {
    await withRig(async (rig) => {
      await openLive(rig);
      (rig.budget as { settle: unknown }).settle = () => {
        rig.budget.calls.push('settle:20');
        return new Promise(() => undefined);
      };
      // 返らない予算の門の呼び出しがある間は、idle（予算の呼び出しの完了待ち）を待たずに時間を進める。
      const settle = rig.clock.settle;
      rig.clock.settle = flushOnly;
      rig.provider.sidebands[0]?.closed(20);
      await flushOnly();
      // 最初の精算は 5 秒で期限切れ、1 秒後に 2 回目、その 5 秒後に 3 回目、尽きたら保持する。
      await rig.clock.advance(6000);
      assert.deepEqual(
        rig.budget.calls.filter((call) => call.startsWith('settle')),
        ['settle:20', 'settle:20'],
      );
      await rig.clock.advance(600000);
      rig.clock.settle = settle;
      await waitUntil(
        rig,
        '精算を 3 回試して予約を保持する',
        () => reservationStatus(rig)[0] === 'usage_unknown',
      );
      assert.deepEqual(rig.budget.calls.slice(2), [
        'settle:20',
        'settle:20',
        'settle:20',
        'hold',
      ]);
      assert.deepEqual(reservationStatus(rig), ['usage_unknown']);
      assert.deepEqual(actualGross(rig), [null as unknown as number]);
    });
  },
);

test(
  '精算が settlement_conflict（同じ照合 ID の違う金額）で拒否されたら、試し直さず・保持にも戻さない（二重に数えない）',
  TIMEOUT,
  async () => {
    await withRig(async (rig) => {
      await openLive(rig);
      (rig.budget as { settle: unknown }).settle = () => {
        rig.budget.calls.push('settle:conflict');
        return Promise.resolve({
          ok: false,
          reasons: ['settlement_conflict'],
        });
      };
      rig.provider.sidebands[0]?.closed(20);
      await rig.wait();
      await rig.clock.advance(5000);
      await rig.wait();
      assert.deepEqual(rig.budget.calls.slice(2), ['settle:conflict']);
    });
  },
);

// ---- 結果不明の保持と終了後の照合 ------------------------------------------------------------------------------------------

// サイドバンドが切れ、閉じるための再接続もできず、終了未確認（予約を保持）になった Live を作る。
async function unconfirmedLive(rig: Rig): Promise<string> {
  const live = await openLive(rig);
  rig.provider.sidebandPlans.push('fail');
  rig.provider.sidebands[0]?.disconnect();
  await rig.wait();
  const record = rig.voice.liveRecord(live);
  assert.deepEqual(
    [record?.control_state, record?.closure],
    ['closed', 'close_unconfirmed'],
  );
  assert.deepEqual(reservationStatus(rig), ['usage_unknown']);
  return live;
}

test(
  '終了後の照合: 使用量を確認できなかった Live を provider へ照会し、閉じていて使用秒数が分かれば確認済みにして精算する',
  TIMEOUT,
  async () => {
    await withRig(async (rig) => {
      const live = await unconfirmedLive(rig);
      assert.deepEqual(actualGross(rig), [null as unknown as number]);
      rig.provider.lookups.set(live, {
        state: 'closed',
        provider_session_id: 'prov-synthetic',
        usage_seconds: 33,
      });
      await rig.clock.advance(LIVE_RECONCILE_INTERVAL_MS - 1);
      assert.deepEqual(rig.provider.lookupCalls, []);
      await rig.clock.advance(1);
      await rig.wait();
      assert.deepEqual(rig.provider.lookupCalls, [live]);
      const record = rig.voice.liveRecord(live);
      assert.deepEqual(
        [record?.closure, record?.usage_seconds],
        ['close_confirmed', 33],
      );
      assert.deepEqual(reservationStatus(rig), ['settled']);
      assert.deepEqual(actualGross(rig), [33]);
      // 確認できたので、次の間隔では照会しない。provider へ送り直してもいない。
      await rig.clock.advance(LIVE_RECONCILE_INTERVAL_MS * 2);
      assert.equal(rig.provider.lookupCalls.length, 1);
      assert.equal(rig.provider.created.length, 1);
    });
  },
);

test(
  '終了後の照合: 使用秒数が安全な整数でない・会話の最長に余裕を足した上限を超えるときは、確認済みにしない（P3-4）',
  TIMEOUT,
  async () => {
    for (const usage of [Number.MAX_SAFE_INTEGER + 1, 7_300]) {
      await withRig(async (rig) => {
        const live = await unconfirmedLive(rig);
        rig.provider.lookups.set(live, {
          state: 'closed',
          provider_session_id: 'prov-synthetic',
          usage_seconds: usage,
        });
        await rig.clock.advance(LIVE_RECONCILE_INTERVAL_MS);
        await rig.wait();
        const record = rig.voice.liveRecord(live);
        assert.deepEqual(
          [record?.closure, record?.usage_seconds],
          ['close_unconfirmed', null],
        );
        assert.deepEqual(reservationStatus(rig), ['usage_unknown']);
        assert.deepEqual(actualGross(rig), [null as unknown as number]);
      });
    }
  },
);

test(
  '終了後の照合: provider が見つけられない・使用秒数がない間は、解放も精算もせず保持し、間隔を置いて照会を続ける',
  TIMEOUT,
  async () => {
    await withRig(async (rig) => {
      const live = await unconfirmedLive(rig);
      await rig.clock.advance(LIVE_RECONCILE_INTERVAL_MS * 2);
      await rig.wait();
      assert.deepEqual(rig.provider.lookupCalls, [live, live]);
      rig.provider.lookups.set(live, {
        state: 'closed',
        provider_session_id: 'prov-synthetic',
        usage_seconds: null,
      });
      await rig.clock.advance(LIVE_RECONCILE_INTERVAL_MS);
      await rig.wait();
      assert.equal(rig.provider.lookupCalls.length, 3);
      assert.equal(rig.voice.liveRecord(live)?.closure, 'close_unconfirmed');
      assert.deepEqual(reservationStatus(rig), ['usage_unknown']);
      assert.deepEqual(actualGross(rig), [null as unknown as number]);
      assert(!rig.budget.calls.includes('release'));
      assert(!rig.budget.calls.some((call) => call.startsWith('settle')));
    });
  },
);

test(
  '終了後の照合: provider でまだ開いている Live は、閉じるためだけに接続して session.close を送り、届いた使用秒数で精算する',
  TIMEOUT,
  async () => {
    await withRig(async (rig) => {
      const live = await unconfirmedLive(rig);
      rig.provider.lookups.set(live, {
        state: 'open',
        provider_session_id: 'prov-open',
      });
      await rig.clock.advance(LIVE_RECONCILE_INTERVAL_MS);
      await rig.wait();
      assert.equal(rig.provider.connectCalls.at(-1), 'prov-open');
      const closer = rig.provider.last;
      assert.equal(closer.closes, 1);
      assert.equal(rig.voice.liveRecord(live)?.closure, 'close_unconfirmed');
      closer.closed(41);
      await rig.wait();
      const record = rig.voice.liveRecord(live);
      assert.deepEqual(
        [record?.closure, record?.usage_seconds],
        ['close_confirmed', 41],
      );
      assert.deepEqual(actualGross(rig), [41]);
      assert.deepEqual(reservationStatus(rig), ['settled']);
    });
  },
);

// ---- 孤児のセッション -----------------------------------------------------------------------------------------------------------

test(
  '孤児: provider のセッション作成が 10 秒の期限の後に成功したら、送り直さずそのセッションを閉じ、使用量で精算する',
  TIMEOUT,
  async () => {
    await withRig(async (rig) => {
      await renew(rig, A, {
        lease_id: LEASE,
        nonce: 'n1',
        previous_nonce: null,
        at: 10,
      });
      rig.provider.holdCreate = true;
      const pending = rig.voice.createLiveSession(A, liveBody());
      await waitUntil(
        rig,
        'provider.createSession の呼び出し',
        () => rig.provider.created.length === 1,
      );
      await rig.clock.advance(10000);
      const answered = await pending;
      assert.deepEqual(
        [answered.status, bodyOf(answered)['code']],
        [503, 'dependency_unavailable'],
      );
      await rig.wait();
      assert.deepEqual(reservationStatus(rig), ['usage_unknown']);
      const live = rig.provider.created[0]?.live_session_id as string;
      assert.equal(rig.voice.liveRecord(live)?.closure, 'close_unconfirmed');
      assert.equal(rig.provider.sidebands.length, 0);
      // 遅れて作られた。閉じに行き（接続して session.close）、使用 15 秒の確認で精算する。
      rig.provider.releaseCreate();
      await rig.wait();
      assert.deepEqual(rig.provider.connectCalls, [`prov-${live}`]);
      assert.equal(rig.provider.sidebands[0]?.closes, 1);
      rig.provider.sidebands[0]?.closed(15);
      await rig.wait();
      assert.equal(rig.voice.liveRecord(live)?.closure, 'close_confirmed');
      assert.deepEqual(actualGross(rig), [15]);
      assert.deepEqual(reservationStatus(rig), ['settled']);
      // 送り直していない（作成の要求は 1 回だけ）。
      assert.equal(rig.provider.created.length, 1);
      assert.equal(rig.voice.liveCount, 0);
    });
  },
);

test(
  '孤児 0 件: answer を待っている間の停止でも、作成の応答の後に閉じるためだけに接続して session.close を送り、精算する',
  TIMEOUT,
  async () => {
    await withRig(async (rig) => {
      await renew(rig, A, {
        lease_id: LEASE,
        nonce: 'n1',
        previous_nonce: null,
        at: 10,
      });
      rig.provider.holdCreate = true;
      const pending = rig.voice.createLiveSession(A, liveBody());
      await waitUntil(
        rig,
        'provider.createSession の呼び出し',
        () => rig.provider.created.length === 1,
      );
      const stopped = await rig.voice.stopIo(A, {
        request_id: uuid(0x91),
        command_scope_id: SCOPE_A,
        scope: 'local',
      });
      assert.equal(stopped.status, 202);
      rig.provider.releaseCreate();
      await rig.wait();
      const created = await pending;
      assert.deepEqual(
        [created.status, bodyOf(created)['code']],
        [409, 'conflict'],
      );
      // 作った provider のセッションを閉じに行った（孤児にしない）。
      const live = rig.provider.created[0]?.live_session_id as string;
      assert.deepEqual(rig.provider.connectCalls, [`prov-${live}`]);
      assert.equal(rig.provider.sidebands[0]?.closes, 1);
      rig.provider.sidebands[0]?.closed(2);
      await rig.wait();
      assert.deepEqual(actualGross(rig), [15]);
      assert.deepEqual(reservationStatus(rig), ['settled']);
      assert.equal(rig.voice.liveCount, 0);
    });
  },
);

// ---- 送出意図の前の再確認（U84） -------------------------------------------------------------------------------------------

test(
  '送出意図の記録を待つ間に停止が来たときだけ、予約を保持して送らない（記録の前に拾えるものは解放する。残る窓は記録の応答の間）',
  TIMEOUT,
  async () => {
    await withRig(async (rig) => {
      await renew(rig, A, {
        lease_id: LEASE,
        nonce: 'n1',
        previous_nonce: null,
        at: 10,
      });
      let release: () => void = () => undefined;
      let reached = false;
      const original = rig.budget.dispatch.bind(rig.budget);
      (rig.budget as { dispatch: unknown }).dispatch = (ticket: unknown) =>
        new Promise((resolve) => {
          reached = true;
          release = () => resolve(original(ticket));
        });
      const pending = rig.voice.createLiveSession(A, liveBody());
      await waitUntil(rig, '送出意図の記録の呼び出し', () => reached);
      await rig.voice.stopIo(A, {
        request_id: uuid(0x91),
        command_scope_id: SCOPE_A,
        scope: 'local',
      });
      release();
      await rig.wait();
      const created = await pending;
      assert.deepEqual(
        [created.status, bodyOf(created)['code']],
        [403, 'audio_ownership_required'],
      );
      await rig.wait();
      assert.equal(rig.provider.created.length, 0);
      assert.deepEqual(reservationStatus(rig), ['usage_unknown']);
    });
  },
);

// ---- 再起動の後の照合（Live 用の UsageReconciler。X28） ----------------------------------------------------------------

const liveRow = (rig: Rig, live: string) =>
  rig.harness.sql((db) =>
    db
      .prepare(
        'SELECT control_state, closure, usage_seconds FROM live_sessions WHERE live_session_id = ?',
      )
      .get(live),
  );

test(
  '再起動の照合: provider が閉じていて使用秒数が分かれば、予算の再起動の照合で精算し、Live の記録も確認済みにする（二重に数えず、送り直さない）',
  TIMEOUT,
  async () => {
    await withRig(async (rig) => {
      const live = await openLive(rig);
      rig.provider.lookups.set(live, {
        state: 'closed',
        provider_session_id: `prov-${live}`,
        usage_seconds: 77,
      });
      await rig.harness.restart();
      await rig.restart(CORE_2);
      await rig.wait();
      assert.deepEqual(reservationStatus(rig), ['settled']);
      assert.deepEqual(actualGross(rig), [77]);
      assert.deepEqual(liveRow(rig, live), {
        control_state: 'closed',
        closure: 'close_confirmed',
        usage_seconds: 77,
      });
      // 新しい起動の Live の口は、同じ照合 ID の再精算を変化なしで受ける（解放も保持もしない）。
      assert.deepEqual(rig.budget.calls, ['settle:77']);
      assert.equal(rig.provider.created.length, 1);
      assert.equal(voiceRows(rig).length, 1);
    });
  },
);

test(
  '再起動の照合: provider でまだ開いている Live（孤児）は、予算を使用量不明で保持したまま、閉じに行き、届いた使用秒数で精算する',
  TIMEOUT,
  async () => {
    await withRig(async (rig) => {
      const live = await openLive(rig);
      rig.provider.lookups.set(live, {
        state: 'open',
        provider_session_id: 'prov-orphan',
      });
      await rig.harness.restart();
      await rig.restart(CORE_2);
      await rig.wait();
      assert.deepEqual(reservationStatus(rig), ['usage_unknown']);
      assert.equal(rig.provider.connectCalls.at(-1), 'prov-orphan');
      const closer = rig.provider.last;
      assert.equal(closer.closes, 1);
      closer.closed(30);
      await rig.wait();
      assert.deepEqual(reservationStatus(rig), ['settled']);
      assert.deepEqual(actualGross(rig), [30]);
      assert.deepEqual(liveRow(rig, live), {
        control_state: 'closed',
        closure: 'close_confirmed',
        usage_seconds: 30,
      });
      assert.equal(rig.provider.created.length, 1);
    });
  },
);

test(
  '再起動の照合: provider が見つけられなければ、解放も精算もせず使用量不明のまま保持する（送り直さない）',
  TIMEOUT,
  async () => {
    await withRig(async (rig) => {
      const live = await openLive(rig);
      await rig.harness.restart();
      await rig.restart(CORE_2);
      await rig.wait();
      assert.deepEqual(reservationStatus(rig), ['usage_unknown']);
      assert.deepEqual(actualGross(rig), [null as unknown as number]);
      assert.deepEqual(liveRow(rig, live), {
        control_state: 'closed',
        closure: 'close_unconfirmed',
        usage_seconds: null,
      });
      assert.equal(rig.provider.created.length, 1);
      assert.deepEqual(rig.budget.calls, []);
    });
  },
);
