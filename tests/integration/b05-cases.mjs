// B05 の統合のケース。端末側（VoiceController・DesktopDeviceController・模擬の音声レンダラー・合成の PCM）と中枢側
// （VoiceControl・DB worker・予算の門・模擬の Live の provider）を 1 本の手で進める時計でつなぎ、端末が音声レンダラーへ
// 送った命令・音声レンダラーの状態・Core の Live と予約の行・provider 自身の真の使用時間を突き合わせる。
// 期待値は b05-expectations.json の手書きの値（設計 10 §1・§1A・§2・§2A・§8、07 §2・§5、09 の X13 ほか、ADR 0005 の表）。
// 待ち合わせは手で進める時計だけで行い、固定の sleep を使わない。HTTP・WSS・Electron・マイク・実 API は通さない。
import assert from 'node:assert/strict';
import { A, withWorld } from './b05-world.mjs';
import {
  CLEAN,
  deviceEpochRows,
  findings,
  liveRows,
  specification,
  voiceReservationRows,
} from './b05-support.mjs';

const VOICE_LIMIT = '2000';

// 命令・ACK を、基準の時刻からの相対の ms にそろえて取り出す（時刻の乱数はない。手で進める時計）。
const commandsSince = (w, t0) =>
  w.sent
    .filter((entry) => entry.at >= t0)
    .map((entry) => ({
      dt: entry.at - t0,
      channel: entry.channel,
      reason: entry.reason,
    }));
const acksSince = (w, t0) =>
  w.acks
    .filter((entry) => entry.at >= t0)
    .map((entry) => ({
      dt: entry.at - t0,
      channel: entry.ack.channel,
      outcome: entry.ack.outcome,
    }));
const closesSince = (w, t0) =>
  w.closedToCore
    .filter((entry) => entry.at >= t0)
    .map((entry) => ({ dt: entry.at - t0, reason: entry.reason }));

// 音声レンダラーの状態（模擬のレンダラーが持つ観測の値）。
function renderer(w) {
  const stats = w.stats();
  return {
    live: stats.live,
    sending: stats.sending,
    capturing: stats.capturing,
    playing: stats.playing,
    ring_empty: stats.ringFrames === 0,
    last_local_stop: stats.lastLocalStop,
    io_epoch: stats.epochs.io,
    audio_epoch: stats.epochs.audio,
    output_epoch: stats.epochs.output,
    session_epoch: stats.epochs.session,
  };
}

const device = (w) => ({
  lock_state: w.device.state.lockState,
  stop_scope: w.device.state.stopScope,
  io_epoch: w.device.state.ioEpoch,
});

const lifeOf = (row) => ({
  closure: row.closure,
  control_state: row.control_state,
  usage_seconds: row.usage_seconds,
  audio_epoch: row.audio_epoch,
  session_epoch: row.session_epoch,
});

const reservationOf = (row) => ({
  status: row.status,
  actual_gross: row.actual_gross,
});

// 終わりの突き合わせ。端末の命令・Core の行・provider の真の使用時間の不一致がないことを毎回すべての世界で確かめる。
function settle(w) {
  const lives = liveRows(w);
  const reservations = voiceReservationRows(w);
  const found = findings({
    sent: w.sent,
    lives,
    reservations,
    truth: w.providerTruth,
    voiceLimit: VOICE_LIMIT,
  });
  assert.deepEqual(
    found,
    CLEAN,
    '端末の命令・Core の行・provider の記録の不一致',
  );
  return { lives, reservations };
}

function summary(w, extra) {
  const { lives, reservations } = settle(w);
  return {
    db_version: String(w.rig.harness.store.schemaVersion),
    provider_requests: w.rig.provider.created.length,
    provider_state_changes: w.providerTruth.filter(
      (entry) => entry.close_requested_at !== null,
    ).length,
    approvals: 0,
    final_state: [
      `live:${lives.map((row) => row.closure).join('+') || 'none'}`,
      `reservation:${reservations.map((row) => row.status).join('+') || 'none'}`,
      `renderer:${w.stats()?.live ? 'live' : 'closed'}`,
    ].join('|'),
    voice_stop_ms: extra.voice_stop_ms ?? null,
    checks: extra.checks,
  };
}

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
    const before = {
      renderer: renderer(w),
      sent_frames_positive: w.stats().sentFrames > 0,
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
    await w.advance(5000);
    const stop = {
      commands: commandsSince(w, t0),
      acks: acksSince(w, t0),
      renderer: renderer(w),
      sent_frames_after_stop: w.stats().sentFrames - framesAtStop,
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
    const base = {
      renderer: renderer(w),
      lease_active: w.ctl.leaseActive,
    };

    // 1. 読み上げの停止（画面のボタン）: 再生だけ止める。会話・収音・リースは保つ。
    const t1 = w.clock.mono();
    const renewals1 = w.renewals.length;
    w.ctl.applyControl('stop_playback');
    await w.advance(10);
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

const CASES = {
  'X13-os-lock-stops-everything': x13OsLock,
  'X13-io-epoch-sync-before-restart': x13EpochSync,
  'QA43-three-stops-are-distinct': qa43ThreeStops,
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
