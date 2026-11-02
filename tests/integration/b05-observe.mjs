// B05 の観測の共通部品。端末が音声レンダラーへ送った命令・ACK・中枢への閉じる要求・音声レンダラーの状態・端末の状態・
// Core の Live と予約の行を、手書きの期待値と同じ形にそろえる。期待値はここでは作らない。
import assert from 'node:assert/strict';
import {
  CLEAN,
  findings,
  liveRows,
  voiceReservationRows,
} from './b05-support.mjs';

export const VOICE_LIMIT = '2000';

// 命令・ACK を、基準の時刻からの相対の ms にそろえて取り出す（時刻の乱数はない。手で進める時計）。
export const commandsSince = (w, t0) =>
  w.sent
    .filter((entry) => entry.at >= t0)
    .map((entry) => ({
      dt: entry.at - t0,
      channel: entry.channel,
      reason: entry.reason,
    }));
export const acksSince = (w, t0) =>
  w.acks
    .filter((entry) => entry.at >= t0)
    .map((entry) => ({
      dt: entry.at - t0,
      channel: entry.ack.channel,
      outcome: entry.ack.outcome,
    }));
export const closesSince = (w, t0) =>
  w.closedToCore
    .filter((entry) => entry.at >= t0)
    .map((entry) => ({ dt: entry.at - t0, reason: entry.reason }));

// 音声レンダラーの状態（模擬のレンダラーが持つ観測の値）。
export function renderer(w) {
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

export const device = (w) => ({
  lock_state: w.device.state.lockState,
  stop_scope: w.device.state.stopScope,
  io_epoch: w.device.state.ioEpoch,
});

export const lifeOf = (row) => ({
  closure: row.closure,
  control_state: row.control_state,
  usage_seconds: row.usage_seconds,
  audio_epoch: row.audio_epoch,
  session_epoch: row.session_epoch,
});

export const reservationOf = (row) => ({
  status: row.status,
  actual_gross: row.actual_gross,
});

// 終わりの突き合わせ。端末の命令・Core の行・provider の真の使用時間の不一致がないことを毎回すべての世界で確かめる。
export function settle(w) {
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

export function summary(w, extra) {
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
