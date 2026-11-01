// B06-07a-2: 記録しない会話（保存境界の保持者の値）が音声の制御に効くこと（ADR 0045・0059）。
// 記録しない会話の間は Live の受付が 0 回、開いていれば閉じ始める、入出力の状態の private_conversation が実値。
// 模擬の Live provider。実際の音声・実 API・実機・実請求は使わない（未実施）。期待値は手で書いた。

import assert from 'node:assert/strict';
import test from 'node:test';
import { uuid } from './budget-test-support.js';
import {
  A,
  TIMEOUT,
  bodyOf,
  liveBody,
  openLive,
  renew,
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
  'private: a private conversation entered while the Live is still being created closes it as soon as it is registered',
  TIMEOUT,
  async () => {
    // 受付の判定の時点では記録する会話で、記録（DB）を待っている間に記録しない会話へ入った場合。
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
        // 4 回目の呼び出し（登録の直後の確認）で記録しない会話。作成の応答の後に閉じるための接続を張る。
        assert.equal(created.status, 409, JSON.stringify(created.body));
        assert.equal(rig.provider.created.length, 1);
        const sideband = rig.provider.sidebands[0];
        assert.ok(sideband);
        assert.equal(sideband.closes, 1);
      },
      { privateConversation: flip },
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
