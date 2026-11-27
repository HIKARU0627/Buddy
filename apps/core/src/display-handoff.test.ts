// 流れの表示先の移動（POST /v1/stream/handoff・GET /v1/stream/handoff。UI-05 の段階 5、ADR 0193）の模擬試験。
// 音声の制御の試験の装置（DB worker・手で進める時計・端末 A・B の模擬）を使い、表示のリースの取得と更新・移動・拒否・
// 再送・停止・記録しない間・再起動を確かめる。期待値は手で書いた値で、実装から作らない。
// 経路の検査（本人の画面操作・接続範囲・ロック解除）は api-server の経路の表の試験が持つ。ここは中枢の判断だけを見る。
// 実機・実 API・実請求は使わない（未実施）。

import assert from 'node:assert/strict';
import test from 'node:test';
import { uuid } from './budget-test-support.js';
import type { JsonObject } from './strict-json.js';
import {
  A,
  B,
  CORE_2,
  DEV_A,
  DEV_B,
  SCOPE_A,
  SCOPE_B,
  TIMEOUT,
  bodyOf,
  renew,
  withRig,
} from './voice-rig-test-support.js';
import type { Rig } from './voice-rig-test-support.js';

const NIL = '00000000-0000-4000-8000-000000000000';
const LEASE_A = uuid(0x2a);
const LEASE_B = uuid(0x2b);

const handoffBody = (
  scope: string,
  target: string,
  expected: string,
  requestId = uuid(0x9100 + Math.floor(Math.random() * 0xff)),
): JsonObject => ({
  request_id: requestId,
  command_scope_id: scope,
  target_device_id: target,
  expected_route_revision: expected,
});

// 表示のリースを新しい lease_id で取る（nonce は 1 回目）。
const takeDisplay = (rig: Rig, who: typeof A, leaseId: string, at = 10) =>
  renew(rig, who, {
    lease_id: leaseId,
    nonce: 'n1',
    previous_nonce: null,
    at,
    kind: 'display',
  });

const reasonsOf = (result: { body: object }) => bodyOf(result)['reasons'];

test(
  '表示先: まだ誰も移していない間は、端末ごとに表示のリースを取れる（U473 の (a) のまま）。今の表示先は未決定の印',
  TIMEOUT,
  async () => {
    await withRig(async (rig) => {
      assert.deepEqual(bodyOf(rig.voice.displayRoute()), {
        session_id: NIL,
        route_revision: '0',
        display_device_id: NIL,
        state: 'completed',
      });
      assert.equal(
        bodyOf(await takeDisplay(rig, A, LEASE_A))['result'],
        'renewed',
      );
      assert.equal(
        bodyOf(await takeDisplay(rig, B, LEASE_B))['result'],
        'renewed',
      );
    });
  },
);

test(
  '表示先の移動: 表示を持つ前の端末は取り消され、次の更新は display_owned_elsewhere で拒否される。取り直しも拒否される',
  TIMEOUT,
  async () => {
    await withRig(async (rig) => {
      await takeDisplay(rig, A, LEASE_A);
      // A は表示のリースを持っている。B が「このPCに出す」。
      const moved = await rig.voice.handoffDisplay(
        B,
        handoffBody(SCOPE_B, DEV_B, '0'),
      );
      assert.equal(moved.status, 202);
      assert.deepEqual(bodyOf(moved), {
        session_id: NIL,
        route_revision: '1',
        display_device_id: DEV_B,
        // A の表示のリースを取り消したが、A が止まったことはまだ確かめていない。
        state: 'moving',
      });
      assert.equal(bodyOf(rig.voice.displayRoute())['state'], 'moving');
      // A の次の更新（同じリース）は拒否される。理由はこの 1 つだけ（ほかの理由に埋もれない）。
      const renewal = await renew(rig, A, {
        lease_id: LEASE_A,
        nonce: 'n2',
        previous_nonce: 'n1',
        at: 2010,
        kind: 'display',
      });
      assert.equal(bodyOf(renewal)['result'], 'rejected');
      assert.deepEqual(reasonsOf(renewal), ['display_owned_elsewhere']);
      assert.equal(bodyOf(renewal)['ttl_ms'], null);
      // 拒否したので、A が止まったと確かめた（moving が終わる）。
      assert.equal(bodyOf(rig.voice.displayRoute())['state'], 'completed');
      // 新しい lease_id での取り直しも拒否される（取り直しの繰り返しで表示を取り戻さない）。
      const retry = await renew(rig, A, {
        lease_id: uuid(0x2c),
        nonce: 'n1',
        previous_nonce: null,
        at: 4010,
        kind: 'display',
      });
      assert.deepEqual(reasonsOf(retry), ['display_owned_elsewhere']);
      // B は取れて、更新もできる。
      assert.equal(
        bodyOf(await takeDisplay(rig, B, LEASE_B, 20))['result'],
        'renewed',
      );
      const again = await renew(rig, B, {
        lease_id: LEASE_B,
        nonce: 'n2',
        previous_nonce: 'n1',
        at: 2020,
        kind: 'display',
      });
      assert.equal(bodyOf(again)['result'], 'renewed');
    });
  },
);

test(
  '表示先の移動: 前の端末が更新に来ないときは、中枢の見積もりの期限（最後の更新から 6 秒）まで moving、期限で completed',
  TIMEOUT,
  async () => {
    await withRig(async (rig) => {
      await takeDisplay(rig, A, LEASE_A);
      await rig.clock.advance(1000);
      const moved = await rig.voice.handoffDisplay(
        B,
        handoffBody(SCOPE_B, DEV_B, '0'),
      );
      assert.equal(bodyOf(moved)['state'], 'moving');
      // A の取得は時計 0 で受け付けた。期限は 6000 ちょうどで、5999 では moving のまま。
      await rig.clock.advance(4999);
      assert.equal(bodyOf(rig.voice.displayRoute())['state'], 'moving');
      await rig.clock.advance(1);
      assert.equal(bodyOf(rig.voice.displayRoute())['state'], 'completed');
    });
  },
);

test(
  '表示先の移動: 前の端末が表示のリースを持っていない・期限切れなら、確かめることがなく最初から completed。音声のリースは変えない',
  TIMEOUT,
  async () => {
    await withRig(async (rig) => {
      // A は音声のリースだけを持つ（表示のリースはない）。
      const audio = await renew(rig, A, {
        lease_id: uuid(0x2d),
        nonce: 'n1',
        previous_nonce: null,
        at: 10,
      });
      assert.equal(bodyOf(audio)['result'], 'renewed');
      const first = await rig.voice.handoffDisplay(
        B,
        handoffBody(SCOPE_B, DEV_B, '0'),
      );
      assert.equal(bodyOf(first)['state'], 'completed');
      // 音声のリースは表示先と関係なく更新できる。
      const audioAgain = await renew(rig, A, {
        lease_id: uuid(0x2d),
        nonce: 'n2',
        previous_nonce: 'n1',
        at: 2010,
      });
      assert.equal(bodyOf(audioAgain)['result'], 'renewed');
      // B が表示のリースを取り、7 秒更新しない（期限切れ）うちに A が移す。
      await takeDisplay(rig, B, LEASE_B, 3000);
      await rig.clock.advance(7000);
      const second = await rig.voice.handoffDisplay(
        A,
        handoffBody(SCOPE_A, DEV_A, '1'),
      );
      assert.equal(second.status, 202);
      assert.deepEqual(
        [bodyOf(second)['route_revision'], bodyOf(second)['state']],
        ['2', 'completed'],
      );
    });
  },
);

test(
  '表示先の移動: 移す先は呼び出した端末だけ（他の端末を指すと 403）。表示先も版も変えない',
  TIMEOUT,
  async () => {
    await withRig(async (rig) => {
      const refused = await rig.voice.handoffDisplay(
        A,
        handoffBody(SCOPE_A, DEV_B, '0'),
      );
      assert.equal(refused.status, 403);
      assert.equal(bodyOf(refused)['code'], 'forbidden');
      assert.deepEqual(bodyOf(rig.voice.displayRoute()), {
        session_id: NIL,
        route_revision: '0',
        display_device_id: NIL,
        state: 'completed',
      });
      // 誰の表示のリースも取り消されていない。
      assert.equal(
        bodyOf(await takeDisplay(rig, B, LEASE_B))['result'],
        'renewed',
      );
    });
  },
);

test(
  '表示先の移動: 版が今と違えば 409（先に別の端末が移した）。古い版・先の版・大きな値のどれも通らず、今の版なら通る',
  TIMEOUT,
  async () => {
    await withRig(async (rig) => {
      await rig.voice.handoffDisplay(B, handoffBody(SCOPE_B, DEV_B, '0'));
      // 他の端末（A）が古い版 0 のまま移そうとする。
      for (const stale of ['0', '2', '10']) {
        const refused = await rig.voice.handoffDisplay(
          A,
          handoffBody(SCOPE_A, DEV_A, stale),
        );
        assert.equal(refused.status, 409, stale);
        assert.equal(bodyOf(refused)['code'], 'conflict', stale);
      }
      // 拒否した間、表示先は B のまま。
      assert.equal(
        bodyOf(rig.voice.displayRoute())['display_device_id'],
        DEV_B,
      );
      assert.equal(bodyOf(rig.voice.displayRoute())['route_revision'], '1');
      const accepted = await rig.voice.handoffDisplay(
        A,
        handoffBody(SCOPE_A, DEV_A, '1'),
      );
      assert.equal(accepted.status, 202);
      assert.deepEqual(
        [
          bodyOf(accepted)['route_revision'],
          bodyOf(accepted)['display_device_id'],
        ],
        ['2', DEV_A],
      );
      // 今度は B が取れない。
      await takeDisplay(rig, A, LEASE_A, 5000);
      assert.deepEqual(reasonsOf(await takeDisplay(rig, B, LEASE_B, 5010)), [
        'display_owned_elsewhere',
      ]);
    });
  },
);

test(
  '表示先の移動: 同じ request_id・同じ内容の再送は同じ応答で版を進めず、内容が違えば 409。別の接続範囲の同じ request_id は別の要求',
  TIMEOUT,
  async () => {
    await withRig(async (rig) => {
      const id = uuid(0x9201);
      const body = handoffBody(SCOPE_B, DEV_B, '0', id);
      const first = await rig.voice.handoffDisplay(B, body);
      const replay = await rig.voice.handoffDisplay(B, body);
      assert.equal(replay.status, 202);
      assert.deepEqual(bodyOf(replay), bodyOf(first));
      assert.equal(bodyOf(rig.voice.displayRoute())['route_revision'], '1');
      // 同じ request_id で版だけ変えた（内容が違う）。
      const different = await rig.voice.handoffDisplay(
        B,
        handoffBody(SCOPE_B, DEV_B, '1', id),
      );
      assert.equal(different.status, 409);
      assert.equal(bodyOf(rig.voice.displayRoute())['route_revision'], '1');
      // 別の接続範囲では、同じ request_id でも別の要求（版 1 は今と同じなので通り、版が進む）。
      const otherScope = await rig.voice.handoffDisplay(
        B,
        handoffBody(uuid(0x5c), DEV_B, '1', id),
      );
      assert.equal(otherScope.status, 202);
      assert.equal(bodyOf(rig.voice.displayRoute())['route_revision'], '2');
    });
  },
);

test(
  '表示先の移動: この端末の入出力が止まっている（この端末の停止・全体停止）と 409 io_suspended。他の端末の表示を消さない',
  TIMEOUT,
  async () => {
    await withRig(async (rig) => {
      await takeDisplay(rig, A, LEASE_A);
      await rig.voice.stopIo(B, {
        request_id: uuid(0x91),
        command_scope_id: SCOPE_B,
        scope: 'local',
      });
      const refused = await rig.voice.handoffDisplay(
        B,
        handoffBody(SCOPE_B, DEV_B, '0'),
      );
      assert.equal(refused.status, 409);
      assert.equal(bodyOf(refused)['code'], 'io_suspended');
      assert.equal(bodyOf(rig.voice.displayRoute())['route_revision'], '0');
      // A の表示のリースは、そのまま更新できる。
      const renewal = await renew(rig, A, {
        lease_id: LEASE_A,
        nonce: 'n2',
        previous_nonce: 'n1',
        at: 2010,
        kind: 'display',
      });
      assert.equal(bodyOf(renewal)['result'], 'renewed');
      // 全体停止でも同じ（A が止めると、A も B も止まる）。
      await rig.voice.stopIo(A, {
        request_id: uuid(0x92),
        command_scope_id: SCOPE_A,
        scope: 'global',
      });
      const refusedA = await rig.voice.handoffDisplay(
        A,
        handoffBody(SCOPE_A, DEV_A, '0'),
      );
      assert.equal(refusedA.status, 409);
      assert.equal(bodyOf(refusedA)['code'], 'io_suspended');
    });
  },
);

test(
  '表示先の移動: 記録しない会話の間も移せるが、何も保存しない（会話の表の表示先・版は変わらない）。中枢の再起動で未決定に戻る',
  TIMEOUT,
  async () => {
    await withRig(
      async (rig) => {
        const rows = () =>
          rig.harness.sql(
            (db) =>
              db
                .prepare(
                  'SELECT session_id, display_device_id, route_revision FROM sessions ORDER BY session_id',
                )
                .all() as unknown[],
          );
        const before = rows();
        await takeDisplay(rig, A, LEASE_A);
        const moved = await rig.voice.handoffDisplay(
          B,
          handoffBody(SCOPE_B, DEV_B, '0'),
        );
        assert.equal(moved.status, 202);
        assert.equal(bodyOf(moved)['display_device_id'], DEV_B);
        assert.deepEqual(rows(), before);
        // 再起動（RAM の表示先は残らない）。
        await rig.restart(CORE_2);
        assert.deepEqual(bodyOf(rig.voice.displayRoute()), {
          session_id: NIL,
          route_revision: '0',
          display_device_id: NIL,
          state: 'completed',
        });
        const acquired = await renew(rig, A, {
          lease_id: uuid(0x2e),
          nonce: 'n1',
          previous_nonce: null,
          at: 10,
          kind: 'display',
          core: CORE_2,
        });
        assert.equal(bodyOf(acquired)['result'], 'renewed');
      },
      { privateConversation: () => true },
    );
  },
);

test(
  '表示先の端末が失効したら表示先は未決定に戻り（版は進む）、他の端末は表示のリースを取れる',
  TIMEOUT,
  async () => {
    await withRig(async (rig) => {
      await rig.voice.handoffDisplay(B, handoffBody(SCOPE_B, DEV_B, '0'));
      assert.deepEqual(reasonsOf(await takeDisplay(rig, A, LEASE_A)), [
        'display_owned_elsewhere',
      ]);
      // B を失効させる（端末の失効は DB の revoked_at）。
      rig.harness.sql((db) => {
        db.prepare(
          'UPDATE devices SET revoked_at = 2000 WHERE device_id = ?',
        ).run(DEV_B);
      });
      const acquired = await renew(rig, A, {
        lease_id: uuid(0x2f),
        nonce: 'n1',
        previous_nonce: null,
        at: 4010,
        kind: 'display',
      });
      assert.equal(bodyOf(acquired)['result'], 'renewed');
      // 失効を見て未決定に戻したので、版は 2、表示先は未決定の印。
      assert.deepEqual(
        [
          bodyOf(rig.voice.displayRoute())['route_revision'],
          bodyOf(rig.voice.displayRoute())['display_device_id'],
        ],
        ['2', NIL],
      );
    });
  },
);
