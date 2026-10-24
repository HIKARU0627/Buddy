// 中枢の音声の制御（B05-03、ADR 0046）の模擬試験。DB worker（一時ディレクトリ）・予算の門・模擬の Live の provider・
// 手で進める時計で、リース・音声所有権・停止の到達・サイドバンドの喪失・再起動の後の世代を確かめる。
// 端末の側は domain の規則（acceptLeaseRenewal・observeLease・assessStop）で模擬する。期待値は手で書いた値で、
// 実装から作らない。実際の音声・実 API・実機・実請求は使わない（未実施）。

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  acceptLeaseRenewal,
  assessStop,
  observeLease,
  planStop,
} from '@buddy/domain';
import type { HeldLease, LeaseSendRecord } from '@buddy/domain';
import type { DeviceRecord } from '@buddy/storage';
import { uuid } from './budget-test-support.js';
import type { JsonObject } from './strict-json.js';
import { VoiceControl } from './voice-control.js';
import type { VoiceControlOptions } from './voice-control.js';
import {
  A,
  B,
  CORE,
  CORE_2,
  DEV_A,
  DEV_B,
  SCOPE_A,
  SCOPE_B,
  TIMEOUT,
  actualGross,
  audioControls,
  bodyOf,
  leaseBody,
  liveBody,
  openLive,
  renew,
  reservationStatus,
  waitUntil,
  withRig,
} from './voice-rig-test-support.js';
import type { Rig } from './voice-rig-test-support.js';

// ---- リースの取得と更新 --------------------------------------------------------------------------------------------

test(
  'リース: 取得と更新、ttl は 6 秒に切り詰め、使い済みの nonce・古い単調時計・別の起動 ID・別の端末は拒否する',
  TIMEOUT,
  async () => {
    await withRig(async (rig) => {
      const lease = uuid(0x1a);
      const first = bodyOf(
        await renew(rig, A, {
          lease_id: lease,
          nonce: 'n1',
          previous_nonce: null,
          at: 100,
          ttl_ms: 60000,
        }),
      );
      assert.deepEqual(
        [first['result'], first['reasons'], first['ttl_ms']],
        ['renewed', [], 6000],
      );
      const second = bodyOf(
        await renew(rig, A, {
          lease_id: lease,
          nonce: 'n2',
          previous_nonce: 'n1',
          at: 2100,
        }),
      );
      assert.deepEqual([second['result'], second['ttl_ms']], ['renewed', 6000]);
      // 最初の nonce の使い回し（A → B → A）。前の nonce も違う。
      assert.deepEqual(
        bodyOf(
          await renew(rig, A, {
            lease_id: lease,
            nonce: 'n1',
            previous_nonce: 'n2',
            at: 4100,
          }),
        )['reasons'],
        ['nonce_reused'],
      );
      // 単調時計が増えない。
      assert.deepEqual(
        bodyOf(
          await renew(rig, A, {
            lease_id: lease,
            nonce: 'n3',
            previous_nonce: 'n2',
            at: 2100,
          }),
        )['reasons'],
        ['mono_clock_regressed'],
      );
      // 前の起動の ID（中枢の再起動の後の要求）。
      assert.deepEqual(
        bodyOf(
          await renew(rig, A, {
            lease_id: lease,
            nonce: 'n4',
            previous_nonce: 'n2',
            at: 6100,
            core: CORE_2,
          }),
        )['reasons'],
        ['core_restarted'],
      );
      // 本文の端末が認証した端末と違う。
      assert.deepEqual(
        bodyOf(
          await renew(rig, A, {
            lease_id: lease,
            nonce: 'n5',
            previous_nonce: 'n2',
            at: 6200,
            device_id: DEV_B,
          }),
        )['reasons'],
        ['device_mismatch'],
      );
      // 接続範囲が変わった（再接続）。
      assert.deepEqual(
        bodyOf(
          await renew(rig, A, {
            lease_id: lease,
            nonce: 'n6',
            previous_nonce: 'n2',
            at: 6300,
            scope: uuid(0x5c),
          }),
        )['reasons'],
        ['scope_changed'],
      );
    });
  },
);

test(
  'リース: ロック中・ロック状態が分からない端末には渡さない（解除済みと扱わない）',
  TIMEOUT,
  async () => {
    await withRig(async (rig) => {
      for (const lock of ['locked', null] as const)
        assert.deepEqual(
          bodyOf(
            await renew(
              rig,
              A,
              {
                lease_id: uuid(0x1b),
                nonce: 'n1',
                previous_nonce: null,
                at: 1,
              },
              lock,
            ),
          )['reasons'],
          ['io_suspended'],
        );
      assert.equal(rig.voice.audioOwner(A), 'none');
    });
  },
);

test(
  'リース: 同じリースの更新は 1800 回で取り直しを求める（nonce の履歴の上限。U69）',
  TIMEOUT,
  async () => {
    await withRig(async (rig) => {
      const lease = uuid(0x1c);
      let previous: string | null = null;
      for (let i = 0; i < 1800; i += 1) {
        const result = bodyOf(
          await renew(rig, A, {
            lease_id: lease,
            nonce: `n${i}`,
            previous_nonce: previous,
            at: 10 + i,
          }),
        );
        assert.equal(result['result'], 'renewed', String(i));
        previous = `n${i}`;
      }
      assert.deepEqual(
        bodyOf(
          await renew(rig, A, {
            lease_id: lease,
            nonce: 'n1800',
            previous_nonce: 'n1799',
            at: 5000,
          }),
        )['reasons'],
        ['lease_rotation_required'],
      );
      // 新しい lease_id で取り直せる（同じ端末なので調停しない）。
      assert.equal(
        bodyOf(
          await renew(rig, A, {
            lease_id: uuid(0x1d),
            nonce: 'm1',
            previous_nonce: null,
            at: 5001,
          }),
        )['result'],
        'renewed',
      );
    });
  },
);

// ---- 同時の呼びかけと端末の交代（X32・10 §8） ---------------------------------------------------------------------

test(
  'X32: 300 ms 以内の 2 台目は 409、表示先の端末なら優先し、前の所有者は更新できず停止の通知を受ける',
  TIMEOUT,
  async () => {
    let target: string | null = null;
    await withRig(
      async (rig) => {
        await renew(rig, A, {
          lease_id: uuid(0x1a),
          nonce: 'a1',
          previous_nonce: null,
          at: 1,
        });
        await rig.clock.advance(100);
        const refused = await renew(rig, B, {
          lease_id: uuid(0x1b),
          nonce: 'b1',
          previous_nonce: null,
          at: 1,
        });
        assert.deepEqual(
          [refused.status, bodyOf(refused)['code']],
          [409, 'audio_owned_elsewhere'],
        );
        assert.equal(rig.voice.audioOwner(B), 'other');
        // 300 ms ちょうど・表示先は B。
        target = DEV_B;
        await rig.clock.advance(200);
        const won = await renew(rig, B, {
          lease_id: uuid(0x1c),
          nonce: 'b2',
          previous_nonce: null,
          at: 2,
        });
        assert.equal(bodyOf(won)['result'], 'renewed');
        assert.equal(rig.voice.audioOwner(B), 'self');
        assert.equal(rig.voice.audioOwner(A), 'other');
        const old = await renew(rig, A, {
          lease_id: uuid(0x1a),
          nonce: 'a2',
          previous_nonce: 'a1',
          at: 2001,
        });
        assert.deepEqual(
          [old.status, bodyOf(old)['code']],
          [409, 'audio_owned_elsewhere'],
        );
        assert.deepEqual(audioControls(rig, DEV_A), [
          ['close_voice_session', 'device_move', '0'],
        ]);
      },
      { displayTarget: () => target },
    );
  },
);

test(
  '端末の交代: 窓より後の呼びかけは、前の端末の Live を先に閉じ（device_move）、新しい世代で開く',
  TIMEOUT,
  async () => {
    await withRig(async (rig) => {
      const first = await openLive(rig);
      assert.equal(rig.voice.liveRecord(first)?.control_state, 'ready');
      await rig.clock.advance(301);
      const taken = await renew(rig, B, {
        lease_id: uuid(0x2b),
        nonce: 'b1',
        previous_nonce: null,
        at: 5,
      });
      assert.equal(bodyOf(taken)['result'], 'renewed');
      // 前の端末の Live は閉じる要求を記録し、サイドバンドから session.close を送った（第 3 層）。
      const record = rig.voice.liveRecord(first);
      assert.deepEqual(
        [record?.control_state, record?.closure, record?.end_reason],
        ['closing', 'close_requested', 'device_move'],
      );
      assert.equal(rig.provider.sidebands[0]?.closes, 1);
      const second = await rig.voice.createLiveSession(B, liveBody(SCOPE_B));
      assert.equal(second.status, 201);
      // 世代は端末ごと。B の最初の接続は 1。A の世代は戻らない。
      assert.deepEqual(
        [bodyOf(second)['audio_epoch'], bodyOf(second)['session_epoch']],
        ['1', '1'],
      );
    });
  },
);

// ---- Live の接続の受付（古い世代・期限切れのリースでは開けない） --------------------------------------------------------

test(
  'Live の接続: リースなし・期限切れ・別の接続範囲・同意なし・同じリースの 2 回目は開かず、provider へ送らない',
  TIMEOUT,
  async () => {
    await withRig(async (rig) => {
      const none = await rig.voice.createLiveSession(A, liveBody());
      assert.deepEqual(
        [none.status, bodyOf(none)['code']],
        [403, 'audio_ownership_required'],
      );
      await renew(rig, A, {
        lease_id: uuid(0x1a),
        nonce: 'n1',
        previous_nonce: null,
        at: 1,
      });
      const otherScope = await rig.voice.createLiveSession(
        A,
        liveBody(uuid(0x5c)),
      );
      assert.deepEqual(
        [otherScope.status, bodyOf(otherScope)['code']],
        [403, 'audio_lease_invalid'],
      );
      // 中枢の見積もりで 6 秒ちょうどで切れる。
      await rig.clock.advance(5999);
      assert.equal(rig.voice.audioOwner(A), 'self');
      await rig.clock.advance(1);
      assert.equal(rig.voice.audioOwner(A), 'none');
      const expired = await rig.voice.createLiveSession(A, liveBody());
      assert.deepEqual(
        [expired.status, bodyOf(expired)['code']],
        [403, 'audio_ownership_required'],
      );
      const live = await openLive(rig, uuid(0x1b));
      assert.ok(live);
      const again = await rig.voice.createLiveSession(A, liveBody());
      assert.deepEqual(
        [again.status, bodyOf(again)['code']],
        [403, 'audio_lease_invalid'],
      );
      assert.equal(rig.provider.created.length, 1);
      assert.deepEqual(rig.budget.calls, ['reserve:195', 'dispatch']);
    });
    await withRig(
      async (rig) => {
        await renew(rig, A, {
          lease_id: uuid(0x1a),
          nonce: 'n1',
          previous_nonce: null,
          at: 1,
        });
        const refused = await rig.voice.createLiveSession(A, liveBody());
        assert.deepEqual(
          [refused.status, bodyOf(refused)['code']],
          [403, 'external_send_consent_required'],
        );
        assert.equal(rig.provider.created.length, 0);
      },
      { consent: () => 'revoked' },
    );
  },
);

test(
  'Live の接続: provider の結果が不明なら送り直さず、終了未確認として予約を保持する',
  TIMEOUT,
  async () => {
    await withRig(async (rig) => {
      rig.provider.createPlan = 'fail';
      await renew(rig, A, {
        lease_id: uuid(0x1a),
        nonce: 'n1',
        previous_nonce: null,
        at: 1,
      });
      const failed = await rig.voice.createLiveSession(A, liveBody());
      assert.deepEqual(
        [failed.status, bodyOf(failed)['code']],
        [503, 'dependency_unavailable'],
      );
      await rig.wait();
      assert.equal(rig.provider.created.length, 1);
      assert.deepEqual(rig.budget.calls, ['reserve:195', 'dispatch', 'hold']);
      assert.deepEqual(reservationStatus(rig), ['usage_unknown']);
    });
  },
);

// ---- サイドバンドの喪失（X25） ----------------------------------------------------------------------------------------

test(
  'X25: pong が 6 秒ないと lost（5999 ms では ready）。リースを更新せず停止を送り、閉じるためだけに再接続して精算する',
  TIMEOUT,
  async () => {
    await withRig(async (rig) => {
      const live = await openLive(rig);
      assert.deepEqual(
        (rig.events.get(DEV_A) ?? []).map((event) => event['event_type']),
        ['sideband_connected'],
      );
      // 1 回目の更新（2 秒ごと）は通る。
      await rig.clock.advance(2000);
      assert.equal(
        bodyOf(
          await renew(rig, A, {
            lease_id: uuid(0x1a),
            nonce: 'n2',
            previous_nonce: 'n1',
            at: 2010,
          }),
        )['result'],
        'renewed',
      );
      await rig.clock.advance(3999);
      assert.equal(rig.voice.liveRecord(live)?.control_state, 'ready');
      assert.equal(rig.provider.sidebands[0]?.pings, 2);
      await rig.clock.advance(1);
      await rig.wait();
      const record = rig.voice.liveRecord(live);
      assert.deepEqual(
        [record?.control_state, record?.control_epoch, record?.end_reason],
        ['closing', '1', 'sideband_lost'],
      );
      assert.deepEqual(audioControls(rig, DEV_A), [
        ['close_voice_session', 'sideband_lost', '0'],
      ]);
      // ハートビートが正常でも、lost 以降は音声リースを更新しない。
      assert.deepEqual(
        bodyOf(
          await renew(rig, A, {
            lease_id: uuid(0x1a),
            nonce: 'n3',
            previous_nonce: 'n2',
            at: 4010,
          }),
        )['reasons'],
        ['sideband_lost'],
      );
      // 閉じるためだけの再接続（2 本目のサイドバンド）で session.close を送った。
      assert.equal(rig.provider.connectCalls.length, 2);
      assert.equal(rig.provider.sidebands[1]?.closes, 1);
      rig.provider.sidebands[1]?.closed(9);
      await rig.wait();
      const closed = rig.voice.liveRecord(live);
      assert.deepEqual(
        [closed?.control_state, closed?.closure, closed?.usage_seconds],
        ['closed', 'close_confirmed', 9],
      );
      // 使用 9 秒を渡し、15 秒の最低課金（1 秒 1 単位の合成の単価で 15）で精算した。
      assert.deepEqual(rig.budget.calls, [
        'reserve:195',
        'dispatch',
        'settle:9',
      ]);
      assert.deepEqual(reservationStatus(rig), ['settled']);
      assert.deepEqual(actualGross(rig), [15]);
    });
  },
);

test(
  'X25: 閉じるための再接続が 3 秒で成り立たなければ終了未確認（予約を保持）にし、期限の後に成り立った接続は使わない',
  TIMEOUT,
  async () => {
    await withRig(async (rig) => {
      const live = await openLive(rig);
      rig.provider.sidebandPlans.push('hold');
      rig.provider.sidebands[0]?.disconnect();
      await rig.wait();
      assert.equal(rig.voice.liveRecord(live)?.control_state, 'closing');
      await rig.clock.advance(2999);
      assert.equal(rig.voice.liveRecord(live)?.closure, 'close_requested');
      await rig.clock.advance(1);
      await rig.wait();
      assert.deepEqual(
        [
          rig.voice.liveRecord(live)?.control_state,
          rig.voice.liveRecord(live)?.closure,
        ],
        ['closed', 'close_unconfirmed'],
      );
      assert.deepEqual(reservationStatus(rig), ['usage_unknown']);
      // 期限の後に成り立った接続は使わない（切る）。
      const late = rig.provider.releaseHeld();
      await rig.wait();
      assert.equal(late?.terminated, true);
      assert.equal(late?.closes, 0);
    });
  },
);

test(
  'X25: session.close の後 2 秒で session.closed がなければ終了未確認。後から届いた使用秒数で照合して精算する',
  TIMEOUT,
  async () => {
    await withRig(async (rig) => {
      const live = await openLive(rig);
      const closed = await rig.voice.closeLiveSession(A, live, {
        request_id: uuid(0x93),
        command_scope_id: SCOPE_A,
        reason: 'silence',
        audio_epoch: '1',
      });
      assert.equal(closed.status, 202);
      assert.deepEqual(bodyOf(closed), {
        live_session_id: live,
        control_state: 'closing',
        control_epoch: '0',
        closure: 'close_requested',
        usage_seconds: null,
        reservation_state: 'reserved',
      });
      assert.equal(rig.provider.sidebands[0]?.closes, 1);
      await rig.clock.advance(1999);
      assert.equal(rig.voice.liveRecord(live)?.control_state, 'closing');
      await rig.clock.advance(1);
      await rig.wait();
      assert.equal(rig.voice.liveRecord(live)?.closure, 'close_unconfirmed');
      // 終了未確認にした接続は切る。後から使用秒数が分かったとき（模擬では切った後の受け口へ届ける）は照合して精算する。
      assert.equal(rig.provider.sidebands[0]?.terminated, true);
      rig.provider.sidebands[0]?.closed(40);
      await rig.wait();
      assert.deepEqual(
        [
          rig.voice.liveRecord(live)?.closure,
          rig.voice.liveRecord(live)?.usage_seconds,
        ],
        ['close_confirmed', 40],
      );
      assert.deepEqual(rig.budget.calls, [
        'reserve:195',
        'dispatch',
        'hold',
        'settle:40',
      ]);
      // 古い audio_epoch の終了の通知は 409、他の端末の接続は見せない。
      const stale = await rig.voice.closeLiveSession(A, live, {
        request_id: uuid(0x94),
        command_scope_id: SCOPE_A,
        reason: 'silence',
        audio_epoch: '0',
      });
      assert.equal(stale.status, 409);
      const other = await rig.voice.closeLiveSession(B, live, {
        request_id: uuid(0x95),
        command_scope_id: SCOPE_B,
        reason: 'silence',
        audio_epoch: '1',
      });
      assert.equal(other.status, 404);
    });
  },
);

// ---- 停止と再開（X13・X14・QA43） -----------------------------------------------------------------------------------

test(
  'X14: 全体停止は要求した端末を確認済み・他を応答待ちにし、他の端末の Live をサイドバンドから閉じ、停止を送る',
  TIMEOUT,
  async () => {
    await withRig(async (rig) => {
      // B が会話中（音声リースと Live）。
      await renew(rig, B, {
        lease_id: uuid(0x2b),
        nonce: 'b1',
        previous_nonce: null,
        at: 1,
      });
      const created = await rig.voice.createLiveSession(B, liveBody(SCOPE_B));
      assert.equal(created.status, 201);
      await rig.wait();
      const live = bodyOf(created)['live_session_id'] as string;
      const stopped = await rig.voice.stopIo(A, {
        request_id: uuid(0x91),
        command_scope_id: SCOPE_A,
        scope: 'global',
      });
      assert.equal(stopped.status, 202);
      assert.deepEqual(bodyOf(stopped), {
        scope: 'global',
        io_epoch: '1',
        devices: [
          { device_id: DEV_A, stop_state: 'confirmed' },
          { device_id: DEV_B, stop_state: 'awaiting_ack' },
        ],
        all_confirmed: false,
      });
      // 第 3 層: 中枢が B の Live を閉じ始めた（session.close を送った）。
      assert.deepEqual(
        [
          rig.voice.liveRecord(live)?.control_state,
          rig.voice.liveRecord(live)?.end_reason,
        ],
        ['closing', 'global_stop'],
      );
      assert.equal(rig.provider.sidebands[0]?.closes, 1);
      assert.deepEqual(audioControls(rig, DEV_B), [
        ['suspend_io', 'global_stop', '1'],
      ]);
      assert.deepEqual(audioControls(rig, DEV_A), []);
      // B は停止の通知を受けなくても、更新が通らない（古い世代・停止中）。
      assert.deepEqual(
        bodyOf(
          await renew(rig, B, {
            lease_id: uuid(0x2b),
            nonce: 'b2',
            previous_nonce: 'b1',
            at: 2001,
          }),
        )['reasons'],
        ['stale_io_epoch', 'io_suspended'],
      );
      // 中枢の見積もりで B のリースが切れた後の停止は、失効（確認ではない）。
      await rig.clock.advance(6000);
      const again = await rig.voice.stopIo(A, {
        request_id: uuid(0x92),
        command_scope_id: SCOPE_A,
        scope: 'global',
      });
      assert.deepEqual(bodyOf(again)['devices'], [
        { device_id: DEV_A, stop_state: 'confirmed' },
        { device_id: DEV_B, stop_state: 'lease_expired' },
      ]);
      assert.equal(bodyOf(again)['all_confirmed'], false);
    });
  },
);

test(
  'QA43: 解除・再接続・新しいリースだけでは再開せず、画面の再開は版が一致するときだけ（世代は戻らない）',
  TIMEOUT,
  async () => {
    await withRig(async (rig) => {
      await rig.voice.stopIo(A, {
        request_id: uuid(0x91),
        command_scope_id: SCOPE_A,
        scope: 'local',
      });
      // 停止中は新しいリースを渡さない（再接続しても同じ）。
      assert.deepEqual(
        bodyOf(
          await renew(rig, A, {
            lease_id: uuid(0x3a),
            nonce: 'n1',
            previous_nonce: null,
            at: 1,
            io_epoch: '1',
            scope: uuid(0x5d),
          }),
        )['reasons'],
        ['io_suspended'],
      );
      const state = (await rig.voice.ioState(A, 'unlocked')) as JsonObject;
      assert.deepEqual(
        [
          state['io_epoch'],
          state['output_epoch'],
          state['stop_scope'],
          state['input_permitted'],
          state['voice_state'],
        ],
        ['1', '1', 'local', false, 'device_stopped'],
      );
      const stale = await rig.voice.resumeIo(
        A,
        {
          request_id: uuid(0x96),
          command_scope_id: SCOPE_A,
          scope: 'local',
          expected_io_epoch: '0',
        },
        'unlocked',
      );
      assert.deepEqual(
        [stale.status, bodyOf(stale)['code']],
        [409, 'conflict'],
      );
      assert.equal(
        await rig.voice.revisionMatches(A, { expected_io_epoch: '1' }),
        true,
      );
      const resumed = await rig.voice.resumeIo(
        A,
        {
          request_id: uuid(0x97),
          command_scope_id: SCOPE_A,
          scope: 'local',
          expected_io_epoch: '1',
        },
        'unlocked',
      );
      assert.equal(resumed.status, 200);
      assert.deepEqual(
        [
          bodyOf(resumed)['io_epoch'],
          bodyOf(resumed)['stop_scope'],
          bodyOf(resumed)['input_permitted'],
          bodyOf(resumed)['audio_lease_valid'],
        ],
        ['1', 'none', true, false],
      );
      // 再開の後も古い世代のリースは通らない。今の世代の新しいリースは渡す。
      assert.deepEqual(
        bodyOf(
          await renew(rig, A, {
            lease_id: uuid(0x3b),
            nonce: 'n1',
            previous_nonce: null,
            at: 2,
            io_epoch: '0',
          }),
        )['reasons'],
        ['stale_io_epoch'],
      );
      assert.equal(
        bodyOf(
          await renew(rig, A, {
            lease_id: uuid(0x3c),
            nonce: 'n1',
            previous_nonce: null,
            at: 3,
            io_epoch: '1',
          }),
        )['result'],
        'renewed',
      );
    });
  },
);

// ---- 中枢の再起動（X28） ---------------------------------------------------------------------------------------------

test(
  'X28: 再起動で前の Live は lost・終了未確認（予約を保持）になり、世代は巻き戻らず、前のリースは使えない',
  TIMEOUT,
  async () => {
    await withRig(async (rig) => {
      const live = await openLive(rig);
      await rig.voice.stopIo(A, {
        request_id: uuid(0x91),
        command_scope_id: SCOPE_A,
        scope: 'local',
      });
      await rig.voice.resumeIo(
        A,
        {
          request_id: uuid(0x97),
          command_scope_id: SCOPE_A,
          scope: 'local',
          expected_io_epoch: '1',
        },
        'unlocked',
      );
      // 閉じている途中のまま中枢が止まった（閉じる要求は記録済み）。
      await rig.harness.restart();
      await rig.restart(CORE_2);
      const row = rig.harness.sql((db) =>
        db
          .prepare(
            'SELECT control_state, control_epoch, closure, usage_seconds FROM live_sessions WHERE live_session_id = ?',
          )
          .get(live),
      );
      assert.deepEqual(row, {
        control_state: 'closed',
        control_epoch: 0,
        closure: 'close_unconfirmed',
        usage_seconds: null,
      });
      // 前の起動のリースの更新は core_restarted（前の nonce もこの起動では知らない）。
      assert.deepEqual(
        bodyOf(
          await renew(rig, A, {
            lease_id: uuid(0x1a),
            nonce: 'n2',
            previous_nonce: 'n1',
            at: 3000,
            io_epoch: '1',
          }),
        )['reasons'],
        ['core_restarted', 'unexpected_previous_nonce'],
      );
      const state = (await rig.voice.ioState(A, 'unlocked')) as JsonObject;
      assert.deepEqual([state['io_epoch'], state['output_epoch']], ['1', '1']);
      // 新しい起動での接続は audio・session の世代を 2 にする（1 へ戻らない）。
      await renew(rig, A, {
        lease_id: uuid(0x1e),
        nonce: 'm1',
        previous_nonce: null,
        at: 3001,
        io_epoch: '1',
        core: CORE_2,
      });
      const created = await rig.voice.createLiveSession(A, liveBody());
      assert.equal(created.status, 201, JSON.stringify(created.body));
      assert.deepEqual(
        [bodyOf(created)['audio_epoch'], bodyOf(created)['session_epoch']],
        ['2', '2'],
      );
    });
  },
);

test(
  'X28: 再起動の時点で ready だった Live は core_restarted で control_epoch を進めてから閉じる',
  TIMEOUT,
  async () => {
    await withRig(async (rig) => {
      const live = await openLive(rig);
      await rig.harness.restart();
      await rig.restart(CORE_2);
      assert.deepEqual(
        rig.harness.sql((db) =>
          db
            .prepare(
              'SELECT control_state, control_epoch, closure, end_reason FROM live_sessions WHERE live_session_id = ?',
            )
            .get(live),
        ),
        {
          control_state: 'closed',
          control_epoch: 1,
          closure: 'close_unconfirmed',
          end_reason: 'core_lease_lost',
        },
      );
    });
  },
);

// ---- 端末の模擬（domain の規則）: 6 秒で止まる・停止側へ倒れる -----------------------------------------------------------

// 端末の main の模擬。中枢の応答を acceptLeaseRenewal で受け、observeLease で見張る。壁時計は単調時計と同じに進める。
class SimulatedDevice {
  held: HeldLease | null = null;
  constructor(
    readonly rig: Rig,
    readonly who: DeviceRecord,
    readonly lease: string,
  ) {}
  async send(
    nonce: string,
    previous: string | null,
    at: number,
    delivered = true,
  ): Promise<void> {
    const body = leaseBody(this.who.device_id, {
      lease_id: this.lease,
      nonce,
      previous_nonce: previous,
      at,
    });
    if (!delivered) return;
    const response = bodyOf(
      await this.rig.voice.renewLease(this.who, body, 'unlocked'),
    );
    const pending: LeaseSendRecord = {
      request_id: body['request_id'] as string,
      lease_id: this.lease,
      nonce,
      core_instance_id: CORE,
      command_scope_id: body['command_scope_id'] as string,
      io_epoch: '0',
      requested_at_mono_ms: at,
      requested_at_wall_ms: at,
      heartbeat_ms: 2000,
    };
    const outcome = acceptLeaseRenewal(
      pending,
      {
        request_id: response['request_id'] as string,
        lease_id: response['lease_id'] as string,
        nonce: response['nonce'] as string,
        result: response['result'] as 'renewed' | 'rejected',
        ttl_ms: response['ttl_ms'] as number | null,
      },
      { mono_ms: at + 5, wall_ms: at + 5 },
      {
        core_instance_id: CORE,
        command_scope_id: body['command_scope_id'] as string,
        io_epoch: '0',
        io_suspended: false,
      },
      this.held,
    );
    if (outcome.held !== null) this.held = outcome.held;
  }
  status(at: number): string {
    return observeLease(this.held, { mono_ms: at, wall_ms: at }).status.status;
  }
}

test(
  'X13: 回線の断・サイドバンドだけの lost・停止の通知の欠落のどれでも、端末は最後に受理された要求から 6 秒で止まる',
  TIMEOUT,
  async () => {
    // 回線の断: 2 秒後の要求が届かない。
    await withRig(async (rig) => {
      const device = new SimulatedDevice(rig, A, uuid(0x1a));
      await device.send('n1', null, 0);
      await device.send('n2', 'n1', 2000, false);
      assert.equal(device.status(5999), 'valid');
      assert.equal(device.status(6000), 'expired');
    });
    // サイドバンドだけの lost: 端末とのハートビートは届くが、中枢が拒否する。
    await withRig(async (rig) => {
      const device = new SimulatedDevice(rig, A, uuid(0x1a));
      await device.send('n1', null, 10);
      assert.equal(device.held?.expires_at_mono_ms, 6010);
      const created = await rig.voice.createLiveSession(A, liveBody());
      assert.equal(created.status, 201);
      await rig.wait();
      const live = bodyOf(created)['live_session_id'] as string;
      rig.provider.sidebands[0]?.disconnect();
      await rig.wait();
      assert.equal(rig.voice.liveRecord(live)?.control_state, 'closing');
      await device.send('n2', 'n1', 2010);
      await device.send('n3', 'n1', 4010);
      assert.equal(device.held?.expires_at_mono_ms, 6010);
      assert.equal(device.status(6009), 'valid');
      assert.equal(device.status(6010), 'expired');
    });
    // 停止の通知の欠落: 端末は停止のイベントを受けない（購読していない）が、更新が拒否されて期限で止まる。
    await withRig(async (rig) => {
      const device = new SimulatedDevice(rig, B, uuid(0x2b));
      await device.send('b1', null, 0);
      await rig.voice.stopIo(A, {
        request_id: uuid(0x91),
        command_scope_id: SCOPE_A,
        scope: 'global',
      });
      await device.send('b2', 'b1', 2000);
      await device.send('b3', 'b1', 4000);
      assert.equal(device.held?.expires_at_mono_ms, 6000);
      assert.equal(device.status(6000), 'expired');
    });
  },
);

test(
  '端末の模擬: 中枢が送った停止を受けた端末は、時計の逆行・ACK の失敗・音声レンダラーの無応答で停止側に倒れる',
  TIMEOUT,
  async () => {
    await withRig(async (rig) => {
      const device = new SimulatedDevice(rig, B, uuid(0x2b));
      await device.send('b1', null, 0);
      await rig.voice.stopIo(A, {
        request_id: uuid(0x91),
        command_scope_id: SCOPE_A,
        scope: 'global',
      });
      // 中枢が B へ送った停止の命令（イベント）を、端末の main が受ける。
      const event = (rig.events.get(DEV_B) ?? []).find(
        (item) => item['event_type'] === 'audio_control',
      );
      const control = event?.['audio_control'] as JsonObject;
      assert.deepEqual(
        [control['action'], control['reason'], control['scope']],
        ['suspend_io', 'global_stop', 'global'],
      );
      const reason = control['reason'] as 'global_stop';
      // 第 1 層は Live を閉じて収音を止め、第 2 層の ACK は 300 ms、第 3 層は中枢がサイドバンドから閉じる。
      const plan = planStop(reason);
      assert.deepEqual(
        [plan.action, plan.ack_deadline_ms, plan.core],
        [
          'suspend_io',
          300,
          [
            'invalidate_old_epoch_results',
            'core_sideband_close',
            'reconcile_usage_hold_reservation',
          ],
        ],
      );
      const base = {
        reason,
        requested_at_mono_ms: 1000,
        local_stop_completed_at_mono_ms: 1150,
        ack_timeout_ms: 300,
        previous_observed_mono_ms: null,
      };
      // ACK の失敗（受理済みで failed）は待たずに強制終了。
      const failed = assessStop({
        ...base,
        ack_at_mono_ms: 1100,
        ack_accepted: true,
        ack_outcome: 'failed',
        now_mono_ms: 1100,
      });
      assert.deepEqual(
        [failed.layer2.status, failed.fallback],
        ['failed', 'force_kill_renderer'],
      );
      // 音声レンダラーの無応答: 300 ms ちょうどは待ち、301 ms で強制終了。
      const noAck = {
        ...base,
        ack_at_mono_ms: null,
        ack_accepted: null,
        ack_outcome: null,
      };
      assert.equal(
        assessStop({ ...noAck, now_mono_ms: 1300 }).layer2.status,
        'waiting',
      );
      const killed = assessStop({ ...noAck, now_mono_ms: 1301 });
      assert.deepEqual(
        [
          killed.layer2.status,
          killed.fallback,
          killed.invalidate_old_epoch_results,
        ],
        ['timed_out', 'force_kill_renderer', true],
      );
      // 時計が要求より前へ戻った: 期限を数えられないので、待たずに強制終了。
      assert.deepEqual(assessStop({ ...noAck, now_mono_ms: 999 }).reasons, [
        'now_clock_regressed',
      ]);
      // 中枢から受理したリースも、単調時計が直前の観測より 1 ms 戻れば期限の前でも捨てる。
      assert.equal(device.held?.expires_at_mono_ms, 6000);
      assert.deepEqual(
        observeLease(device.held, { mono_ms: 4, wall_ms: 4 }).status,
        { status: 'discarded', reason: 'mono_clock_regressed' },
      );
    });
  },
);

// ---- レビュー（Sonnet）の再現: 取り直し・DB の失敗・外部の待ち・同時の Live ------------------------------------------

// DB の書込みを試験が決めて失敗させる store（それ以外は本物の DB worker）。
function failingStore(
  rig: Rig,
  fail: (kind: string) => boolean,
): VoiceControlOptions['store'] {
  const real = rig.harness.store;
  return {
    conversation: ((op: never) => real.conversation(op)) as never,
    voice: ((op: { kind: string }) =>
      fail(op.kind)
        ? Promise.resolve({
            ok: false,
            outcome: 'rejected',
            reasons: ['database_busy'],
          })
        : real.voice(op as never)) as never,
  };
}

async function useStore(rig: Rig, store: VoiceControlOptions['store']) {
  await rig.voice.close();
  const voice = new VoiceControl({
    store,
    coreInstanceId: CORE,
    monoNow: rig.clock.mono,
    wallNow: () => Date.parse('2030-10-15T00:00:00.000Z') + rig.clock.mono(),
    timers: rig.clock,
    provider: rig.provider,
    budget: rig.budget,
    consent: () => 'granted',
  });
  for (const id of [DEV_A, DEV_B])
    voice.subscribe(id, (event) => {
      const list = rig.events.get(id) ?? [];
      list.push(event as JsonObject);
      rig.events.set(id, list);
    });
  rig.voice = voice;
  await voice.start();
}

test(
  'P1: Live を開いたまま lease_id を取り直して更新を止めると、取り直しから 6 秒で中枢が core_lease_lost で閉じる',
  TIMEOUT,
  async () => {
    await withRig(async (rig) => {
      const live = await openLive(rig, uuid(0x1a));
      assert.equal(
        bodyOf(
          await renew(rig, A, {
            lease_id: uuid(0x1b),
            nonce: 'm1',
            previous_nonce: null,
            at: 500,
          }),
        )['result'],
        'renewed',
      );
      // サイドバンドは生きている（pong を返す）。
      for (const step of [2000, 2000, 1999]) {
        await rig.clock.advance(step);
        rig.provider.sidebands[0]?.pong();
        await rig.wait();
      }
      assert.deepEqual(
        [
          rig.voice.liveRecord(live)?.control_state,
          rig.voice.liveRecord(live)?.closure,
        ],
        ['ready', 'open'],
      );
      await rig.clock.advance(1);
      await rig.wait();
      assert.deepEqual(
        [
          rig.voice.liveRecord(live)?.closure,
          rig.voice.liveRecord(live)?.end_reason,
        ],
        ['close_requested', 'core_lease_lost'],
      );
      assert.deepEqual(audioControls(rig, DEV_A), [
        ['suspend_io', 'core_lease_lost', '0'],
      ]);
      // 中枢の見積もりで切れたリースへの遅れた更新は受けない（取り直しを求める）。
      assert.deepEqual(
        bodyOf(
          await renew(rig, A, {
            lease_id: uuid(0x1b),
            nonce: 'm2',
            previous_nonce: 'm1',
            at: 6600,
          }),
        )['reasons'],
        ['lease_rotation_required'],
      );
    });
  },
);

test(
  'P1: 1800 回の後に取り直したリースでも、サイドバンドの喪失で更新を拒否する（sideband_lost）',
  TIMEOUT,
  async () => {
    await withRig(async (rig) => {
      const first = uuid(0x1a);
      await openLive(rig, first);
      let previous = 'n1';
      for (let i = 2; i <= 1800; i += 1) {
        const result = bodyOf(
          await renew(rig, A, {
            lease_id: first,
            nonce: `n${i}`,
            previous_nonce: previous,
            at: 10 + i,
          }),
        );
        assert.equal(result['result'], 'renewed', String(i));
        previous = `n${i}`;
      }
      assert.deepEqual(
        bodyOf(
          await renew(rig, A, {
            lease_id: first,
            nonce: 'n1801',
            previous_nonce: 'n1800',
            at: 3000,
          }),
        )['reasons'],
        ['lease_rotation_required'],
      );
      const rotated = uuid(0x1c);
      assert.equal(
        bodyOf(
          await renew(rig, A, {
            lease_id: rotated,
            nonce: 'r1',
            previous_nonce: null,
            at: 3001,
          }),
        )['result'],
        'renewed',
      );
      rig.provider.sidebands[0]?.disconnect();
      await rig.wait();
      assert.deepEqual(
        bodyOf(
          await renew(rig, A, {
            lease_id: rotated,
            nonce: 'r2',
            previous_nonce: 'r1',
            at: 3002,
          }),
        )['reasons'],
        ['sideband_lost'],
      );
    });
  },
);

test(
  'P1: voice.stop を DB へ書けなくても、他の端末の更新を拒否して停止を送り、書けるまで再試行し、その間は再開しない',
  TIMEOUT,
  async () => {
    await withRig(async (rig) => {
      let failing = true;
      await useStore(
        rig,
        failingStore(rig, (kind) => failing && kind === 'voice.stop'),
      );
      await renew(rig, A, {
        lease_id: uuid(0x1a),
        nonce: 'n1',
        previous_nonce: null,
        at: 10,
      });
      const stopped = await rig.voice.stopIo(B, {
        request_id: uuid(0x91),
        command_scope_id: SCOPE_B,
        scope: 'global',
      });
      assert.deepEqual(
        [stopped.status, bodyOf(stopped)['code']],
        [503, 'dependency_unavailable'],
      );
      assert.deepEqual(audioControls(rig, DEV_A), [
        ['suspend_io', 'global_stop', '1'],
      ]);
      assert.deepEqual(
        bodyOf(
          await renew(rig, A, {
            lease_id: uuid(0x1a),
            nonce: 'n2',
            previous_nonce: 'n1',
            at: 2010,
          }),
        )['reasons'],
        ['io_suspended'],
      );
      assert.deepEqual(
        bodyOf(
          await renew(rig, A, {
            lease_id: uuid(0x1b),
            nonce: 'm1',
            previous_nonce: null,
            at: 2011,
          }),
        )['reasons'],
        ['io_suspended'],
      );
      assert.equal(rig.voice.audioOwner(A), 'none');
      const resume = await rig.voice.resumeIo(
        B,
        {
          request_id: uuid(0x97),
          command_scope_id: SCOPE_B,
          scope: 'global',
          expected_io_epoch: '0',
        },
        'unlocked',
      );
      assert.equal(resume.status, 503);
      // DB が戻ると、再試行で全体停止が保存される（世代は 1 つ進む）。
      failing = false;
      await rig.clock.advance(1000);
      await rig.wait();
      const state = (await rig.voice.ioState(A, 'unlocked')) as JsonObject;
      assert.deepEqual(
        [state['stop_scope'], state['io_epoch']],
        ['global', '1'],
      );
    });
  },
);

test(
  'P2: 予算の門の予約が返らないままでも全体停止は返り、Live の受付は期限（5 秒）で結果不明として断る',
  TIMEOUT,
  async () => {
    await withRig(async (rig) => {
      await renew(rig, A, {
        lease_id: uuid(0x1a),
        nonce: 'n1',
        previous_nonce: null,
        at: 10,
      });
      (rig.budget as { reserve: unknown }).reserve = () =>
        new Promise(() => undefined);
      const pending = rig.voice.createLiveSession(A, liveBody());
      await rig.clock.settle();
      const stopped = await rig.voice.stopIo(B, {
        request_id: uuid(0x91),
        command_scope_id: SCOPE_B,
        scope: 'global',
      });
      assert.equal(stopped.status, 202);
      await rig.clock.advance(4999);
      await rig.clock.advance(1);
      const created = await pending;
      assert.deepEqual(
        [created.status, bodyOf(created)['code']],
        [503, 'dependency_unavailable'],
      );
      assert.equal(rig.provider.created.length, 0);
    });
  },
);

test(
  'P2: lost の DB 書込みが失敗しても、更新の拒否・停止のイベント・閉じるための再接続はメモリーの状態で先に行い、DB へは再試行で書く',
  TIMEOUT,
  async () => {
    await withRig(async (rig) => {
      let failing = false;
      await useStore(
        rig,
        failingStore(rig, (kind) => failing && kind === 'voice.live_update'),
      );
      const live = await openLive(rig, uuid(0x1a));
      failing = true;
      rig.provider.sidebands[0]?.disconnect();
      await rig.wait();
      assert.deepEqual(
        [
          rig.voice.liveRecord(live)?.control_state,
          rig.voice.liveRecord(live)?.control_epoch,
        ],
        ['closing', '1'],
      );
      assert.deepEqual(audioControls(rig, DEV_A), [
        ['close_voice_session', 'sideband_lost', '0'],
      ]);
      assert.deepEqual(
        bodyOf(
          await renew(rig, A, {
            lease_id: uuid(0x1a),
            nonce: 'n2',
            previous_nonce: 'n1',
            at: 2010,
          }),
        )['reasons'],
        ['sideband_lost'],
      );
      assert.equal(rig.provider.sidebands[1]?.closes, 1);
      const row = () =>
        rig.harness.sql((db) =>
          db
            .prepare(
              'SELECT control_state, control_epoch, end_reason FROM live_sessions WHERE live_session_id = ?',
            )
            .get(live),
        );
      assert.deepEqual(row(), {
        control_state: 'ready',
        control_epoch: 0,
        end_reason: null,
      });
      failing = false;
      await rig.clock.advance(1000);
      await rig.wait();
      assert.deepEqual(row(), {
        control_state: 'closing',
        control_epoch: 1,
        end_reason: 'sideband_lost',
      });
    });
  },
);

test(
  'P2: 受付の途中の Live がある間は、交代した端末も 2 つ目を開けず（409）、途中の受付は所有者が変わったので断る',
  TIMEOUT,
  async () => {
    await withRig(async (rig) => {
      await renew(rig, A, {
        lease_id: uuid(0x1a),
        nonce: 'n1',
        previous_nonce: null,
        at: 10,
      });
      let release: () => void = () => undefined;
      const original = rig.budget.reserve.bind(rig.budget);
      (rig.budget as { reserve: unknown }).reserve = (input: {
        request_id: string;
        seconds: number;
      }) =>
        new Promise((resolve) => {
          release = () => resolve(original(input));
        });
      const pendingA = rig.voice.createLiveSession(A, liveBody());
      await rig.clock.settle();
      await rig.clock.advance(301);
      assert.equal(
        bodyOf(
          await renew(rig, B, {
            lease_id: uuid(0x2b),
            nonce: 'b1',
            previous_nonce: null,
            at: 5,
          }),
        )['result'],
        'renewed',
      );
      const createdB = await rig.voice.createLiveSession(B, liveBody(SCOPE_B));
      assert.deepEqual(
        [createdB.status, bodyOf(createdB)['code']],
        [409, 'conflict'],
      );
      release();
      await rig.wait();
      const createdA = await pendingA;
      assert.deepEqual(
        [createdA.status, bodyOf(createdA)['code']],
        [409, 'audio_owned_elsewhere'],
      );
      await rig.wait();
      assert.equal(rig.provider.created.length, 0);
      // 送出意図の前の再確認で断ったので、送っていない予約を解放する（ADR 0049・U84）。
      assert.deepEqual(rig.budget.calls, ['reserve:195', 'release']);
      assert.deepEqual(reservationStatus(rig), ['released']);
    });
  },
);

test(
  'P3: 正常に終わった Live のリースの更新は取り直しを求め、終わった Live はメモリーから外す',
  TIMEOUT,
  async () => {
    await withRig(async (rig) => {
      const live = await openLive(rig, uuid(0x1a));
      await rig.voice.closeLiveSession(A, live, {
        request_id: uuid(0x93),
        command_scope_id: SCOPE_A,
        reason: 'conversation_ended',
        audio_epoch: '1',
      });
      rig.provider.sidebands[0]?.closed(20);
      await rig.wait();
      assert.equal(rig.voice.liveRecord(live)?.closure, 'close_confirmed');
      assert.equal(rig.voice.liveCount, 0);
      assert.deepEqual(
        bodyOf(
          await renew(rig, A, {
            lease_id: uuid(0x1a),
            nonce: 'n2',
            previous_nonce: 'n1',
            at: 2010,
          }),
        )['reasons'],
        ['lease_rotation_required'],
      );
    });
  },
);

// ---- 再確認（Sonnet）の再現: 停止のイベントの世代・遅れて成功した予約・受付の途中の停止 ------------------------------

test(
  'P2-A: 再起動の後に一度も読んでいない端末にも、全体停止のイベントは DB の世代（0 ではない）で届く',
  TIMEOUT,
  async () => {
    await withRig(async (rig) => {
      // 前の起動で B の世代を 2 まで進めておく（局所停止 2 回）。
      for (const id of [0x91, 0x92])
        await rig.voice.stopIo(B, {
          request_id: uuid(id),
          command_scope_id: SCOPE_B,
          scope: 'local',
        });
      await rig.harness.restart();
      await rig.restart(CORE_2);
      rig.events.clear();
      const stopped = await rig.voice.stopIo(A, {
        request_id: uuid(0x93),
        command_scope_id: SCOPE_A,
        scope: 'global',
      });
      assert.equal(stopped.status, 202);
      assert.deepEqual(audioControls(rig, DEV_B), [
        ['suspend_io', 'global_stop', '3'],
      ]);
    });
  },
);

test(
  'P2-A: 中枢が世代をまだ読めていない端末へは、DB の値が返った後に停止のイベントを送る（DB を書けない間は送らない）',
  TIMEOUT,
  async () => {
    await withRig(async (rig) => {
      const DEV_C = uuid(0xc3);
      rig.harness.sql((db) =>
        db
          .prepare(
            `INSERT INTO devices VALUES (?, '合成の端末', 'macos', 0, X'${'c'.repeat(64)}', 1000, NULL, NULL)`,
          )
          .run(DEV_C),
      );
      const seen: JsonObject[] = [];
      // 購読と同時に停止が来る（購読のときの読み取りが終わる前）。
      rig.voice.subscribe(DEV_C, (event) => seen.push(event as JsonObject));
      const stopped = await rig.voice.stopIo(A, {
        request_id: uuid(0x91),
        command_scope_id: SCOPE_A,
        scope: 'global',
      });
      assert.equal(stopped.status, 202);
      assert.deepEqual(
        seen.map((event) => {
          const control = event['audio_control'] as JsonObject;
          return [
            control['reason'],
            control['io_epoch'],
            control['output_epoch'],
            control['audio_epoch'],
          ];
        }),
        [['global_stop', '1', '1', '0']],
      );
    });
    await withRig(async (rig) => {
      const DEV_C = uuid(0xc3);
      // 起動の後に登録された端末（起動のときには世代を読んでいない）。
      await useStore(
        rig,
        failingStore(rig, (kind) => kind === 'voice.stop'),
      );
      rig.harness.sql((db) =>
        db
          .prepare(
            `INSERT INTO devices VALUES (?, '合成の端末', 'macos', 0, X'${'c'.repeat(64)}', 1000, NULL, NULL)`,
          )
          .run(DEV_C),
      );
      const seen: JsonObject[] = [];
      rig.voice.subscribe(DEV_C, (event) => seen.push(event as JsonObject));
      const stopped = await rig.voice.stopIo(A, {
        request_id: uuid(0x91),
        command_scope_id: SCOPE_A,
        scope: 'global',
      });
      assert.equal(stopped.status, 503);
      assert.deepEqual(seen, []);
    });
  },
);

test(
  'P2-B: 予約が 5 秒の期限の後に遅れて成功したら、送出意図の前なので解放する',
  TIMEOUT,
  async () => {
    await withRig(async (rig) => {
      await renew(rig, A, {
        lease_id: uuid(0x1a),
        nonce: 'n1',
        previous_nonce: null,
        at: 10,
      });
      let release: () => void = () => undefined;
      let called = false;
      const original = rig.budget.reserve.bind(rig.budget);
      (rig.budget as { reserve: unknown }).reserve = (input: {
        request_id: string;
        seconds: number;
      }) =>
        new Promise((resolve) => {
          called = true;
          release = () => resolve(original(input));
        });
      const pending = rig.voice.createLiveSession(A, liveBody());
      // 予約の呼び出し（5 秒の期限を数え始める）まで進める。
      while (!called) await rig.clock.settle();
      await rig.clock.advance(4999);
      assert.equal(rig.budget.calls.length, 0);
      await rig.clock.advance(1);
      const created = await pending;
      assert.deepEqual(
        [created.status, bodyOf(created)['code']],
        [503, 'dependency_unavailable'],
      );
      release();
      // 遅れた予約（DB worker の受付）が返り、解放が終わるまで実時間の上限つきで待つ。
      await waitUntil(
        rig,
        '遅れた予約の解放（予算の解放の呼び出しと予約の状態 released）',
        () =>
          rig.budget.calls.includes('release') &&
          reservationStatus(rig).includes('released'),
      );
      assert.deepEqual(rig.budget.calls, ['reserve:195', 'release']);
      assert.deepEqual(reservationStatus(rig), ['released']);
      assert.equal(rig.provider.created.length, 0);
    });
  },
);

test(
  'P3: 予約を待っている間の局所停止で、受付は 403 になり、provider へ送らず、送出意図の前なので予約を解放する',
  TIMEOUT,
  async () => {
    await withRig(async (rig) => {
      await renew(rig, A, {
        lease_id: uuid(0x1a),
        nonce: 'n1',
        previous_nonce: null,
        at: 10,
      });
      let release: () => void = () => undefined;
      const original = rig.budget.reserve.bind(rig.budget);
      (rig.budget as { reserve: unknown }).reserve = (input: {
        request_id: string;
        seconds: number;
      }) =>
        new Promise((resolve) => {
          release = () => resolve(original(input));
        });
      const pending = rig.voice.createLiveSession(A, liveBody());
      await rig.clock.settle();
      const stopped = await rig.voice.stopIo(A, {
        request_id: uuid(0x91),
        command_scope_id: SCOPE_A,
        scope: 'local',
      });
      assert.equal(stopped.status, 202);
      release();
      await rig.wait();
      const created = await pending;
      assert.deepEqual(
        [created.status, bodyOf(created)['code']],
        [403, 'audio_ownership_required'],
      );
      await rig.wait();
      assert.equal(rig.provider.created.length, 0);
      assert.deepEqual(rig.budget.calls, ['reserve:195', 'release']);
      assert.deepEqual(reservationStatus(rig), ['released']);
    });
  },
);
