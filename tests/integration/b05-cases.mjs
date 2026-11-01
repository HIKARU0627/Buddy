// B05 の統合のケース。端末側（VoiceController・DesktopDeviceController・模擬の音声レンダラー・合成の PCM）と中枢側
// （VoiceControl・DB worker・予算の門・模擬の Live の provider）を 1 本の手で進める時計でつなぎ、端末が音声レンダラーへ
// 送った命令・音声レンダラーの状態・Core の Live と予約の行・provider 自身の真の使用時間を突き合わせる。
// 期待値は b05-expectations.json の手書きの値（設計 10 §1・§1A・§2・§2A・§8、07 §2・§5、09 の X13 ほか、ADR 0005 の表）。
// 待ち合わせは手で進める時計だけで行い、固定の sleep を使わない。HTTP・WSS・Electron・マイク・実 API は通さない。
import assert from 'node:assert/strict';
import { A, NO_FAULTS, withWorld } from './b05-world.mjs';
import { CONVERSATION_CASES } from './b05-cases-conversation.mjs';
import { INPUT_CASES } from './b05-cases-input.mjs';
import {
  acksSince,
  closesSince,
  commandsSince,
  device,
  lifeOf,
  renderer,
  reservationOf,
  settle,
  summary,
} from './b05-observe.mjs';
import {
  deviceEpochRows,
  liveRows,
  specification,
  voiceReservationRows,
} from './b05-support.mjs';

// 中枢へも端末の停止を伝える（端末の停止の報告の経路は未実装。U70。ここでは試験が両方へ送って世代をそろえる）。
async function coreStopLocal(w) {
  const result = await w.rig.voice.stopIo(A, {
    request_id: w.newId(),
    scope: 'local',
  });
  assert.equal(result.status, 202, '中枢の停止の応答（受理）');
  await w.advance(10);
}

async function coreResumeLocal(w, expected) {
  return w.rig.voice.resumeIo(
    A,
    { request_id: w.newId(), scope: 'local', expected_io_epoch: expected },
    'unlocked',
  );
}

// ---- ケース ---------------------------------------------------------------------------------------------------------

// X13: OS のロックで収音・認識・再生を止め、古い音声を送らない。解除だけでは再開せず、画面の明示再開は版が一致するときだけ。
async function x13OsLock() {
  let result;
  await withWorld({}, async (w) => {
    await w.begin();
    await w.advance(3000);
    // 相手の音声を再生中にする（再生中から停止することを確かめるため）。
    w.remoteAudio();
    await w.advance(200);
    const before = {
      renderer: renderer(w),
      sent_frames_positive: w.stats().sentFrames > 0,
      played_frames_positive: w.stats().playedFrames > 0,
      lease_active: w.ctl.leaseActive,
      voice_state: w.ctl.view().voice_state,
      external_send: w.ctl.view().external_send,
    };
    const renewalsBefore = w.renewals.length;
    const t0 = w.clock.mono();
    w.device.applyLockQuery('lock_screen');
    await w.advance(1);
    const stopAck = acksSince(w, t0).find(
      (entry) => entry.channel === 'voice.suspend_io',
    );
    const framesAtStop = w.stats().sentFrames;
    const playedAtStop = w.stats().playedFrames;
    await w.advance(5000);
    // 止めた後に届いた古い世代の音声は再生しない。
    w.remoteAudio('0');
    const stop = {
      commands: commandsSince(w, t0),
      acks: acksSince(w, t0),
      renderer: renderer(w),
      sent_frames_after_stop: w.stats().sentFrames - framesAtStop,
      played_frames_after_stop: w.stats().playedFrames - playedAtStop,
      late_audio_played: w.stats().playing,
      renewals_after_stop: w.renewals.length - renewalsBefore,
      lease_active: w.ctl.leaseActive,
      view: w.ctl.view().visibility,
      device: device(w),
      core_close_requests: closesSince(w, t0),
    };
    const { lives, reservations } = settle(w);
    const core = {
      live: lifeOf(lives[0]),
      reservation: reservationOf(reservations[0]),
      provider_close_requests: w.providerTruth.filter(
        (entry) => entry.close_requested_at !== null,
      ).length,
      provider_truth_seconds: Math.floor(
        (w.providerTruth[0].close_requested_at -
          w.providerTruth[0].created_at) /
          1000,
      ),
    };
    // ロックを解除しただけでは再開しない（QA43）。
    w.device.applyLockQuery('unlock_screen');
    await w.advance(100);
    const continued = await w.ctl.continueConversation();
    const afterUnlock = {
      device: device(w),
      voice_state: w.ctl.view().voice_state,
      can_continue: w.ctl.view().can_continue,
      continue_outcome: continued,
      renderer_capturing: w.stats().capturing,
      renderer_sending: w.stats().sending,
    };
    // 画面の明示再開: 窓が前面にないとき・版が違うときは拒否し、前面で版が一致するときだけ受け付ける。
    const unfocused = w.resumeFromScreen({ focused: false });
    const stale = w.resumeFromScreen({ epoch: '0' });
    const stillStopped = device(w);
    const resumed = w.resumeFromScreen();
    await w.advance(100);
    const resume = {
      unfocused,
      stale_epoch: stale,
      still_stopped: stillStopped,
      accepted: resumed,
      device: device(w),
      voice_state: w.ctl.view().voice_state,
      can_continue: w.ctl.view().can_continue,
      renderer_sending: w.stats().sending,
    };
    result = summary(w, {
      voice_stop_ms: stopAck?.dt ?? null,
      checks: { before, stop, core, after_unlock: afterUnlock, resume },
    });
  });
  return result;
}

// X13（世代の突き合わせ）: 端末が進めた io_epoch を中枢へ報告する経路は未実装（U70）。端末だけが止まって再開すると、中枢は
// 次のリースを unknown_io_epoch で拒否し、会話は再開できない（拒否は安全側。再開できないことは既知の未了）。試験が中枢へも
// 停止・再開を送って世代をそろえると、新しい Live（新しい世代）で再開できる。古い音声レンダラーの世代の ACK は混ざらない。
async function x13EpochSync() {
  let result;
  await withWorld({}, async (w) => {
    await w.begin();
    await w.advance(2000);
    const firstLive = liveRows(w)[0].live_session_id;
    w.device.applyLockQuery('lock_screen');
    await w.advance(2500);
    w.device.applyLockQuery('unlock_screen');
    await w.advance(10);
    w.resumeFromScreen();
    await w.advance(100);
    // 端末だけが止まって再開した場面（中枢の世代は 0 のまま）。
    const t1 = w.clock.mono();
    const renewalsBefore = w.renewResponses.length;
    const gapOutcome = await w.ctl.continueConversation();
    await w.advance(100);
    const gap = {
      continue_outcome: gapOutcome,
      lease_responses: w.renewResponses.slice(renewalsBefore).map((entry) => ({
        result: entry.result,
        reasons: entry.reasons,
      })),
      lease_active: w.ctl.leaseActive,
      renderer_sending: w.stats().sending,
      clips_played: w.stats().clipsPlayed,
      device_io_epoch: w.device.state.ioEpoch,
      core_io_epoch: String(deviceEpochRows(w)[0].io_epoch),
      live_rows: liveRows(w).length,
      commands_since: commandsSince(w, t1).map((entry) => entry.channel),
    };

    // 中枢へも停止と再開を送って世代をそろえる（端末: 1、中枢: 0 → 停止で 1）。
    await coreStopLocal(w);
    const staleResume = await coreResumeLocal(w, '0');
    const syncedEpochs = {
      core_after_stop: String(deviceEpochRows(w)[0].io_epoch),
      stale_resume_status: staleResume.status,
    };
    const okResume = await coreResumeLocal(w, '1');
    const synced = {
      ...syncedEpochs,
      resume_status: okResume.status,
      core_after_resume: String(deviceEpochRows(w)[0].io_epoch),
      local_stop: deviceEpochRows(w)[0].local_stop,
    };

    const t2 = w.clock.mono();
    const opened = await w.ctl.continueConversation();
    await w.advance(100);
    await w.advanceUntil(
      '新しい Live の送信',
      () => w.stats().sending === true,
    );
    const { lives, reservations } = settle(w);
    const second = {
      continue_outcome: opened,
      renderer: renderer(w),
      live_rows: lives.map(lifeOf),
      first_live_is_closed: lives[0].live_session_id === firstLive,
      reservations: reservations.map(reservationOf),
      commands: commandsSince(w, t2).map((entry) => entry.channel),
    };
    result = summary(w, {
      voice_stop_ms: null,
      checks: { epoch_gap: gap, synchronised: synced, restarted: second },
    });
  });
  return result;
}

// QA43: stop_playback・close_voice_session・suspend_io を混同しない（再生だけ／会話を閉じる／入出力のすべて）。
async function qa43ThreeStops() {
  let result;
  await withWorld({}, async (w) => {
    await w.begin();
    await w.advance(1000);
    w.remoteAudio();
    await w.advance(100);
    const base = {
      renderer: renderer(w),
      lease_active: w.ctl.leaseActive,
    };

    // 1. 読み上げの停止（画面のボタン）: 再生だけ止める。会話・収音・リースは保つ。
    const t1 = w.clock.mono();
    const renewals1 = w.renewals.length;
    w.ctl.applyControl('stop_playback');
    await w.advance(10);
    const playedAtStop = w.stats().playedFrames;
    const stopPlayback = {
      commands: commandsSince(w, t1),
      acks: acksSince(w, t1),
      renderer: renderer(w),
      external_send: w.ctl.view().external_send,
      lease_active: w.ctl.leaseActive,
      core_close_requests: closesSince(w, t1),
      live_closure: liveRows(w)[0].closure,
    };
    await w.advance(3000);
    stopPlayback.renewals_kept = w.renewals.length > renewals1;
    stopPlayback.played_frames_after_stop =
      w.stats().playedFrames - playedAtStop;
    // 止める前の出力の世代の音声が遅れて届いても再生しない。既定では本人の再開操作で新しい Live 接続を開くまで
    // 出力の mute を保つので、会話が続いていても、今の世代と一致する音声の到着だけでは再生を再開しない（ADR 0038）。
    w.remoteAudio('0');
    stopPlayback.late_old_audio = {
      playing: w.stats().playing,
      discarded: w.stats().discardedAudio,
    };
    w.remoteAudio();
    stopPlayback.new_audio_plays = w.stats().playing;

    // 2. 会話の終了: Live だけ閉じる。収音は保ち（端末内の KWS・③）、リースは止める。
    const t2 = w.clock.mono();
    const renewals2 = w.renewals.length;
    w.ctl.applyControl('end_conversation');
    await w.advance(3000);
    const closeSession = {
      commands: commandsSince(w, t2),
      acks: acksSince(w, t2),
      renderer: renderer(w),
      external_send: w.ctl.view().external_send,
      lease_active: w.ctl.leaseActive,
      renewals_after: w.renewals.length - renewals2,
      core_close_requests: closesSince(w, t2),
      live_closure: liveRows(w)[0].closure,
      voice_state: w.ctl.view().voice_state,
    };

    // 3. 端末の入出力の停止: 収音・認識・再生・Live のすべてを止める。
    await w.begin();
    await w.advance(1000);
    w.remoteAudio();
    await w.advance(100);
    const t3 = w.clock.mono();
    w.device.stopFromMain();
    await w.advance(3000);
    const suspend = {
      commands: commandsSince(w, t3),
      acks: acksSince(w, t3),
      renderer: renderer(w),
      external_send: w.ctl.view().external_send,
      lease_active: w.ctl.leaseActive,
      core_close_requests: closesSince(w, t3),
      device: device(w),
      voice_state: w.ctl.view().voice_state,
    };
    const { lives } = settle(w);
    result = summary(w, {
      checks: {
        base,
        stop_playback: stopPlayback,
        close_voice_session: closeSession,
        suspend_io: suspend,
        live_closures: lives.map((row) => row.closure),
      },
    });
  });
  return result;
}

// ---- 段階 2: サイドバンドの喪失（X25・QA24）と停止の ACK の期限（X30） ------------------------------------------------

const liveState = (w, liveId) => w.rig.voice.liveRecord(liveId);

// サイドバンドが喪失する場面を作る: 20 秒の健全な会話の後、pong を返さなくなる。最後の pong から 6 秒で喪失（5999 ms では ready）。
async function sidebandLossScenario(w) {
  await w.begin();
  await w.advance(20_000);
  const liveId = liveRows(w)[0].live_session_id;
  w.sidebandHealthy = false;
  const lastPong = w.lastPongAt;
  await w.advance(lastPong + 5999 - w.clock.mono());
  const readyAt5999 = liveState(w, liveId).control_state === 'ready';
  const leaseAt5999 = w.ctl.leaseActive;
  await w.advance(1);
  const tLost = w.clock.mono();
  const lostRecord = liveState(w, liveId);
  return {
    liveId,
    tLost,
    lostAfterMs: tLost - lastPong,
    readyAt5999,
    leaseAt5999,
    readyAfter: lostRecord.control_state === 'ready',
    controlEpoch: String(lostRecord.control_epoch),
  };
}

// X25: サイドバンドを喪失すると、ハートビートが正常でも音声リースを更新せず、端末へ close_voice_session（sideband_lost）を送る。
// 閉じるためだけの再接続で session.close を送り、使用秒数が確認できたら精算する。
async function x25SidebandLost() {
  let result;
  await withWorld({}, async (w) => {
    const loss = await sidebandLossScenario(w);
    await w.advance(100);
    const audioControls = w.coreEvents
      .filter(
        (entry) =>
          entry.at >= loss.tLost && entry.event.event_type === 'audio_control',
      )
      .map((entry) => ({
        dt: entry.at - loss.tLost,
        action: entry.event.audio_control.action,
        reason: entry.event.audio_control.reason,
      }));
    const last = w.renewalBodies.at(-1);
    const probe = await w.rig.voice.renewLease(
      A,
      {
        ...last,
        request_id: w.newId(),
        nonce: 'probe-after-loss',
        previous_nonce: last.nonce,
        requested_at_mono_ms: w.clock.mono(),
      },
      'unlocked',
    );
    await w.advance(3000);
    const { lives, reservations } = settle(w);
    result = summary(w, {
      checks: {
        loss: {
          lost_after_last_pong_ms: loss.lostAfterMs,
          ready_at_5999: loss.readyAt5999,
          lease_active_at_5999: loss.leaseAt5999,
          ready_after_6000: loss.readyAfter,
          control_epoch: loss.controlEpoch,
        },
        device: {
          audio_controls: audioControls,
          commands: commandsSince(w, loss.tLost),
          acks: acksSince(w, loss.tLost),
          renderer: renderer(w),
          lease_active: w.ctl.leaseActive,
          external_send: w.ctl.view().external_send,
          voice_state: w.ctl.view().voice_state,
          core_close_requests: closesSince(w, loss.tLost),
        },
        lease_probe: {
          status: probe.status,
          result: probe.body.result,
          reasons: probe.body.reasons,
        },
        core: {
          reconnects: w.rig.provider.connectCalls.length,
          live: lifeOf(lives[0]),
          reservation: reservationOf(reservations[0]),
        },
      },
    });
  });
  return result;
}

// QA24: 閉じる確認（session.closed）が 2 秒来ないときは終了未確認で、予約を精算も解放もせず保持する。後から届いた使用秒数で
// 一度だけ精算する（15 秒の最低課金を含む）。
async function qa24CloseUnconfirmed() {
  let result;
  await withWorld({}, async (w) => {
    w.providerCloses = 'never';
    const loss = await sidebandLossScenario(w);
    await w.advance(1999);
    const waiting = {
      closure: liveRows(w)[0].closure,
      reservation: reservationOf(voiceReservationRows(w)[0]),
    };
    await w.advance(1);
    const held = {
      closure: liveRows(w)[0].closure,
      reservation: reservationOf(voiceReservationRows(w)[0]),
      dispatched: voiceReservationRows(w)[0].dispatched,
    };
    await w.advance(30_000);
    const stillHeld = reservationOf(voiceReservationRows(w)[0]);
    // 遅れて届いた使用秒数（provider 自身の記録: 作成から閉じる要求までの秒数）。2 回届いても精算は一度だけ。
    const truth = w.providerTruth[0];
    const seconds = Math.floor(
      (truth.close_requested_at - truth.created_at) / 1000,
    );
    w.rig.provider.last.closed(seconds);
    await w.advance(100);
    w.rig.provider.last.closed(seconds);
    await w.advance(100);
    const { lives, reservations } = settle(w);
    result = summary(w, {
      checks: {
        lost_after_last_pong_ms: loss.lostAfterMs,
        waiting_for_close: waiting,
        unconfirmed: held,
        still_held_after_30s: stillHeld,
        reconciled: {
          live: lifeOf(lives[0]),
          reservation: reservationOf(reservations[0]),
          settled_rows: reservations.filter((row) => row.status === 'settled')
            .length,
        },
      },
    });
  });
  return result;
}

// 停止（OS のロック）の命令の ACK を観測する。ACK の遅れ・固まる・ACK が来ない故障は faults で与える。
// afterLockMs: ロックから観測までに進める ms。戻り値は観測（世界は閉じた後なので、値だけを返す）。
async function lockWithFault(faults, afterLockMs, extra = () => undefined) {
  let out;
  await withWorld({ faults: [faults] }, async (w) => {
    await w.begin();
    await w.advance(3000);
    const t0 = w.clock.mono();
    w.device.applyLockQuery('lock_screen');
    const atDeadline = [];
    // 1 ms ずつ進め、外部への送信が止まった（音声レンダラーが止めた、または強制終了した）最初の時刻を測る。
    let stopMs = null;
    for (let dt = 1; dt <= 301; dt += 1) {
      await w.advance(1);
      const entry = w.slots.at(-1);
      if (stopMs === null && (!entry.alive || !w.stats().sending)) stopMs = dt;
      if (dt === 1 || dt === 300 || dt === 301)
        atDeadline.push({
          dt,
          alive: entry.alive,
          kills: w.kills.length,
          sent_frames: w.stats().sentFrames,
        });
    }
    await w.advance(afterLockMs);
    out = {
      commands: commandsSince(w, t0),
      acks: acksSince(w, t0),
      kills: w.kills.map((entry) => ({ dt: entry.at - t0 })),
      renderer_alive: w.slots.at(-1).alive,
      stop_ms: stopMs,
      frames_at: atDeadline,
      frames_at_end: w.stats().sentFrames,
      logs: [...w.logs],
      device: device(w),
      core_close_requests: closesSince(w, t0),
      renderers_created: w.slots.length,
      extra: await extra(w, t0),
      summary: summary(w, { checks: {} }),
    };
  });
  return out;
}

// X30（ACK の期限）: ACK は 300 ms ちょうどなら間に合い、1 ms 遅れると音声レンダラーを強制終了して全停止する。強制終了した
// 音声レンダラーの遅れた ACK は使わず、再開もしない。
async function x30AckDeadline() {
  const ok = await lockWithFault({ ...NO_FAULTS, delayMs: 298 }, 2000);
  const late = await lockWithFault(
    { ...NO_FAULTS, delayMs: 299 },
    2000,
    (w) => {
      // 強制終了した音声レンダラーの遅れた ACK を、main へ届ける（実機では届かない。届いても使わないことを確かめる）。
      const stale = w.acks.at(-1).ack;
      const commandsBefore = w.sent.length;
      w.ctl.receiveAck(1, stale);
      return {
        ack_logged_as_old: w.logs.includes('voice_ack_from_old_renderer'),
        commands_added: w.sent.length - commandsBefore,
        device: device(w),
        renderers_created: w.slots.length,
      };
    },
  );
  const pick = (run) => ({
    commands: run.commands,
    acks: run.acks,
    kills: run.kills,
    renderer_alive: run.renderer_alive,
    stop_ms: run.stop_ms,
    ack_missing_logged: run.logs.includes('voice_ack_missing:voice.suspend_io'),
    device: run.device,
    core_close_requests: run.core_close_requests,
    renderers_created: run.renderers_created,
    stopped_sending: run.frames_at_end === run.frames_at[0].sent_frames,
  });
  return {
    ...summary_of(late),
    voice_stop_ms: ok.stop_ms,
    checks: {
      ack_at_300ms: pick(ok),
      ack_at_301ms: { ...pick(late), late_ack: late.extra },
    },
  };
}

// X30（固まった音声レンダラー）: suspend_io で固まっても、送信は main の強制終了までは止まらない（実機の WebRTC の模型）。
// 301 ms で強制終了して送信を止め、中枢の閉じる要求（第 3 層）は音声レンダラーの応答に依存せず精算まで進む。
async function x30HungRenderer() {
  const hung = await lockWithFault(
    { ...NO_FAULTS, hangOn: 'voice.suspend_io' },
    5000,
  );
  return {
    ...summary_of(hung),
    voice_stop_ms: hung.stop_ms,
    checks: {
      stop_ms: hung.stop_ms,
      commands: hung.commands,
      acks: hung.acks,
      kills: hung.kills,
      renderer_alive: hung.renderer_alive,
      sent_frames_grew_before_kill:
        hung.frames_at[2].sent_frames > hung.frames_at[0].sent_frames,
      sent_frames_after_kill:
        hung.frames_at_end - hung.frames_at[2].sent_frames,
      device: hung.device,
      core_close_requests: hung.core_close_requests,
      ack_missing_logged: hung.logs.includes(
        'voice_ack_missing:voice.suspend_io',
      ),
    },
  };
}

// X30（読み上げの停止の ACK がない）: 再生の停止は適用されても ACK が来なければ、安全側に全停止して入力の中断を知らせる。
async function x30StopPlaybackWithoutAck() {
  let result;
  await withWorld(
    { faults: [{ ...NO_FAULTS, dropAck: ['voice.stop_playback'] }] },
    async (w) => {
      await w.begin();
      await w.advance(2000);
      // 相手の音声を再生中にしてから停止する。
      w.remoteAudio();
      await w.advance(100);
      const playingBefore = w.stats().playing;
      const t0 = w.clock.mono();
      w.ctl.applyControl('stop_playback');
      let playbackStopMs = null;
      for (let dt = 1; dt <= 300; dt += 1) {
        await w.advance(1);
        if (playbackStopMs === null && !w.stats().playing) playbackStopMs = dt;
      }
      const atDeadline = {
        commands: commandsSince(w, t0),
        device: device(w),
        notice: w.ctl.view().notice,
        playing: w.stats().playing,
        live: w.stats().live,
      };
      await w.advance(1);
      await w.advance(2000);
      result = summary(w, {
        voice_stop_ms: playbackStopMs,
        checks: {
          playing_before: playingBefore,
          playback_stop_ms: playbackStopMs,
          at_300ms: atDeadline,
          after_deadline: {
            commands: commandsSince(w, t0),
            acks: acksSince(w, t0),
            kills: w.kills.length,
            renderer: renderer(w),
            device: device(w),
            notice: w.ctl.view().notice,
            core_close_requests: closesSince(w, t0),
            voice_state: w.ctl.view().voice_state,
          },
        },
      });
    },
  );
  return result;
}

// lockWithFault の戻り値から、証拠に書く共通の項目（DB の版・件数・最終状態）を取り出す。
const summary_of = (run) => ({
  db_version: run.summary.db_version,
  provider_requests: run.summary.provider_requests,
  provider_state_changes: run.summary.provider_state_changes,
  approvals: 0,
  final_state: run.summary.final_state,
});

const CASES = {
  'X13-os-lock-stops-everything': x13OsLock,
  'X13-io-epoch-sync-before-restart': x13EpochSync,
  'QA43-three-stops-are-distinct': qa43ThreeStops,
  'X25-sideband-lost-closes-and-settles': x25SidebandLost,
  'QA24-close-unconfirmed-holds-reservation': qa24CloseUnconfirmed,
  'X30-ack-deadline-boundary': x30AckDeadline,
  'X30-hung-renderer-is-killed': x30HungRenderer,
  'X30-stop-playback-without-ack-escalates': x30StopPlaybackWithoutAck,
  ...CONVERSATION_CASES,
  ...INPUT_CASES,
};

// 1 つのケースを実行し、手書きの期待値と突き合わせる。観測を返す（証拠の元）。
export async function runCase(spec, seed, round) {
  const run = CASES[spec.id];
  assert.ok(run, `未登録のケース: ${spec.id}`);
  const observed = await run(spec, seed, round);
  assert.deepEqual(
    observed.checks,
    spec.expected,
    `${spec.id}: 観測が手書きの期待値と一致しません`,
  );
  assert.equal(
    observed.db_version,
    specification.db_version,
    '手書きの DB の版',
  );
  return observed;
}

export const caseIds = () => Object.keys(CASES);
