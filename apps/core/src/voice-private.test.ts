// B06-07a-2: 記録しない会話（保存境界の保持者の値）が音声の制御に効くこと（ADR 0045・0059）。
// 記録しない会話の間は Live の受付が 0 回、開いていれば閉じ始める、入出力の状態の private_conversation が実値。
// 模擬の Live provider。実際の音声・実 API・実機・実請求は使わない（未実施）。期待値は手で書いた。

import assert from 'node:assert/strict';
import test from 'node:test';
import { uuid } from './budget-test-support.js';
import {
  A,
  TIMEOUT,
  actualGross,
  bodyOf,
  liveBody,
  openLive,
  renew,
  reservationStatus,
  waitUntil,
  withRig,
} from './voice-rig-test-support.js';

type RigOf = Parameters<Parameters<typeof withRig>[0]>[0];

async function lease(rig: RigOf, id = uuid(0x1a)): Promise<void> {
  const renewed = await renew(rig, A, {
    lease_id: id,
    nonce: 'n1',
    previous_nonce: null,
    at: 10,
  });
  assert.equal(bodyOf(renewed)['result'], 'renewed');
}

test(
  'private: while private, a Live start is refused before the budget gate and the provider are touched (0 connections)',
  TIMEOUT,
  async () => {
    const state = { private: true };
    await withRig(
      async (rig) => {
        await lease(rig);
        const refused = await rig.voice.createLiveSession(A, liveBody());
        // 409（private_conversation）。予約も provider への作成もない。
        assert.equal(refused.status, 409);
        assert.equal(bodyOf(refused)['code'], 'private_conversation');
        assert.equal(rig.provider.created.length, 0);
        assert.deepEqual(rig.budget.calls, []);
        // 記録する会話へ戻れば、同じ端末・同じリースで開ける。
        state.private = false;
        const created = await rig.voice.createLiveSession(A, liveBody());
        assert.equal(created.status, 201, JSON.stringify(created.body));
        assert.equal(rig.provider.created.length, 1);
      },
      { privateConversation: () => state.private },
    );
  },
);

test(
  'private: the io state reports the real value, in both directions',
  TIMEOUT,
  async () => {
    const state = { private: false };
    await withRig(
      async (rig) => {
        await lease(rig);
        const normal = (await rig.voice.ioState(A, 'unlocked')) as Record<
          string,
          unknown
        >;
        assert.equal(normal['private_conversation'], false);
        state.private = true;
        const priv = (await rig.voice.ioState(A, 'unlocked')) as Record<
          string,
          unknown
        >;
        assert.equal(priv['private_conversation'], true);
      },
      { privateConversation: () => state.private },
    );
  },
);

test(
  'private: entering closes the open Live (close request recorded, session.close sent once), and a second call does nothing',
  TIMEOUT,
  async () => {
    const state = { private: false };
    await withRig(
      async (rig) => {
        const live = await openLive(rig);
        assert.equal(rig.voice.liveRecord(live)?.closure, 'open');
        state.private = true;
        assert.equal(rig.voice.closeForPrivateConversation(), 1);
        const record = rig.voice.liveRecord(live);
        assert.deepEqual(
          [record?.control_state, record?.closure, record?.end_reason],
          ['closing', 'close_requested', 'private_conversation'],
        );
        assert.equal(rig.provider.sidebands[0]?.closes, 1);
        // 閉じ始めた接続には重ねて閉じる要求を送らない。
        assert.equal(rig.voice.closeForPrivateConversation(), 0);
        assert.equal(rig.provider.sidebands[0]?.closes, 1);
        // 終了の確認（session.closed）で使用量を精算できる（閉じ方は他の理由と同じ）。
        rig.provider.sidebands[0]?.closed(5);
        await rig.wait();
        assert.equal(rig.voice.liveRecord(live)?.closure, 'close_confirmed');
      },
      { privateConversation: () => state.private },
    );
  },
);

test(
  'private: with no open Live, closing for a private conversation closes nothing',
  TIMEOUT,
  async () => {
    await withRig(async (rig) => {
      assert.equal(rig.voice.closeForPrivateConversation(), 0);
    });
  },
);

test(
  'private: a private conversation entered while the Live record is being saved never reaches the provider, and the dispatched reservation is held (not billed)',
  TIMEOUT,
  async () => {
    // 受付の判定の時点では記録する会話で、Live の記録（DB）を待っている間に記録しない会話へ入った場合。
    // 判定は 3 回（1 段目・予約の後・2 段目）。2 段目の判定の後に入ったことを、呼び出しの回数で作る。
    let calls = 0;
    const flip = () => {
      calls += 1;
      return calls > 3;
    };
    await withRig(
      async (rig) => {
        await lease(rig);
        const created = await rig.voice.createLiveSession(A, liveBody());
        await rig.wait();
        assert.deepEqual(
          [created.status, bodyOf(created)['code']],
          [409, 'private_conversation'],
        );
        // provider へは何も送らない（Live の接続 0 回。X17・X36）。サイドバンドも張らない。
        assert.equal(rig.provider.created.length, 0);
        assert.equal(rig.provider.sidebands.length, 0);
        // 送出意図は記録済みなので予約は解放せず、使用量不明として保持する（15 秒の最低額で精算しない）。
        assert.deepEqual(rig.budget.calls, ['reserve:195', 'dispatch', 'hold']);
        assert.deepEqual(reservationStatus(rig), ['usage_unknown']);
        assert.deepEqual(actualGross(rig), [null]);
        // 保存した Live の記録は、終了を確認できない状態で閉じ、理由は記録しない会話。
        const stored = rig.harness.sql(
          (db) =>
            db
              .prepare(
                'SELECT control_state, closure, end_reason, usage_seconds FROM live_sessions',
              )
              .all() as Record<string, unknown>[],
        );
        assert.deepEqual(stored, [
          {
            control_state: 'closed',
            closure: 'close_unconfirmed',
            end_reason: 'private_conversation',
            usage_seconds: null,
          },
        ]);
      },
      { privateConversation: flip },
    );
  },
);

test(
  'private: a private conversation entered and left while the budget is being reserved does not let the old request through (conflict, reservation released, provider untouched)',
  TIMEOUT,
  async () => {
    // 記録しない会話に入って出た（真偽値は false に戻る）が、区切りの世代は進んでいる場合。世代の読み出しは、受付の開始・
    // 1 段目・予約の後・2 段目・登録の後の順。予約の後（3 回目）から世代が変わる。
    let reads = 0;
    const storageBoundary = () => {
      reads += 1;
      return reads >= 3 ? '3' : '1';
    };
    await withRig(
      async (rig) => {
        await lease(rig);
        const refused = await rig.voice.createLiveSession(A, liveBody());
        await rig.wait();
        assert.deepEqual(
          [refused.status, bodyOf(refused)['code']],
          [409, 'conflict'],
        );
        // 送出意図の前に断ったので、予約は解放できる。provider には何も送らない。
        assert.equal(rig.provider.created.length, 0);
        assert.deepEqual(rig.budget.calls, ['reserve:195', 'release']);
        assert.deepEqual(reservationStatus(rig), ['released']);
        assert.deepEqual(
          rig.harness.sql((db) =>
            db.prepare('SELECT count(*) FROM live_sessions').pluck().get(),
          ),
          0,
        );
      },
      { privateConversation: () => false, storageBoundary },
    );
  },
);

test(
  'private: a private conversation entered and left while the Live record is being saved never reaches the provider (hold, conflict)',
  TIMEOUT,
  async () => {
    // 世代の読み出し: 受付の開始・1 段目・予約の後・2 段目・登録の後。登録の後（5 回目）から世代が変わる。
    let reads = 0;
    const storageBoundary = () => {
      reads += 1;
      return reads >= 5 ? '3' : '1';
    };
    await withRig(
      async (rig) => {
        await lease(rig);
        const refused = await rig.voice.createLiveSession(A, liveBody());
        await rig.wait();
        assert.deepEqual(
          [refused.status, bodyOf(refused)['code']],
          [409, 'conflict'],
        );
        assert.equal(rig.provider.created.length, 0);
        assert.deepEqual(rig.budget.calls, ['reserve:195', 'dispatch', 'hold']);
        assert.deepEqual(reservationStatus(rig), ['usage_unknown']);
      },
      { privateConversation: () => false, storageBoundary },
    );
  },
);

test(
  'private: an unchanged storage boundary lets the Live start (the generation check does not block the normal path)',
  TIMEOUT,
  async () => {
    await withRig(
      async (rig) => {
        await lease(rig);
        const created = await rig.voice.createLiveSession(A, liveBody());
        assert.equal(created.status, 201, JSON.stringify(created.body));
        assert.equal(rig.provider.created.length, 1);
      },
      { privateConversation: () => false, storageBoundary: () => '7' },
    );
  },
);

test(
  'private: entering while the provider is creating the session still closes it once the answer arrives (the request was already sent)',
  TIMEOUT,
  async () => {
    // 作成の呼び出しの後（応答を待つ間）に入った場合は、すでに送っている。応答の後に閉じる（作成の途中の接続の扱い）。
    const state = { private: false };
    await withRig(
      async (rig) => {
        await lease(rig);
        rig.provider.holdCreate = true;
        const pending = rig.voice.createLiveSession(A, liveBody());
        await waitUntil(
          rig,
          'provider への作成の呼び出し',
          () => rig.provider.created.length === 1,
        );
        state.private = true;
        assert.equal(rig.voice.closeForPrivateConversation(), 1);
        rig.provider.releaseCreate();
        const created = await pending;
        await rig.wait();
        assert.equal(created.status, 409, JSON.stringify(created.body));
        assert.equal(rig.provider.created.length, 1);
      },
      { privateConversation: () => state.private },
    );
  },
);

test(
  'private: Live input is refused while private even if the connection has not finished closing',
  TIMEOUT,
  async () => {
    const state = { private: false };
    await withRig(
      async (rig) => {
        const live = await openLive(rig);
        state.private = true;
        const conditions = await rig.voice.conversationHost().conditions(live);
        assert.equal(conditions?.not_private_conversation, false);
        state.private = false;
        const back = await rig.voice.conversationHost().conditions(live);
        assert.equal(back?.not_private_conversation, true);
      },
      { privateConversation: () => state.private },
    );
  },
);
