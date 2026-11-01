// B05 専用の装置（突き合わせの規則と読み取り）。期待値は b05-expectations.json の手書きの値だけで、ここでは作らない。
// 製品の src は直接 import せず、世界（b05-world.mjs）が読み込むビルド済みの dist だけを使う。
import { readFileSync } from 'node:fs';

export { shuffled } from './b05-world.mjs';

export const specification = JSON.parse(
  readFileSync(new URL('./b05-expectations.json', import.meta.url), 'utf8'),
);

export const CLEAN = Object.freeze([]);

// 会話の予約の最低の課金（秒）。設計 10 §2A・ADR 0046 の「15 秒の最低課金」。単価は合成の 1 秒 1 単位（XTS）。
export const MIN_BILLED_SECONDS = 15;

// Live の行（SQL で直接読む。DB worker・domain を通さない）。
export function liveRows(world) {
  return world.rig.harness.sql((db) =>
    db
      .prepare(
        `SELECT live_session_id, device_id, control_state, control_epoch, closure, usage_seconds,
                reservation_id, audio_epoch, session_epoch, end_reason
           FROM live_sessions ORDER BY started_at, rowid`,
      )
      .all(),
  );
}

// 音声の枠の予約の行。金額は文字列にそろえる。
export function voiceReservationRows(world) {
  return world.rig.harness
    .sql((db) =>
      db
        .prepare(
          `SELECT reservation_id, status, reserved_amount, max_liability, actual_gross, dispatch_intent_at
             FROM budget_reservations WHERE pool_id = 'voice' ORDER BY created_at, rowid`,
        )
        .all(),
    )
    .map((row) => ({
      reservation_id: row.reservation_id,
      status: row.status,
      reserved: String(row.reserved_amount),
      max_liability: String(row.max_liability),
      actual_gross: row.actual_gross === null ? null : String(row.actual_gross),
      dispatched: row.dispatch_intent_at !== null,
    }));
}

export function deviceEpochRows(world) {
  return world.rig.harness.sql((db) =>
    db
      .prepare(
        'SELECT device_id, io_epoch, output_epoch, audio_epoch, session_epoch, local_stop FROM device_epochs ORDER BY device_id',
      )
      .all(),
  );
}

const big = (value) => BigInt(value);

// 突き合わせの規則。端末が実際に音声レンダラーへ送った命令の記録（sent）・Core の Live と予約の行・provider 自身の
// 真の使用時間から、実装の判定とは別に数える。空の配列なら不一致なし。
// (1) 同じ音声レンダラーへ送った命令の io_epoch・output_epoch が後退しない
// (2) 開始の命令は Core に存在する Live だけで、世代がその Live の行と同じ
// (3) 閉じ終えた（close_confirmed）Live は、provider の真の使用秒数と同じ使用秒数で精算済み（最低 15 秒）
// (4) 送出意図のある予約が、使用秒数の確認なしに released になっていない
// (5) 閉じていない（open）Live の予約が精算済みになっていない
// (6) 音声の枠の使用量（精算済みは実費、そのほかは M。released は 0）が上限以内
export function findings({
  sent,
  lives,
  reservations,
  truth,
  voiceLimit,
  unitPerSecond = 1,
}) {
  const found = [];
  const lastByGeneration = new Map();
  for (const command of sent) {
    const last = lastByGeneration.get(command.generation) ?? {
      io: 0n,
      output: 0n,
    };
    const io = big(command.payload.io_epoch);
    const output = big(command.payload.output_epoch);
    if (io < last.io) found.push(`io_epoch_regressed:${command.channel}`);
    if (output < last.output)
      found.push(`output_epoch_regressed:${command.channel}`);
    lastByGeneration.set(command.generation, {
      io: io > last.io ? io : last.io,
      output: output > last.output ? output : last.output,
    });
    if (command.channel === 'voice.start') {
      const live = lives.find(
        (row) => row.live_session_id === command.payload.live_session_id,
      );
      if (live === undefined) found.push('start_without_live');
      else if (
        String(live.audio_epoch) !== command.payload.audio_epoch ||
        String(live.session_epoch) !== command.payload.session_epoch
      )
        found.push('start_epoch_differs_from_live');
    }
  }
  const byReservation = new Map(
    reservations.map((row) => [row.reservation_id, row]),
  );
  let used = 0n;
  for (const row of reservations) {
    if (row.status === 'settled') used += big(row.actual_gross ?? '0');
    else if (row.status !== 'released') used += big(row.max_liability);
  }
  if (voiceLimit !== undefined && used > big(voiceLimit))
    found.push('voice_limit_exceeded');
  for (const live of lives) {
    const reservation = byReservation.get(live.reservation_id);
    if (reservation === undefined) {
      found.push('live_without_reservation');
      continue;
    }
    if (live.closure === 'close_confirmed') {
      const real = truth.find(
        (entry) => entry.live_session_id === live.live_session_id,
      );
      const seconds =
        real === undefined || real.close_requested_at === null
          ? null
          : Math.floor((real.close_requested_at - real.created_at) / 1000);
      if (seconds === null) found.push('confirmed_without_provider_close');
      else {
        if (live.usage_seconds !== seconds)
          found.push('usage_differs_from_provider');
        const billed = Math.max(seconds, MIN_BILLED_SECONDS) * unitPerSecond;
        if (reservation.status !== 'settled')
          found.push('confirmed_but_not_settled');
        else if (reservation.actual_gross !== String(billed))
          found.push('settled_amount_differs');
      }
    }
    if (live.closure === 'open' && reservation.status === 'settled')
      found.push('open_but_settled');
    if (
      reservation.status === 'released' &&
      reservation.dispatched &&
      live.closure !== 'close_confirmed'
    )
      found.push('dispatched_released_without_usage');
  }
  return found;
}
